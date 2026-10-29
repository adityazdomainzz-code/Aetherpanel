// VPS hosting: every VPS is a Docker container, an LXC/Incus container or an Incus KVM VM - on the panel's own
// machine, or on a connected remote node (node-agent/agent.js runs Incus there, jobs go through nodeJobs.ts).
// The server folder (data/servers/<id>) is mounted as /root inside the VPS, so File Manager, Importer,
// Backups and the Env tab (/root/.env) all work on the VPS home folder.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { getDb, saveDbSync } from '../db';
import { Server } from '../../src/types';
import { sendNodeJob } from './nodeJobs';

export type VpsEngine = 'docker' | 'lxc' | 'vm';

export interface VpsInfo {
  engine: VpsEngine;
  os: string;            // key of VPS_OS
  image: string;         // image used to create it
  instanceName: string;  // docker container / lxc instance name
  hostname: string;
  cli?: 'incus' | 'lxc'; // lxc only
  createdAt?: string;
  remote?: boolean;      // runs on a connected node, not on the panel machine
  nodeId?: string;
}

export const VPS_OS: Record<string, { label: string; docker: string; lxc: string }> = {
  'ubuntu-22.04': { label: 'Ubuntu 22.04', docker: 'ubuntu:22.04', lxc: 'images:ubuntu/22.04' },
  'ubuntu-24.04': { label: 'Ubuntu 24.04', docker: 'ubuntu:24.04', lxc: 'images:ubuntu/24.04' },
  'debian-12': { label: 'Debian 12', docker: 'debian:12', lxc: 'images:debian/12' },
  'alpine-3.20': { label: 'Alpine 3.20', docker: 'alpine:3.20', lxc: 'images:alpine/3.20' },
};

export const isVpsServer = (s: any): boolean => !!s && (s.productId === 'prod_vps' || !!s.vps);

// ---------- small exec helper ----------
interface RunResult { code: number; stdout: string; stderr: string }
function run(cmd: string, args: string[], timeoutMs = 60000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err: any, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || (err && !stderr ? err.message : '')) });
    });
  });
}
async function must(cmd: string, args: string[], timeoutMs?: number): Promise<string> {
  const r = await run(cmd, args, timeoutMs);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `${cmd} failed`).trim().split('\n').slice(-3).join(' '));
  return r.stdout;
}

// ---------- engine detection ----------
let detected: { docker: boolean; lxc: 'incus' | 'lxc' | null; checkedAt: number } | null = null;
export async function detectVpsEngines(force = false) {
  if (detected && !force && Date.now() - detected.checkedAt < 60000) return detected;
  const docker = (await run('docker', ['info', '--format', '{{.ServerVersion}}'], 8000)).code === 0;
  let lxc: 'incus' | 'lxc' | null = null;
  if ((await run('incus', ['list', '--format', 'csv', '-c', 'n'], 8000)).code === 0) lxc = 'incus';
  else if ((await run('lxc', ['list', '--format', 'csv', '-c', 'n'], 8000)).code === 0) lxc = 'lxc';
  detected = { docker, lxc, checkedAt: Date.now() };
  return detected;
}

export function buildVpsInfo(serverId: string, engine: VpsEngine, osKey: string, name: string, remoteNodeId?: string): VpsInfo {
  const os = VPS_OS[osKey] ? osKey : 'ubuntu-22.04';
  const short = serverId.replace(/^srv_/, '').replace(/[^a-zA-Z0-9]/g, '').slice(-10).toLowerCase();
  const base = String(name || 'vps').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'vps';
  return {
    engine,
    os,
    image: engine === 'docker' ? VPS_OS[os].docker : VPS_OS[os].lxc,
    instanceName: engine === 'docker' ? `aether-vps-${short}` : `avps-${short}`,
    hostname: `${base}-${short.slice(-5)}`.replace(/^-/, 'vps-'),
    ...(remoteNodeId ? { remote: true, nodeId: remoteNodeId } : {}),
  };
}

