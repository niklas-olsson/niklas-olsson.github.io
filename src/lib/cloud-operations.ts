// SPDX-License-Identifier: Apache-2.0
import { CloudError, type CloudEvent, type CloudOperation, type CloudOperationHandle, type CloudRequestOptions, type CloudResourceType } from "./cloud-types.ts";

const OPERATION_HISTORY = 200;
const EVENT_HISTORY = 500;
interface Entry {
  snapshot: CloudOperation;
  handle: CloudOperationHandle<unknown>;
  fingerprint: string;
  idempotencyKey?: string;
  locks: string[];
  run(): Promise<void>;
}

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (value && typeof value === "object") {
    if (seen.has(value)) throw new CloudError("invalid_argument", "Cloud requests cannot contain circular data.");
    seen.add(value);
    try {
      if (Array.isArray(value)) return `[${value.map((item) => canonical(item, seen)).join(",")}]`;
      if ([Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key], seen)}`).join(",")}}`;
      }
    } finally { seen.delete(value); }
  }
  throw new CloudError("invalid_argument", "Cloud requests must contain plain, finite JSON data.");
}

function failure(error: unknown, operationId: string): CloudError {
  if (error instanceof CloudError) return new CloudError(error.code, error.message, operationId);
  if (error instanceof DOMException && error.name === "QuotaExceededError") return new CloudError("quota_exceeded", "The browser has no storage quota for this operation.", operationId);
  return new CloudError("provider_error", error instanceof Error ? error.message : String(error), operationId);
}

/** An operation succeeds only after its real provider callback completes. */
export class CloudOperations {
  readonly limits = Object.freeze({ completedOperations: OPERATION_HISTORY, events: EVENT_HISTORY, idempotency: "retained operations in this open page" });
  private readonly entries = new Map<string, Entry>();
  private readonly idempotency = new Map<string, Entry>();
  private readonly pending: Entry[] = [];
  private readonly heldLocks = new Set<string>();
  private readonly completed: string[] = [];
  private readonly history: CloudEvent[] = [];
  private readonly listeners = new Set<(event: CloudEvent) => void>();
  private sequence = 0;
  private readonly before: (context: { action: string; identity: string; operationId: string }) => Promise<void>;
  constructor(before: (context: { action: string; identity: string; operationId: string }) => Promise<void> = async () => undefined) { this.before = before; }

