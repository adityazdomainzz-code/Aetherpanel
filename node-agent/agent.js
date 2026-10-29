#!/usr/bin/env node
// AetherNode agent - turns this machine into a VPS node of an AetherPanel.
// Runs VPS as Incus LXC containers or KVM virtual machines. Connects OUT to the panel
// (long-poll + websocket), so the node works behind NAT and without a public IPv4.
// Config: /etc/aethernode/config.json  {panelUrl, nodeId, daemonToken}
'use strict';
const fs = require('fs');
const os = require('os');
const { execFile, spawn, execFileSync } = require('child_process');

const VERSION = '2.0.0';
const CFG_FILE = process.env.AETHERNODE_CONFIG || '/etc/aethernode/config.json';
const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const PANEL = String(cfg.panelUrl).replace(/\/+$/, '');
const TOKEN = cfg.daemonToken;
const log = (...a) => console.log(new Date().toISOString(), '[aethernode]', ...a);

let CLI = 'incus';
try { execFileSync('incus', ['version'], { stdio: 'ignore', timeout: 10000 }); }
catch { try { execFileSync('lxc', ['version'], { stdio: 'ignore', timeout: 10000 }); CLI = 'lxc'; } catch { log('WARNING: incus is not installed - VPS cannot be created'); } }

// ---------- helpers ----------
function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || (err && !stderr ? err.message : '')) });
    });
  });
}
const lastLines = (t, n = 3) => String(t || '').trim().split('\n').slice(-n).join(' ');