export const isRemoteVps = (v?: VpsInfo | null) => !!(v && v.remote && v.nodeId);
const isIncus = (v: VpsInfo) => v.engine === 'lxc' || v.engine === 'vm';

/** run a job on the remote node; throws with the node's error message */
async function nodeDo(server: Server, v: VpsInfo, action: string, extra: any = {}, timeoutMs = 120000) {
  const r = await sendNodeJob(v.nodeId!, action, {
    serverId: server.id, instanceName: v.instanceName, engine: v.engine, image: v.image, os: v.os, hostname: v.hostname, ...extra,
  }, timeoutMs);
  if (!r.ok) throw new Error(r.error || `${action} failed on the node`);
  return r;
}

const serverDir = (id: string) => {
  const d = path.join(process.cwd(), 'data', 'servers', id);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
};
const lxcCli = (v: VpsInfo) => v.cli || (detected?.lxc ?? 'incus');

// ---------- logs / status helpers (provider is loaded lazily: it imports this file) ----------
async function log(serverId: string, line: string) {
  try { (await import('../provider')).appendConsoleLog(serverId, line); } catch {}
  // VPS pages show the terminal, not the console - mirror the message there so progress / errors are visible
  try {
    const color = /ERROR/.test(line) ? '31' : /WARN|TIP/.test(line) ? '33' : '36';
    (await import('./vpsTerminal')).writeToTerminalLog(serverId, `\x1b[${color}m${line}\x1b[0m\r\n`);
  } catch {}
}

/** runs a long command and prints "still working..." every 15s so the user sees it is not stuck */
async function withHeartbeat<T>(serverId: string, what: string, p: Promise<T>): Promise<T> {
  const t0 = Date.now();
  const iv = setInterval(() => { log(serverId, `[AetherVPS]: ${what}... ${Math.round((Date.now() - t0) / 1000)}s`); }, 15000);
  try { return await p; } finally { clearInterval(iv); }
}

const creating = new Set<string>(); // VPS that are being created right now
async function setStatus(server: Server, status: string, extra?: any) {
  (server as any).status = status;
  if (status !== 'running') { server.cpuUsage = 0; server.ramUsageMB = 0; }
  saveDbSync();
  try { (await import('../provider')).emitServerStatus(server.id, status, extra); } catch {}
}

// ---------- state ----------
export async function vpsState(v: VpsInfo): Promise<'running' | 'stopped' | 'missing'> {
  if (isRemoteVps(v)) {
    const r = await sendNodeJob(v.nodeId!, 'state', { instanceName: v.instanceName }, 30000);
    if (!r.ok) throw new Error(r.error || 'node did not answer');
    return (r.data?.state as any) || 'missing';
  }
  if (v.engine === 'docker') {
    const r = await run('docker', ['inspect', '-f', '{{.State.Running}}', v.instanceName], 10000);
    if (r.code !== 0) return 'missing';
    return r.stdout.trim() === 'true' ? 'running' : 'stopped';
  }
  const r = await run(lxcCli(v), ['list', v.instanceName, '--format', 'csv', '-c', 'ns'], 10000);
  if (r.code !== 0) return 'missing';
  const line = r.stdout.split('\n').find((l) => l.split(',')[0] === v.instanceName);
  if (!line) return 'missing';
  return /RUNNING/i.test(line) ? 'running' : 'stopped';
}

// ---------- create ----------
const SETUP_SCRIPT = [
  // copy default shell files into /root (it is the mounted, empty server folder at first)
  'for f in .bashrc .profile; do [ -f /root/$f ] || cp /etc/skel/$f /root/$f 2>/dev/null || true; done',
  // load /root/.env (Env & Variables tab) in every login shell
  "mkdir -p /etc/profile.d && printf '%s\\n' '[ -f /root/.env ] && { set -a; . /root/.env 2>/dev/null; set +a; }' > /etc/profile.d/aether-env.sh",
  'grep -q aether-env /root/.bashrc 2>/dev/null || echo \'[ -f /etc/profile.d/aether-env.sh ] && . /etc/profile.d/aether-env.sh\' >> /root/.bashrc',
  'true',
].join('; ');

