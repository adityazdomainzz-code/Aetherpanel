import { VPS_OS, buildVpsInfo, detectVpsEngines } from '../services/vpsService';
import { assertMinecraftNameAvailable, registerMinecraftDns } from '../services/cloudflareService';
import { Router, Response } from 'express';
import { getDb, saveDbSync } from '../db';
import { authMiddleware, AuthenticatedRequest, createAuditLog } from '../auth';
import { buildBotStartupCommand } from '../../src/lib/startup';
import { initializeServerFiles, appendConsoleLog, startServer } from '../provider';
import { downloadMinecraftServerJar, writeMinecraftEula, writeServerProperties, getRecommendedJavaVersion } from '../minecraftService';
import { Server, Order, Allocation } from '../../src/types';
import { dispatchWebhookEvent } from '../webhookService';
import { RESERVED_SYSTEM_PORTS, isPortReserved, resolveNodePublicEndpoint, resolveServerPublicEndpoint } from '../network/endpointResolver';
import { getUserAllocationStatus, canUserDeployServer } from '../services/allocationService';
import { resolveServerResources } from '../services/resourceResolverService';
import { applyServerPortRule } from '../services/networkProtectionService';
import { ALLOW_SELF_DEPLOY, isAdminRole, SELF_DEPLOY_ERROR } from '../services/fundingPolicy';

const router = Router();

// GET /api/v1/deploy/options - Get products, plans, locations, nodes, templates, allocations
router.get('/options', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const db = await getDb();
  const allocationStatus = req.user ? getUserAllocationStatus(db, req.user) : null;
  res.json({
    success: true,
    data: {
      products: db.products.filter(p => p.isActive),
      plans: db.plans.filter(p => p.isActive),
      nodes: db.nodes.filter(n => n.status === 'online' && !n.isMaintenanceMode),
      templates: (db.templates || []).filter(t => t.status === 'active'),
      userCredits: req.user!.credits,
      currentServerCount: db.servers.filter(s => s.userId === req.user!.id).length,
      allocations: allocationStatus
    }
  });
});

// User deployment mutex locks to prevent allocation race conditions
const userDeployLocks = new Map<string, Promise<void>>();
let globalDeployLock: Promise<void> | null = null;

async function withGlobalDeployLock<T>(fn: () => Promise<T>): Promise<T> {
  while (globalDeployLock) {
    await globalDeployLock;
  }
  let resolveLock: () => void;
  globalDeployLock = new Promise<void>(resolve => {
    resolveLock = resolve;
  });
  try {
    return await fn();
  } finally {
    globalDeployLock = null;
    resolveLock!();
  }
}

export async function withUserDeployLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  while (userDeployLocks.has(userId)) {
    await userDeployLocks.get(userId);
  }
  let resolveLock: () => void;
  const lockPromise = new Promise<void>(resolve => {
    resolveLock = resolve;
  });
  userDeployLocks.set(userId, lockPromise);
  try {
    // Also acquire global lock to prevent concurrent node capacity over-allocation
    return await withGlobalDeployLock(fn);
  } finally {
    userDeployLocks.delete(userId);
    resolveLock!();
  }
}

