// SPDX-License-Identifier: Apache-2.0
import { createExt2Pages, type Ext2Page } from "./volume-format.ts";
import { Sha256Stream } from "./sha256-stream.ts";
import { publishResourceChange, subscribeResourceChanges, withResourceMutation, type ResourceChangeListener } from "./resource-events.ts";
import {
  DEFAULT_VOLUME_MIB,
  MAX_BUFFERED_VOLUME_MIB,
  VOLUME_CACHE_BYTES,
  VOLUME_PAGE_BYTES,
  VOLUME_TRANSFER_BYTES,
  VOLUME_WRITE_QUEUE_BYTES,
  isVolumeMeta,
  validateVolumeId,
  validateVolumeName,
  validateVolumeSize,
  type VolumeMeta,
  type VolumeExport,
  type VolumeStreamOptions,
  type VolumeStreamResult,
} from "./volume-types.ts";

export type { VolumeMeta, VolumeExport, VolumeStreamOptions, VolumeStreamResult } from "./volume-types.ts";
export interface VolumeDeleteOptions { ifRevision?: number; ifSha256?: string }
export interface VolumeCopyOptions {
  name?: string;
  signal?: AbortSignal;
  /** Copy progress counts logical address coverage, including sparse holes. */
  onProgress?: (progress: { phase: "hash" | "copy"; completedBytes: number; totalBytes: number }) => void;
}
export type VolumeDeletionGuard = (id: string) => (() => void) | Promise<() => void>;
const deletionGuards = new Set<VolumeDeletionGuard>();

/** Hold a workspace dependency lease for the entire deletion, including awaits. */
export function registerVolumeDeletionGuard(guard: VolumeDeletionGuard): () => void {
  deletionGuards.add(guard);
  return () => { deletionGuards.delete(guard); };
}

export const subscribeVolumeChanges = (listener: ResourceChangeListener): (() => void) => subscribeResourceChanges("volume", listener);
const DB_NAME = "terrarium-volumes-v1";
export const VOLUME_DB_VERSION = 2;
export const MAX_STAGED_VOLUME_COPIES = 4;
const COPY_BATCH_PAGES = VOLUME_TRANSFER_BYTES / VOLUME_PAGE_BYTES;
const STORES = ["metadata", "pages", "staging"];
interface PageRecord { id: string; index: number; data: Uint8Array<ArrayBuffer> }
interface CopyStage { version: 1; id: string; token: string; sourceId: string; sourceRevision: number; bytes: number; createdAt: number; nextIndex: number }
class VolumeBusyError extends Error {}

function storageError(error?: unknown): Error {
  const detail = error instanceof Error ? ` (${error.name}: ${error.message})` : "";
  return new Error("The volume transaction was not committed. Browser storage may be full or unavailable." + detail);
}

function database(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error("Durable volumes require browser IndexedDB storage."));
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DB_NAME, VOLUME_DB_VERSION);
    const timeout = setTimeout(() => fail(new Error("Volume storage did not open. Close other Terrarium tabs and retry.")), 10_000);
    const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timeout); reject(error); };
    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) {
        request.result.createObjectStore("metadata", { keyPath: "id" });
        request.result.createObjectStore("pages", { keyPath: ["id", "index"] });
      } else if (!request.result.objectStoreNames.contains("metadata") || !request.result.objectStoreNames.contains("pages")) {
        request.transaction!.abort(); return; // Never replace a damaged old inventory with empty stores.
      }
      // The v1 records and bytes are untouched. This schema-only upgrade is atomic.
      if (!request.result.objectStoreNames.contains("staging")) request.result.createObjectStore("staging", { keyPath: "id" });
    };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true; clearTimeout(timeout);
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => fail(storageError(request.error));
    request.onblocked = () => fail(new Error("Close other Terrarium tabs before updating volume storage."));
  });
}