// LXCFS gives every container its own /proc/meminfo, cpuinfo, uptime ... so `free -h`, `htop`, `nproc`
// show the VPS limits (4 GB) instead of the host (27 GB). LXC/Incus does this by itself.
function lxcfsMounts(): string[] {
  const base = '/var/lib/lxcfs/proc';
  if (!fs.existsSync(path.join(base, 'meminfo'))) return [];
  const out: string[] = [];
  for (const f of ['meminfo', 'cpuinfo', 'stat', 'uptime', 'loadavg', 'diskstats', 'swaps']) {
    if (fs.existsSync(path.join(base, f))) out.push('-v', `${base}/${f}:/proc/${f}:rw`);
  }
  if (fs.existsSync('/var/lib/lxcfs/sys/devices/system/cpu/online')) out.push('-v', '/var/lib/lxcfs/sys/devices/system/cpu/online:/sys/devices/system/cpu/online:rw');
  return out;
}

async function createInstance(server: Server, v: VpsInfo) {
  const lim = server.limits || ({} as any);
  const ram = Math.max(128, lim.ramMB || 1024);
  const cpus = Math.max(0.1, lim.cpuCores || 1);
  const disk = Math.max(1, lim.diskGB || 10);

  if (isRemoteVps(v)) {
    await log(server.id, `[AetherVPS]: Creating ${v.engine === 'vm' ? 'KVM VM' : 'LXC container'} on the connected node (first time downloads the OS image)...`);
    await withHeartbeat(server.id, 'Node is creating the VPS', nodeDo(server, v, 'create', { ram, cpus, disk, setup: SETUP_SCRIPT }, 30 * 60000));
    v.createdAt = new Date().toISOString();
    return;
  }
  const dir = serverDir(server.id);

  if (v.engine === 'docker') {
    if (!lxcfsMounts().length) await log(server.id, `[AetherVPS/TIP]: Install lxcfs on the panel machine (apt install -y lxcfs) so free/htop/nproc inside the VPS show the VPS limits instead of the whole machine.`);
    if ((await run('docker', ['image', 'inspect', v.image], 15000)).code !== 0) {
      await log(server.id, `[AetherVPS]: Downloading image ${v.image} (first time only)...`);
      await withHeartbeat(server.id, `Downloading ${v.image}`, must('docker', ['pull', v.image], 15 * 60000));
    }
    const args = [
      'run', '-d', '--name', v.instanceName, '--hostname', v.hostname,
      '--restart', 'unless-stopped',
      '--memory', `${ram}m`, '--memory-swap', `${ram}m`, '--cpus', String(cpus),
      '--pids-limit', '1024',
      ...lxcfsMounts(),
      '-v', `${dir}:/root`, '-w', '/root',
      '-e', 'TERM=xterm-256color', '-e', 'LANG=C.UTF-8',
      '--label', `aetherpanel.server=${server.id}`,
      '--entrypoint', '/bin/sh', v.image,
      '-c', 'trap "exit 0" TERM INT; while :; do sleep 3600 & wait $!; done',
    ];
    // disk quota only works on overlay2 + xfs(pquota); try it, fall back without
    let r = await run('docker', ['run', '--storage-opt', `size=${disk}G`, ...args.slice(1)], 120000);
    if (r.code !== 0) {
      await run('docker', ['rm', '-f', v.instanceName], 20000);
      r = await run('docker', args, 120000);
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-2).join(' '));
    }
  } else {
    const cli = lxcCli(v);
    await log(server.id, `[AetherVPS]: Creating ${cli} instance from ${v.image} (first time can take a few minutes)...`);
    // image sources: incus has "images:", snap LXD only has "ubuntu:" for Ubuntu
    const ver = (v.os.match(/ubuntu-(\d+\.\d+)/) || [])[1];
    const sources = [v.image];
    if (cli === 'lxc' && ver) sources.unshift(`ubuntu:${ver}`);
    let r: RunResult = { code: 1, stdout: '', stderr: 'no image source' };
    for (const img of [...new Set(sources)]) {
      const base = ['launch', img, v.instanceName, ...(v.engine === 'vm' ? ['--vm'] : []), '-c', `limits.memory=${ram}MiB`, '-c', `limits.cpu=${Math.max(1, Math.ceil(cpus))}`,
        ...(v.engine === 'vm' ? [] : ['-c', 'security.nesting=true']), '-c', 'boot.autostart=true'];
      r = await withHeartbeat(server.id, `Downloading ${img} and creating the container (first time takes a few minutes)`, run(cli, [...base, '-d', `root,size=${disk}GiB`], 25 * 60000));
      if (r.code !== 0 && /size|device|root|pool|quota/i.test(r.stderr + r.stdout)) {
        await log(server.id, `[AetherVPS/WARN]: Disk size limit not supported by this storage pool - creating without it.`);
        await run(cli, ['delete', '--force', v.instanceName], 60000);
        r = await withHeartbeat(server.id, `Creating the container`, run(cli, base, 25 * 60000));
      }
      if (r.code === 0) { v.image = img; break; }
      await log(server.id, `[AetherVPS/WARN]: ${img} failed: ${(r.stderr || r.stdout || 'timeout').trim().split('\n').slice(-2).join(' ')}`);
      await run(cli, ['delete', '--force', v.instanceName], 60000);
    }
    if (r.code !== 0) throw new Error(`LXC create failed: ${(r.stderr || r.stdout || 'timed out after 25 minutes').trim().split('\n').slice(-2).join(' ')} - check on the server: ${cli} list ; ${cli} image list ; ${cli} network list`);
    if (cpus < 1 && v.engine !== 'vm') await run(cli, ['config', 'set', v.instanceName, 'limits.cpu.allowance', `${Math.round(cpus * 100)}%`], 20000);
    // server folder -> /root (shift=true maps file owners for unprivileged containers)
    let m = await run(cli, ['config', 'device', 'add', v.instanceName, 'aetherroot', 'disk', `source=${dir}`, 'path=/root', 'shift=true'], 60000);
    if (m.code !== 0) m = await run(cli, ['config', 'device', 'add', v.instanceName, 'aetherroot', 'disk', `source=${dir}`, 'path=/root'], 60000);
    if (m.code !== 0) await log(server.id, `[AetherVPS/WARN]: Could not mount the file manager folder into /root: ${m.stderr.trim()}`);
    // wait for the instance to come up
    for (let i = 0; i < (v.engine === 'vm' ? 120 : 30); i++) { if ((await run(cli, ['exec', v.instanceName, '--', 'true'], 10000)).code === 0) break; await new Promise((r2) => setTimeout(r2, 1000)); }
  }
  await execInVps(v, SETUP_SCRIPT, 60000).catch(() => {});
  v.createdAt = new Date().toISOString();
}

