// SPDX-License-Identifier: Apache-2.0
// Browser acceptance helper, deliberately separate from the shipped application.
// Requires a dedicated origin/profile with an empty volume inventory.
import {
  cloneVolume, createVolume, deleteVolume, exportVolume, exportVolumeTo, getVolume, listVolumes,
  openVolume, recoverVolumeCopies, snapshotVolume, VOLUME_DB_VERSION, type VolumeSession,
} from "../../src/lib/volume-store.ts";
import { Sha256Stream } from "../../src/lib/sha256-stream.ts";
import { VOLUME_CACHE_BYTES, VOLUME_PAGE_BYTES, VOLUME_TRANSFER_BYTES, type VolumeMeta } from "../../src/lib/volume-types.ts";

const MIB = 1024 * 1024, LOGICAL_BYTES = 8192 * MIB, DATA_CHUNKS = 256;
const DATA_SHA256 = "6f12bfa9dedc12e525a26920222e5e84fe9b4fc8c836d73ae123e9b80a22034a";
const DB_NAME = "terrarium-volumes-v1";
const COMPLETION = "TERRARIUM_S2_STORAGE_COMPLETE";
type JsonRecord = Record<string, unknown>;
export interface StorageAcceptanceStep {
  name: string; status: "running" | "passed" | "failed"; startedAt: string; elapsedMs?: number;
  observations?: JsonRecord; progress?: JsonRecord; error?: string;
}
export interface StorageAcceptanceReport {
  schema: "terrarium.s2-storage-acceptance.v1";
  status: "running" | "passed" | "failed";
  startedAt: string; finishedAt?: string; elapsedMs?: number; completionMarker?: string;
  evidenceClass: string; environment: JsonRecord; budgets: JsonRecord; limitations: string[];
  steps: StorageAcceptanceStep[]; storageEstimates: JsonRecord[]; artifacts: JsonRecord[];
  cleanup: JsonRecord; error?: string;
}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
const errorText = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);
const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index]);

function dataOffset(block: number): number {
  // Four MiB in each of 64 groups. Keep every generated filesystem metadata
  // area intact; these are raw free-block bytes, not a guest-created file.
  return (block % 64) * 128 * MIB + 4 * MIB + Math.floor(block / 64) * MIB;
}
function fillData(chunk: Uint8Array, block: number): void {
  let state = (0x9e3779b9 ^ Math.imul(block + 1, 0x85ebca6b)) | 0;
  if (!state) state = 1;
  for (let i = 0; i < chunk.length; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    chunk[i] = (state >>> 24) || 1; // All 256MiB are nonzero, without a short repeating pattern.
  }
}
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function inventoryCounts(): Promise<JsonRecord> {
  const db = await database();
  try { return await new Promise((resolve, reject) => {
    const tx = db.transaction(["metadata", "pages", "staging"]);
    const metadata = tx.objectStore("metadata").count(), pages = tx.objectStore("pages").count(), staging = tx.objectStore("staging").count();
    tx.oncomplete = () => resolve({ version: db.version, metadata: metadata.result, pages: pages.result, staging: staging.result });
    tx.onabort = tx.onerror = () => reject(tx.error);
  }); } finally { db.close(); }
}
async function expectRejection(action: () => Promise<unknown>, pattern: RegExp): Promise<string> {
  try { await action(); } catch (error) {
    const text = errorText(error); check(pattern.test(text), `Unexpected rejection: ${text}`); return text;
  }
  throw new Error(`The negative check unexpectedly succeeded (${pattern}).`);
}