function transaction(db: IDBDatabase, mode: IDBTransactionMode): IDBTransaction {
  return db.transaction(STORES, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
}

function pageRange(id: string): IDBKeyRange {
  return IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
}

/** A held Web Lock is released automatically if its owning tab disappears. */
async function acquire(id: string, mode: "exclusive" | "shared" = "exclusive"): Promise<() => Promise<void>> {
  if (!globalThis.navigator?.locks) throw new Error("Safe volume attachment requires the Web Locks API. Use a current browser over HTTPS or localhost.");
  let release!: () => void;
  let grant!: () => void;
  let rejectGrant!: (error: unknown) => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const granted = new Promise<void>((resolve, reject) => { grant = resolve; rejectGrant = reject; });
  const completed = navigator.locks.request(`terrarium-volume:${id}`, { mode, ifAvailable: true }, async (lock) => {
    if (!lock) { rejectGrant(new VolumeBusyError("This volume is attached or in use in another machine or tab. Stop and detach it before this operation.")); return; }
    grant();
    await held;
  });
  void completed.catch(rejectGrant);
  await granted;
  return async () => { release(); await completed; };
}

async function locked<T>(id: string, callback: () => Promise<T>): Promise<T> {
  validateVolumeId(id);
  const release = await acquire(id);
  try { return await callback(); } finally { await release(); }
}

function nonzero(bytes: Uint8Array): boolean { return bytes.some((byte) => byte !== 0); }

function validPage(value: unknown, metadata: VolumeMeta): PageRecord {
  const page = value as Partial<PageRecord>;
  if (!page || page.id !== metadata.id || !Number.isSafeInteger(page.index) || page.index! < 0
    || page.index! >= metadata.bytes / VOLUME_PAGE_BYTES || !(page.data instanceof Uint8Array)
    || page.data.byteLength !== VOLUME_PAGE_BYTES || !(page.data.buffer instanceof ArrayBuffer)
    || page.data.byteOffset !== 0 || page.data.buffer.byteLength !== VOLUME_PAGE_BYTES)
    throw new Error("The stored volume has an invalid disk page.");
  return page as PageRecord;
}

function requireCurrent(actual: unknown, expected: VolumeMeta): void {
  if (!isVolumeMeta(actual) || actual.id !== expected.id || actual.kind !== expected.kind || actual.revision !== expected.revision
    || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
    throw new Error("The volume changed outside its owning session. No stale write was committed; reopen it before reading or writing.");
}

async function metadataFrom(db: IDBDatabase, id: string): Promise<VolumeMeta> {
  const value = await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction("metadata");
    const request = tx.objectStore("metadata").get(id);
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = tx.onerror = () => reject(storageError(tx.error));
  });
  if (!isVolumeMeta(value) || value.id !== id) throw new Error("The volume was not found or its metadata is invalid.");
  return Object.freeze({ ...value });
}

/** The only getAll of page bytes is bounded to <=17 pages (one unaligned MiB). */
async function readPages(db: IDBDatabase, metadata: VolumeMeta, first: number, last: number): Promise<Map<number, Uint8Array<ArrayBuffer>>> {
  if (first < 0 || last < first || last - first > VOLUME_TRANSFER_BYTES / VOLUME_PAGE_BYTES)
    throw new Error("A volume page read exceeded its transfer budget.");
  return new Promise((resolve, reject) => {
    const tx = transaction(db, "readonly");
    const current = tx.objectStore("metadata").get(metadata.id);
    const request = tx.objectStore("pages").getAll(IDBKeyRange.bound([metadata.id, first], [metadata.id, last]));
    tx.oncomplete = () => {
      try {
        requireCurrent(current.result, metadata);
        const pages = new Map<number, Uint8Array<ArrayBuffer>>();
        for (const value of request.result) { const page = validPage(value, metadata); pages.set(page.index, page.data); }
        resolve(pages);
      } catch (error) { reject(error); }
    };
    tx.onabort = tx.onerror = () => reject(storageError(tx.error));
  });
}

/** Validate the sparse inventory with one cursor record live, never getAll(). */
async function validatePages(db: IDBDatabase, metadata: VolumeMeta, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const tx = transaction(db, "readonly");
    let failure: unknown;
    const current = tx.objectStore("metadata").get(metadata.id);
    const request = tx.objectStore("pages").openCursor(pageRange(metadata.id));
    request.onsuccess = () => {
      try { signal?.throwIfAborted(); if (request.result) { validPage(request.result.value, metadata); request.result.continue(); } }
      catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => { try { requireCurrent(current.result, metadata); resolve(); } catch (error) { reject(error); } };
    tx.onabort = tx.onerror = () => reject(failure ?? storageError(tx.error));
  });
}

async function readRange(db: IDBDatabase, metadata: VolumeMeta, offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const output = new Uint8Array(length);
  if (!length) return output;
  const first = Math.floor(offset / VOLUME_PAGE_BYTES), last = Math.floor((offset + length - 1) / VOLUME_PAGE_BYTES);
  const pages = await readPages(db, metadata, first, last);
  for (const [index, page] of pages) {
    const start = index * VOLUME_PAGE_BYTES, from = Math.max(offset, start), to = Math.min(offset + length, start + VOLUME_PAGE_BYTES);
    output.set(page.subarray(from - start, to - start), from - offset);
  }
  return output;
}

function streamChunkBytes(options: VolumeStreamOptions): number {
  const size = options.chunkBytes ?? VOLUME_TRANSFER_BYTES;
  if (!Number.isSafeInteger(size) || size < 1 || size > VOLUME_TRANSFER_BYTES)
    throw new Error("Volume stream chunks must contain 1–1048576 bytes.");
  return size;
}