// ---------- power ----------
export async function startVps(server: Server): Promise<boolean> {
  const v = (server as any).vps as VpsInfo;
  if (!v) return false;
  if (creating.has(server.id)) {
    await log(server.id, `[AetherVPS]: This VPS is still being created - please wait, progress is shown here.`);
    return true;
  }
  creating.add(server.id);
  try { return await startVpsInner(server, v); } finally { creating.delete(server.id); }
}

async function startVpsInner(server: Server, v: VpsInfo): Promise<boolean> {
  await setStatus(server, 'starting');
  try {
    if (!isRemoteVps(v)) {
      const eng = await detectVpsEngines(true);
      if (v.engine === 'docker' && !eng.docker) throw new Error('Docker is not installed or not running on this machine (install: curl -fsSL https://get.docker.com | sh)');
      if (isIncus(v)) {
        if (!eng.lxc) throw new Error('LXC/Incus is not installed on this machine (install incus and run "incus admin init --minimal")');
        if (!v.cli) v.cli = eng.lxc;
        if (v.engine === 'vm' && !fs.existsSync('/dev/kvm')) throw new Error('KVM is not available on this machine (/dev/kvm missing) - use an LXC container instead');
      }
    }
    const state = await vpsState(v);
    if (state === 'missing') {
      await setStatus(server, 'installing');
      await log(server.id, `[AetherVPS]: Creating ${v.engine === 'docker' ? 'Docker' : v.engine === 'vm' ? 'KVM VM' : 'LXC'} VPS '${v.hostname}' (${VPS_OS[v.os]?.label || v.os})...`);
      await createInstance(server, v);
    } else if (state === 'stopped') {
      if (isRemoteVps(v)) await nodeDo(server, v, 'start', {}, 180000);
      else if (v.engine === 'docker') await must('docker', ['start', v.instanceName], 60000);
      else await must(lxcCli(v), ['start', v.instanceName], 120000);
    }
    if (!server.startup) (server as any).startup = {};
    server.startup!.lastStartedAt = new Date().toISOString() as any;
    await setStatus(server, 'running');
    await log(server.id, `[AetherVPS]: VPS is running.`);
    try { // someone has the terminal open -> give them a shell right away
      const t = await import('./vpsTerminal');
      const s = t.getTerminalSession(server.id);
      if (s.listeners.size && !s.alive) s.start(v);
    } catch {}
    return true;
  } catch (e: any) {
    await log(server.id, `[AetherVPS/ERROR]: ${e.message}`);
    if (!server.startup) (server as any).startup = {};
    (server.startup as any).lastCrashReason = e.message;
    await setStatus(server, 'error', { error: e.message });
    return false;
  }
}

