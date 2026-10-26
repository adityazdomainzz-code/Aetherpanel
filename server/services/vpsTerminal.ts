// Persistent web terminal for VPS servers.
// One shell session per VPS lives on the panel side; its output is kept in a buffer, so leaving the page
// and coming back shows exactly what was on screen (and the shell keeps running, e.g. after "sudo su").
import { spawn, ChildProcess, execFileSync } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { terminalCommand, VpsInfo } from './vpsService';

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

  start(v: VpsInfo) {
    if (this.alive) return;
    const cmd = terminalCommand(v);
    const py = findPython();
    const env = { ...process.env, TERM: 'xterm-256color', AE_COLS: String(this.cols), AE_ROWS: String(this.rows) };
    const child = py
      ? spawn(py, ['-u', '-c', PTY_HELPER, ...cmd], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env })
      : spawn('script', ['-qfc', cmd.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' '), '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.child = child;
    this.alive = true;
    this.decoder = new StringDecoder('utf8');
    child.stdout!.on('data', (b: Buffer) => this.push(this.decoder.write(b)));
    child.stderr!.on('data', (b: Buffer) => this.push(this.decoder.write(b)));
    child.on('error', (e) => this.push(`\r\n\x1b[31m[terminal error] ${e.message}\x1b[0m\r\n`));
    child.on('close', () => {
      if (this.child !== child) return;
      this.alive = false;
      this.child = null;
      this.push(this.decoder.end() + '\r\n\x1b[33m[shell closed - press Enter to open a new one]\x1b[0m\r\n');
      this.state('closed');
    });
    this.state('open');
  }

  write(data: string) {
    if (this.child && this.alive) { try { this.child.stdin!.write(data); } catch {} }
  }

  resize(cols: number, rows: number) {
    this.cols = Math.max(20, Math.min(500, cols | 0));
    this.rows = Math.max(5, Math.min(200, rows | 0));
    const ctl: any = this.child?.stdio?.[3];
    if (ctl && this.alive) { try { ctl.write(`R ${this.cols} ${this.rows}\n`); } catch {} }
  }

  close(reason?: string) {
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
