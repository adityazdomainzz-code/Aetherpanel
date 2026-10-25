/**
 * What normal users may do themselves (set on the server: ALLOW_SELF_FUNDING / ALLOW_SELF_DEPLOY).
 * Default: users cannot add funds and cannot create servers - only admins do that.
 */
import { useEffect, useState } from 'react';
import { apiRequest } from './api';

export interface PanelPolicy { selfFunding: boolean; selfDeploy: boolean; }
const DEFAULT_POLICY: PanelPolicy = { selfFunding: false, selfDeploy: false };

let cached: PanelPolicy | null = null;
let pending: Promise<PanelPolicy> | null = null;

export function loadPolicy(): Promise<PanelPolicy> {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = apiRequest<PanelPolicy>('/billing/policy')
      .then((res) => { cached = res.success && res.data ? { ...DEFAULT_POLICY, ...res.data } : DEFAULT_POLICY; return cached; })
      .catch(() => DEFAULT_POLICY)
      .finally(() => { pending = null; });
  }
  return pending;
}

export function usePolicy(): PanelPolicy {
  const [policy, setPolicy] = useState<PanelPolicy>(cached || DEFAULT_POLICY);
  useEffect(() => { let alive = true; loadPolicy().then((p) => { if (alive) setPolicy(p); }); return () => { alive = false; }; }, []);
  return policy;
}

export const isAdminUser = (user?: { role?: string } | null) => !!user && (user.role === 'admin' || user.role === 'super_admin');

/** may this user open the deploy wizard? */
export const canDeploy = (user: { role?: string } | null | undefined, policy: PanelPolicy) => isAdminUser(user) || policy.selfDeploy;
