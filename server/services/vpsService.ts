// VPS hosting: every VPS is a Docker container or an LXC/Incus instance on the panel's own machine.
// The server folder (data/servers/<id>) is mounted as /root inside the VPS, so File Manager, Importer,
// Backups and the Env tab (/root/.env) all work on the VPS home folder.
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { getDb, saveDbSync } from '../db';
import { Server } from '../../src/types';

export type VpsEngine = 'docker' | 'lxc';

export interface VpsInfo {
  engine: VpsEngine;
  os: string;            // key of VPS_OS
  image: string;         // image used to create it
  instanceName: string;  // docker container / lxc instance name
  hostname: string;
  cli?: 'incus' | 'lxc'; // lxc only
  createdAt?: string;
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

export function buildVpsInfo(serverId: string, engine: VpsEngine, osKey: string, name: string): VpsInfo {
  const os = VPS_OS[osKey] ? osKey : 'ubuntu-22.04';
  const short = serverId.replace(/^srv_/, '').replace(/[^a-zA-Z0-9]/g, '').slice(-10).toLowerCase();
  const base = String(name || 'vps').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'vps';
  return {
    engine,
    os,
    image: engine === 'docker' ? VPS_OS[os].docker : VPS_OS[os].lxc,
    instanceName: engine === 'docker' ? `aether-vps-${short}` : `avps-${short}`,
    hostname: `${base}-${short.slice(-5)}`.replace(/^-/, 'vps-'),
  };
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
}
async function setStatus(server: Server, status: string, extra?: any) {
  (server as any).status = status;
  if (status !== 'running') { server.cpuUsage = 0; server.ramUsageMB = 0; }
  saveDbSync();
  try { (await import('../provider')).emitServerStatus(server.id, status, extra); } catch {}
}

// ---------- state ----------
export async function vpsState(v: VpsInfo): Promise<'running' | 'stopped' | 'missing'> {
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

async function createInstance(server: Server, v: VpsInfo) {
  const lim = server.limits || ({} as any);
  const ram = Math.max(128, lim.ramMB || 1024);
  const cpus = Math.max(0.1, lim.cpuCores || 1);
  const disk = Math.max(1, lim.diskGB || 10);
  const dir = serverDir(server.id);

  if (v.engine === 'docker') {
    if ((await run('docker', ['image', 'inspect', v.image], 15000)).code !== 0) {
      await log(server.id, `[AetherVPS]: Downloading image ${v.image} (first time only)...`);
      await must('docker', ['pull', v.image], 15 * 60000);
    }
    const args = [
      'run', '-d', '--name', v.instanceName, '--hostname', v.hostname,
      '--restart', 'unless-stopped',
      '--memory', `${ram}m`, '--memory-swap', `${ram}m`, '--cpus', String(cpus),
      '--pids-limit', '1024',
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
    const base = ['launch', v.image, v.instanceName, '-c', `limits.memory=${ram}MiB`, '-c', `limits.cpu=${Math.max(1, Math.ceil(cpus))}`,
      '-c', 'security.nesting=true', '-c', 'boot.autostart=true'];
    let r = await run(cli, [...base, '-d', `root,size=${disk}GiB`], 20 * 60000);
    if (r.code !== 0 && /size|device|root/i.test(r.stderr)) {
      await run(cli, ['delete', '--force', v.instanceName], 60000);
      r = await run(cli, base, 20 * 60000);
    }
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-2).join(' '));
    if (cpus < 1) await run(cli, ['config', 'set', v.instanceName, 'limits.cpu.allowance', `${Math.round(cpus * 100)}%`], 20000);
    // server folder -> /root (shift=true maps file owners for unprivileged containers)
    let m = await run(cli, ['config', 'device', 'add', v.instanceName, 'aetherroot', 'disk', `source=${dir}`, 'path=/root', 'shift=true'], 60000);
    if (m.code !== 0) m = await run(cli, ['config', 'device', 'add', v.instanceName, 'aetherroot', 'disk', `source=${dir}`, 'path=/root'], 60000);
    if (m.code !== 0) await log(server.id, `[AetherVPS/WARN]: Could not mount the file manager folder into /root: ${m.stderr.trim()}`);
    // wait for the instance to come up
    for (let i = 0; i < 30; i++) { if ((await run(cli, ['exec', v.instanceName, '--', 'true'], 10000)).code === 0) break; await new Promise((r2) => setTimeout(r2, 1000)); }
  }
  await execInVps(v, SETUP_SCRIPT, 60000).catch(() => {});
  v.createdAt = new Date().toISOString();
}

// ---------- power ----------
export async function startVps(server: Server): Promise<boolean> {
  const v = (server as any).vps as VpsInfo;
  if (!v) return false;
  await setStatus(server, 'starting');
  try {
    const eng = await detectVpsEngines(true);
    if (v.engine === 'docker' && !eng.docker) throw new Error('Docker is not installed or not running on this machine (install: curl -fsSL https://get.docker.com | sh)');
    if (v.engine === 'lxc') {
      if (!eng.lxc) throw new Error('LXC/Incus is not installed on this machine (install incus and run "incus admin init --minimal")');
      if (!v.cli) v.cli = eng.lxc;
    }
    const state = await vpsState(v);
    if (state === 'missing') {
      await setStatus(server, 'installing');
      await log(server.id, `[AetherVPS]: Creating ${v.engine === 'docker' ? 'Docker' : 'LXC'} VPS '${v.hostname}' (${VPS_OS[v.os]?.label || v.os})...`);
      await createInstance(server, v);
    } else if (state === 'stopped') {
      if (v.engine === 'docker') await must('docker', ['start', v.instanceName], 60000);
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
  if (v.engine === 'docker') await run('docker', force ? ['kill', v.instanceName] : ['stop', '-t', '15', v.instanceName], 60000);
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
  if (v.engine === 'docker') await run('docker', ['rm', '-f', v.instanceName], 60000);
  else await run(lxcCli(v), ['delete', '--force', v.instanceName], 120000);
}

// ---------- exec / terminal ----------
export async function execInVps(v: VpsInfo, command: string, timeoutMs = 120000): Promise<RunResult> {
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
    const list = db.servers.filter((s: any) => s.vps && s.status === 'running');
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
    for (const srv of list.filter((s: any) => s.vps.engine === 'lxc') as any[]) {
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
        if (s.vps.engine === 'lxc' && !s.vps.cli && eng.lxc) s.vps.cli = eng.lxc;
        const st = await vpsState(s.vps).catch(() => 'missing');
        const want = st === 'running' ? 'running' : 'stopped';
        if (s.status !== want && s.status !== 'installing') s.status = want;
      }
      saveDbSync();
    }
  } catch (e: any) { console.error('[AetherVPS] boot sync failed:', e.message); }
  poller = setInterval(pollStats, 5000);
  if (poller.unref) poller.unref();
}
