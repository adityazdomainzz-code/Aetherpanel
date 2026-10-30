// Cloudflare DNS for Minecraft servers.
// Admin connects an API token + picks a domain (Platform Settings -> Cloudflare DNS).
// Every new Minecraft server then gets  <server-name>.<domain>  (A/AAAA/CNAME, grey cloud)
// plus an SRV record so players join with just the name - no port needed.
import { getDb, saveDbSync } from '../db';

const API = (process.env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');

export interface CloudflareSettings {
  enabled: boolean;
  apiToken: string;
  zoneId: string;
  zoneName: string;
  targetIp?: string;    // optional: public IP to use instead of the node IP (NAT / private node IP)
  connectedAt?: string;
}

export class CloudflareError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

async function cf(token: string, method: string, path: string, body?: any): Promise<any> {
  let r: Response;
  try {
    r = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e: any) {
    throw new CloudflareError('CF_UNREACHABLE', `Cloudflare is unreachable from the panel machine (${e?.cause?.code || e.message})`);
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) {
    const msg = (j.errors && j.errors[0] && j.errors[0].message) || `Cloudflare HTTP ${r.status}`;
    throw new CloudflareError('CF_API_ERROR', `Cloudflare: ${msg}`);
  }
  return j;
}

export function getCloudflareSettings(db: any): CloudflareSettings | null {
  const s = db.settings?.cloudflare;
  return s && s.apiToken ? s : null;
}
export function cloudflareActive(db: any) {
  const s = getCloudflareSettings(db);
  return !!(s && s.enabled && s.zoneId && s.zoneName);
}

export async function verifyTokenAndListZones(token: string) {
  const t = String(token || '').trim();
  if (!t) throw new CloudflareError('TOKEN_REQUIRED', 'Paste your Cloudflare API token.');
  await cf(t, 'GET', '/user/tokens/verify');
  const z = await cf(t, 'GET', '/zones?per_page=50&status=active');
  const zones = (z.result || []).map((x: any) => ({ id: x.id, name: x.name }));
  if (!zones.length) throw new CloudflareError('NO_ZONES', 'This token cannot see any domain. Give it "Zone - DNS - Edit" and "Zone - Zone - Read" for your domain.');
  return zones;
}

/** server name -> subdomain label:  "Survival SMP!" -> "survival-smp" */
export function subdomainFor(name: string) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/g, '');
}

const isPrivateV4 = (ip: string) => /^(10\.|127\.|192\.168\.|169\.254\.|0\.)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
const isV4 = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
const isV6 = (s: string) => s.includes(':');

/**
 * Throws CloudflareError('NAME_TAKEN', 'Server name already exists') when the name's subdomain is used
 * by another server or already exists in the Cloudflare zone. No-op when Cloudflare is not connected.
 */
export async function assertMinecraftNameAvailable(db: any, name: string, exceptServerId?: string) {
  if (!cloudflareActive(db)) return null;
  const s = getCloudflareSettings(db)!;
  const label = subdomainFor(name);
  if (!label) throw new CloudflareError('NAME_INVALID', 'Server name must contain letters or numbers (it becomes the address).');
  const host = `${label}.${s.zoneName}`;
  const clash = db.servers.find((x: any) => x.id !== exceptServerId && (x.dns?.hostname === host || (x.productId === 'prod_minecraft' && subdomainFor(x.name) === label && x.dns)));
  if (clash) throw new CloudflareError('NAME_TAKEN', `Server name already exists (${host} is used by '${clash.name}'). Choose another name.`);
  const r = await cf(s.apiToken, 'GET', `/zones/${s.zoneId}/dns_records?name=${encodeURIComponent(host)}`);
  if ((r.result || []).length) throw new CloudflareError('NAME_TAKEN', `Server name already exists (${host} is already in your Cloudflare DNS). Choose another name.`);
  return host;
}

/** create the DNS records for a new Minecraft server; never throws (server creation must not fail on DNS) */
export async function registerMinecraftDns(serverId: string): Promise<{ ok: boolean; hostname?: string; error?: string }> {
  try {
    const db = await getDb();
    if (!cloudflareActive(db)) return { ok: false, error: 'Cloudflare not connected' };
    const s = getCloudflareSettings(db)!;
    const server: any = db.servers.find((x: any) => x.id === serverId);
    if (!server) return { ok: false, error: 'server not found' };
    const label = subdomainFor(server.name);
    if (!label) return { ok: false, error: 'invalid name' };
    const host = `${label}.${s.zoneName}`;

    let target = String(s.targetIp || '').trim() || String(server.primaryIp || '').trim();
    if (!target || (isV4(target) && isPrivateV4(target))) {
      return { ok: false, error: `the server IP (${target || 'none'}) is private - set "Public IP for DNS" in Cloudflare settings` };
    }
    const ids: string[] = [];
    const main = isV4(target) ? { type: 'A', content: target } : isV6(target) ? { type: 'AAAA', content: target } : { type: 'CNAME', content: target };
    const rec = await cf(s.apiToken, 'POST', `/zones/${s.zoneId}/dns_records`, { ...main, name: host, ttl: 1, proxied: false, comment: `AetherPanel ${server.id}` });
    ids.push(rec.result.id);
    if (server.primaryPort) {
      const srv = await cf(s.apiToken, 'POST', `/zones/${s.zoneId}/dns_records`, {
        type: 'SRV', name: `_minecraft._tcp.${host}`, ttl: 1, comment: `AetherPanel ${server.id}`,
        data: { priority: 0, weight: 5, port: Number(server.primaryPort), target: host },
      }).catch((e: any) => { console.warn('[Cloudflare] SRV record failed:', e.message); return null; });
      if (srv?.result?.id) ids.push(srv.result.id);
    }
    server.dns = { provider: 'cloudflare', hostname: host, zoneId: s.zoneId, recordIds: ids, createdAt: new Date().toISOString() };
    saveDbSync();
    try { (await import('../provider')).appendConsoleLog(serverId, `[Cloudflare]: Address registered: ${host} (players can join with just this name)`); } catch {}
    return { ok: true, hostname: host };
  } catch (e: any) {
    console.warn('[Cloudflare] DNS registration failed:', e.message);
    try { (await import('../provider')).appendConsoleLog(serverId, `[Cloudflare/WARN]: DNS registration failed: ${e.message}`); } catch {}
    return { ok: false, error: e.message };
  }
}

/** remove the server's DNS records (on delete); never throws */
export async function removeServerDns(server: any) {
  try {
    if (!server?.dns?.recordIds?.length) return;
    const db = await getDb();
    const s = getCloudflareSettings(db);
    if (!s) return;
    for (const id of server.dns.recordIds) {
      await cf(s.apiToken, 'DELETE', `/zones/${server.dns.zoneId || s.zoneId}/dns_records/${id}`).catch(() => {});
    }
  } catch {}
}
