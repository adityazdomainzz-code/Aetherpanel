// Persistent web terminal for VPS servers.
// One shell session per VPS lives on the panel side; its output is kept in a buffer, so leaving the page
// and coming back shows exactly what was on screen (and the shell keeps running, e.g. after "sudo su").
import { spawn, ChildProcess, execFileSync } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { terminalCommand, VpsInfo, isRemoteVps } from './vpsService';
import { fireNodeJob } from './nodeJobs';

const MAX_BUFFER = 256 * 1024; // characters kept for replay

// tiny PTY helper (python3 is on every normal Linux VPS) - gives a real terminal incl. window resize
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
    _, st = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(st) if hasattr(os, 'waitstatus_to_exitcode') else 0)
except Exception:
    sys.exit(0)
`;

let python: string | null | undefined;
function findPython(): string | null {
  if (python !== undefined) return python;
  for (const p of ['python3', 'python']) {
    try { execFileSync(p, ['-c', 'import pty'], { stdio: 'ignore', timeout: 5000 }); python = p; return p; } catch {}
  }
  python = null;
  return null;
}

type Listener = (msg: { t: 'o'; d: string } | { t: 's'; state: string }) => void;

class TerminalSession {
  buffer = '';
  child: ChildProcess | null = null;
  alive = false;
  listeners = new Set<Listener>();
  cols = 120;
  rows = 32;
  private decoder = new StringDecoder('utf8');

  constructor(public serverId: string) {}

  push(text: string) {
    if (!text) return;
    this.buffer += text;
    if (this.buffer.length > MAX_BUFFER) {
      let cut = this.buffer.length - MAX_BUFFER;
      const nl = this.buffer.indexOf('\n', cut);
      if (nl !== -1 && nl - cut < 4096) cut = nl + 1;
      this.buffer = this.buffer.slice(cut);
    }
    for (const l of this.listeners) l({ t: 'o', d: text });
  }

  state(s: string) { for (const l of this.listeners) l({ t: 's', state: s }); }

  agent: any = null;        // remote node agent websocket (VPS on a connected node)
  private bootRetries = 0;  // KVM: shell opened before the VM agent was up -> retry quietly
  private agentWait: NodeJS.Timeout | null = null;

  start(v: VpsInfo) {
    if (this.alive) return;
    if (isRemoteVps(v)) {
      // ask the node to open a shell and connect it back to /api/v1/node/term/<serverId>
      this.alive = true;
      this.child = null;
      fireNodeJob(v.nodeId!, 'term-open', { serverId: this.serverId, instanceName: v.instanceName, engine: v.engine, cols: this.cols, rows: this.rows });
      if (this.agentWait) clearTimeout(this.agentWait);
      this.agentWait = setTimeout(() => {
        if (!this.agent) {
          this.alive = false;
          this.push('\r\n\x1b[31m[the node did not open a shell - is it online? check on the node: systemctl status aethernode]\x1b[0m\r\n');
          this.state('closed');
        }
      }, 25000);
      return;
    }
    const cmd = terminalCommand(v);
    const py = findPython();
    const env = { ...process.env, TERM: 'xterm-256color', AE_COLS: String(this.cols), AE_ROWS: String(this.rows) };
    const child = py
      ? spawn(py, ['-u', '-c', PTY_HELPER, ...cmd], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env })
      : spawn('script', ['-qfc', cmd.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' '), '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.child = child;
    this.alive = true;
    this.decoder = new StringDecoder('utf8');
    const startedAt = Date.now();
    let early = '';
    const out = (b: Buffer) => {
      const t = this.decoder.write(b);
      if (v.engine === 'vm' && Date.now() - startedAt < 15000 && early.length < 2000) {
        early += t;
        if (/VM agent isn't currently running/i.test(early)) return; // hidden - we retry below
      }
      this.push(t);
    };
    child.stdout!.on('data', out);
    child.stderr!.on('data', out);
    child.on('error', (e) => this.push(`\r\n\x1b[31m[terminal error] ${e.message}\x1b[0m\r\n`));
    child.on('close', () => {
      if (this.child !== child) return;
      this.alive = false;
      this.child = null;
      if (/VM agent isn't currently running/i.test(early) && this.bootRetries < 40) {
        if (this.bootRetries++ === 0) this.push('\r\n\x1b[36m[AetherVPS]: VM is still booting - the shell opens automatically in a moment...\x1b[0m\r\n');
        this.state('ready');
        setTimeout(() => { if (!this.alive && this.listeners.size) this.start(v); }, 5000);
        return;
      }
      this.bootRetries = 0;
      this.push(this.decoder.end() + '\r\n\x1b[33m[shell closed - press Enter to open a new one]\x1b[0m\r\n');
      this.state('closed');
    });
    this.state('open');
  }

  write(data: string) {
    if (this.agent && this.alive) { try { this.agent.send(JSON.stringify({ t: 'i', d: data })); } catch {} return; }
    if (this.child && this.alive) { try { this.child.stdin!.write(data); } catch {} }
  }

  /** a node agent connected its shell for this VPS */
  attachAgent(ws: any) {
    if (this.agent) { try { this.agent.close(); } catch {} }
    if (this.agentWait) { clearTimeout(this.agentWait); this.agentWait = null; }
    this.agent = ws;
    this.alive = true;
    this.decoder = new StringDecoder('utf8');
    ws.on('message', (data: any, isBinary: boolean) => {
      if (this.agent !== ws) return;
      if (isBinary) { this.push(this.decoder.write(Buffer.from(data))); return; }
      let m: any; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.t === 'o' && typeof m.d === 'string') this.push(m.d);
    });
    ws.on('close', () => {
      if (this.agent !== ws) return;
      this.agent = null;
      this.alive = false;
      this.push('\r\n\x1b[33m[shell closed - press Enter to open a new one]\x1b[0m\r\n');
      this.state('closed');
    });
    try { ws.send(JSON.stringify({ t: 'r', c: this.cols, r: this.rows })); } catch {}
    this.state('open');
  }

  resize(cols: number, rows: number) {
    this.cols = Math.max(20, Math.min(500, cols | 0));
    this.rows = Math.max(5, Math.min(200, rows | 0));
    if (this.agent) { try { this.agent.send(JSON.stringify({ t: 'r', c: this.cols, r: this.rows })); } catch {} return; }
    const ctl: any = this.child?.stdio?.[3];
    if (ctl && this.alive) { try { ctl.write(`R ${this.cols} ${this.rows}\n`); } catch {} }
  }

  close(reason?: string) {
    if (this.agent) { const a = this.agent; this.agent = null; try { a.close(); } catch {} }
    if (this.agentWait) { clearTimeout(this.agentWait); this.agentWait = null; }
    const c = this.child;
    this.child = null;
    this.alive = false;
    if (c) { try { c.stdin!.end(); } catch {} setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, 1500); }
    if (reason) this.push(`\r\n\x1b[33m[${reason}]\x1b[0m\r\n`);
    this.state('closed');
  }
}

const sessions = new Map<string, TerminalSession>();

export function getTerminalSession(serverId: string): TerminalSession {
  let s = sessions.get(serverId);
  if (!s) { s = new TerminalSession(serverId); sessions.set(serverId, s); }
  return s;
}

export function closeTerminalSession(serverId: string, reason?: string) {
  const s = sessions.get(serverId);
  if (s && (s.alive || reason)) s.close(reason);
}

export function writeToTerminalLog(serverId: string, text: string) {
  getTerminalSession(serverId).push(text);
}

export function clearTerminal(serverId: string) {
  const s = sessions.get(serverId);
  if (s) s.buffer = '';
}
