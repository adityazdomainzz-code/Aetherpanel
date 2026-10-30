import React, { useEffect, useState } from 'react';
import { Cloud, Loader2, Check, Unplug, Globe, ExternalLink } from 'lucide-react';
import { apiRequest } from '../../lib/api';

interface CfState { connected: boolean; enabled: boolean; zoneId?: string; zoneName?: string; targetIp?: string; tokenHint?: string }

/**
 * Platform Settings -> Cloudflare DNS.
 * Connect an API token, pick a domain; every new Minecraft server then gets <server-name>.<domain>.
 */
export const CloudflareDnsSettings: React.FC = () => {
  const [state, setState] = useState<CfState | null>(null);
  const [zones, setZones] = useState<{ id: string; name: string }[]>([]);
  const [token, setToken] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [targetIp, setTargetIp] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = async () => {
    const r = await apiRequest<CfState>('/admin/cloudflare');
    if (r.success && r.data) {
      setState(r.data);
      setZoneId(r.data.zoneId || '');
      setEnabled(r.data.connected ? !!r.data.enabled || !r.data.zoneId : true);
      setTargetIp(r.data.targetIp || '');
      if (r.data.connected) {
        const z = await apiRequest<any>('/admin/cloudflare/zones');
        if (z.success && Array.isArray(z.data)) setZones(z.data);
        else if (z.error) setMsg({ ok: false, text: z.error.message });
      }
    }
  };
  useEffect(() => { load(); }, []);

  const connect = async () => {
    setBusy('connect'); setMsg(null);
    const r = await apiRequest<any>('/admin/cloudflare/connect', { method: 'POST', body: JSON.stringify({ apiToken: token }) });
    setBusy(null);
    if (r.success && r.data) {
      setState(r.data); setZones(r.data.zones || []); setToken('');
      if (!zoneId && r.data.zones?.length === 1) setZoneId(r.data.zones[0].id);
      setMsg({ ok: true, text: `Connected - ${r.data.zones?.length || 0} domain(s) found. Pick one and save.` });
    } else setMsg({ ok: false, text: r.error?.message || 'Could not connect.' });
  };

  const save = async () => {
    setBusy('save'); setMsg(null);
    const zone = zones.find((z) => z.id === zoneId);
    const r = await apiRequest<CfState>('/admin/cloudflare', { method: 'PUT', body: JSON.stringify({ zoneId, zoneName: zone?.name || state?.zoneName, enabled, targetIp }) });
    setBusy(null);
    if (r.success && r.data) { setState(r.data); setMsg({ ok: true, text: r.data.enabled ? `Saved - new Minecraft servers get <name>.${r.data.zoneName}` : 'Saved - automatic DNS is off.' }); }
    else setMsg({ ok: false, text: r.error?.message || 'Could not save.' });
  };

  const disconnect = async () => {
    setBusy('disconnect');
    await apiRequest('/admin/cloudflare/disconnect', { method: 'POST' });
    setBusy(null); setZones([]); setZoneId(''); setState({ connected: false, enabled: false });
    setMsg({ ok: true, text: 'Cloudflare disconnected. Existing DNS records were left untouched.' });
  };

  const zoneName = zones.find((z) => z.id === zoneId)?.name || state?.zoneName || 'example.com';
  const input = 'w-full rounded-xl bg-zinc-950 border border-zinc-800 px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-amber-500';

  return (
    <div className="p-6 rounded-3xl bg-zinc-900 border border-zinc-800 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-white flex items-center gap-2"><Cloud className="h-4 w-4 text-orange-400" /> Cloudflare DNS</h3>
          <p className="text-xs text-zinc-400 mt-1 max-w-2xl">
            Every new Minecraft server gets its own address from its name, e.g. server <b className="text-white">Survival SMP</b> →{' '}
            <code className="text-amber-300">survival-smp.{zoneName}</code>. An SRV record is added too, so players join without a port.
            If the name is already used, server creation stops with "Server name already exists".
          </p>
        </div>
        {state?.connected && (
          <span className={`shrink-0 px-3 py-1 rounded-full text-[11px] font-bold border ${state.enabled ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>
            {state.enabled ? `● Active · ${state.zoneName}` : '○ Connected · off'}
          </span>
        )}
      </div>

      {msg && <div className={`p-3 rounded-xl text-xs border ${msg.ok ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300' : 'bg-red-500/10 border-red-500/20 text-red-300'}`}>{msg.text}</div>}

      {/* 1. token */}
      <div className="space-y-2">
        <label className="block text-xs font-semibold text-zinc-300">1. Cloudflare API token {state?.connected && <span className="text-zinc-500 font-normal">(saved {state.tokenHint} - paste a new one to replace)</span>}</label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Cloudflare API token" className={input} />
          <button onClick={connect} disabled={busy !== null || (!token && !state?.connected)}
            className="shrink-0 px-5 py-2.5 rounded-xl bg-orange-500 hover:bg-orange-400 disabled:opacity-50 text-zinc-950 font-bold text-xs flex items-center justify-center gap-2">
            {busy === 'connect' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />} {state?.connected && !token ? 'Reload domains' : 'Connect'}
          </button>
        </div>
        <p className="text-[11px] text-zinc-500">
          Create it at Cloudflare → My Profile → API Tokens → Create Token → template <b>Edit zone DNS</b> → Zone Resources: your domain.{' '}
          <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noopener noreferrer" className="text-orange-400 inline-flex items-center gap-0.5">Open <ExternalLink className="h-3 w-3" /></a>
        </p>
      </div>

      {state?.connected && (
        <>
          {/* 2. domain */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5">2. Domain</label>
              <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} className={input}>
                <option value="">Select a domain…</option>
                {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-zinc-300 mb-1.5">Public IP for DNS <span className="text-zinc-500 font-normal">(optional)</span></label>
              <input value={targetIp} onChange={(e) => setTargetIp(e.target.value)} placeholder="empty = the server's node IP" className={input} />
              <p className="text-[10px] text-zinc-500 mt-1">Set this when the node's IP is private (NAT). Records are DNS-only (grey cloud) - Minecraft cannot go through the orange proxy.</p>
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="rounded border-zinc-700 bg-zinc-950" />
            Create <code className="text-amber-300">&lt;server-name&gt;.{zoneName}</code> automatically for every new Minecraft server
          </label>

          <div className="flex flex-wrap gap-2 justify-between">
            <button onClick={disconnect} disabled={busy !== null} className="px-4 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800 hover:border-red-500/40 text-red-400 text-xs font-semibold flex items-center gap-2">
              {busy === 'disconnect' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />} Disconnect
            </button>
            <button onClick={save} disabled={busy !== null || (enabled && !zoneId)} className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-zinc-950 font-bold text-xs flex items-center gap-2">
              {busy === 'save' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save
            </button>
          </div>
        </>
      )}

      <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-[11px] text-zinc-400 flex items-start gap-2">
        <Globe className="h-4 w-4 text-zinc-500 shrink-0 mt-0.5" />
        <span>Deleting a server removes its DNS records. Bot hosting and VPS servers are not given an address.</span>
      </div>
    </div>
  );
};
