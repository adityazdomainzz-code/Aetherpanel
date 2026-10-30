#!/usr/bin/env node
// AetherNode agent - turns this machine into a VPS node of an AetherPanel.
// Runs VPS as Incus LXC containers or KVM virtual machines. Connects OUT to the panel
// (long-poll + websocket), so the node works behind NAT and without a public IPv4.
// Config: /etc/aethernode/config.json  {panelUrl, nodeId, daemonToken}
'use strict';
const fs = require('fs');
const os = require('os');
const { execFile, spawn, execFileSync } = require('child_process');

const VERSION = '2.2.0';
const CFG_FILE = process.env.AETHERNODE_CONFIG || '/etc/aethernode/config.json';
const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
const PANEL = String(cfg.panelUrl).replace(/\/+$/, '');
const TOKEN = cfg.daemonToken;
const log = (...a) => console.log(new Date().toISOString(), '[aethernode]', ...a);

let HAS_DOCKER = false;
try { execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore', timeout: 15000 }); HAS_DOCKER = true; } catch {}

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

// ---------- OS image download (own downloader: real progress %, resume, stall detection, mirror fallback) ----------
// "incus launch images:..." shows no progress and can hang for ever on a slow/blocked link; here we download the
// image files ourselves, import them once as a local alias (aether/<os>[-vm]) and every next VPS starts instantly.
const IMG_DISTRO = { 'ubuntu-22.04': 'ubuntu/jammy', 'ubuntu-24.04': 'ubuntu/noble', 'debian-12': 'debian/bookworm', 'alpine-3.20': 'alpine/3.20' };
const IMG_MIRRORS = (process.env.AETHER_IMAGE_MIRRORS || 'https://images.linuxcontainers.org,https://mirrors.tuna.tsinghua.edu.cn/lxc-images,https://mirror.nju.edu.cn/lxc-images')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const IMG_DIR = '/var/tmp/aether-images';

async function imgDownload(url, dest, say, label) {
  const fsp = require('fs');
  for (let attempt = 1; attempt <= 4; attempt++) {
    let have = 0;
    try { have = fsp.statSync(dest + '.part').size; } catch {}
    const ctrl = new AbortController();
    let stall = setTimeout(() => ctrl.abort(), 60000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: have ? { Range: `bytes=${have}-` } : {} });
      if (r.status === 404) throw Object.assign(new Error('404'), { notFound: true });
      if (r.status === 416) { fsp.renameSync(dest + '.part', dest); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (r.status !== 206) have = 0;
      const total = have + Number(r.headers.get('content-length') || 0);
      const out = fsp.createWriteStream(dest + '.part', { flags: have ? 'a' : 'w' });
      let got = have, lastSay = Date.now(), lastGot = got, lastT = Date.now();
      for await (const chunk of r.body) {
        clearTimeout(stall); stall = setTimeout(() => ctrl.abort(), 60000);
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok));
        const now = Date.now();
        if (now - lastSay > 5000) {
          const speed = (got - lastGot) / ((now - lastT) / 1000);
          say(`Downloading ${label}: ${total ? Math.floor((got / total) * 100) + '% ' : ''}(${(got / 1048576).toFixed(0)}${total ? '/' + (total / 1048576).toFixed(0) : ''} MB, ${(speed / 1048576).toFixed(1)} MB/s)`);
          lastSay = now; lastGot = got; lastT = now;
        }
      }
      await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
      clearTimeout(stall);
      if (total && got < total) throw new Error('connection closed early');
      fsp.renameSync(dest + '.part', dest);
      return;
    } catch (e) {
      clearTimeout(stall);
      if (e && e.notFound) throw e;
      const why = e && e.name === 'AbortError' ? 'no data for 60s' : (e && (e.cause && e.cause.code || e.message)) || 'error';
      say(`${label}: download problem (${why}) - retry ${attempt}/4`);
      if (attempt === 4) throw new Error(`${label}: ${why}`);
      await new Promise((ok) => setTimeout(ok, 3000));
    }
  }
}

