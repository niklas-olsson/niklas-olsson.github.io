// SPDX-License-Identifier: Apache-2.0
import { CloudError, type CloudResourceEvent } from "./cloud-types.ts";
import { beginResourceMutation, publishResourceChange, subscribeResourceChanges } from "./resource-events.ts";

export const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
export interface CloudBucket { name: string; createdAt: number; generation: string }
export interface CloudObjectMetadata {
  bucket: string; key: string; bytes: number; sha256: string; contentType: string;
  metadata: Record<string, string>; createdAt: number; updatedAt: number; revision: number; generation: string;
}
export interface CloudObject extends CloudObjectMetadata { body: Uint8Array }
export interface ObjectConditions { ifMatch?: string; ifRevision?: number; ifGeneration?: string; ifNoneMatch?: boolean }
export interface ObjectPutOptions extends ObjectConditions { contentType?: string; metadata?: Record<string, string> }
interface ObjectData { bucket: string; key: string; body: ArrayBuffer }

function bucketName(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9._-]{0,61}[a-z0-9])?$/.test(value)) throw new CloudError("invalid_argument", "Bucket names use 1–63 lowercase letters, numbers, dots, underscores, or hyphens, with alphanumeric ends.");
  return value;
}
function objectKey(value: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value) || value.includes("\0") || new TextEncoder().encode(value).length > 1024) throw new CloudError("invalid_argument", "Object keys use 1–1024 UTF-8 bytes and cannot contain null bytes.");
  return value;
}
function conditions(input: ObjectConditions = {}): ObjectConditions {
  if (input.ifMatch !== undefined && !/^[a-f0-9]{64}$/.test(input.ifMatch)) throw new CloudError("invalid_argument", "ifMatch must be a lowercase SHA-256 digest.");
  if (input.ifRevision !== undefined && (!Number.isSafeInteger(input.ifRevision) || input.ifRevision < 1)) throw new CloudError("invalid_argument", "ifRevision must be a positive object revision.");
  if (input.ifGeneration !== undefined && (typeof input.ifGeneration !== "string" || !/^[A-Za-z0-9:._-]{1,100}$/.test(input.ifGeneration))) throw new CloudError("invalid_argument", "ifGeneration must be the object's generation token.");
  if (input.ifNoneMatch && (input.ifMatch !== undefined || input.ifRevision !== undefined || input.ifGeneration !== undefined)) throw new CloudError("invalid_argument", "Use ifNoneMatch or a match condition, not both.");
  return { ifMatch: input.ifMatch, ifRevision: input.ifRevision, ifGeneration: input.ifGeneration, ifNoneMatch: input.ifNoneMatch === true };
}
function withGeneration(value: CloudObjectMetadata): CloudObjectMetadata {
  // Existing v1 records remain readable without a schema migration. New objects
  // receive random generations, so delete/recreate cannot satisfy an old token.
  return typeof value.generation === "string" ? value : { ...value, generation: `legacy:${value.createdAt}` };
}
function bucketGeneration(value: CloudBucket): CloudBucket {
  return typeof value.generation === "string" ? value : { ...value, generation: `legacy:${value.createdAt}` };
}
function checkConditions(old: CloudObjectMetadata | undefined, input: ObjectConditions): void {
  if (input.ifNoneMatch && old) throw new CloudError("conflict", "That object already exists.");
  if (input.ifMatch !== undefined && old?.sha256 !== input.ifMatch) throw new CloudError("conflict", "The stored object's SHA-256 no longer matches.");
  if (input.ifRevision !== undefined && old?.revision !== input.ifRevision) throw new CloudError("conflict", "The stored object's revision no longer matches.");
  if (input.ifGeneration !== undefined && old?.generation !== input.ifGeneration) throw new CloudError("conflict", "This key now refers to a different object generation.");
}
function metadata(input: Record<string, string> | undefined): Record<string, string> {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CloudError("invalid_argument", "Object metadata must map text keys to text values.");
  const result: Record<string, string> = Object.create(null);
  let total = 0;
  for (const [key, value] of Object.entries(input)) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key) || typeof value !== "string" || value.length > 1024) throw new CloudError("invalid_argument", "Metadata keys use 1–64 simple characters and values contain at most 1024 characters.");
    total += new TextEncoder().encode(key + value).length;
    if (total > 8192) throw new CloudError("invalid_argument", "Object metadata exceeds 8 KiB.");
    result[key] = value;
  }
  return result;
}
async function digest(body: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new CloudError("unsupported", "Object integrity checks require a secure context with Web Crypto.");
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", body as Uint8Array<ArrayBuffer>))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed.")); });
}
function storeError(error: unknown): Error {
  if (error instanceof CloudError) return error;
  if (error instanceof DOMException && error.name === "QuotaExceededError") return new CloudError("quota_exceeded", "The browser has no remaining IndexedDB storage quota for this object.");
  return new CloudError("storage_unavailable", error instanceof Error ? error.message : "IndexedDB storage failed.");
}

