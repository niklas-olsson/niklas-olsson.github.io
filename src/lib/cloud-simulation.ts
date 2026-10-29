// SPDX-License-Identifier: Apache-2.0
import { CloudError, type CloudResourceEvent } from "./cloud-types.ts";

export const CLOUD_MUTATIONS = Object.freeze([
  "instances.create", "instances.update", "instances.start", "instances.pause", "instances.resume", "instances.stop", "instances.delete",
  "instances.setNetwork", "instances.configureTransport", "instances.setPolicy", "instances.move", "instances.attachVolume", "instances.detachVolume", "instances.syncVolumes",
  "vpcs.create", "vpcs.update", "vpcs.delete", "subnets.create", "subnets.update", "subnets.delete",
  "volumes.create", "volumes.snapshot", "volumes.clone", "volumes.delete",
  "images.import", "images.delete",
]);
export interface SimulatedIdentity { id: string; allow: string[]; deny: string[]; revision: number }
export type SimulatedIdentityInput = Omit<SimulatedIdentity, "revision">;
export interface SimulatedFault { id: string; action: string; delayMs: number; fail: boolean; message: string }
export interface MutationContext { action: string; identity: string; operationId: string }

function pattern(value: string): string {
  if (typeof value !== "string" || !(value === "*" || CLOUD_MUTATIONS.includes(value) || (/^[a-z]+\.\*$/.test(value) && CLOUD_MUTATIONS.some((action) => action.startsWith(value.slice(0, -1)))))) throw new CloudError("invalid_argument", "Choose a known mutation action, its namespace wildcard, or *.");
  return value;
}
function matches(value: string, action: string): boolean { return value === "*" || value === action || (value.endsWith(".*") && action.startsWith(value.slice(0, -1))); }

/** Explicit teaching controls for mutation dispatch. This is not authentication. */
export class CloudSimulation {
  readonly semantics = Object.freeze({ authentication: false, scope: "control-plane mutations only", readsRestricted: false, persistence: "open-page-only", defaultIdentity: "local", defaultFaults: "none" });
  readonly actions = CLOUD_MUTATIONS;
  private readonly policies = new Map<string, SimulatedIdentity>([["local", { id: "local", allow: ["*"], deny: [], revision: 1 }]]);
  private readonly queue: SimulatedFault[] = [];
  private readonly listeners = new Set<(event: CloudResourceEvent) => void>();
  private revision = 1;
  private readonly beforeMutation: () => void;
  constructor(options: { beforeMutation?: () => void } = {}) { this.beforeMutation = options.beforeMutation ?? (() => undefined); }
  subscribe = (listener: (event: CloudResourceEvent) => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed(resourceType: "identity" | "fault", resourceId: string | null, action: string): void {
    const event: CloudResourceEvent = { type: "resource.changed", at: Date.now(), resourceType, resourceId, action };
    for (const listener of this.listeners) { try { listener({ ...event }); } catch { /* Observers do not own simulation state. */ } }
  }

  readonly identities = Object.freeze({
    list: (): SimulatedIdentity[] => [...this.policies.values()].map((value) => structuredClone(value)),
    get: (id: string): SimulatedIdentity => {
      const value = this.policies.get(id); if (!value) throw new CloudError("not_found", "That simulated identity does not exist."); return structuredClone(value);
    },
    set: (input: SimulatedIdentityInput): SimulatedIdentity => {
      this.beforeMutation();
      if (!input || typeof input.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(input.id)) throw new CloudError("invalid_argument", "Simulated identity IDs use 1–64 simple characters.");
      if (input.id === "local") throw new CloudError("conflict", "The local page identity remains the unrestricted owner of this simulation.");
      if (!Array.isArray(input.allow) || !Array.isArray(input.deny) || input.allow.length + input.deny.length > 64) throw new CloudError("invalid_argument", "Use at most 64 action patterns in a simulated policy.");
      const value = { id: input.id, allow: [...new Set(input.allow.map(pattern))], deny: [...new Set(input.deny.map(pattern))], revision: ++this.revision };
      const existed = this.policies.has(value.id);
      this.policies.set(value.id, value); this.changed("identity", value.id, existed ? "updated" : "created"); return structuredClone(value);
    },
    delete: (id: string, options: { ifRevision?: number } = {}): boolean => {
      this.beforeMutation();
      if (id === "local") throw new CloudError("conflict", "The local page identity cannot be deleted.");
      if (options.ifRevision !== undefined && (!Number.isSafeInteger(options.ifRevision) || options.ifRevision < 1)) throw new CloudError("invalid_argument", "ifRevision must be a positive simulated identity revision.");
      if (options.ifRevision !== undefined && this.policies.get(id)?.revision !== options.ifRevision) throw new CloudError("conflict", "This identity changed after it was selected. Review its current policy before deleting it.");
      const deleted = this.policies.delete(id); if (deleted) this.changed("identity", id, "deleted"); return deleted;
    },
  });

  readonly faults = Object.freeze({
    list: (): SimulatedFault[] => this.queue.map((fault) => ({ ...fault })),
    next: (input: { action: string; delayMs?: number; fail?: boolean; message?: string }): SimulatedFault => {
      this.beforeMutation();
      const action = pattern(input.action); const delayMs = input.delayMs ?? 0;
      if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30000) throw new CloudError("invalid_argument", "Simulated delay must be a whole number from 0–30000 milliseconds.");
      if (!delayMs && input.fail !== true) throw new CloudError("invalid_argument", "Choose a delay or an injected failure.");
      if (this.queue.length >= 64) throw new CloudError("conflict", "Clear or consume queued fault rules before adding more than 64.");
      const message = input.message ?? "An explicitly configured simulated failure stopped this mutation before the provider was called.";
      if (typeof message !== "string" || !message || message.length > 256) throw new CloudError("invalid_argument", "Fault messages use 1–256 characters.");
      const value = { id: crypto.randomUUID(), action, delayMs, fail: input.fail === true, message };
      this.queue.push(value); this.changed("fault", value.id, "created"); return { ...value };
    },
    delete: (id: string): boolean => {
      this.beforeMutation();
      const index = this.queue.findIndex((fault) => fault.id === id);
      if (index < 0) return false;
      this.queue.splice(index, 1); this.changed("fault", id, "deleted"); return true;
    },
    clear: (): void => { this.beforeMutation(); if (this.queue.length) { this.queue.length = 0; this.changed("fault", null, "cleared"); } },
  });

  before = async (context: MutationContext): Promise<void> => {
    this.beforeMutation();
    const authorize = () => {
      const policy = this.policies.get(context.identity);
      if (!policy || policy.deny.some((rule) => matches(rule, context.action)) || !policy.allow.some((rule) => matches(rule, context.action))) throw new CloudError("access_denied", `Simulated identity ${context.identity} is not allowed to perform ${context.action}.`, context.operationId);
    };
    authorize();
    const index = this.queue.findIndex((fault) => matches(fault.action, context.action));
    if (index < 0) return;
    const [fault] = this.queue.splice(index, 1);
    this.changed("fault", fault.id, "consumed");
    if (fault.delayMs) await new Promise<void>((resolve) => setTimeout(resolve, fault.delayMs));
    this.beforeMutation(); authorize();
    if (fault.fail) throw new CloudError("injected_failure", fault.message, context.operationId);
  };
}