export async function stopVps(server: Server, force = false): Promise<boolean> {
  const v = (server as any).vps as VpsInfo;
  if (!v) return false;
  await setStatus(server, 'stopping');
  try {
    const { closeTerminalSession } = await import('./vpsTerminal');
    closeTerminalSession(server.id, force ? 'VPS killed' : 'VPS stopped');
  } catch {}
  if (isRemoteVps(v)) {
    try { await nodeDo(server, v, force ? 'kill' : 'stop', {}, 120000); }
    catch (e: any) { await log(server.id, `[AetherVPS/WARN]: ${e.message}`); }
  } else if (v.engine === 'docker') await run('docker', force ? ['kill', v.instanceName] : ['stop', '-t', '15', v.instanceName], 60000);
  else {
    const r = await run(lxcCli(v), ['stop', v.instanceName, ...(force ? ['--force'] : ['--timeout', '30'])], 90000);
    if (r.code !== 0 && !force) await run(lxcCli(v), ['stop', v.instanceName, '--force'], 60000);
  }
  if (!server.startup) (server as any).startup = {};
  (server.startup as any).lastStoppedAt = new Date().toISOString();
  await setStatus(server, 'stopped');
  await log(server.id, `[AetherVPS]: VPS ${force ? 'killed' : 'stopped'}.`);
  return true;
}

export async function destroyVps(server: any): Promise<void> {
  const v = server?.vps as VpsInfo | undefined;
  if (!v) return;
  try { (await import('./vpsTerminal')).closeTerminalSession(server.id, 'VPS deleted'); } catch {}
  if (isRemoteVps(v)) { await nodeDo(server, v, 'delete', {}, 120000).catch(() => {}); return; }
  if (v.engine === 'docker') await run('docker', ['rm', '-f', v.instanceName], 60000);
  else await run(lxcCli(v), ['delete', '--force', v.instanceName], 120000);
}