async function streamImage(db: IDBDatabase, metadata: VolumeMeta, sink: { write(chunk: Uint8Array<ArrayBuffer>): void | Promise<void> } | null, options: VolumeStreamOptions = {}): Promise<VolumeStreamResult> {
  const chunkBytes = streamChunkBytes(options), hash = new Sha256Stream();
  options.signal?.throwIfAborted();
  await validatePages(db, metadata, options.signal);
  let bytesWritten = 0;
  for (let offset = 0; offset < metadata.bytes; offset += chunkBytes) {
    options.signal?.throwIfAborted();
    const bytes = await readRange(db, metadata, offset, Math.min(chunkBytes, metadata.bytes - offset));
    options.signal?.throwIfAborted();
    hash.update(bytes);
    if (sink) await sink.write(bytes); // The sink owns this chunk; never reused.
    bytesWritten += bytes.byteLength;
    options.onProgress?.(bytesWritten, metadata.bytes);
  }
  options.signal?.throwIfAborted();
  const sha256 = hash.digestHex();
  if (metadata.kind === "snapshot" && sha256 !== metadata.sha256)
    throw new Error("The preserved volume snapshot failed SHA-256 verification. It was not attached or accepted as an export.");
  return { metadata, sha256, bytesWritten };
}

async function insertPages(metadata: VolumeMeta, pages: Iterable<Ext2Page>): Promise<void> {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = transaction(db, "readwrite");
      let failure: unknown;
      // add(), not put(): snapshots and new volumes cannot replace an original.
      try {
        for (const { index, data } of pages) {
          const page = validPage({ id: metadata.id, index, data }, metadata);
          if (nonzero(data)) tx.objectStore("pages").add(page);
        }
        tx.objectStore("metadata").add(metadata);
      } catch (error) { failure = error; tx.abort(); }
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(failure ?? storageError(tx.error));
    });
  } finally { db.close(); }
}

function validStage(value: unknown): CopyStage {
  const stage = value as Partial<CopyStage>;
  try {
    if (!stage || stage.version !== 1) throw new Error();
    validateVolumeId(stage.id); validateVolumeId(stage.token); validateVolumeId(stage.sourceId);
    validateVolumeSize(Number(stage.bytes) / 1024 / 1024);
    if (stage.id === stage.sourceId || typeof stage.bytes !== "number" || !Number.isSafeInteger(stage.sourceRevision) || stage.sourceRevision! < 0
      || !Number.isSafeInteger(stage.createdAt) || stage.createdAt! <= 0 || !Number.isSafeInteger(stage.nextIndex)
      || stage.nextIndex! < 0 || stage.nextIndex! > stage.bytes / VOLUME_PAGE_BYTES) throw new Error();
  } catch { throw new Error("The pending volume-copy journal is corrupt. Its bytes were retained for explicit recovery."); }
  return stage as CopyStage;
}

function requireStage(value: unknown, expected: CopyStage): void {
  const actual = validStage(value);
  if (actual.id !== expected.id || actual.token !== expected.token || actual.sourceId !== expected.sourceId
    || actual.sourceRevision !== expected.sourceRevision || actual.bytes !== expected.bytes
    || actual.createdAt !== expected.createdAt || actual.nextIndex !== expected.nextIndex)
    throw new Error("The pending volume-copy generation changed. No stale copy was published.");
}