/** Actual browser IndexedDB/Web Locks, with explicitly labeled failure injection. */
export async function runStorageAcceptance(options: { signal?: AbortSignal; onStep?: (step: StorageAcceptanceStep) => void } = {}): Promise<StorageAcceptanceReport> {
  const start = performance.now(), owned = new Set<string>(), sessions = new Set<VolumeSession>();
  const report: StorageAcceptanceReport = {
    schema: "terrarium.s2-storage-acceptance.v1", status: "running", startedAt: new Date().toISOString(),
    evidenceClass: "browser-e2e and resource-measurement: production storage APIs in an actual browser",
    environment: { userAgent: navigator.userAgent, origin: location.origin, crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency },
    budgets: { logicalBytes: LOGICAL_BYTES, streamedNonzeroBytes: DATA_CHUNKS * MIB, cacheBytesPerOpenVolume: VOLUME_CACHE_BYTES,
      transferBytes: VOLUME_TRANSFER_BYTES, copyBatchBytes: MIB, expectedDataSha256: DATA_SHA256, suggestedFixtureDeadlineMs: 30 * 60_000 },
    limitations: [
      "This helper validates actual browser storage APIs; it does not execute a guest or replace S2-G4 guest/reopen evidence.",
      "The quota branch uses an injected QuotaExceededError and a real transaction abort. Browser storage quota is not physically exhausted.",
      "Heap sampling is browser-reported when available. Per-process RSS and total browser memory require the external harness.",
      "The logical8GiB fixture contains256MiB of raw nonzero free-block data; the actual-guest filesystem fixture is separate.",
      "Schema-v1 upgrade must run in a separate fresh profile before the production app opens the database; this helper verifies schema2 and interrupted-copy recovery.",
      "These results describe this local test origin and browser, not a published production origin.",
    ], steps: [], storageEstimates: [], artifacts: [], cleanup: {},
  };
  const emit = (step: StorageAcceptanceStep) => { try { options.onStep?.(structuredClone(step)); } catch { /* Reporting cannot alter storage results. */ } };
  async function observe(label: string): Promise<void> {
    check(typeof navigator.storage?.estimate === "function", "Browser storage estimates are required for this resource fixture.");
    const estimate = await navigator.storage.estimate();
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    report.storageEstimates.push({ label, at: new Date().toISOString(), usage: estimate.usage ?? null, quota: estimate.quota ?? null,
      ...(memory ? { jsHeap: { used: memory.usedJSHeapSize, total: memory.totalJSHeapSize, limit: memory.jsHeapSizeLimit } } : {}) });
  }
  async function step<T extends JsonRecord>(name: string, work: (record: StorageAcceptanceStep) => Promise<T>): Promise<T> {
    options.signal?.throwIfAborted();
    const record: StorageAcceptanceStep = { name, status: "running", startedAt: new Date().toISOString() }, at = performance.now();
    report.steps.push(record); emit(record);
    try { const observations = await work(record); record.observations = observations; record.status = "passed"; return observations; }
    catch (error) { record.status = "failed"; record.error = errorText(error); throw error; }
    finally { record.elapsedMs = performance.now() - at; emit(record); }
  }
  function progress(record: StorageAcceptanceStep, value: JsonRecord): void { record.progress = value; emit(record); }
  async function open(id: string, readOnly = false): Promise<VolumeSession> {
    const session = await openVolume(id, { readOnly }); sessions.add(session); return session;
  }
  async function close(session: VolumeSession): Promise<void> {
    try { await session.close(); } finally { sessions.delete(session); }
  }
  async function verifyData(session: VolumeSession, record: StorageAcceptanceStep): Promise<string> {
    const hash = new Sha256Stream();
    for (let block = 0; block < DATA_CHUNKS; block++) {
      options.signal?.throwIfAborted();
      hash.update(await session.read(dataOffset(block), MIB));
      if (block % 16 === 15) progress(record, { phase: "verify-nonzero", bytes: (block + 1) * MIB, totalBytes: DATA_CHUNKS * MIB });
      check(session.getStorageStats().cacheBytes <= VOLUME_CACHE_BYTES, "Committed-page cache exceeded64MiB.");
    }
    const result = hash.digestHex(); check(result === DATA_SHA256, `256MiB digest mismatch: ${result}`); return result;
  }
  function copyObserver(record: StorageAcceptanceStep) {
    let previous = -128 * MIB, phase = "";
    return (value: { phase: string; completedBytes: number; totalBytes: number }) => {
      if (phase !== value.phase || value.completedBytes - previous >= 128 * MIB || value.completedBytes === value.totalBytes) {
        phase = value.phase; previous = value.completedBytes; progress(record, value);
      }
    };
  }
  async function measuredCopy(work: () => Promise<VolumeMeta>): Promise<{ metadata: VolumeMeta; maximumTransactionBytes: number; copiedBytes: number }> {
    const original = IDBObjectStore.prototype.add, amounts = new WeakMap<IDBTransaction, number>();
    let maximumTransactionBytes = 0, copiedBytes = 0;
    IDBObjectStore.prototype.add = function(value, key) {
      if (this.name === "pages" && value?.data instanceof Uint8Array) {
        const total = (amounts.get(this.transaction) ?? 0) + value.data.byteLength;
        amounts.set(this.transaction, total); maximumTransactionBytes = Math.max(maximumTransactionBytes, total); copiedBytes += value.data.byteLength;
      }
      return key === undefined ? original.call(this, value) : original.call(this, value, key);
    };
    try { const metadata = await work(); owned.add(metadata.id); return { metadata, maximumTransactionBytes, copiedBytes }; }
    finally { IDBObjectStore.prototype.add = original; }
  }
  let source: VolumeMeta | null = null, snapshot: VolumeMeta | null = null;
  try {
    await step("environment-and-empty-inventory", async () => {
      check(typeof indexedDB !== "undefined" && !!navigator.locks, "IndexedDB and Web Locks are required.");
      check(crossOriginIsolated, "The acceptance browser must use the production isolation headers.");
      check((await listVolumes()).length === 0, "Use a dedicated empty browser profile; existing volumes were not changed.");
      const counts = await inventoryCounts(); check(counts.staging === 0 && counts.pages === 0, "Use an empty volume database; preexisting or orphan pages were not changed.");
      check(counts.version === VOLUME_DB_VERSION, "Unexpected volume database schema.");
      await observe("before"); report.environment.storagePersisted = await navigator.storage.persisted();
      return counts;
    });
    await step("create-sparse8GiB", async () => {
      source = await createVolume({ name: "S2 browser acceptance sparse8GiB", sizeMiB: 8192 }); owned.add(source.id);
      const counts = await inventoryCounts(), session = await open(source.id);
      check(source.bytes === LOGICAL_BYTES && counts.pages === 65, "8GiB creation did not use exactly65 sparse formatter pages.");
      const stats = session.getStorageStats(); check(stats.cacheBytes === 0, "Opening a large volume eagerly allocated cache pages.");
      await close(session); report.artifacts.push({ kind: "source", metadata: source });
      return { metadata: source, counts, stats };
    });
    for (const mode of ["quota-exception", "native-abort"] as const) await step(`Failure injection:${mode}`, async () => {
      const session = await open(source!.id), offset = 32 * MIB + VOLUME_PAGE_BYTES - 7;
      const before = session.getMetadata(); await session.read(offset, 19);
      const original = IDBObjectStore.prototype.put; let attempts = 0;
      IDBObjectStore.prototype.put = function(value, key) {
        if (this.name === "pages" && value?.id === source!.id && ++attempts === 2) {
          if (mode === "native-abort") this.transaction.abort();
          throw new DOMException(`Failure injection ${mode}`, mode === "quota-exception" ? "QuotaExceededError" : "AbortError");
        }
        return key === undefined ? original.call(this, value) : original.call(this, value, key);
      };
      let writeError: string;
      try { writeError = await expectRejection(() => session.write(offset, new Uint8Array(19).fill(211)), /Failure injection/); }
      finally { IDBObjectStore.prototype.put = original; }
      check(attempts === 2, "Failure injection did not reach a second page in the same transaction.");
      check(equalBytes(session.cachedRead(offset, 19), new Uint8Array(19)), "Failed bytes became visible in the committed cache.");
      check((await getVolume(source!.id)).revision === before.revision, "Failed write advanced the durable revision.");
      const flushError = await expectRejection(() => session.flush(), /Failure injection/);
      const closeError = await expectRejection(() => close(session), /Failure injection/);
      const reopened = await open(source!.id, true);
      check(equalBytes(await reopened.read(offset, 19), new Uint8Array(19)), "Aborted first-page data survived reopen.");
      await close(reopened);
      return { mode, attempts, writeError, flushError, closeError, physicalQuotaExhausted: false, revisionUnchanged: true };
    });
    await step("interrupted-copy-recovery", async () => {
      const id = crypto.randomUUID(), db = await database();
      try { await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["pages", "staging"], "readwrite", { durability: "strict" });
        tx.objectStore("staging").add({ version: 1, id, token: crypto.randomUUID(), sourceId: source!.id, sourceRevision: 0, bytes: LOGICAL_BYTES, createdAt: Date.now(), nextIndex: 33 });
        for (let index = 0; index < 33; index++) tx.objectStore("pages").add({ id, index, data: new Uint8Array(VOLUME_PAGE_BYTES).fill(113) });
        tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
      }); } finally { db.close(); }
      const result = await recoverVolumeCopies({ signal: options.signal });
      check(result.recovered === 1 && result.removedPages === 33 && result.skippedActive === 0, "Recovery did not reclaim the owned unpublished copy.");
      const counts = await inventoryCounts(); check(counts.staging === 0 && counts.pages === 65 && counts.metadata === 1, "Recovery changed the source or retained partial pages.");
      return { setup: "Explicit journal fixture simulating33 previously committed unpublished pages; not a claimed tab crash", result, counts };
    });
    await step("stream256MiB-nonzero-and-evict", async (record) => {
      const session = await open(source!.id), chunk = new Uint8Array(MIB), generated = new Sha256Stream();
      for (let block = 0; block < DATA_CHUNKS; block++) {
        options.signal?.throwIfAborted(); fillData(chunk, block); generated.update(chunk);
        await session.write(dataOffset(block), chunk);
        const stats = session.getStorageStats(); check(stats.cacheBytes <= VOLUME_CACHE_BYTES, "The write cache exceeded64MiB.");
        if (block % 16 === 15) progress(record, { phase: "write-nonzero", bytes: (block + 1) * MIB, totalBytes: DATA_CHUNKS * MIB, stats });
      }
      check(generated.digestHex() === DATA_SHA256, "Generated data disagrees with the native-crypto reference digest.");
      const stats = session.getStorageStats();
      check(stats.peakCacheBytes === VOLUME_CACHE_BYTES && stats.cacheEvictions > 0, "The real64MiB LRU budget/eviction was not exercised.");
      let evicted = false; try { session.cachedRead(dataOffset(0), 1); } catch { evicted = true; }
      check(evicted, "The first streamed page was not evicted.");
      const digest = await verifyData(session, record); await session.flush();
      const finalStats = session.getStorageStats(); await close(session); await observe("after256MiB");
      return { nonzeroBytes: DATA_CHUNKS * MIB, sha256: digest, firstPageEvicted: evicted, stats, finalStats, counts: await inventoryCounts() };
    });
    await step("partial-high-offset-boundary-and-read-only", async () => {
      const session = await open(source!.id), offset = 4096 * MIB + 16 * MIB + VOLUME_PAGE_BYTES - 7;
      const bytes = Uint8Array.from({ length: 19 }, (_, i) => i + 17);
      await session.write(offset, bytes); await session.write(LOGICAL_BYTES - 5, new Uint8Array([251,252,253,254,255]));
      const expected = new Uint8Array(25); expected.set(bytes, 3);
      check(equalBytes(await session.read(offset - 3, 25), expected), "Cross-page partial-write boundaries changed.");
      await close(session);
      const ro = await open(source!.id, true), revision = ro.getMetadata().revision;
      const denied = await expectRejection(() => ro.write(offset, new Uint8Array([7])), /write protection/);
      check(equalBytes(await ro.read(offset, 19), bytes), "RO denial changed saved bytes.");
      check(equalBytes(await ro.read(LOGICAL_BYTES - 8, 8), new Uint8Array([0,0,0,251,252,253,254,255])), "The8GiB tail offset wrapped or truncated.");
      await close(ro); check((await getVolume(source!.id)).revision === revision, "RO denial advanced the revision.");
      const bufferedDenied = await expectRejection(() => exportVolume(source!.id), /streaming file sink/);
      return { offset, bytes: Array.from(bytes), tailOffset: LOGICAL_BYTES - 5, denied, bufferedDenied, revision };
    });
    await step("bounded-copy-and-independent-clone", async (record) => {
      const result = await measuredCopy(() => cloneVolume(source!.id, { name: "S2 independent clone", signal: options.signal, onProgress: copyObserver(record) }));
      check(result.maximumTransactionBytes <= MIB && result.copiedBytes >= DATA_CHUNKS * MIB, "The clone exceeded its1MiB transaction budget or omitted stored data.");
      const session = await open(result.metadata.id); const digest = await verifyData(session, record);
      await session.write(dataOffset(0), new Uint8Array([99])); await close(session);
      const original = await open(source!.id, true), expected = new Uint8Array(MIB); fillData(expected, 0);
      check((await original.read(dataOffset(0), 1))[0] === expected[0], "Clone mutation changed the original.");
      await close(original); await observe("after-clone");
      // The clone has been read back and independently mutated. Release this
      // owned fixture before creating the snapshot, keeping the measured test
      // within the browser's real origin quota rather than retaining three
      // 256 MiB copies simultaneously. Native quota rejection is a separate run.
      await deleteVolume(result.metadata.id); owned.delete(result.metadata.id);
      const afterDeletion = await inventoryCounts();
      check(afterDeletion.metadata === 1 && afterDeletion.staging === 0, "The completed clone was not independently reclaimed.");
      await observe("after-clone-deletion");
      report.artifacts.push({ kind: "clone", metadata: result.metadata, retained: false, explicitlyDeletedAfterVerification: true });
      return { metadata: result.metadata, maximumTransactionBytes: result.maximumTransactionBytes, copiedBytes: result.copiedBytes, sha256OfNonzeroData: digest, independentMutation: true,
        explicitlyDeletedAfterVerification: true, afterDeletion, maximumConcurrentCommittedCopies: 2 };
    });
    await step("bounded8GiB-snapshot", async (record) => {
      const result = await measuredCopy(() => snapshotVolume(source!.id, { name: "S2 immutable8GiB snapshot", signal: options.signal, onProgress: copyObserver(record) }));
      snapshot = result.metadata;
      check(snapshot.kind === "snapshot" && /^[a-f0-9]{64}$/.test(snapshot.sha256 ?? ""), "Snapshot digest or kind is missing.");
      check(result.maximumTransactionBytes <= MIB && result.copiedBytes >= DATA_CHUNKS * MIB, "Snapshot copy exceeded its1MiB transaction budget or omitted data.");
      report.artifacts.push({ kind: "snapshot", metadata: snapshot }); await observe("after-snapshot");
      return { metadata: snapshot, maximumTransactionBytes: result.maximumTransactionBytes, copiedBytes: result.copiedBytes, checkpointClaim: "Independent disk snapshot only; no VM state checkpoint" };
    });
    await step("stream-export8GiB-raw-hash-and-sink-backpressure", async (record) => {
      const sinkHash = new Sha256Stream(); let bytes = 0, maxChunk = 0, busy = false, sinkCompletionChecks = 0;
      // Hash the copied destination, not the source again. The snapshot's saved
      // SHA was accumulated from source bytes during the earlier copy.
      const exported = await exportVolumeTo(snapshot!.id, { async write(chunk) {
        check(!busy, "The exporter overlapped sink writes."); busy = true;
        check(chunk.length <= MIB, "The raw exporter exceeded its1MiB chunk budget.");
        sinkHash.update(chunk); bytes += chunk.length; maxChunk = Math.max(maxChunk, chunk.length);
        await Promise.resolve(); busy = false;
      } }, { signal: options.signal, onProgress(completedBytes, totalBytes) {
        check(!busy, "Export progress ran before the pending sink write completed.");
        sinkCompletionChecks++;
        if (completedBytes % (128 * MIB) === 0 || completedBytes === totalBytes) progress(record, { phase: "raw-export", completedBytes, totalBytes });
      } });
      const digest = sinkHash.digestHex();
      check(bytes === LOGICAL_BYTES && exported.bytesWritten === LOGICAL_BYTES && maxChunk === MIB, "Raw export byte accounting is incomplete.");
      check(sinkCompletionChecks > 0, "The exporter produced no sink-completion progress observations.");
      check(exported.sha256 === digest && snapshot!.sha256 === digest, "Raw export, independently accumulated sink and saved snapshot digests differ.");
      await observe("after-export");
      return { bytes, maximumChunkBytes: maxChunk, exportedSnapshotId: snapshot!.id, sinkCompletionChecks,
        storeSha256: exported.sha256, sinkSha256: digest, snapshotSha256: snapshot!.sha256, collectedBlobOrWholeArray: false };
    });
    report.status = "passed";
  } catch (error) { report.status = "failed"; report.error = errorText(error); }
  finally {
    const errors: string[] = [], removed: string[] = [];
    for (const session of sessions) { try { await session.close(); } catch (error) { errors.push(errorText(error)); } }
    // Cleanup never deletes preexisting user disks; the fixture starts empty and
    // records each committed destination before continuing to the next check.
    if (owned.size) {
      try { await recoverVolumeCopies(); } catch (error) { errors.push(errorText(error)); }
      for (const id of [...owned].reverse()) {
        try { await deleteVolume(id); removed.push(id); } catch (error) { errors.push(`${id}: ${errorText(error)}`); }
      }
      try { report.cleanup.counts = await inventoryCounts(); await observe("after-cleanup"); } catch (error) { errors.push(errorText(error)); }
    }
    report.cleanup = { ...report.cleanup, ownedIds: [...owned], removedIds: removed, errors };
    if (errors.length) { report.status = "failed"; report.error = `${report.error ?? ""} Cleanup incomplete: ${errors.join("; ")}`.trim(); }
    if (report.status === "passed") {
      const counts = report.cleanup.counts as JsonRecord | undefined;
      if (!counts || counts.metadata !== 0 || counts.pages !== 0 || counts.staging !== 0) { report.status = "failed"; report.error = "Owned fixture storage was not completely reclaimed."; }
    }
    report.finishedAt = new Date().toISOString(); report.elapsedMs = performance.now() - start;
    if (report.status === "passed") report.completionMarker = COMPLETION;
  }
  return report;
}