/** Real origin-local bytes. This service does not claim an S3 or guest HTTP endpoint. */
export class CloudObjectStore {
  readonly semantics = Object.freeze({ backend: "IndexedDB", endpoint: "JavaScript API", remoteReplication: false, versioning: false, maxObjectBytes: MAX_OBJECT_BYTES });
  private readonly factory: IDBFactory | undefined;
  private readonly databaseName: string;
  private database: Promise<IDBDatabase> | null = null;
  private readonly beforeMutation: () => void;
  private pendingWrites = 0;
  constructor(options: { indexedDB?: IDBFactory; databaseName?: string; beforeMutation?: () => void } = {}) {
    this.factory = options.indexedDB ?? globalThis.indexedDB;
    this.databaseName = options.databaseName ?? "terrarium-cloud-objects-v1";
    this.beforeMutation = options.beforeMutation ?? (() => undefined);
    this.buckets = Object.freeze({ ...this.buckets, create: this.trackMutation("bucket", this.buckets.create), delete: this.trackMutation("bucket", this.buckets.delete) });
    this.objects = Object.freeze({ ...this.objects, put: this.trackMutation("object", this.objects.put), delete: this.trackMutation("object", this.objects.delete) });
  }
  private trackMutation<Args extends unknown[], Result>(resource: "bucket" | "object", work: (...args: Args) => Promise<Result>): (...args: Args) => Promise<Result> {
    return async (...args) => {
      this.beforeMutation(); const finish = beginResourceMutation(resource); this.pendingWrites++;
      try { return await work(...args); } finally { this.pendingWrites--; finish(); }
    };
  }
  assertSettled = (): void => {
    if (this.pendingWrites) throw new CloudError("conflict", `Wait for ${this.pendingWrites} pending object-store mutation${this.pendingWrites === 1 ? "" : "s"} before reloading.`);
  };
  /** A new handle over the same database, preserving a caller's storage backend. */
  withMutationGuard(guard: () => void): CloudObjectStore {
    return new CloudObjectStore({ indexedDB: this.factory, databaseName: this.databaseName, beforeMutation: () => { this.beforeMutation(); guard(); } });
  }
  subscribe = (listener: (event: CloudResourceEvent) => void): (() => void) => {
    const removeBucket = subscribeResourceChanges("bucket", (change) => listener({ type: "resource.changed", at: Date.now(), resourceType: "bucket", resourceId: change.id, action: change.action }), this.databaseName);
    const removeObject = subscribeResourceChanges("object", (change) => {
      const slash = change.id.indexOf("/");
      listener({ type: "resource.changed", at: Date.now(), resourceType: "object", resourceId: change.id.slice(slash + 1), action: change.action, scope: change.id.slice(0, slash) });
    }, this.databaseName);
    return () => { removeBucket(); removeObject(); };
  };
  private changed(resourceType: "bucket" | "object", resourceId: string, action: string, scope?: string): void {
    publishResourceChange({ resource: resourceType, id: resourceType === "object" ? `${scope}/${resourceId}` : resourceId, action: action === "written" ? "updated" : action === "created" ? "created" : "deleted", scope: this.databaseName });
  }

