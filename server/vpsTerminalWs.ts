// WebSocket for the VPS web terminal:  /api/v1/servers/:id/ws-terminal?token=JWT
// client -> server: {"t":"i","d":"keys"} input · {"t":"r","c":cols,"r":rows} resize · {"t":"clear"}
// server -> client: {"t":"o","d":"text"} output (first message = saved screen) · {"t":"s","state":...}
import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { parse as parseUrl } from 'url';
import { verifyToken } from './auth';
import { getDb } from './db';
import { getTerminalSession, clearTerminal } from './services/vpsTerminal';
import { isVpsServer } from './services/vpsService';

function reject(socket: any, code: number, reason: string) {
  try { socket.end(`HTTP/1.1 ${code} ${reason}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`); }
  catch { try { socket.destroy(); } catch {} }
}

async function access(serverId: string, user: any) {
  const db = await getDb();
  const server: any = db.servers.find((s) => s.id === serverId);
  if (!server) return { server: null, view: false, input: false };
  const owner = server.userId === user.id;
  const admin = ['admin', 'super_admin', 'moderator'].includes(user.role);
  const sub = db.subusers?.find((s: any) => s.serverId === serverId && s.userId === user.id);
  const view = owner || admin || !!(sub && sub.permissions.includes('console.view'));
  const input = owner || admin || !!(sub && sub.permissions.includes('console.send'));
  return { server, view, input };
}

export function setupVpsTerminalWebSocket(httpServer: HttpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', async (req, socket, head) => {
    const parsed = parseUrl(req.url || '', true);
    const m = (parsed.pathname || '').match(/^\/api\/v1\/servers\/([a-zA-Z0-9_-]+)\/ws-terminal\/?$/);
    if (!m) return; // other websocket paths are handled elsewhere
    socket.on('error', () => { try { socket.destroy(); } catch {} });

    let token = String(parsed.query.token || '');
    if (!token && req.headers.authorization?.startsWith('Bearer ')) token = req.headers.authorization.slice(7).trim();
    if (!token && req.headers.cookie) { const c = req.headers.cookie.match(/aether_token=([^;]+)/); if (c) token = decodeURIComponent(c[1]); }
    if (!token) return reject(socket, 401, 'Unauthorized');
    const user = await verifyToken(token);
    if (!user) return reject(socket, 401, 'Unauthorized');
    const a = await access(m[1], user);
    if (!a.server) return reject(socket, 404, 'Not Found');
    if (!isVpsServer(a.server)) return reject(socket, 400, 'Not a VPS');
    if (!a.view) return reject(socket, 403, 'Forbidden');

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, m[1], user));
  });

  wss.on('connection', async (ws: WebSocket, serverId: string, user: any) => {
    const session = getTerminalSession(serverId);
    const send = (o: any) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
    const listener = (msg: any) => send(msg);

    // 1) saved screen first, 2) live output
    send({ t: 'o', d: session.buffer, replay: true });
    session.listeners.add(listener);

    const db = await getDb();
    const server: any = db.servers.find((s) => s.id === serverId);
    const running = server?.status === 'running';
    send({ t: 's', state: running ? (session.alive ? 'open' : 'ready') : 'offline', status: server?.status });
    if (running && !session.alive) session.start(server.vps);
    else if (!running && !session.buffer) session.push('\x1b[33mVPS is offline - press Start to boot it.\x1b[0m\r\n');

    let alive = true;
    ws.on('pong', () => { alive = true; });
    const ping = setInterval(() => {
      if (!alive) { try { ws.terminate(); } catch {} return; }
      alive = false;
      try { ws.ping(); } catch {}
    }, 30000);

    ws.on('message', async (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'r') { session.resize(+msg.c || 120, +msg.r || 32); return; }
      const a = await access(serverId, user);
      if (msg.t === 'clear') { if (a.input) clearTerminal(serverId); return; }
      if (msg.t !== 'i' || typeof msg.d !== 'string') return;
      if (!a.input) { send({ t: 'o', d: '\r\n\x1b[31m[you have no permission to type in this terminal]\x1b[0m\r\n' }); return; }
      if (!session.alive) {
        if (a.server?.status !== 'running') { send({ t: 'o', d: '\r\n\x1b[33mVPS is offline - press Start first.\x1b[0m\r\n' }); return; }
        if (/\r|\n/.test(msg.d)) session.start(a.server.vps);
        return;
      }
      session.write(msg.d);
    });

    ws.on('close', () => { clearInterval(ping); session.listeners.delete(listener); });
  });

  return wss;
}