/** returns a local image alias ready for "launch", or null (caller falls back to images:...) */
async function ensureLocalImage(run, cli, osKey, vm, say) {
  const fsp = require('fs');
  const alias = `aether/${osKey}${vm ? '-vm' : ''}`;
  if ((await run(cli, ['image', 'info', alias], 20000)).code === 0) { say(`Using cached image ${alias}`); return alias; }
  const distro = IMG_DISTRO[osKey];
  if (!distro) return null;
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const metaName = cli === 'lxc' ? 'lxd.tar.xz' : 'incus.tar.xz';
  const dataName = vm ? 'disk.qcow2' : 'rootfs.squashfs';
  fsp.mkdirSync(IMG_DIR, { recursive: true });
  for (const mirror of IMG_MIRRORS) {
    const host = mirror.replace(/^https?:\/\//, '').split('/')[0];
    try {
      const listUrl = `${mirror}/images/${distro}/${arch}/default/`;
      const lr = await fetch(listUrl, { signal: AbortSignal.timeout(20000) });
      if (!lr.ok) throw new Error(`image list HTTP ${lr.status}`);
      const builds = [...new Set([...(await lr.text()).matchAll(/href="\.?\/?(\d{8}_\d{2}(?::|%3A)\d{2})\/?"/g)].map((m) => m[1]))].sort().reverse();
      if (!builds.length) throw new Error('no builds listed');
      for (const b of builds.slice(0, 3)) {
        const base = `${listUrl}${b}/`;
        const tag = `${osKey}${vm ? '-vm' : ''}-${decodeURIComponent(b).replace(/[^0-9_]/g, '')}`;
        const meta = `${IMG_DIR}/${tag}-${metaName}`, data = `${IMG_DIR}/${tag}-${dataName}`;
        try {
          say(`Downloading ${osKey} ${vm ? 'VM' : 'container'} image from ${host} (build ${decodeURIComponent(b)})`);
          if (!fsp.existsSync(meta)) await imgDownload(base + metaName, meta, say, metaName);
          if (!fsp.existsSync(data)) await imgDownload(base + dataName, data, say, dataName);
        } catch (e) { if (e && e.notFound) { for (const f of [meta, data]) { try { fsp.unlinkSync(f); } catch {} } say(`build ${decodeURIComponent(b)} has no ${dataName} - trying an older one`); continue; } throw e; }
        say(`Importing the image into ${cli} (one time)...`);
        const im = await run(cli, ['image', 'import', meta, data, '--alias', alias], 15 * 60000);
        if (im.code !== 0 && !/already exists/i.test(im.stderr)) throw new Error(`image import failed: ${lastLinesOf(im.stderr || im.stdout)}`);
        for (const f of [meta, data]) { try { fsp.unlinkSync(f); } catch {} }
        say(`Image ready: ${alias}`);
        return alias;
      }
      throw new Error(`no ${dataName} found in the last builds`);
    } catch (e) {
      say(`Mirror ${host} failed: ${(e && e.message) || e} - trying the next mirror`);
    }
  }
  say(`All image mirrors failed - falling back to "${cli} launch images:..." (check internet / DNS on this machine: curl -I https://images.linuxcontainers.org)`);
  return null;
}
const lastLinesOf = (t) => String(t || '').trim().split('\n').slice(-2).join(' ');


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
const toBytes = (txt) => {
  const m = /([\d.]+)\s*([KMGT]?i?B)/i.exec(txt || '');
  if (!m) return 0;
  const n = parseFloat(m[1]); const u = m[2].toUpperCase();
  const mul = u.startsWith('T') ? 1024 ** 4 : u.startsWith('G') ? 1024 ** 3 : u.startsWith('M') ? 1024 ** 2 : u.startsWith('K') ? 1024 : 1;
  return Math.round(n * mul);
};
async function listDocker() {
  if (!HAS_DOCKER) return [];
  const ps = await run('docker', ['ps', '-a', '--filter', 'name=aether-vps-', '--format', '{{.Names}};{{.State}}'], 20000);
  if (ps.code !== 0) return [];
  const list = ps.stdout.split('\n').filter(Boolean).map((l) => { const [name, state] = l.split(';'); return { name, state: String(state || '').toLowerCase(), cpuPercent: 0, memBytes: 0 }; });
  const running = list.filter((x) => x.state === 'running');
  if (running.length) {
    const st = await run('docker', ['stats', '--no-stream', '--format', '{{.Name}};{{.CPUPerc}};{{.MemUsage}}', ...running.map((x) => x.name)], 20000);
    for (const line of st.stdout.split('\n')) {
      const [name, cpu, mem] = line.split(';');
      const x = list.find((y) => y.name === name);
      if (x) { x.cpuPercent = parseFloat(cpu) || 0; x.memBytes = toBytes((mem || '').split('/')[0]); }
    }
  }
  return list;
}
async function listInstances() {
  const out = await listDocker();
  const r = await run(CLI, ['list', '--format', 'json'], 30000);
  if (r.code !== 0) return out;
  try {
    return out.concat(JSON.parse(r.stdout).filter((i) => /^avps-/.test(i.name)).map((i) => ({
      name: i.name,
      state: String(i.status || '').toLowerCase(),
      cpuNs: i.state && i.state.cpu ? i.state.cpu.usage : 0,
      memBytes: i.state && i.state.memory ? i.state.memory.usage : 0,
    })));
  } catch { return out; }
}
const isDockerJob = (job) => job.payload && job.payload.engine === 'docker';
async function dockerState(name) {
  const r = await run('docker', ['inspect', '-f', '{{.State.Running}}', name], 15000);
  if (r.code !== 0) return 'missing';
  return r.stdout.trim() === 'true' ? 'running' : 'stopped';
}
function lxcfsMounts() {
  const base = '/var/lib/lxcfs/proc';
  if (!fs.existsSync(base + '/meminfo')) return [];
  const out = [];
  for (const f of ['meminfo', 'cpuinfo', 'stat', 'uptime', 'loadavg', 'diskstats', 'swaps']) if (fs.existsSync(`${base}/${f}`)) out.push('-v', `${base}/${f}:/proc/${f}:rw`);
  return out;
}
const DOCKER_IMAGES = { 'ubuntu-22.04': 'ubuntu:22.04', 'ubuntu-24.04': 'ubuntu:24.04', 'debian-12': 'debian:12', 'alpine-3.20': 'alpine:3.20' };
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

async function dockerCreate(job) {
  const p = job.payload;
  if (!HAS_DOCKER) {
    try { execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15000 }); HAS_DOCKER = true; } catch {}
    if (!HAS_DOCKER) return { ok: false, error: 'Docker is not installed on this node (curl -fsSL https://get.docker.com | sh, then: systemctl restart aethernode)' };
  }
  const existing = await dockerState(p.instanceName);
  if (existing === 'running') return { ok: true, output: 'already running' };
  if (existing === 'stopped') { const st = await run('docker', ['start', p.instanceName], 60000); return st.code === 0 ? { ok: true, output: 'started' } : { ok: false, error: lastLines(st.stderr || st.stdout) }; }
  const image = DOCKER_IMAGES[p.os] || 'ubuntu:22.04';
  const ram = Math.max(128, +p.ram || 1024);
  const cpus = Math.max(0.1, +p.cpus || 1);
  const disk = Math.max(1, +p.disk || 10);
  if ((await run('docker', ['image', 'inspect', image], 15000)).code !== 0) {
    progress(job.id, `Downloading ${image}...`);
    const tick = setInterval(() => progress(job.id, 'still downloading the image...'), 20000);
    const pull = await run('docker', ['pull', image], 15 * 60000);
    clearInterval(tick);
    if (pull.code !== 0) return { ok: false, error: `docker pull ${image} failed: ${lastLines(pull.stderr || pull.stdout)}` };
  }
  const args = ['run', '-d', '--name', p.instanceName, '--hostname', p.hostname, '--restart', 'unless-stopped',
    '--memory', `${ram}m`, '--memory-swap', `${ram}m`, '--cpus', String(cpus), '--pids-limit', '1024',
    ...lxcfsMounts(), '-v', `${p.instanceName}-root:/root`, '-w', '/root',
    '-e', 'TERM=xterm-256color', '-e', 'LANG=C.UTF-8', '--label', `aetherpanel.server=${p.serverId}`,
    '--entrypoint', '/bin/sh', image, '-c', 'trap "exit 0" TERM INT; while :; do sleep 3600 & wait $!; done'];
  let r = await run('docker', ['run', '--storage-opt', `size=${disk}G`, ...args.slice(1)], 120000);
  if (r.code !== 0) {
    await run('docker', ['rm', '-f', p.instanceName], 30000);
    r = await run('docker', args, 120000);
  }
  if (r.code !== 0) return { ok: false, error: `docker run failed: ${lastLines(r.stderr || r.stdout)}` };
  if (p.setup) await run('docker', ['exec', p.instanceName, 'sh', '-c', p.setup], 60000);
  if (!lxcfsMounts().length) progress(job.id, 'Tip: apt install -y lxcfs on the node so free/htop inside Docker VPS show the VPS limits');
  return { ok: true, output: 'created' };
}