async function beginCopyStage(db: IDBDatabase, source: VolumeMeta, id: string): Promise<CopyStage> {
  const stage: CopyStage = { version: 1, id, token: crypto.randomUUID(), sourceId: source.id, sourceRevision: source.revision, bytes: source.bytes, createdAt: Date.now(), nextIndex: 0 };
  await new Promise<void>((resolve, reject) => {
    const tx = transaction(db, "readwrite");
    let failure: unknown;
    const current = tx.objectStore("metadata").get(source.id), destination = tx.objectStore("metadata").get(id);
    const count = tx.objectStore("staging").count();
    count.onsuccess = () => {
      try {
        requireCurrent(current.result, source);
        if (destination.result !== undefined) throw new Error("A copied volume cannot replace an existing destination.");
        if (count.result >= MAX_STAGED_VOLUME_COPIES) throw new Error("The four-copy storage budget is full. Wait for active copies or recover interrupted copies.");
        tx.objectStore("staging").add(stage);
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(failure ?? storageError(tx.error));
  });
  return stage;
}

/** One strict transaction copies at most 1MiB. Only its final batch publishes metadata. */
async function copyPageBatch(db: IDBDatabase, source: VolumeMeta, metadata: VolumeMeta, stage: CopyStage, signal?: AbortSignal): Promise<{ stage: CopyStage; published: boolean }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const tx = transaction(db, "readwrite");
    let failure: unknown, copied = 0, published = false, next = stage;
    const fail = (error: unknown) => { failure ??= error; try { tx.abort(); } catch { /* Aborted or committed already; completion remains authoritative. */ } };
    const abort = () => fail(signal?.reason ?? new DOMException("Volume copy cancelled.", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    const current = tx.objectStore("metadata").get(source.id), destination = tx.objectStore("metadata").get(metadata.id);
    const pending = tx.objectStore("staging").get(stage.id);
    pending.onsuccess = () => {
      try {
        signal?.throwIfAborted(); requireCurrent(current.result, source); requireStage(pending.result, stage);
        if (destination.result !== undefined) throw new Error("A pending copy cannot overwrite a published volume.");
        const request = tx.objectStore("pages").openCursor(IDBKeyRange.bound([source.id, stage.nextIndex], [source.id, Number.MAX_SAFE_INTEGER]));
        request.onsuccess = () => {
          try {
            signal?.throwIfAborted();
            const cursor = request.result;
            if (!cursor) {
              tx.objectStore("metadata").add(metadata); tx.objectStore("staging").delete(stage.id); published = true; return;
            }
            const page = validPage(cursor.value, source);
            if (nonzero(page.data)) tx.objectStore("pages").add({ ...page, id: stage.id });
            copied++; next = { ...stage, nextIndex: page.index + 1 };
            if (copied >= COPY_BATCH_PAGES) tx.objectStore("staging").put(next);
            else cursor.continue();
          } catch (error) { fail(error); }
        };
      } catch (error) { fail(error); }
    };
    tx.oncomplete = () => { signal?.removeEventListener("abort", abort); resolve({ stage: next, published }); };
    tx.onabort = tx.onerror = () => { signal?.removeEventListener("abort", abort); reject(failure ?? storageError(tx.error)); };
  });
}

/** Destination lock must remain held until every unpublished batch is reclaimed. */
async function removeCopyStage(db: IDBDatabase, stage: CopyStage, signal?: AbortSignal): Promise<number> {
  let removed = 0, done = false;
  while (!done) {
    signal?.throwIfAborted();
    const result = await new Promise<{ count: number; done: boolean }>((resolve, reject) => {
      const tx = transaction(db, "readwrite");
      let failure: unknown, count = 0, finished = false;
      const destination = tx.objectStore("metadata").get(stage.id), pending = tx.objectStore("staging").get(stage.id);
      pending.onsuccess = () => {
        try {
          if (destination.result !== undefined) throw new Error("Copy recovery found a published destination. All metadata and pages were retained.");
          requireStage(pending.result, stage);
          const request = tx.objectStore("pages").openKeyCursor(pageRange(stage.id));
          request.onsuccess = () => {
            try {
              const cursor = request.result;
              if (!cursor) { tx.objectStore("staging").delete(stage.id); finished = true; return; }
              tx.objectStore("pages").delete(cursor.primaryKey); count++;
              if (count < COPY_BATCH_PAGES) cursor.continue();
            } catch (error) { failure = error; tx.abort(); }
          };
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve({ count, done: finished });
      tx.onabort = tx.onerror = () => reject(failure ?? storageError(tx.error));
    });
    removed += result.count; done = result.done;
  }
  return removed;
}

export interface VolumeCopyRecovery { recovered: number; skippedActive: number; removedPages: number }
/** Call on workspace recovery. Live copies are skipped through their destination Web Lock. */
export const recoverVolumeCopies = (options: { signal?: AbortSignal } = {}): Promise<VolumeCopyRecovery> => withResourceMutation("volume", async () => {
  const db = await database();
  const result: VolumeCopyRecovery = { recovered: 0, skippedActive: 0, removedPages: 0 };
  try {
    const stages = await new Promise<CopyStage[]>((resolve, reject) => {
      const tx = db.transaction("staging");
      const request = tx.objectStore("staging").getAll(undefined, MAX_STAGED_VOLUME_COPIES + 1);
      tx.oncomplete = () => {
        try {
          if (request.result.length > MAX_STAGED_VOLUME_COPIES) throw new Error("The copy journal exceeds its four-copy budget. It was retained for explicit recovery.");
          resolve(request.result.map(validStage));
        } catch (error) { reject(error); }
      };
      tx.onabort = tx.onerror = () => reject(storageError(tx.error));
    });
    for (const stage of stages) {
      options.signal?.throwIfAborted();
      let release: () => Promise<void>;
      try { release = await acquire(stage.id); }
      catch (error) { if (error instanceof VolumeBusyError) { result.skippedActive++; continue; } throw error; }
      try {
        // A copy can finish after the inventory read and before the lock grant.
        const current = await new Promise<unknown>((resolve, reject) => {
          const tx = db.transaction("staging"), request = tx.objectStore("staging").get(stage.id);
          tx.oncomplete = () => resolve(request.result); tx.onabort = tx.onerror = () => reject(storageError(tx.error));
        });
        if (current === undefined) continue;
        const latest = validStage(current);
        requireStage({ ...latest, nextIndex: stage.nextIndex }, stage);
        result.removedPages += await removeCopyStage(db, latest, options.signal); result.recovered++;
      } finally { await release(); }
    }
    return result;
  } finally { db.close(); }
});

async function createVolumeRecord(options: { name: string; sizeMiB?: number }): Promise<VolumeMeta> {
  const name = validateVolumeName(options.name);
  const size = validateVolumeSize(options.sizeMiB ?? DEFAULT_VOLUME_MIB);
  const id = crypto.randomUUID();
  const now = Date.now();
  const metadata: VolumeMeta = { id, name, bytes: size * 1024 * 1024, kind: "volume", filesystem: "ext2", createdAt: now, updatedAt: now, revision: 0, sha256: null };
  await insertPages(metadata, createExt2Pages(size, id));
  publishResourceChange({ resource: "volume", action: "created", id });
  return Object.freeze(metadata);
}

export const createVolume = (options: { name: string; sizeMiB?: number }): Promise<VolumeMeta> => withResourceMutation("volume", () => createVolumeRecord(options));

export async function listVolumes(): Promise<VolumeMeta[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("metadata");
      const request = tx.objectStore("metadata").getAll();
      tx.oncomplete = () => {
        try {
          if (request.result.some((record: unknown) => !isVolumeMeta(record)))
            throw new Error("Volume metadata is corrupt. Stored metadata and disk bytes were retained; the inventory was not replaced with an empty list.");
          resolve(request.result.sort((a: VolumeMeta, b: VolumeMeta) => b.createdAt - a.createdAt).map((record: VolumeMeta) => Object.freeze({ ...record })));
        } catch (error) { reject(error); }
      };
      tx.onabort = tx.onerror = () => reject(storageError(tx.error));
    });
  } finally { db.close(); }
}