  readonly buckets = Object.freeze({
    list: async (): Promise<CloudBucket[]> => this.transaction(["buckets"], "readonly", async (tx) => (await request(tx.objectStore("buckets").getAll()) as CloudBucket[]).map(bucketGeneration).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    get: async (name: string): Promise<CloudBucket> => {
      bucketName(name); return this.transaction(["buckets"], "readonly", async (tx) => {
        const value = await request(tx.objectStore("buckets").get(name)) as CloudBucket | undefined;
        if (!value) throw new CloudError("not_found", "That bucket does not exist."); return bucketGeneration(value);
      });
    },
    create: async (input: { name: string }): Promise<CloudBucket> => {
      this.beforeMutation();
      const name = bucketName(input.name);
      const result = await this.transaction(["buckets"], "readwrite", async (tx) => {
        const store = tx.objectStore("buckets");
        if (await request(store.get(name))) throw new CloudError("conflict", "That bucket already exists.");
        const value = { name, createdAt: Date.now(), generation: crypto.randomUUID() }; await request(store.add(value)); return value;
      });
      this.changed("bucket", name, "created"); return result;
    },
    delete: async (name: string, options: Pick<ObjectConditions, "ifGeneration"> = {}): Promise<{ name: string; deleted: boolean }> => {
      this.beforeMutation(); bucketName(name); const match = conditions(options);
      const result = await this.transaction(["buckets", "objects"], "readwrite", async (tx) => {
        const store = tx.objectStore("buckets");
        const raw = await request(store.get(name)) as CloudBucket | undefined;
        if (match.ifGeneration !== undefined && (!raw || bucketGeneration(raw).generation !== match.ifGeneration)) throw new CloudError("conflict", "This name now refers to a different bucket generation.");
        if (!raw) return { name, deleted: false };
        if (await request(tx.objectStore("objects").index("bucket").count(name))) throw new CloudError("conflict", "Delete the bucket's objects before deleting the bucket.");
        await request(store.delete(name)); return { name, deleted: true };
      });
      if (result.deleted) this.changed("bucket", name, "deleted"); return result;
    },
  });

  readonly objects = Object.freeze({
    list: async (bucket: string, options: { prefix?: string } = {}): Promise<CloudObjectMetadata[]> => {
      bucketName(bucket); const prefix = objectKey(options.prefix ?? "", true);
      return this.transaction(["buckets", "objects"], "readonly", async (tx) => {
        if (!(await request(tx.objectStore("buckets").get(bucket)))) throw new CloudError("not_found", "That bucket does not exist.");
        const entries = await request(tx.objectStore("objects").index("bucket").getAll(bucket)) as CloudObjectMetadata[];
        return entries.filter((entry) => entry.key.startsWith(prefix)).map(withGeneration).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      });
    },
    head: async (bucket: string, key: string): Promise<CloudObjectMetadata> => {
      bucketName(bucket); objectKey(key);
      return this.transaction(["objects"], "readonly", async (tx) => {
        const value = await request(tx.objectStore("objects").get([bucket, key])) as CloudObjectMetadata | undefined;
        if (!value) throw new CloudError("not_found", "That object does not exist."); return withGeneration(value);
      });
    },
    get: async (bucket: string, key: string): Promise<CloudObject> => {
      bucketName(bucket); objectKey(key);
      const object = await this.transaction(["objects", "object-data"], "readonly", async (tx) => {
        const value = await request(tx.objectStore("objects").get([bucket, key])) as CloudObjectMetadata | undefined;
        if (!value) throw new CloudError("not_found", "That object does not exist.");
        const data = await request(tx.objectStore("object-data").get([bucket, key])) as ObjectData | undefined;
        if (!data || !(data.body instanceof ArrayBuffer) || data.body.byteLength !== value.bytes) throw new CloudError("provider_error", "Stored object bytes are missing or have an unexpected length.");
        return { ...withGeneration(value), body: new Uint8Array(data.body) };
      });
      if (await digest(object.body) !== object.sha256) throw new CloudError("provider_error", "The stored object failed its SHA-256 integrity check.");
      return object;
    },
    put: async (bucket: string, key: string, input: string | Uint8Array | ArrayBuffer, options: ObjectPutOptions = {}): Promise<CloudObjectMetadata> => {
      this.beforeMutation();
      bucketName(bucket); objectKey(key); const match = conditions(options); const userMetadata = metadata(options.metadata);
      const contentType = options.contentType ?? (typeof input === "string" ? "text/plain; charset=utf-8" : "application/octet-stream");
      if (typeof contentType !== "string" || !contentType || contentType.length > 255 || /[^\x20-\x7e]/.test(contentType)) throw new CloudError("invalid_argument", "Use a printable content type within 255 characters.");
      if (!(typeof input === "string" || input instanceof Uint8Array || input instanceof ArrayBuffer)) throw new CloudError("invalid_argument", "Object data must be text, Uint8Array, or ArrayBuffer.");
      if (typeof input !== "string" && input.byteLength > MAX_OBJECT_BYTES) throw new CloudError("invalid_argument", "Keep individual objects within 64 MiB.");
      const body = typeof input === "string" ? new TextEncoder().encode(input) : input instanceof Uint8Array ? new Uint8Array(input) : new Uint8Array(input.slice(0));
      if (body.byteLength > MAX_OBJECT_BYTES) throw new CloudError("invalid_argument", "Keep individual objects within 64 MiB.");
      // Hash the private copy before opening the transaction; no asynchronous
      // non-IDB work is awaited while the transaction is active.
      const sha256 = await digest(body);
      const result = await this.transaction(["buckets", "objects", "object-data"], "readwrite", async (tx) => {
        if (!(await request(tx.objectStore("buckets").get(bucket)))) throw new CloudError("not_found", "Create the bucket before storing objects.");
        const store = tx.objectStore("objects"); const raw = await request(store.get([bucket, key])) as CloudObjectMetadata | undefined;
        const old = raw ? withGeneration(raw) : undefined;
        checkConditions(old, match); const now = Date.now();
        const value: CloudObjectMetadata = { bucket, key, bytes: body.byteLength, sha256, contentType, metadata: userMetadata, createdAt: old?.createdAt ?? now, updatedAt: now, revision: (old?.revision ?? 0) + 1, generation: old?.generation ?? crypto.randomUUID() };
        await request(store.put(value)); await request(tx.objectStore("object-data").put({ bucket, key, body: body.buffer }));
        return value;
      });
      this.changed("object", key, "written", bucket); return result;
    },
    delete: async (bucket: string, key: string, options: ObjectConditions = {}): Promise<{ bucket: string; key: string; deleted: boolean }> => {
      this.beforeMutation();
      bucketName(bucket); objectKey(key); const match = conditions(options);
      const result = await this.transaction(["objects", "object-data"], "readwrite", async (tx) => {
        const store = tx.objectStore("objects"); const raw = await request(store.get([bucket, key])) as CloudObjectMetadata | undefined;
        const old = raw ? withGeneration(raw) : undefined;
        checkConditions(old, match);
        if (!old) return { bucket, key, deleted: false };
        await request(store.delete([bucket, key])); await request(tx.objectStore("object-data").delete([bucket, key]));
        return { bucket, key, deleted: true };
      });
      if (result.deleted) this.changed("object", key, "deleted", bucket); return result;
    },
  });

  async close(): Promise<void> { if (this.database) { const db = await this.database; db.close(); this.database = null; } }

  private open(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new CloudError("storage_unavailable", "IndexedDB is unavailable in this browser context."));
    if (!this.database) this.database = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(storeError(error));
      };
      const timer = setTimeout(() => fail(new CloudError("storage_unavailable", "Opening the object store timed out. Close other pages using this origin and try again.")), 10000);
      let opening: IDBOpenDBRequest;
      try { opening = this.factory!.open(this.databaseName, 1); } catch (error) { fail(error); return; }
      opening.onupgradeneeded = () => {
        const db = opening.result;
        db.createObjectStore("buckets", { keyPath: "name" });
        db.createObjectStore("objects", { keyPath: ["bucket", "key"] }).createIndex("bucket", "bucket");
        db.createObjectStore("object-data", { keyPath: ["bucket", "key"] });
      };
      opening.onsuccess = () => {
        const db = opening.result;
        if (settled) { db.close(); return; }
        settled = true; clearTimeout(timer);
        db.onversionchange = () => { db.close(); this.database = null; };
        resolve(db);
      };
      opening.onerror = () => fail(opening.error);
      opening.onblocked = () => fail(new CloudError("storage_unavailable", "Another page is blocking this object-store database version."));
    }).catch((error) => { this.database = null; throw error; });
    return this.database;
  }

  private async transaction<T>(stores: string[], mode: IDBTransactionMode, work: (transaction: IDBTransaction) => Promise<T>): Promise<T> {
    let tx: IDBTransaction;
    try { const db = await this.open(); if (mode === "readwrite") this.beforeMutation(); tx = db.transaction(stores, mode); } catch (error) { throw storeError(error); }
    const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error("Object-store transaction aborted.")); tx.onerror = () => undefined; });
    void done.catch(() => undefined);
    try { const value = await work(tx); await done; return structuredClone(value); }
    catch (error) { try { tx.abort(); } catch { /* It may already be aborted. */ } await done.catch(() => undefined); throw storeError(error); }
  }
}