// ---------- exec / terminal ----------
export async function execInVps(v: VpsInfo, command: string, timeoutMs = 120000): Promise<RunResult> {
  if (isRemoteVps(v)) {
    const r = await sendNodeJob(v.nodeId!, 'exec', { instanceName: v.instanceName, command, timeoutMs }, timeoutMs + 15000);
    return { code: r.ok ? (r.data?.code ?? 0) : 1, stdout: r.output || '', stderr: r.ok ? '' : (r.error || '') };
  }
  if (v.engine === 'docker') return run('docker', ['exec', v.instanceName, 'sh', '-lc', command], timeoutMs);
  return run(lxcCli(v), ['exec', v.instanceName, '--', 'sh', '-lc', command], timeoutMs);
}

/** command for an interactive login shell (bash if present, else sh) */
export function terminalCommand(v: VpsInfo): string[] {
  const shell = ['sh', '-c', 'cd /root 2>/dev/null; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi'];
  if (v.engine === 'docker') return ['docker', 'exec', '-it', '-e', 'TERM=xterm-256color', '-e', 'LANG=C.UTF-8', v.instanceName, ...shell];
  return [lxcCli(v), 'exec', v.instanceName, '-t', '--env', 'TERM=xterm-256color', '--env', 'LANG=C.UTF-8', '--', ...shell];
}

/** used by schedules / "send command": runs the command and writes the output to the terminal */
export async function runVpsCommand(server: Server, command: string): Promise<string> {
  const v = (server as any).vps as VpsInfo;
  if (!v) return 'Not a VPS';
  if (server.status !== 'running') return 'VPS is offline. Start it to run commands.';
  const r = await execInVps(v, command, 10 * 60000);
  const out = (r.stdout + r.stderr).trimEnd();
  try {
    (await import('./vpsTerminal')).writeToTerminalLog(server.id,
      `\r\n\x1b[36m[schedule]\x1b[0m $ ${command}\r\n${out.replace(/\r?\n/g, '\r\n')}${out ? '\r\n' : ''}\x1b[90m(exit ${r.code})\x1b[0m\r\n`);
  } catch {}
  await log(server.id, `[AetherVPS]: $ ${command} (exit ${r.code})`);
  return out || `exit ${r.code}`;
}

// ---------- live stats (used by Monitoring + header) ----------
const stats = new Map<string, { cpuPercent: number; ramMB: number; at: number }>();
const lxcCpu = new Map<string, { ns: number; at: number }>();
export function getVpsStats(serverId: string) {
  const s = stats.get(serverId);
  return s && Date.now() - s.at < 30000 ? s : null;
}
const toMB = (txt: string) => {
  const m = /([\d.]+)\s*([KMGT]?i?B)/i.exec(txt || '');
  if (!m) return 0;
  const n = parseFloat(m[1]); const u = m[2].toUpperCase();
  return u.startsWith('G') ? n * 1024 : u.startsWith('M') ? n : u.startsWith('K') ? n / 1024 : u.startsWith('T') ? n * 1048576 : n / 1048576;
};