export async function getVolume(id: string): Promise<VolumeMeta> {
  validateVolumeId(id);
  const db = await database();
  try {
    return await metadataFrom(db, id);
  } finally { db.close(); }
}

async function copyVolume(id: string, options: VolumeCopyOptions, kind: VolumeMeta["kind"]): Promise<VolumeMeta> {
  const suppliedName = options.name === undefined ? undefined : validateVolumeName(options.name);
  options.signal?.throwIfAborted();
  await recoverVolumeCopies({ signal: options.signal });
  return locked(id, async () => {
    const db = await database();
    let stage: CopyStage | null = null, published = false;
    let releaseDestination: (() => Promise<void>) | null = null;
    try {
      const source = await metadataFrom(db, id);
      const name = suppliedName ?? `${source.name.slice(0, 68)} ${kind === "snapshot" ? "snapshot" : "copy"}`;
      const now = Date.now();
      const metadata: VolumeMeta = { id: crypto.randomUUID(), name, bytes: source.bytes, kind, filesystem: "ext2", createdAt: now, updatedAt: now, revision: 0, sha256: null, sourceId: id };
      releaseDestination = await acquire(metadata.id);
      stage = await beginCopyStage(db, source, metadata.id); // Admit before expensive hashing.
      const progress = (phase: "hash" | "copy", completedBytes: number) => {
        try { options.onProgress?.({ phase, completedBytes, totalBytes: source.bytes }); } catch { /* Observers do not own committed copies. */ }
      };
      if (kind === "snapshot" || source.kind === "snapshot") {
        const result = await streamImage(db, source, null, { signal: options.signal, onProgress: (bytes) => progress("hash", bytes) });
        if (kind === "snapshot") metadata.sha256 = result.sha256;
      }
      while (!published) {
        const batch = await copyPageBatch(db, source, metadata, stage, options.signal);
        stage = batch.stage; published = batch.published;
        progress("copy", published ? source.bytes : stage.nextIndex * VOLUME_PAGE_BYTES);
      }
      publishResourceChange({ resource: "volume", action: "created", id: metadata.id });
      return Object.freeze(metadata);
    } catch (error) {
      if (stage && !published) {
        try { await removeCopyStage(db, stage); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "The volume copy failed. Unpublished pages remain in the recovery journal; the original and existing snapshots were retained."); }
      }
      throw error;
    } finally { db.close(); await releaseDestination?.(); }
  });
}

export const snapshotVolume = (id: string, options: VolumeCopyOptions = {}): Promise<VolumeMeta> => withResourceMutation("volume", () => copyVolume(id, options, "snapshot"));
export const cloneVolume = (id: string, options: VolumeCopyOptions = {}): Promise<VolumeMeta> => withResourceMutation("volume", () => copyVolume(id, options, "volume"));