  submit<Input, Result>(
    action: string,
    resourceType: CloudResourceType,
    resourceId: string | null,
    input: Input,
    locks: string[],
    work: (input: Input) => Promise<Result>,
    options: CloudRequestOptions = {},
  ): CloudOperationHandle<Result> {
    let stableInput: Input;
    try { stableInput = structuredClone(input); } catch { throw new CloudError("invalid_argument", "Cloud requests must be cloneable data."); }
    const identity = options.identity ?? "local";
    if (typeof identity !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(identity)) throw new CloudError("invalid_argument", "Choose a simple simulated identity ID.");
    const fingerprint = canonical({ action, resourceType, resourceId, identity, input: stableInput });
    if (new TextEncoder().encode(fingerprint).length > 131072) throw new CloudError("invalid_argument", "Control-plane request metadata exceeds 128 KiB.");
    const key = options.idempotencyKey;
    if (key !== undefined && (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key))) throw new CloudError("invalid_argument", "Idempotency keys use 1–128 letters, numbers, dots, underscores, colons, or hyphens.");
    if (key !== undefined) {
      const existing = this.idempotency.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new CloudError("idempotency_conflict", "That idempotency key belongs to a different request. Use a new key for a changed operation.", existing.snapshot.id);
        return existing.handle as CloudOperationHandle<Result>;
      }
    }
    const snapshot: CloudOperation<Result> = { id: crypto.randomUUID(), action, identity, resourceType, resourceId, status: "queued", submittedAt: Date.now(), startedAt: null, finishedAt: null };
    let resolve!: (result: Result) => void;
    let reject!: (error: CloudError) => void;
    const completion = new Promise<Result>((yes, no) => { resolve = yes; reject = no; });
    // Polling operations is supported without awaiting them immediately.
    void completion.catch(() => undefined);
    const handle: CloudOperationHandle<Result> = Object.freeze({
      id: snapshot.id,
      get: () => structuredClone(snapshot),
      wait: () => completion.then((result) => structuredClone(result)),
    });
    const entry: Entry = {
      snapshot,
      handle,
      fingerprint,
      idempotencyKey: key,
      locks: [...new Set(locks)].sort(),
      run: async () => {
        try {
          await this.before({ action, identity, operationId: snapshot.id });
          const result = structuredClone(await work(stableInput));
          snapshot.result = structuredClone(result);
          if (result && typeof result === "object" && "id" in result && typeof result.id === "string") snapshot.resourceId = result.id;
          snapshot.status = "succeeded"; snapshot.finishedAt = Date.now(); this.emit(entry, "operation.succeeded");
          resolve(result);
        } catch (error) {
          const converted = failure(error, snapshot.id);
          snapshot.status = "failed"; snapshot.finishedAt = Date.now(); snapshot.error = { code: converted.code, message: converted.message };
          this.emit(entry, "operation.failed"); reject(converted);
        } finally {
          for (const lock of entry.locks) this.heldLocks.delete(lock);
          this.completed.push(snapshot.id); this.prune(); queueMicrotask(() => this.pump());
        }
      },
    };
    this.entries.set(snapshot.id, entry);
    if (key !== undefined) this.idempotency.set(key, entry);
    this.pending.push(entry); this.emit(entry, "operation.queued"); queueMicrotask(() => this.pump());
    return handle;
  }

  get = (id: string): CloudOperation => {
    const entry = this.entries.get(id);
    if (!entry) throw new CloudError("not_found", "That operation is not retained in this page's bounded history.");
    return structuredClone(entry.snapshot);
  };
  list = (): CloudOperation[] => [...this.entries.values()].map((entry) => structuredClone(entry.snapshot)).reverse();
  wait = (id: string): Promise<unknown> => {
    const entry = this.entries.get(id);
    if (!entry) return Promise.reject(new CloudError("not_found", "That operation is not retained in this page's bounded history."));
    return entry.handle.wait();
  };
  events = (afterSequence = 0): CloudEvent[] => this.history.filter((event) => event.sequence > afterSequence).map((event) => ({ ...event }));
  subscribe = (listener: (event: CloudEvent) => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };

  private emit(entry: Entry, type: CloudEvent["type"]): void {
    const event: CloudEvent = { sequence: ++this.sequence, at: Date.now(), type, operationId: entry.snapshot.id, action: entry.snapshot.action, identity: entry.snapshot.identity, resourceType: entry.snapshot.resourceType, resourceId: entry.snapshot.resourceId };
    if (this.history.length >= EVENT_HISTORY) this.history.shift();
    this.history.push(event);
    for (const listener of this.listeners) { try { listener({ ...event }); } catch { /* Observers cannot change an operation outcome. */ } }
  }

  private pump(): void {
    for (let index = 0; index < this.pending.length;) {
      const entry = this.pending[index];
      if (entry.locks.some((lock) => this.heldLocks.has(lock))) { index++; continue; }
      this.pending.splice(index, 1);
      for (const lock of entry.locks) this.heldLocks.add(lock);
      entry.snapshot.status = "running"; entry.snapshot.startedAt = Date.now(); this.emit(entry, "operation.running");
      void entry.run();
    }
  }

  private prune(): void {
    while (this.completed.length > OPERATION_HISTORY) {
      const id = this.completed.shift()!; const entry = this.entries.get(id);
      this.entries.delete(id);
      if (entry?.idempotencyKey && this.idempotency.get(entry.idempotencyKey) === entry) this.idempotency.delete(entry.idempotencyKey);
    }
  }
}
