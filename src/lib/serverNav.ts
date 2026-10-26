// Shared state between the open server page (ServerManage) and the Sidebar / Navbar.
// ServerManage publishes the tabs the current user may see; the Sidebar renders them as a menu.
import { useSyncExternalStore } from 'react';

export interface ServerNavTab {
  id: string;
  label: string;
  group: 'manage' | 'files' | 'config' | 'admin';
  count?: number;
}

export interface ServerNavState {
  serverId: string;
  name: string;
  software: string;
  status: string;
  activeTab: string;
  tabs: ServerNavTab[];
}

let state: ServerNavState | null = null;
let selectHandler: ((tab: string) => void) | null = null;
const listeners = new Set<() => void>();

export function publishServerNav(next: ServerNavState | null) {
  if (JSON.stringify(next) === JSON.stringify(state)) return;
  state = next;
  listeners.forEach((l) => l());
}

export function setServerNavSelect(fn: ((tab: string) => void) | null) {
  selectHandler = fn;
}

/** Switch tab through the server page (keeps its "unsaved changes" check). */
export function selectServerTab(tab: string, fallback?: () => void) {
  if (selectHandler) selectHandler(tab);
  else if (fallback) fallback();
}

export function useServerNav(): ServerNavState | null {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
    () => state,
  );
}