export async function exportVolume(id: string): Promise<VolumeExport> {
  return locked(id, async () => {
    const db = await database();
    try {
      const metadata = await metadataFrom(db, id);
      if (metadata.bytes > MAX_BUFFERED_VOLUME_MIB * 1024 * 1024)
        throw new Error("Buffered export is limited to 128 MiB. Use exportVolumeTo with a streaming file sink for this disk.");
      const output = new Uint8Array(metadata.bytes);
      let offset = 0;
      const result = await streamImage(db, metadata, { write(chunk) { output.set(chunk, offset); offset += chunk.byteLength; } });
      return { metadata, buffer: output.buffer, sha256: result.sha256 };
    } finally { db.close(); }
  });
}

/** Stream a raw image while holding its offline lease. Caller owns sink commit/abort. */
export async function exportVolumeTo(id: string, sink: { write(chunk: Uint8Array<ArrayBuffer>): void | Promise<void> }, options: VolumeStreamOptions = {}): Promise<VolumeStreamResult> {
  if (!sink || typeof sink.write !== "function") throw new Error("Volume export requires a backpressured write sink.");
  streamChunkBytes(options); options.signal?.throwIfAborted();
  return locked(id, async () => {
    const db = await database();
    try { return await streamImage(db, await metadataFrom(db, id), sink, options); }
    finally { db.close(); }
  });
}

export async function hashVolume(id: string, options: VolumeStreamOptions = {}): Promise<VolumeStreamResult> {
  streamChunkBytes(options); options.signal?.throwIfAborted();
  return locked(id, async () => {
    const db = await database();
    try { return await streamImage(db, await metadataFrom(db, id), null, options); }
    finally { db.close(); }
  });
}

async function deleteVolumeRecord(id: string, options: VolumeDeleteOptions): Promise<void> {
  validateVolumeId(id);
  const { ifRevision, ifSha256 } = options;
  if (ifRevision !== undefined && (!Number.isSafeInteger(ifRevision) || ifRevision < 0))
    throw new Error("A volume delete revision must be a nonnegative safe integer.");
  if (ifSha256 !== undefined && (typeof ifSha256 !== "string" || !/^[a-f0-9]{64}$/.test(ifSha256)))
    throw new Error("A volume delete digest must be a lowercase SHA-256 value.");
  const releases: (() => void)[] = [];
  let deleted = false;
  try {
    for (const guard of [...deletionGuards]) releases.push(await guard(id));
    await locked(id, async () => {
      const db = await database();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = transaction(db, "readwrite");
          let failure: Error | null = null;
          const metadata = tx.objectStore("metadata");
          const request = metadata.get(id);
          request.onsuccess = () => {
            const current: unknown = request.result;
            if ((ifRevision !== undefined && (!isVolumeMeta(current) || current.revision !== ifRevision)) ||
                (ifSha256 !== undefined && (!isVolumeMeta(current) || current.sha256 !== ifSha256))) {
              failure = new Error("The volume changed since deletion was requested. Refresh its details and review the deletion again.");
              tx.abort(); return;
            }
            deleted = current !== undefined;
            metadata.delete(id);
            tx.objectStore("pages").delete(pageRange(id));
          };
          tx.oncomplete = () => resolve();
          tx.onabort = tx.onerror = () => reject(failure ?? storageError(tx.error));
        });
      } finally { db.close(); }
    });
  } finally {
    for (const release of releases.reverse()) {
      try { release(); } catch { /* A lease cleanup cannot undo a completed storage transaction. */ }
    }
  }
  if (deleted) publishResourceChange({ resource: "volume", action: "deleted", id });
}

export const deleteVolume = (id: string, options: VolumeDeleteOptions = {}): Promise<void> => withResourceMutation("volume", () => deleteVolumeRecord(id, options));

export interface VolumeSessionState {
  pendingWrites: number;
  lastPersistedAt: number | null;
  error: string | null;
}

export interface VolumeStorageStats {
  logicalBytes: number;
  cacheBytes: number;
  cacheLimitBytes: number;
  peakCacheBytes: number;
  cachePages: number;
  cacheHits: number;
  cacheMisses: number;
  cacheEvictions: number;
  queuedWriteBytes: number;
  peakQueuedWriteBytes: number;
  pendingOperations: number;
}

/** Sparse committed-page LRU. No session owns a logical-disk-sized array. */
export class VolumeSession {
  readonly readOnly: boolean;
  private metadata: VolumeMeta;
  private readonly cache = new Map<number, Uint8Array<ArrayBuffer>>();
  private readonly db: IDBDatabase;
  private readonly release: () => Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private closeOperation: Promise<void> | null = null;
  private closing = false;
  private closed = false;
  private failure: Error | null = null;
  private pending = 0;
  private operations = 0;
  private queuedWriteBytes = 0;
  private peakQueuedWriteBytes = 0;
  private peakCacheBytes = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheEvictions = 0;
  private persisted: number | null;
  private listeners = new Set<(state: VolumeSessionState) => void>();

