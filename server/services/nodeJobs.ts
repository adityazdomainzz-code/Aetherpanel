// Job queue between the panel and remote node agents (node-agent/agent.js).
// Nodes connect OUT to the panel (long-poll), so they work behind NAT / without a public IPv4.
import crypto from 'crypto';

export interface NodeJob {
  id: string;
  nodeId: string;
  action: string;       // create | start | stop | kill | delete | exec | state | term-open
  payload: any;
  serverId?: string;
  createdAt: number;
}
export interface NodeJobResult { ok: boolean; output?: string; error?: string; data?: any }

const queues = new Map<string, NodeJob[]>();
const waiters = new Map<string, Set<() => void>>();
const pending = new Map<string, { resolve: (r: NodeJobResult) => void; timer: NodeJS.Timeout; serverId?: string }>();
const jobServer = new Map<string, string>(); // jobId -> serverId (for progress lines)

function wake(nodeId: string) {
  const w = waiters.get(nodeId);
  if (w) { for (const f of w) f(); w.clear(); }
}

function enqueue(nodeId: string, action: string, payload: any): NodeJob {
  const job: NodeJob = { id: `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`, nodeId, action, payload, serverId: payload?.serverId, createdAt: Date.now() };
  if (!queues.has(nodeId)) queues.set(nodeId, []);
  queues.get(nodeId)!.push(job);
  if (job.serverId) jobServer.set(job.id, job.serverId);
  wake(nodeId);
  return job;
}

/** send a job and wait for the agent's answer */
export function sendNodeJob(nodeId: string, action: string, payload: any, timeoutMs = 120000): Promise<NodeJobResult> {
  const job = enqueue(nodeId, action, payload);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(job.id);
      jobServer.delete(job.id);
      // drop it from the queue if the node never picked it up
      const q = queues.get(nodeId);
      if (q) queues.set(nodeId, q.filter((j) => j.id !== job.id));
      resolve({ ok: false, error: `Node did not answer within ${Math.round(timeoutMs / 1000)}s (is the node online? check: systemctl status aethernode)` });
    }, timeoutMs);
    pending.set(job.id, { resolve, timer, serverId: job.serverId });
  });
}

/** fire and forget (terminal open etc.) */
export function fireNodeJob(nodeId: string, action: string, payload: any) {
  enqueue(nodeId, action, payload);
}

/** agent long-poll: returns queued jobs, or waits up to waitMs for one */
export async function takeNodeJobs(nodeId: string, waitMs: number): Promise<NodeJob[]> {
  const take = () => {
    const q = queues.get(nodeId) || [];
    // forget jobs nobody picked up for 30 minutes
    const fresh = q.filter((j) => Date.now() - j.createdAt < 30 * 60000);
    queues.set(nodeId, []);
    return fresh;
  };
  let jobs = take();
  if (jobs.length || waitMs <= 0) return jobs;
  await new Promise<void>((resolve) => {
    const t = setTimeout(done, waitMs);
    function done() { clearTimeout(t); waiters.get(nodeId)?.delete(done); resolve(); }
    if (!waiters.has(nodeId)) waiters.set(nodeId, new Set());
    waiters.get(nodeId)!.add(done);
  });
  jobs = take();
  return jobs;
}

/** put jobs back at the front of the queue (agent disconnected before it got them) */
export function requeueNodeJobs(nodeId: string, jobs: NodeJob[]) {
  if (!jobs.length) return;
  queues.set(nodeId, [...jobs, ...(queues.get(nodeId) || [])]);
  wake(nodeId);
}

export function resolveNodeJob(jobId: string, result: NodeJobResult) {
  const p = pending.get(jobId);
  jobServer.delete(jobId);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(jobId);
  p.resolve(result);
  return true;
}

export function serverOfJob(jobId: string) {
  return jobServer.get(jobId) || pending.get(jobId)?.serverId;
}
