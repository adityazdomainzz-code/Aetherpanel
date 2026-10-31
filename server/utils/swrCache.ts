// Tiny stale-while-revalidate cache: slow checks (public IP lookup, port probes, playit IPC)
// must not block page loads. Fresh value -> returned; stale value -> returned at once and refreshed
// in the background; no value yet -> computed once (concurrent callers share the same promise).
const store = new Map<string, { at: number; value?: any; has: boolean; pending?: Promise<any> }>();

export function swr<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  let e = store.get(key);
  if (!e) { e = { at: 0, has: false }; store.set(key, e); }
  const entry = e;
  const refresh = () => {
    if (!entry.pending) {
      entry.pending = fn()
        .then((v) => { entry.value = v; entry.has = true; entry.at = Date.now(); return v; })
        .finally(() => { entry.pending = undefined; });
    }
    return entry.pending as Promise<T>;
  };
  if (entry.has) {
    if (Date.now() - entry.at > ttlMs) refresh().catch(() => {});
    return Promise.resolve(entry.value as T);
  }
  return refresh();
}

export function swrForget(prefix: string) {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}