  constructor(db: IDBDatabase, metadata: VolumeMeta, readOnly: boolean, release: () => Promise<void>) {
    this.db = db; this.metadata = metadata;
    this.readOnly = readOnly; this.release = release; this.persisted = metadata.updatedAt;
  }
  getMetadata(): VolumeMeta { return this.metadata; }
  getState(): VolumeSessionState { return { pendingWrites: this.pending, lastPersistedAt: this.persisted, error: this.failure?.message ?? null }; }
  getStorageStats(): VolumeStorageStats {
    return {
      logicalBytes: this.metadata.bytes, cacheBytes: this.cache.size * VOLUME_PAGE_BYTES, cacheLimitBytes: VOLUME_CACHE_BYTES,
      peakCacheBytes: this.peakCacheBytes, cachePages: this.cache.size, cacheHits: this.cacheHits, cacheMisses: this.cacheMisses,
      cacheEvictions: this.cacheEvictions, queuedWriteBytes: this.queuedWriteBytes, peakQueuedWriteBytes: this.peakQueuedWriteBytes,
      pendingOperations: this.operations,
    };
  }
  subscribe(listener: (state: VolumeSessionState) => void): () => void {
    this.listeners.add(listener); listener(this.getState());
    return () => { this.listeners.delete(listener); };
  }
  private publish(): void { for (const listener of this.listeners) { try { listener(this.getState()); } catch { /* Observers do not own disk I/O. */ } } }
  private range(offset: number, length: number): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > this.metadata.bytes)
      throw new Error("Disk access is outside the attached volume.");
    if (length > VOLUME_TRANSFER_BYTES) throw new Error("A disk transfer exceeds the 1 MiB request budget.");
    if (this.closed) throw new Error("The volume is detached.");
  }
  private available(): void {
    if (this.closing) throw new Error("The volume is detaching.");
    if (this.failure) throw this.failure;
    if (this.operations >= 128) throw new Error("The volume I/O queue reached its 128-request budget. Await pending operations before retrying.");
  }
  private cachePage(index: number, data: Uint8Array<ArrayBuffer>): void {
    this.cache.delete(index);
    while (this.cache.size >= VOLUME_CACHE_BYTES / VOLUME_PAGE_BYTES) {
      this.cache.delete(this.cache.keys().next().value!); this.cacheEvictions++;
    }
    this.cache.set(index, data);
    this.peakCacheBytes = Math.max(this.peakCacheBytes, this.cache.size * VOLUME_PAGE_BYTES);
  }
  private async pages(first: number, last: number): Promise<Map<number, Uint8Array<ArrayBuffer>>> {
    const result = new Map<number, Uint8Array<ArrayBuffer>>();
    let missing = false;
    for (let index = first; index <= last; index++) {
      const page = this.cache.get(index);
      if (page) { this.cacheHits++; this.cache.delete(index); this.cache.set(index, page); result.set(index, page); }
      else { this.cacheMisses++; missing = true; }
    }
    if (missing) {
      const stored = await readPages(this.db, this.metadata, first, last);
      for (let index = first; index <= last; index++) if (!result.has(index)) {
        const page = stored.get(index) ?? new Uint8Array(VOLUME_PAGE_BYTES);
        this.cachePage(index, page); result.set(index, page);
      }
    }
    return result;
  }
  private enqueue<T>(operation: () => Promise<T>, finished: () => void = () => undefined): Promise<T> {
    this.operations++;
    const task = this.tail.then(async () => { if (this.failure) throw this.failure; return operation(); });
    const settled = task.then((value) => { this.operations--; finished(); return value; }, (error: unknown) => {
      this.failure ??= error instanceof Error ? error : new Error(String(error));
      this.operations--; finished(); this.publish(); throw error;
    });
    this.tail = settled.then(() => undefined, () => undefined);
    return settled;
  }
  /** Diagnostic compatibility view only. Uncached ranges require async read(). */
  cachedRead(offset: number, length: number): Uint8Array<ArrayBuffer> {
    this.range(offset, length);
    const output = new Uint8Array(length);
    for (let at = 0; at < length;) {
      const absolute = offset + at, index = Math.floor(absolute / VOLUME_PAGE_BYTES), start = absolute % VOLUME_PAGE_BYTES;
      const count = Math.min(length - at, VOLUME_PAGE_BYTES - start), page = this.cache.get(index);
      if (!page) throw new Error("This page is not cached. Use the bounded asynchronous volume read API.");
      output.set(page.subarray(start, start + count), at); at += count;
    }
    return output; // Never expose a mutable cache page.
  }
  async read(offset: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
    this.range(offset, length); this.available();
    return this.enqueue(async () => {
      const output = new Uint8Array(length);
      if (!length) return output;
      const first = Math.floor(offset / VOLUME_PAGE_BYTES), last = Math.floor((offset + length - 1) / VOLUME_PAGE_BYTES);
      const pages = await this.pages(first, last);
      for (const [index, page] of pages) {
        const start = index * VOLUME_PAGE_BYTES, from = Math.max(offset, start), to = Math.min(offset + length, start + VOLUME_PAGE_BYTES);
        output.set(page.subarray(from - start, to - start), from - offset);
      }
      return output;
    });
  }
  write(offset: number, input: Uint8Array): Promise<void> {
    try {
      if (!(input instanceof Uint8Array)) throw new Error("Disk writes require a byte array.");
      this.range(offset, input.byteLength);
      if (this.readOnly) throw new Error("Host write protection rejected a write to a read-only volume. The preserved disk bytes were not changed.");
      this.available();
      if (this.queuedWriteBytes + input.byteLength > VOLUME_WRITE_QUEUE_BYTES)
        throw new Error("The volume write queue reached its 8 MiB payload budget. Await committed writes before retrying.");
    } catch (error) { return Promise.reject(error); }
    if (!input.byteLength) return Promise.resolve();
    const data = Uint8Array.from(input);
    this.queuedWriteBytes += data.byteLength;
    this.peakQueuedWriteBytes = Math.max(this.peakQueuedWriteBytes, this.queuedWriteBytes);
    this.pending++;
    const task = this.enqueue(async () => {
      const expected = this.metadata;
      if (expected.revision >= Number.MAX_SAFE_INTEGER) throw new Error("The volume revision counter is exhausted. No write was committed.");
      const next = Object.freeze({ ...expected, revision: expected.revision + 1, updatedAt: Math.max(Date.now(), expected.updatedAt), sha256: null });
      const first = Math.floor(offset / VOLUME_PAGE_BYTES);
      const last = Math.floor((offset + data.byteLength - 1) / VOLUME_PAGE_BYTES);
      const existing = await this.pages(first, last);
      const changed: PageRecord[] = [];
      for (let index = first; index <= last; index++) {
        const start = index * VOLUME_PAGE_BYTES;
        const page = existing.get(index)!.slice();
        const from = Math.max(start, offset), to = Math.min(start + VOLUME_PAGE_BYTES, offset + data.byteLength);
        page.set(data.subarray(from - offset, to - offset), from - start);
        changed.push({ id: expected.id, index, data: page });
      }
      await new Promise<void>((resolve, reject) => {
        const tx = transaction(this.db, "readwrite");
        let failure: Error | null = null;
        const request = tx.objectStore("metadata").get(expected.id);
        request.onsuccess = () => {
          const actual = request.result;
          try {
            requireCurrent(actual, expected);
            if (expected.kind !== "volume") throw new Error("Host write protection rejected a snapshot mutation.");
            for (const page of changed) {
              if (nonzero(page.data)) tx.objectStore("pages").put(page);
              else tx.objectStore("pages").delete([expected.id, page.index]);
            }
            tx.objectStore("metadata").put(next);
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
            try { tx.abort(); } catch { /* A native abort may already have made the transaction inactive. */ }
          }
        };
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(failure ?? storageError(tx.error));
      });
      // The LRU only receives changed bytes after the strict transaction commits.
      for (const page of changed) this.cachePage(page.index, page.data);
      this.metadata = next;
      this.persisted = next.updatedAt;
    }, () => { this.pending--; this.queuedWriteBytes -= data.byteLength; this.publish(); });
    // Publish only after joining the queue: a synchronous observer may enqueue
    // another write, which must follow this already accepted request.
    this.publish();
    return task;
  }
  async flush(): Promise<void> {
    // A callback can queue another write while a previous completion runs.
    let observed: Promise<void>;
    do { observed = this.tail; await observed; } while (observed !== this.tail);
    if (this.failure) throw this.failure;
  }
  close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    if (this.closed) return Promise.resolve();
    this.closing = true;
    this.closeOperation = (async () => {
      try { await this.flush(); }
      finally { this.closed = true; this.cache.clear(); this.db.close(); await this.release(); this.listeners.clear(); }
    })();
    return this.closeOperation;
  }
}

export async function openVolume(id: string, options: { readOnly?: boolean } = {}): Promise<VolumeSession> {
  validateVolumeId(id);
  const initial = await getVolume(id);
  const readOnly = options.readOnly === true || initial.kind === "snapshot";
  const release = await acquire(id, readOnly ? "shared" : "exclusive");
  let db: IDBDatabase | undefined;
  try {
    db = await database();
    const metadata = await metadataFrom(db, id);
    if (metadata.kind === "snapshot") await streamImage(db, metadata, null);
    else await validatePages(db, metadata);
    return new VolumeSession(db, metadata, readOnly || metadata.kind === "snapshot", release);
  } catch (error) { db?.close(); await release(); throw error; }
}
