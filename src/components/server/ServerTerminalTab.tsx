import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TerminalSquare, Trash2, Maximize2, Minimize2, Copy, Check } from 'lucide-react';
import { Server } from '../../types';

interface Props {
  server: Server;
  canType: boolean;
}

type ConnState = 'connecting' | 'open' | 'ready' | 'closed' | 'offline' | 'installing' | 'disconnected';

/**
 * VPS web terminal. The shell runs on the panel side and keeps going while nobody looks;
 * on (re)connect the server sends the saved screen first, so the user sees exactly what was there before.
 */
export const ServerTerminalTab: React.FC<Props> = ({ server, canType }) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: 5000,
      convertEol: false,
      disableStdin: !canType,
      theme: {
        background: '#08080a', foreground: '#e4e4e7', cursor: '#fbbf24', cursorAccent: '#08080a',
        selectionBackground: '#3f3f46', black: '#18181b', brightBlack: '#52525b',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(boxRef.current!);
    termRef.current = term;
    fitRef.current = fit;
    try { fit.fit(); } catch {}

    let closedByUs = false;
    let retry: any = null;
    const safeFit = () => { if (!closedByUs) { try { fit.fit(); } catch {} } };

    const connect = () => {
      setConn('connecting');
      const token = localStorage.getItem('aether_token') || '';
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/api/v1/servers/${encodeURIComponent(server.id)}/ws-terminal?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;
      ws.onopen = () => {
        if (closedByUs) { ws.close(); return; }
        safeFit();
        ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
      };
      ws.onmessage = (ev) => {
        if (closedByUs) return;
        let m: any;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t === 'o') {
          if (m.replay) term.reset();
          if (m.d) term.write(m.d);
        } else if (m.t === 's') {
          setConn(m.state as ConnState);
        }
      };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (closedByUs) return;
        setConn('disconnected');
        retry = setTimeout(connect, 2500);
      };
    };
    connect();

    const sub = term.onData((d) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d }));
    });
    const onResize = () => {
      if (closedByUs) return;
      safeFit();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(boxRef.current!);
    try { (term.textarea as any)?.focus({ preventScroll: true }); } catch {}

    return () => {
      closedByUs = true;
      clearTimeout(retry);
      ro.disconnect();
      sub.dispose();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
        else { try { ws.close(); } catch {} }
      }
      fitRef.current = null;
      termRef.current = null;
      setTimeout(() => { try { term.dispose(); } catch {} }, 0);
    };
  }, [server.id, canType]);

  // re-fit after fullscreen toggle
  useEffect(() => {
    const t = setTimeout(() => {
      const term = termRef.current;
      try { fitRef.current?.fit(); } catch {}
      const ws = wsRef.current;
      if (term && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'r', c: term.cols, r: term.rows }));
    }, 60);
    return () => clearTimeout(t);
  }, [full]);

  const clear = () => {
    termRef.current?.clear();
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'clear' }));
    termRef.current?.focus();
  };
  const copySel = async () => {
    const sel = termRef.current?.getSelection();
    if (!sel) return;
    try { await navigator.clipboard.writeText(sel); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };

  const badge: Record<ConnState, [string, string]> = {
    connecting: ['Connecting…', 'text-amber-400 bg-amber-500/10 border-amber-500/20'],
    open: ['Shell connected', 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'],
    ready: ['Opening shell…', 'text-amber-400 bg-amber-500/10 border-amber-500/20'],
    closed: ['Shell closed · press Enter', 'text-zinc-300 bg-zinc-800 border-zinc-700'],
    offline: ['VPS offline', 'text-red-400 bg-red-500/10 border-red-500/20'],
    installing: ['Creating VPS…', 'text-amber-400 bg-amber-500/10 border-amber-500/20'],
    disconnected: ['Reconnecting…', 'text-amber-400 bg-amber-500/10 border-amber-500/20'],
  };
  const [label, cls] = badge[conn] || badge.connecting;

  return (
    <div className={full ? 'fixed inset-0 z-[80] bg-[#08080a] p-3 flex flex-col gap-2' : 'space-y-3'}>
      <div className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-2xl bg-zinc-900/80 border border-zinc-800">
        <div className="flex items-center gap-2 text-xs">
          <TerminalSquare className="h-4 w-4 text-amber-400" />
          <span className="font-semibold text-white">Terminal</span>
          <span className="font-mono text-zinc-500">root@{(server as any).vps?.hostname || 'vps'}</span>
          <span className={`px-2 py-0.5 rounded-lg border text-[11px] font-semibold ${cls}`}>{label}</span>
          {!canType && <span className="px-2 py-0.5 rounded-lg border border-zinc-700 text-[11px] text-zinc-400">read only</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={copySel} className="px-3 py-1.5 rounded-xl bg-zinc-950 border border-zinc-800 hover:border-zinc-600 text-xs text-zinc-300 flex items-center gap-1.5">
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />} Copy
          </button>
          {canType && (
            <button onClick={clear} className="px-3 py-1.5 rounded-xl bg-zinc-950 border border-zinc-800 hover:border-zinc-600 text-xs text-zinc-300 flex items-center gap-1.5">
              <Trash2 className="h-3.5 w-3.5" /> Clear
            </button>
          )}
          <button onClick={() => setFull((f) => !f)} className="px-3 py-1.5 rounded-xl bg-zinc-950 border border-zinc-800 hover:border-zinc-600 text-xs text-zinc-300 flex items-center gap-1.5">
            {full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />} {full ? 'Exit' : 'Full screen'}
          </button>
        </div>
      </div>
      <div
        className={`rounded-2xl border border-zinc-800 bg-[#08080a] p-2 ${full ? 'flex-1 min-h-0' : 'h-[560px]'}`}
        onClick={() => termRef.current?.focus()}
      >
        <div ref={boxRef} className="h-full w-full" />
      </div>
      {!full && (
        <p className="text-[11px] text-zinc-500">
          The shell keeps running when you leave this page - come back and everything is still here.{' '}
          {(server as any).vps?.remote ? 'This VPS runs on a connected node.' : <>Files in <code className="text-zinc-300">/root</code> are the same as in the File Manager.</>}
        </p>
      )}
    </div>
  );
};