async function api(method, path, body, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(PANEL + '/api/v1/node' + path, {
      method, signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'X-Daemon-Token': TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { log('panel rejected the daemon token - this node was removed or re-connected. Run install.sh again.'); }
    return j;
  } finally { clearTimeout(t); }
}

// ---------- instance info ----------
async function listInstances() {
  const r = await run(CLI, ['list', '--format', 'json'], 30000);
  if (r.code !== 0) return [];
  try {
    return JSON.parse(r.stdout).filter((i) => /^avps-/.test(i.name)).map((i) => ({
      name: i.name,
      state: String(i.status || '').toLowerCase(),
      cpuNs: i.state && i.state.cpu ? i.state.cpu.usage : 0,
      memBytes: i.state && i.state.memory ? i.state.memory.usage : 0,
    }));
  } catch { return []; }
}
async function stateOf(name) {
  const r = await run(CLI, ['list', name, '--format', 'csv', '-c', 'ns'], 15000);
  if (r.code !== 0) return 'missing';
  const line = r.stdout.split('\n').find((l) => l.split(',')[0] === name);
  if (!line) return 'missing';
  return /RUNNING/i.test(line) ? 'running' : 'stopped';
}

function diskInfo() {
  try {
    const s = fs.statfsSync('/');
    return { totalDiskGB: Math.round((s.blocks * s.bsize) / 1073741824), usedDiskGB: Math.round(((s.blocks - s.bfree) * s.bsize) / 1073741824) };
  } catch { return { totalDiskGB: 0, usedDiskGB: 0 }; }
}

// ---------- heartbeat ----------
async function heartbeat() {
  try {
    const total = Math.round(os.totalmem() / 1048576);
    const used = total - Math.round(os.freemem() / 1048576);
    const d = diskInfo();
    const vpsStates = await listInstances();
    await api('POST', '/heartbeat', {
      totalRamMB: total, ramUsageMB: used, totalCpuCores: os.cpus().length,
      cpuUsageCores: +(os.loadavg()[0] || 0).toFixed(2), totalDiskGB: d.totalDiskGB, diskUsageGB: d.usedDiskGB,
      activeContainers: vpsStates.length, vpsStates, agentVersion: VERSION,
    }, 20000);
  } catch (e) { log('heartbeat failed:', e.message); }
}

// ---------- jobs ----------
const progress = (jobId, line) => api('POST', `/jobs/${jobId}/log`, { line }, 10000).catch(() => {});
const finish = (jobId, result) => api('POST', `/jobs/${jobId}/result`, result, 30000).catch((e) => log('could not send result:', e.message));

const handlers = {
  async state(job) { return { ok: true, data: { state: await stateOf(job.payload.instanceName) } }; },

  async create(job) {
    const p = job.payload;
    const ram = Math.max(128, +p.ram || 1024);
    const cpus = Math.max(1, Math.ceil(+p.cpus || 1));
    const disk = Math.max(1, +p.disk || 10);
    const vm = p.engine === 'vm';
    if (vm && !fs.existsSync('/dev/kvm')) return { ok: false, error: 'This node has no KVM (/dev/kvm missing) - create an LXC container instead.' };
    if ((await stateOf(p.instanceName)) !== 'missing') return { ok: true, output: 'already exists' };

    const ver = (String(p.os || '').match(/ubuntu-(\d+\.\d+)/) || [])[1];
    const sources = [p.image];
    if (CLI === 'lxc' && ver) sources.unshift(`ubuntu:${ver}`);
    let r = { code: 1, stdout: '', stderr: 'no image' };
    for (const img of [...new Set(sources)]) {
      progress(job.id, `Downloading ${img} and creating the ${vm ? 'VM' : 'container'}...`);
      const base = ['launch', img, p.instanceName, ...(vm ? ['--vm'] : []), '-c', `limits.memory=${ram}MiB`, '-c', `limits.cpu=${cpus}`,
        ...(vm ? [] : ['-c', 'security.nesting=true']), '-c', 'boot.autostart=true', '-c', `user.aether.server=${p.serverId}`];
      const tick = setInterval(() => progress(job.id, 'still working (image download / first boot)...'), 20000);
      try {
        r = await run(CLI, [...base, '-d', `root,size=${disk}GiB`], 25 * 60000);
        if (r.code !== 0 && /size|device|root|pool|quota/i.test(r.stderr + r.stdout)) {
          progress(job.id, 'Storage pool does not support a disk size limit - creating without it');
          await run(CLI, ['delete', '--force', p.instanceName], 60000);
          r = await run(CLI, base, 25 * 60000);
        }
      } finally { clearInterval(tick); }
      if (r.code === 0) break;
      progress(job.id, `${img} failed: ${lastLines(r.stderr || r.stdout)}`);
      await run(CLI, ['delete', '--force', p.instanceName], 60000);
    }
    if (r.code !== 0) return { ok: false, error: `create failed: ${lastLines(r.stderr || r.stdout)} (check on the node: ${CLI} list ; ${CLI} network list ; ${CLI} storage list)` };

    progress(job.id, `Waiting for the ${vm ? 'VM' : 'container'} to boot...`);
    for (let i = 0; i < (vm ? 150 : 40); i++) {
      if ((await run(CLI, ['exec', p.instanceName, '--', 'true'], 10000)).code === 0) break;
      await new Promise((ok) => setTimeout(ok, 1000));
    }
    await run(CLI, ['exec', p.instanceName, '--', 'hostnamectl', 'set-hostname', p.hostname], 20000);
    if (p.setup) await run(CLI, ['exec', p.instanceName, '--', 'sh', '-c', p.setup], 60000);
    return { ok: true, output: 'created' };
  },

  async start(job) {
    const r = await run(CLI, ['start', job.payload.instanceName], 180000);
    return r.code === 0 || /already running/i.test(r.stderr) ? { ok: true } : { ok: false, error: lastLines(r.stderr || r.stdout) };
  },
  async stop(job) {
    let r = await run(CLI, ['stop', job.payload.instanceName, '--timeout', '30'], 90000);
    if (r.code !== 0 && !/not running/i.test(r.stderr)) r = await run(CLI, ['stop', job.payload.instanceName, '--force'], 60000);
    return r.code === 0 || /not running/i.test(r.stderr) ? { ok: true } : { ok: false, error: lastLines(r.stderr || r.stdout) };
  },
  async kill(job) {
    const r = await run(CLI, ['stop', job.payload.instanceName, '--force'], 60000);
    return r.code === 0 || /not running/i.test(r.stderr) ? { ok: true } : { ok: false, error: lastLines(r.stderr || r.stdout) };
  },
  async delete(job) {
    const r = await run(CLI, ['delete', '--force', job.payload.instanceName], 180000);
    return r.code === 0 || /not found/i.test(r.stderr) ? { ok: true } : { ok: false, error: lastLines(r.stderr || r.stdout) };
  },
  async exec(job) {
    const r = await run(CLI, ['exec', job.payload.instanceName, '--', 'sh', '-lc', job.payload.command], Math.min(+job.payload.timeoutMs || 600000, 3600000));
    return { ok: true, output: r.stdout + r.stderr, data: { code: r.code } };
  },
  async 'term-open'(job) { openTerminal(job.payload); return null; },
};

async function runJob(job) {
  const h = handlers[job.action];
  if (!h) return finish(job.id, { ok: false, error: `unknown action ${job.action}` });
  try {
    const res = await h(job);
    if (res) await finish(job.id, res);
  } catch (e) { await finish(job.id, { ok: false, error: e.message }); }
}

async function jobLoop() {
  for (;;) {
    try {
      const j = await api('GET', '/jobs?wait=20', undefined, 40000);
      for (const job of (j && j.data) || []) runJob(job); // in parallel
    } catch (e) {
      log('panel unreachable:', e.message);
      await new Promise((ok) => setTimeout(ok, 5000));
    }
  }
}

// ---------- web terminal ----------
const PTY_HELPER = `
import os, sys, pty, select, fcntl, termios, struct, signal
argv = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
def setsz(c, r):
    try: fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
    except Exception: pass
setsz(int(os.environ.get('AE_COLS', '120')), int(os.environ.get('AE_ROWS', '32')))
fds = [0, fd, 3]
buf = b''
while True:
    try: r, _, _ = select.select(fds, [], [])
    except InterruptedError: continue
    if fd in r:
        try: d = os.read(fd, 65536)
        except OSError: break
        if not d: break
        os.write(1, d)
    if 0 in r:
        d = os.read(0, 65536)
        if not d:
            try: os.kill(pid, signal.SIGHUP)
            except Exception: pass
            break
        os.write(fd, d)
    if 3 in r:
        d = os.read(3, 4096)
        if not d: fds.remove(3)
        else:
            buf += d
            while b'\\n' in buf:
                line, buf = buf.split(b'\\n', 1)
                p = line.split()
                if len(p) == 3 and p[0] == b'R': setsz(int(p[1]), int(p[2]))
try:
    os.waitpid(pid, 0)
except Exception:
    pass
`;

function openTerminal(p) {
  if (typeof WebSocket === 'undefined') { log('terminal needs Node.js 22+ (global WebSocket)'); return; }
  const shell = 'cd /root 2>/dev/null; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi';
  const cmd = [CLI, 'exec', p.instanceName, '-t', '--env', 'TERM=xterm-256color', '--env', 'LANG=C.UTF-8', '--', 'sh', '-c', shell];
  const child = spawn('python3', ['-u', '-c', PTY_HELPER, ...cmd], {
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color', AE_COLS: String(p.cols || 120), AE_ROWS: String(p.rows || 32) },
  });
  const wsUrl = PANEL.replace(/^http/, 'ws') + `/api/v1/node/term/${encodeURIComponent(p.serverId)}?token=${encodeURIComponent(TOKEN)}`;
  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  const pending = [];
  const send = (b) => { if (ws.readyState === 1) ws.send(b); else pending.push(b); };
  child.stdout.on('data', send);
  child.stderr.on('data', send);
  ws.onopen = () => { while (pending.length) ws.send(pending.shift()); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
    if (m.t === 'i' && typeof m.d === 'string') { try { child.stdin.write(m.d); } catch {} }
    else if (m.t === 'r') { try { child.stdio[3].write(`R ${m.c} ${m.r}\n`); } catch {} }
  };
  const end = () => { try { child.stdin.end(); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500); };
  ws.onclose = end;
  ws.onerror = () => { log('terminal websocket error'); };
  child.on('close', () => { try { ws.close(); } catch {} });
}

// ---------- main ----------
log(`AetherNode agent ${VERSION} - panel ${PANEL} - node ${cfg.nodeId} - ${CLI}`);
heartbeat();
setInterval(heartbeat, 10000);
jobLoop();
process.on('unhandledRejection', (e) => log('error:', e && e.message));
