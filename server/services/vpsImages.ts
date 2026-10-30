// Downloads VPS OS images for Incus/LXD (used by vpsService.ts; same code lives in node-agent/agent.js)
import fsp from 'fs';

// ---------- OS image download (own downloader: real progress %, resume, stall detection, mirror fallback) ----------
// "incus launch images:..." shows no progress and can hang for ever on a slow/blocked link; here we download the
// image files ourselves, import them once as a local alias (aether/<os>[-vm]) and every next VPS starts instantly.
const IMG_DISTRO: Record<string, string> = { 'ubuntu-22.04': 'ubuntu/jammy', 'ubuntu-24.04': 'ubuntu/noble', 'debian-12': 'debian/bookworm', 'alpine-3.20': 'alpine/3.20' };
const IMG_MIRRORS = (process.env.AETHER_IMAGE_MIRRORS || 'https://images.linuxcontainers.org,https://mirrors.tuna.tsinghua.edu.cn/lxc-images,https://mirror.nju.edu.cn/lxc-images')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
const IMG_DIR = '/var/tmp/aether-images';

async function imgDownload(url: string, dest: string, say: (l: string) => void, label: string) {
  
  for (let attempt = 1; attempt <= 4; attempt++) {
    let have = 0;
    try { have = fsp.statSync(dest + '.part').size; } catch {}
    const ctrl = new AbortController();
    let stall: any = setTimeout(() => ctrl.abort(), 60000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: have ? { Range: `bytes=${have}-` } : {} });
      if (r.status === 404) throw Object.assign(new Error('404'), { notFound: true });
      if (r.status === 416) { fsp.renameSync(dest + '.part', dest); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      if (r.status !== 206) have = 0;
      const total = have + Number(r.headers.get('content-length') || 0);
      const out = fsp.createWriteStream(dest + '.part', { flags: have ? 'a' : 'w' });
      let got = have, lastSay = Date.now(), lastGot = got, lastT = Date.now();
      for await (const chunk of r.body as any) {
        clearTimeout(stall); stall = setTimeout(() => ctrl.abort(), 60000);
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((ok: any) => out.once('drain', ok));
        const now = Date.now();
        if (now - lastSay > 5000) {
          const speed = (got - lastGot) / ((now - lastT) / 1000);
          say(`Downloading ${label}: ${total ? Math.floor((got / total) * 100) + '% ' : ''}(${(got / 1048576).toFixed(0)}${total ? '/' + (total / 1048576).toFixed(0) : ''} MB, ${(speed / 1048576).toFixed(1)} MB/s)`);
          lastSay = now; lastGot = got; lastT = now;
        }
      }
      await new Promise<void>((ok, bad) => out.end((e: any) => (e ? bad(e) : ok())));
      clearTimeout(stall);
      if (total && got < total) throw new Error('connection closed early');
      fsp.renameSync(dest + '.part', dest);
      return;
    } catch (e: any) {
      clearTimeout(stall);
      if (e && e.notFound) throw e;
      const why = e && e.name === 'AbortError' ? 'no data for 60s' : (e && (e.cause && e.cause.code || e.message)) || 'error';
      say(`${label}: download problem (${why}) - retry ${attempt}/4`);
      if (attempt === 4) throw new Error(`${label}: ${why}`);
      await new Promise((ok: any) => setTimeout(ok, 3000));
    }
  }
}

/** returns a local image alias ready for "launch", or null (caller falls back to images:...) */
export async function ensureLocalImage(run: (c: string, a: string[], t?: number) => Promise<{ code: number; stdout: string; stderr: string }>, cli: string, osKey: string, vm: boolean, say: (l: string) => void): Promise<string | null> {
  
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
        } catch (e: any) { if (e && e.notFound) { for (const f of [meta, data]) { try { fsp.unlinkSync(f); } catch {} } say(`build ${decodeURIComponent(b)} has no ${dataName} - trying an older one`); continue; } throw e; }
        say(`Importing the image into ${cli} (one time)...`);
        const im = await run(cli, ['image', 'import', meta, data, '--alias', alias], 15 * 60000);
        if (im.code !== 0 && !/already exists/i.test(im.stderr)) throw new Error(`image import failed: ${lastLinesOf(im.stderr || im.stdout)}`);
        for (const f of [meta, data]) { try { fsp.unlinkSync(f); } catch {} }
        say(`Image ready: ${alias}`);
        return alias;
      }
      throw new Error(`no ${dataName} found in the last builds`);
    } catch (e: any) {
      say(`Mirror ${host} failed: ${(e && e.message) || e} - trying the next mirror`);
    }
  }
  say(`All image mirrors failed - falling back to "${cli} launch images:..." (check internet / DNS on this machine: curl -I https://images.linuxcontainers.org)`);
  return null;
}
const lastLinesOf = (t: string) => String(t || '').trim().split('\n').slice(-2).join(' ');