let poller: NodeJS.Timeout | null = null;
let polling = false;
async function pollStats() {
  if (polling) return;
  polling = true;
  try {
    const db = await getDb();
    const list = db.servers.filter((s: any) => s.vps && !s.vps.remote && s.status === 'running');
    const dockerOnes = list.filter((s: any) => s.vps.engine === 'docker');
    if (dockerOnes.length) {
      const r = await run('docker', ['stats', '--no-stream', '--format', '{{.Name}};{{.CPUPerc}};{{.MemUsage}}', ...dockerOnes.map((s: any) => s.vps.instanceName)], 20000);
      for (const line of r.stdout.split('\n')) {
        const [name, cpu, mem] = line.split(';');
        const srv: any = dockerOnes.find((s: any) => s.vps.instanceName === name);
        if (!srv) continue;
        const cpuPercent = +(parseFloat(cpu) || 0).toFixed(1);
        const ramMB = +toMB((mem || '').split('/')[0]).toFixed(1);
        stats.set(srv.id, { cpuPercent, ramMB, at: Date.now() });
        srv.cpuUsage = cpuPercent; srv.ramUsageMB = ramMB;
      }
    }
    for (const srv of list.filter((s: any) => s.vps.engine === 'lxc' || s.vps.engine === 'vm') as any[]) {
      const r = await run(lxcCli(srv.vps), ['query', `/1.0/instances/${srv.vps.instanceName}/state`], 10000);
      if (r.code !== 0) continue;
      try {
        const st = JSON.parse(r.stdout);
        const ramMB = +((st.memory?.usage || 0) / 1048576).toFixed(1);
        const ns = st.cpu?.usage || 0; const now = Date.now();
        const prev = lxcCpu.get(srv.id);
        let cpuPercent = 0;
        if (prev && now > prev.at) cpuPercent = +Math.max(0, ((ns - prev.ns) / 1e6) / (now - prev.at) * 100).toFixed(1);
        lxcCpu.set(srv.id, { ns, at: now });
        stats.set(srv.id, { cpuPercent, ramMB, at: now });
        srv.cpuUsage = cpuPercent; srv.ramUsageMB = ramMB;
      } catch {}
    }
  } catch {} finally { polling = false; }
}

/** boot: sync saved status with the real container state, start stats poller */
export async function initVpsService() {
  if (poller) return;
  try {
    const db = await getDb();
    const vpsList = db.servers.filter((s: any) => s.vps);
    if (vpsList.length) {
      const eng = await detectVpsEngines(true);
      for (const s of vpsList as any[]) {
        if (s.vps.remote) { if (s.status === 'installing' || s.status === 'starting') s.status = 'stopped'; continue; } // node reports the real state
        if ((s.vps.engine === 'lxc' || s.vps.engine === 'vm') && !s.vps.cli && eng.lxc) s.vps.cli = eng.lxc;
        const st = await vpsState(s.vps).catch(() => 'missing');
        const want = st === 'running' ? 'running' : 'stopped';
        if (s.status !== want) s.status = want; // also clears an 'installing' left over from a panel restart
      }
      saveDbSync();
    }
  } catch (e: any) { console.error('[AetherVPS] boot sync failed:', e.message); }
  poller = setInterval(pollStats, 5000);
  if (poller.unref) poller.unref();
}

// ---------- remote nodes: states + stats arrive with the node heartbeat ----------
const remoteCpu = new Map<string, { ns: number; at: number }>();
export function applyRemoteVpsStates(nodeId: string, servers: any[], states: { name: string; state: string; cpuNs?: number; memBytes?: number }[]) {
  const byName = new Map(states.map((x) => [x.name, x]));
  for (const srv of servers) {
    const v = srv.vps as VpsInfo | undefined;
    if (!v || !v.remote || v.nodeId !== nodeId) continue;
    if (creating.has(srv.id) || ['installing', 'starting', 'stopping'].includes(srv.status)) continue;
    const st = byName.get(v.instanceName);
    if (!st) continue;
    const running = /running/i.test(st.state);
    srv.status = running ? 'running' : 'stopped';
    if (running) {
      const now = Date.now();
      const prev = remoteCpu.get(srv.id);
      let cpuPercent = 0;
      if (prev && st.cpuNs && now > prev.at) cpuPercent = +Math.max(0, ((st.cpuNs - prev.ns) / 1e6) / (now - prev.at) * 100).toFixed(1);
      if (st.cpuNs) remoteCpu.set(srv.id, { ns: st.cpuNs, at: now });
      const ramMB = +((st.memBytes || 0) / 1048576).toFixed(1);
      stats.set(srv.id, { cpuPercent, ramMB, at: now });
      srv.cpuUsage = cpuPercent; srv.ramUsageMB = ramMB;
    } else { srv.cpuUsage = 0; srv.ramUsageMB = 0; }
  }
}

/** progress line sent by a node agent while it works on a job */
export function nodeProgress(serverId: string, line: string) { log(serverId, `[Node]: ${line}`); }
