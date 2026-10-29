// SPDX-License-Identifier: Apache-2.0

export type StoredResource = "volume" | "snapshot" | "evidence" | "bucket" | "object" | "image";
export interface ResourceChange {
  readonly resource: StoredResource;
  readonly action: "created" | "updated" | "deleted";
  readonly id: string;
  /** A custom IndexedDB database is a separate notification namespace. */
  readonly scope?: string;
}
export type ResourceChangeListener = (change: ResourceChange) => void;

const CHANNEL = "terrarium.resource-changes.v1";
const listeners = new Map<string, Set<ResourceChangeListener>>();
let channel: BroadcastChannel | null = null;
let storageListener: ((event: StorageEvent) => void) | null = null;
const pendingMutations = new Map<symbol, StoredResource>();
let reloadGuarded = false;

/** The mutation remains tracked through hashing, IDB commit, and notification. */
export function beginResourceMutation(resource: StoredResource): () => void {
  if (reloadGuarded) throw new Error("The workspace is preparing a safe reload. Wait before changing saved resources.");
  const token = Symbol(resource);
  pendingMutations.set(token, resource);
  return () => { pendingMutations.delete(token); };
}

export function assertNoPendingResourceMutations(): void {
  if (pendingMutations.size)
    throw new Error(`Wait for saved resource changes to finish before reloading (${[...new Set(pendingMutations.values())].join(", ")}).`);
}

/** Check and fence are synchronous, so no new save can race a controlled reload. */
export function acquireResourceReloadGuard(): () => void {
  assertNoPendingResourceMutations();
  if (reloadGuarded) throw new Error("A safe reload is already being prepared.");
  reloadGuarded = true;
  let released = false;
  return () => { if (!released) { released = true; reloadGuarded = false; } };
}

export async function withResourceMutation<T>(resource: StoredResource, work: () => Promise<T>): Promise<T> {
  const finish = beginResourceMutation(resource);
  try { return await work(); } finally { finish(); }
}

function validChange(value: unknown): value is ResourceChange {
  if (!value || typeof value !== "object") return false;
  const change = value as Partial<ResourceChange>;
  return ["volume", "snapshot", "evidence", "bucket", "object", "image"].includes(change.resource ?? "") &&
    (change.action === "created" || change.action === "updated" || change.action === "deleted") &&
    typeof change.id === "string" &&
    (change.resource === "object" ? change.id.length > 0 && change.id.length <= 2_112 && !change.id.includes("\0") :
      change.resource === "bucket" ? /^[A-Za-z0-9._-]{1,128}$/.test(change.id) : /^[A-Za-z0-9-]{1,100}$/.test(change.id)) &&
    (change.scope === undefined || typeof change.scope === "string" && change.scope.length > 0 && change.scope.length <= 256);
}

function key(resource: StoredResource, scope?: string): string { return JSON.stringify([resource, scope ?? null]); }

function notify(change: ResourceChange): void {
  const value = Object.freeze({ resource: change.resource, action: change.action, id: change.id, ...(change.scope === undefined ? {} : { scope: change.scope }) });
  const group = key(change.resource, change.scope);
  for (const listener of [...(listeners.get(group) ?? [])]) {
    // Unsubscribing from an earlier callback must suppress later delivery.
    if (!listeners.get(group)?.has(listener)) continue;
    try { listener(value); } catch { /* A view cannot change a committed mutation. */ }
  }
}

function browser(): boolean {
  return typeof window !== "undefined" && typeof window.addEventListener === "function";
}

function connect(): void {
  if (!browser() || channel || storageListener) return;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (event: MessageEvent<unknown>) => { if (validChange(event.data)) notify(event.data); };
      return;
    } catch { /* Storage events provide a fallback when channels are denied. */ }
  }
  storageListener = (event) => {
    if (event.key !== CHANNEL || !event.newValue) return;
    try {
      const value: unknown = JSON.parse(event.newValue);
      if (validChange(value)) notify(value);
    } catch { /* Notifications invalidate views; they never authorize a mutation. */ }
  };
  window.addEventListener("storage", storageListener);
}

function disconnectIfUnused(): void {
  if ([...listeners.values()].some((set) => set.size)) return;
  channel?.close(); channel = null;
  if (storageListener && browser()) window.removeEventListener("storage", storageListener);
  storageListener = null;
}

/** Subscriptions invalidate resource lists. Callers must read the current store. */
export function subscribeResourceChanges(resource: StoredResource, listener: ResourceChangeListener, scope?: string): () => void {
  const group = key(resource, scope);
  const set = listeners.get(group) ?? new Set<ResourceChangeListener>();
  listeners.set(group, set); set.add(listener); connect();
  return () => { set.delete(listener); if (!set.size && listeners.get(group) === set) listeners.delete(group); disconnectIfUnused(); };
}

/** Call only after the data transaction commits, never for a failed operation. */
export function publishResourceChange(change: ResourceChange): void {
  notify(change);
  if (!browser()) return;
  connect();
  try {
    if (channel) channel.postMessage(change);
    else {
      // A nonce ensures repeated invalidations remain distinct storage events.
      window.localStorage.setItem(CHANNEL, JSON.stringify({ ...change, nonce: crypto.randomUUID() }));
      window.localStorage.removeItem(CHANNEL);
    }
  } catch { /* Cross-tab notification failure does not undo committed bytes. */ }
  disconnectIfUnused();
}