export async function executeServerDeployment(db: any, userId: string, payload: {
  name: string;
  planId: string;
  templateId?: string;
  nodeId?: string;
  location?: string;
  software?: string;
  version?: string;
  billingCycle?: 'monthly' | 'yearly';
  couponCode?: string;
  paymentMethod?: string;
  environmentVars?: Record<string, string>;
  serverTypeId?: string;
  transactionRef?: string;
  isPaidUpfront?: boolean;
  // set when an administrator creates the server for this user: skips the user's own
  // server-count limit, but the plan price is still taken from the user's credits
  adminProvision?: { adminId: string; adminEmail: string };
  // VPS plans: engine + OS (wizard sends OS as software and engine as version)
  vpsEngine?: 'docker' | 'lxc' | 'vm';
  vpsOs?: string;
  // category the user picked in the wizard - the plan must belong to it
  productCategory?: string;
}) {
  const {
    name, planId, templateId, nodeId, location, software, version,
    billingCycle, couponCode, paymentMethod, environmentVars, serverTypeId,
    transactionRef, isPaidUpfront, adminProvision
  } = payload;

  if (!name || !planId) {
    throw new Error('Server name and plan selection are required.');
  }

  const freshUser = db.users.find((u: any) => u.id === userId);
  if (!freshUser) {
    throw new Error('User account no longer exists.');
  }

  if (freshUser.isSuspended) {
    throw new Error('Your account is currently suspended. Deployment is prohibited.');
  }

  const plan = db.plans.find((p: any) => p.id === planId && p.isActive);
  if (!plan) {
    throw new Error('Selected plan is invalid or inactive.');
  }

  const template = templateId ? (db.templates || []).find((t: any) => t.id === templateId) : null;

  const deployCheck = adminProvision ? { allowed: true, errorMessage: '' } : canUserDeployServer(db, freshUser);
  if (!deployCheck.allowed) {
    throw new Error(deployCheck.errorMessage || 'Server allocation limit reached.');
  }

  const prod = db.products.find((p: any) => p.id === plan.productId);
  const category = template?.category || prod?.category || (plan.id.includes('bot') ? 'bot' : 'minecraft');
  const wantCat = String(payload.productCategory || '').toLowerCase();
  if (wantCat && ['minecraft', 'bot', 'vps'].includes(wantCat) && wantCat !== category) {
    const nice = (c: string) => (c === 'vps' ? 'VPS' : c === 'bot' ? 'Bot Hosting' : 'Minecraft');
    throw new Error(`The plan '${plan.name}' is a ${nice(category)} plan, not ${nice(wantCat)}. Pick a ${nice(wantCat)} plan (Admin -> Products & Plans).`);
  }

  // Minecraft + Cloudflare connected: the server name becomes <name>.<domain> - it must be free
  if (category === 'minecraft') await assertMinecraftNameAvailable(db, name);

  // ---- VPS plan: pick engine + OS and make sure the engine exists before any credits are taken
  const isVps = category === 'vps' || plan.productId === 'prod_vps';
  let vpsEngine: 'docker' | 'lxc' | 'vm' = 'docker';
  let vpsOs = 'ubuntu-22.04';
  let vpsRemoteNode: any = null;
  if (isVps) {
    vpsEngine = payload.vpsEngine || (/kvm|vm/i.test(String(version || '')) ? 'vm' : /lxc|incus/i.test(String(version || '')) ? 'lxc' : 'docker');
    const wanted = String(payload.vpsOs || software || '').toLowerCase();
    vpsOs = Object.keys(VPS_OS).find((k) => k === wanted || VPS_OS[k].label.toLowerCase() === wanted) || 'ubuntu-22.04';
    const asked = nodeId ? db.nodes.find((n: any) => n.id === nodeId) : null;
    if (asked && asked.id !== 'node_local' && !asked.isLocalNode) {
      vpsRemoteNode = asked; // VPS on a connected node (install.sh -> Make this VPS a node)
      if (asked.status !== 'online') throw new Error(`Node '${asked.name}' is offline - check on the node: systemctl status aethernode`);
      if (vpsEngine === 'vm' && asked.capabilities && !asked.capabilities.kvm) throw new Error(`Node '${asked.name}' has no KVM - choose an LXC container.`);
    }
  }
  if (isVps && !vpsRemoteNode) {
    const eng = await detectVpsEngines(true);
    if (vpsEngine === 'docker' && !eng.docker) throw new Error('VPS engine Docker is not installed or not running on the panel machine (curl -fsSL https://get.docker.com | sh).');
    if (vpsEngine !== 'docker' && !eng.lxc) throw new Error('VPS engine LXC/Incus is not installed on the panel machine (install incus, then: incus admin init --minimal).');
  }

  const resolvedResources = resolveServerResources({
    db,
    planId: plan.id,
    serverCategory: category,
    provisionSource: 'self_service',
    requestedLimits: {}
  });

  let targetNode = null;
  let nodeRejectionReason = '';

  if (isVps) {
    // a VPS runs on the panel machine itself, or on the connected node that was picked
    targetNode = vpsRemoteNode || db.nodes.find((n: any) => n.id === 'node_local' || n.isLocalNode) || null;
    if (!targetNode) throw new Error('The panel machine (local node) was not found - VPS needs it.');
  } else if (nodeId) {
    targetNode = db.nodes.find((n: any) => n.id === nodeId && n.status === 'online' && !n.isMaintenanceMode);
  }

  if (!targetNode) {
    // No capacity limits: servers are never refused for "insufficient RAM / CPU / disk" or max server count.
    // Pick any online node (allowed for this product first), least loaded first; fall back to the panel's own node.
    const usable = (n: any) => n.status === 'online' && !n.isMaintenanceMode;
    const vpsOnly = (n: any) => Array.isArray(n.tags) && n.tags.includes('vps-node');
    let candidateNodes = db.nodes.filter((n: any) => usable(n) && !vpsOnly(n) && (!n.allowedProducts || n.allowedProducts.length === 0 || n.allowedProducts.includes(plan.productId)));
    if (candidateNodes.length === 0) candidateNodes = db.nodes.filter((n: any) => usable(n) && !vpsOnly(n));
    if (candidateNodes.length === 0) candidateNodes = db.nodes.filter((n: any) => n.id === 'node_local' || n.isLocalNode);
    if (candidateNodes.length === 0) candidateNodes = db.nodes.slice(0, 1);
    if (candidateNodes.length === 0) {
      throw new Error('No compute node exists yet - add one in Admin -> Compute Nodes.');
    }
    void nodeRejectionReason;

    let locationNodes = candidateNodes.filter((n: any) => n.location === location);
    if (locationNodes.length === 0) locationNodes = candidateNodes;

    locationNodes.sort((a: any, b: any) => {
      const effMaxA = Math.max(1, (a.totalRamMB || 1) * (1 + (a.ramOverallocatePercent || 0) / 100));
      const effMaxB = Math.max(1, (b.totalRamMB || 1) * (1 + (b.ramOverallocatePercent || 0) / 100));
      return ((a.usedRamMB || 0) / effMaxA) - ((b.usedRamMB || 0) / effMaxB);
    });

    targetNode = locationNodes[0];
  }

  if (!targetNode) {
    throw new Error('Unable to resolve eligible target node for deployment.');
  }

  let basePrice = billingCycle === 'yearly' ? plan.priceYearly : plan.priceMonthly;
  let finalAmount = basePrice;

  if (couponCode) {
    const coupon = db.coupons.find((c: any) => c.code.toUpperCase() === couponCode.trim().toUpperCase() && c.isActive);
    if (coupon) {
      if (coupon.discountType === 'percent') {
        finalAmount = Math.max(0, basePrice * (1 - coupon.discountValue / 100));
      } else {
        finalAmount = Math.max(0, basePrice - coupon.discountValue);
      }
      coupon.timesUsed += 1;
    }
  }

  const methodStr = (paymentMethod || 'balance').toLowerCase();

  // Deduct balance only if amount > 0 and not paid upfront
  let deductedCredits = 0;
  if (finalAmount > 0 && !isPaidUpfront && !methodStr.includes('stripe') && !methodStr.includes('upi') && !methodStr.includes('crypto')) {
    if (freshUser.credits < finalAmount) {
      throw new Error(adminProvision
        ? `${freshUser.email} has only $${(freshUser.credits || 0).toFixed(2)} credits - the plan '${plan.name}' costs $${finalAmount.toFixed(2)}. Add credits to the user first (Admin -> Users).`
        : `Insufficient credits balance. Required: $${finalAmount.toFixed(2)}, Available: $${freshUser.credits.toFixed(2)}`);
    }
    freshUser.credits = parseFloat((freshUser.credits - finalAmount).toFixed(2));
    deductedCredits = finalAmount;
  }

  let alloc = db.allocations.find((a: any) => a.nodeId === targetNode.id && !a.isAssigned && !isPortReserved(a.port, targetNode));
  let assignedPort: number;
  if (alloc) {
    assignedPort = alloc.port;
  } else {
    let candidate = template?.defaultPort || 25565;
    while (isPortReserved(candidate, targetNode) || db.allocations.some((a: any) => a.nodeId === targetNode.id && a.port === candidate)) {
      candidate = Math.floor(Math.random() * 4000) + 25565;
    }
    assignedPort = candidate;
  }

  const serverId = `srv_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
  const nodeEndpoint = resolveNodePublicEndpoint(targetNode);
  const effectiveIp = nodeEndpoint.host;

  if (!alloc) {
    alloc = {
      id: `alloc_${Date.now()}_${assignedPort}`,
      nodeId: targetNode.id,
      ip: targetNode.ip,
      port: assignedPort,
      serverId,
      isAssigned: true,
      createdAt: new Date().toISOString()
    };
    db.allocations.push(alloc);
  } else {
    alloc.serverId = serverId;
    alloc.isAssigned = true;
  }

  const resourceLimits = {
    ramMB: resolvedResources.ramMB,
    cpuCores: resolvedResources.cpuCores,
    diskGB: resolvedResources.diskGB,
    backups: resolvedResources.backups,
    databases: resolvedResources.databases
  };

  const selectedSoftware = isVps ? `${VPS_OS[vpsOs].label} (${vpsEngine === 'docker' ? 'Docker' : vpsEngine === 'vm' ? 'KVM VM' : 'LXC'})` : (software || template?.name || (category === 'minecraft' ? 'Paper' : 'Node.js'));
  const selectedVersion = isVps ? vpsOs : (version || template?.defaultVersion || (category === 'minecraft' ? '1.21.4' : 'Node 22 (LTS)'));

  let resolvedServerTypeId = isVps ? 'st_vps' : serverTypeId;
  if (!resolvedServerTypeId) {
    const swLower = (selectedSoftware || '').toLowerCase();
    if (swLower.includes('node')) resolvedServerTypeId = 'st_nodejs';
    else if (swLower.includes('bun')) resolvedServerTypeId = 'st_bun';
    else if (swLower.includes('python')) resolvedServerTypeId = 'st_python';
    else resolvedServerTypeId = 'st_minecraft_java';
  }

  const startupConfig: any = category === 'bot' ? {
    botRuntime: selectedSoftware.toLowerCase().includes('python') ? 'python' : selectedSoftware.toLowerCase().includes('bun') ? 'bun' : 'nodejs',
    nodeConfig: selectedSoftware.toLowerCase().includes('node') ? { version: selectedVersion, startupFile: 'index.js' } : undefined,
    pythonConfig: selectedSoftware.toLowerCase().includes('python') ? { version: selectedVersion, startupFile: 'main.py' } : undefined,
    bunConfig: selectedSoftware.toLowerCase().includes('bun') ? { version: selectedVersion, startupFile: 'index.ts' } : undefined,
    entryFile: selectedSoftware.toLowerCase().includes('python') ? 'main.py' : selectedSoftware.toLowerCase().includes('bun') ? 'index.ts' : 'index.js',
    customFlags: '',
    autoStartOnBoot: true,
    autoRestartPolicy: 'on_crash',
    maxCrashRestarts: 5,
    crashRestartDelaySeconds: 5
  } : {
    javaVersion: environmentVars?.JAVA_VERSION || `Java ${getRecommendedJavaVersion(selectedVersion)}`,
    serverJar: 'server.jar',
    xmsMB: 128,
    xmxMB: resourceLimits.ramMB,
    nogui: true,
    jvmFlags: '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200',
    autoStartOnBoot: true,
    autoRestartPolicy: 'on_crash',
    maxCrashRestarts: 5,
    crashRestartDelaySeconds: 5
  };

  const tempServerContext: Partial<Server> = {
    software: selectedSoftware,
    version: selectedVersion,
    limits: resourceLimits
  };

  if (isVps) {
    for (const k of Object.keys(startupConfig)) delete startupConfig[k];
    startupConfig.compiledCommand = '';
  } else if (category === 'bot') {
    const cmdObj = buildBotStartupCommand(tempServerContext, startupConfig);
    startupConfig.compiledCommand = cmdObj.compiledCommand;
  } else {
    startupConfig.compiledCommand = `java -Xms128M -Xmx${resourceLimits.ramMB}M ${startupConfig.jvmFlags} -jar server.jar nogui`;
  }

  const newServer: Server = {
    id: serverId,
    name: name.trim(),
    userId: freshUser.id,
    productId: plan.productId,
    planId: plan.id,
    nodeId: targetNode.id,
    templateId: template?.id,
    serverTypeId: resolvedServerTypeId,
    deploymentState: 'READY',
    status: isVps ? 'installing' : 'running',
    ...(isVps ? { vps: buildVpsInfo(serverId, vpsEngine, vpsOs, name, vpsRemoteNode ? vpsRemoteNode.id : undefined) } : {}),
    primaryIp: effectiveIp,
    primaryPort: assignedPort,
    location: targetNode.locationName,
    software: selectedSoftware,
    version: selectedVersion,
    startup: startupConfig as any,
    limits: resourceLimits,
    resources: {
      memoryMb: resolvedResources.ramMB,
      cpuPercent: resolvedResources.cpuPercent,
      diskGb: resolvedResources.diskGB
    },
    provisionSource: adminProvision ? 'admin_assigned' : 'self_service',
    isAdminCreated: !!adminProvision,
    createdByAdmin: !!adminProvision,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cpuUsage: 12.0,
    ramUsageMB: Math.floor(resourceLimits.ramMB * 0.25),
    diskUsageMB: 250,
    uptimeSeconds: 0
  };

  targetNode.usedRamMB += resourceLimits.ramMB;
  targetNode.usedCpuCores += resourceLimits.cpuCores;
  targetNode.usedDiskGB = (targetNode.usedDiskGB || 0) + resourceLimits.diskGB;
  targetNode.serverCount += 1;

  db.servers.push(newServer);

  if (assignedPort) {
    applyServerPortRule(assignedPort, 'both', newServer.id, newServer.name).catch(() => {});
  }

  let orderPaymentMethodName = (paymentMethod && paymentMethod !== 'balance') ? paymentMethod : (adminProvision ? 'Account Credits (created by admin)' : 'Aether Account Credits');
  if (isPaidUpfront && methodStr.includes('crypto')) orderPaymentMethodName = `Crypto Processor (${transactionRef ? 'Tx: ' + transactionRef.slice(0, 10) : 'Confirmed'})`;

  const order: Order = {
    id: `ord_${Date.now()}`,
    userId: freshUser.id,
    userEmail: freshUser.email,
    planId: plan.id,
    planName: `${prod?.name || 'Hosting'} - ${plan.name} (${newServer.name})`,
    billingCycle: billingCycle || 'monthly',
    amount: parseFloat(finalAmount.toFixed(2)),
    currency: db.settings.currencyCode || 'USD',
    status: 'paid',
    paymentMethod: orderPaymentMethodName,
    transactionRef: transactionRef || undefined,
    createdAt: new Date().toISOString()
  };
  db.orders.unshift(order);

  if (!isVps) initializeServerFiles(serverId, prod?.category || 'minecraft', newServer.software, newServer.version);

  if (prod?.category === 'minecraft') {
    appendConsoleLog(serverId, `[AetherPanel]: Provisioning Minecraft server runtime (${newServer.software} ${newServer.version})...`);
    writeMinecraftEula(serverId, true);
    writeServerProperties(serverId, {
      serverPort: assignedPort,
      motd: `§bAetherPanel §7- ${newServer.name}`
    });
    try {
      await downloadMinecraftServerJar(serverId, newServer.software, newServer.version);
    } catch (err: any) {
      appendConsoleLog(serverId, `[AetherInstaller/WARN]: Server JAR download notice: ${err.message}`);
    }
  }

  appendConsoleLog(serverId, `[AetherPanel]: Server auto-provisioned successfully from template '${selectedSoftware}' on node ${targetNode.name}.`);

  try {
    if (isVps) startServer(serverId).catch(() => {}); // image download can take minutes - runs in the background
    else await startServer(serverId);
  } catch (err: any) {
    if (newServer && targetNode) {
      targetNode.usedRamMB -= resourceLimits.ramMB;
      targetNode.usedCpuCores -= resourceLimits.cpuCores;
      targetNode.usedDiskGB = (targetNode.usedDiskGB || 0) - resourceLimits.diskGB;
      targetNode.serverCount -= 1;
      const srvIdx = db.servers.findIndex((s: any) => s.id === serverId);
      if (srvIdx !== -1) db.servers.splice(srvIdx, 1);
      if (alloc) alloc.isAssigned = false;
    }
    // the server was not created: give the credits back and drop the order
    if (deductedCredits > 0) freshUser.credits = parseFloat((freshUser.credits + deductedCredits).toFixed(2));
    const ordIdx = db.orders.findIndex((o: any) => o.id === order.id);
    if (ordIdx !== -1) db.orders.splice(ordIdx, 1);
    saveDbSync();
    throw err;
  }

  saveDbSync();
  if (category === 'minecraft') registerMinecraftDns(serverId).catch(() => {}); // <name>.<domain> on Cloudflare

  await createAuditLog(
    freshUser.id, freshUser.email, freshUser.role,
    'SERVER_PROVISION', serverId,
    adminProvision
      ? `Admin ${adminProvision.adminEmail} created server '${name}' (${plan.name}) for this user - $${finalAmount.toFixed(2)} taken from credits`
      : `Provisioned server '${name}' from template '${selectedSoftware}' ($${finalAmount.toFixed(2)})`
  );

  dispatchWebhookEvent('server.created', {
    serverId: newServer.id,
    serverName: newServer.name,
    userId: newServer.userId,
    userEmail: freshUser.email,
    nodeId: targetNode.id,
    nodeName: targetNode.name,
    software: newServer.software,
    version: newServer.version,
    primaryIp: newServer.primaryIp,
    primaryPort: newServer.primaryPort,
    limits: newServer.limits
  }, freshUser.id).catch(() => {});

  return { server: newServer, order };
}

// POST /api/v1/deploy/create - Deploy server instance
router.post('/create', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  // only administrators create servers (Admin -> Servers -> Create Server)
  if (!ALLOW_SELF_DEPLOY && !isAdminRole(req.user!.role)) {
    return res.status(403).json(SELF_DEPLOY_ERROR);
  }
  return withUserDeployLock(req.user!.id, async () => {
    try {
      const db = await getDb();
      // never trust payment flags from the browser: the price is always taken from credits
      const { isPaidUpfront, adminProvision, paymentMethod, transactionRef, ...body } = req.body || {};
      const result = await executeServerDeployment(db, req.user!.id, { ...body, paymentMethod: 'balance' });
      res.json({
        success: true,
        message: 'Server deployed and running!',
        data: result
      });
    } catch (err: any) {
      res.status(400).json({ success: false, error: { code: 'DEPLOYMENT_FAILED', message: err.message || 'Server deployment failed.' } });
    }
  });
});

export default router;