const handlers = {
  async state(job) { return { ok: true, data: { state: isDockerJob(job) ? await dockerState(job.payload.instanceName) : await stateOf(job.payload.instanceName) } }; },

  async create(job) {
    const p = job.payload;
    if (p.engine === 'docker') return dockerCreate(job);
    const ram = Math.max(128, +p.ram || 1024);
    const cpus = Math.max(1, Math.ceil(+p.cpus || 1));
    const disk = Math.max(1, +p.disk || 10);
    const vm = p.engine === 'vm';
    if (vm && !fs.existsSync('/dev/kvm')) return { ok: false, error: 'This node has no KVM (/dev/kvm missing) - create an LXC container instead.' };
    const existing = await stateOf(p.instanceName);
    if (existing === 'running') return { ok: true, output: 'already running' };
    if (existing === 'stopped') { const st = await run(CLI, ['start', p.instanceName], 180000); return st.code === 0 ? { ok: true, output: 'started' } : { ok: false, error: lastLines(st.stderr || st.stdout) }; }

    const ver = (String(p.os || '').match(/ubuntu-(\d+\.\d+)/) || [])[1];
    const sources = [p.image];
    if (CLI === 'lxc' && ver) sources.unshift(`ubuntu:${ver}`);
    const local = await ensureLocalImage(run, CLI, String(p.os || 'ubuntu-22.04'), vm, (l) => progress(job.id, l)).catch((e) => { progress(job.id, `image download error: ${e.message}`); return null; });
    if (local) sources.unshift(local);
    let r = { code: 1, stdout: '', stderr: 'no image' };
    for (const img of [...new Set(sources)]) {
      progress(job.id, img.startsWith('aether/') ? `Creating the ${vm ? 'VM' : 'container'} from ${img}...` : `Downloading ${img} and creating the ${vm ? 'VM' : 'container'}...`);
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
    if (isDockerJob(job)) { const d = await run('docker', ['start', job.payload.instanceName], 60000); return d.code === 0 ? { ok: true } : { ok: false, error: lastLines(d.stderr || d.stdout) }; }
    const r = await run(CLI, ['start', job.payload.instanceName], 180000);
    return r.code === 0 || /already running/i.test(r.stderr) ? { ok: true } : { ok: false, error: lastLines(r.stderr || r.stdout) };
  },
  async stop(job) {
    if (isDockerJob(job)) { await run('docker', ['stop', '-t', '15', job.payload.instanceName], 60000); return { ok: true }; }
    let r = await run(CLI, ['stop', job.payload.instanceName, '--timeout', '30'], 90000);
    if (r.code !== 0 && !/not running/i.test(r.stderr)) r = await run(CLI, ['stop', job.payload.instanceName, '--force'], 60000);
    return r.code === 0 || /not running/i.test(r.stderr) ? { ok: true } : { ok: false, error: lastLines(r.stderr || r.stdout) };
  },
  async kill(job) {
    if (isDockerJob(job)) { await run('docker', ['kill', job.payload.instanceName], 30000); return { ok: true }; }
    const r = await run(CLI, ['stop', job.payload.instanceName, '--force'], 60000);
    return r.code === 0 || /not running/i.test(r.stderr) ? { ok: true } : { ok: false, error: lastLines(r.stderr || r.stdout) };
  },
  async delete(job) {
    if (isDockerJob(job)) { await run('docker', ['rm', '-f', job.payload.instanceName], 60000); return { ok: true }; }
    const r = await run(CLI, ['delete', '--force', job.payload.instanceName], 180000);
    return r.code === 0 || /not found/i.test(r.stderr) ? { ok: true } : { ok: false, error: lastLines(r.stderr || r.stdout) };
  },
  async exec(job) {
    const r = isDockerJob(job)
      ? await run('docker', ['exec', job.payload.instanceName, 'sh', '-lc', job.payload.command], Math.min(+job.payload.timeoutMs || 600000, 3600000))
      : await run(CLI, ['exec', job.payload.instanceName, '--', 'sh', '-lc', job.payload.command], Math.min(+job.payload.timeoutMs || 600000, 3600000));
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
  const cmd = p.engine === 'docker'
    ? ['docker', 'exec', '-it', '-e', 'TERM=xterm-256color', '-e', 'LANG=C.UTF-8', p.instanceName, 'sh', '-c', shell]
    : [CLI, 'exec', p.instanceName, '-t', '--env', 'TERM=xterm-256color', '--env', 'LANG=C.UTF-8', '--', 'sh', '-c', shell];
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
log(`AetherNode agent ${VERSION} - panel ${PANEL} - node ${cfg.nodeId} - ${CLI}${HAS_DOCKER ? ' + docker' : ''}`);
heartbeat();
setInterval(heartbeat, 10000);
jobLoop();
process.on('unhandledRejection', (e) => log('error:', e && e.message));
