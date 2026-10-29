// SPDX-License-Identifier: Apache-2.0
// Deterministic historical schema fixtures, stored in real browser origin data.
import { DEFAULT_MACHINE, MACHINE_STORAGE_KEY, VPC_STORAGE_KEY } from "../../src/lib/machine-config.ts";
import { DEFAULT_VPCS } from "../../src/lib/vpc-config.ts";
import { WORKSPACE_STORAGE_KEY, WORKSPACE_LOCK, loadWorkspaceManifest, commitWorkspaceManifest } from "../../src/lib/workspace-persistence.ts";
import { createExt2Pages } from "../../src/lib/volume-format.ts";
import { openVolume, getVolume, listVolumes } from "../../src/lib/volume-store.ts";
import { CloudObjectStore } from "../../src/lib/cloud-object-store.ts";
import { createEvidenceArchive, decodeEvidenceBytes, importEvidenceArchive } from "../../src/lib/evidence.ts";
import { storeEvidence, listEvidence, readEvidence } from "../../src/lib/evidence-store.ts";
import { Sha256Stream } from "../../src/lib/sha256-stream.ts";

const DISK_ID = "68d0132b-8750-4938-b9a4-23f0a93ff401";
const PAYLOAD = new TextEncoder().encode("Independent saved bytes · Terrarium åäö ☘\n");
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function oldDefinition(id: string, profile = "x86") {
  return { ...structuredClone(DEFAULT_MACHINE), id, name: id, profile, network: "isolated" };
}

/** Inspect the existing historical stores directly. In particular, this must
 * not call getVolume/openVolume or attribute their upgrade to application startup.
 * One 64 KiB page is live at a time; holes contribute exact zero bytes. */
async function rawDiskIdentity(db: IDBDatabase) {
  const pageBytes = 65536, logicalBytes = 4 * 1048576;
  return new Promise<{ databaseVersion: number; stores: string[]; metadata: Record<string, unknown>;
    logicalBytes: number; rawSha256: string; storedPages: number; maximumPageBytes: number }>((resolve, reject) => {
    const tx = db.transaction(["metadata", "pages"], "readonly"), digest = new Sha256Stream(), zero = new Uint8Array(pageBytes);
    const metadata = tx.objectStore("metadata").get(DISK_ID);
    const cursor = tx.objectStore("pages").openCursor(IDBKeyRange.bound([DISK_ID, 0], [DISK_ID, Number.MAX_SAFE_INTEGER]));
    let nextPage = 0, storedPages = 0, rawSha256 = "", failure: unknown;
    cursor.onsuccess = () => {
      try {
        const entry = cursor.result;
        if (entry) {
          const page = entry.value as { id: string; index: number; data: Uint8Array<ArrayBuffer> };
          check(page.id === DISK_ID && Number.isSafeInteger(page.index) && page.index >= nextPage && page.index < logicalBytes / pageBytes,
            "Historical disk contains an invalid or duplicate page index.");
          check(page.data instanceof Uint8Array && page.data.byteLength === pageBytes, "Historical disk page has an unexpected encoding or size.");
          while (nextPage < page.index) { digest.update(zero); nextPage++; }
          digest.update(page.data); nextPage++; storedPages++; entry.continue();
        } else {
          while (nextPage < logicalBytes / pageBytes) { digest.update(zero); nextPage++; }
          rawSha256 = digest.digestHex();
        }
      } catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => {
      try {
        check(metadata.result?.id === DISK_ID && metadata.result.bytes === logicalBytes, "Historical disk metadata is missing or its logical size changed.");
        check(rawSha256.length === 64, "Historical full-disk hash did not complete.");
        resolve({ databaseVersion: db.version, stores: [...db.objectStoreNames].sort(), metadata: metadata.result as Record<string, unknown>,
          logicalBytes, rawSha256, storedPages, maximumPageBytes: pageBytes });
      } catch (error) { reject(error); }
    };
    tx.onabort = tx.onerror = () => reject(failure ?? tx.error ?? new Error("Historical raw-disk inspection did not complete."));
  });
}

async function openExistingDatabase(name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => { request.transaction!.abort(); reject(new Error("Raw inspection must never create or upgrade a fixture database.")); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}

async function inspectExistingDiskDatabase() {
  const db = await openExistingDatabase("terrarium-volumes-v1");
  try { return await rawDiskIdentity(db); } finally { db.close(); }
}

/** Direct bounded readonly transactions only; no production store opener can
 * create or upgrade a database while the pre-commit interruption is observed. */
async function rawIndependentArtifacts() {
  const read = async (name: string, stores: string[]) => {
    const db = await openExistingDatabase(name);
    try {
      const records = await new Promise<Record<string, unknown[]>>((resolve, reject) => {
        const tx = db.transaction(stores, "readonly");
        const requests = stores.map(store => [store, tx.objectStore(store).getAll(undefined, 2)] as const);
        tx.oncomplete = () => resolve(Object.fromEntries(requests.map(([store, request]) => [store, request.result])));
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Raw independent-artifact inspection failed."));
      });
      for (const store of stores) check(records[store].length === 1, `The dedicated ${name}/${store} fixture was lost or duplicated.`);
      return { databaseVersion: db.version, stores: [...db.objectStoreNames].sort(), records };
    } finally { db.close(); }
  };
  const objects = await read("terrarium-cloud-objects-v1", ["buckets", "objects", "object-data"]);
  const data = objects.records["object-data"][0] as { bucket: string; key: string; body: ArrayBuffer };
  const metadata = objects.records.objects[0] as { bucket: string; key: string; bytes: number; sha256: string };
  check(data.bucket === "independent-retained" && data.key === "exact-bytes.bin" && data.body instanceof ArrayBuffer,
    "The historical raw object has an invalid identity or encoding.");
  check(metadata.bucket === data.bucket && metadata.key === data.key && metadata.bytes === data.body.byteLength,
    "The raw object metadata disagrees with its exact bytes.");
  const objectBodySha256 = await digest(new Uint8Array(data.body));
  check(objectBodySha256 === metadata.sha256, "The raw object failed its stored digest.");
  const evidence = await read("terrarium-evidence-v1", ["metadata", "archives"]);
  const blob = evidence.records.archives[0], meta = evidence.records.metadata[0] as { id: string; sha256: string };
  check(blob instanceof Blob && blob.size <= 8 * 1048576, "The raw historical archive has an invalid encoding or size.");
  const bytes = new Uint8Array(await blob.arrayBuffer()), archive = await importEvidenceArchive(bytes);
  check(archive.id === meta.id && archive.sha256 === meta.sha256, "The raw historical archive differs from its metadata.");
  return {
    objects: { databaseVersion: objects.databaseVersion, stores: objects.stores,
      bucket: objects.records.buckets[0], metadata: objects.records.objects[0], bodyBytes: data.body.byteLength, bodySha256: objectBodySha256 },
    evidence: { databaseVersion: evidence.databaseVersion, stores: evidence.stores, metadata: evidence.records.metadata[0],
      storedBytes: bytes.byteLength, storedSha256: await digest(bytes), archiveSha256: archive.sha256,
      fileSha256: await digest(new Uint8Array(decodeEvidenceBytes(archive.files[0]))) },
  };
}

/** Caller navigates an empty dedicated origin page, before loading the app. */
export async function seedMigrationFixture(kind: "v04" | "v07" | "empty" | "corrupt") {
  check(localStorage.length === 0, "Migration fixtures require a new isolated browser context with no user data.");
  const source = { publicV04Commit: "5a1363e4a351f2a470cbbe0d679e3bbc006f27eb",
    publicMachineSchemaSha256: "9e5ae55dde9e1605041c5da9c02cbebb2880b95a611c850496707c2af9a2b2de",
    publicVolumeStoreSha256: "6ba42a6f70393e205b7eabac2501db8be86b7357bcb0bde5b703fc4f931789f3",
    v07ArchiveSha256: "742c16b48c6859807e417945eb870916d46d573712951c55313be8de85efc19b" };
  const machines = kind === "empty" ? [] : [oldDefinition(kind === "v07" ? "v07-retained" : "v04-retained", kind === "v07" ? "alpine-x86_64" : "x86")];
  const vpcs = kind === "empty" ? [] : structuredClone(DEFAULT_VPCS);
  if (kind === "v04" || kind === "empty") {
    localStorage.setItem(MACHINE_STORAGE_KEY, JSON.stringify(machines)); localStorage.setItem(VPC_STORAGE_KEY, JSON.stringify(vpcs));
  } else localStorage.setItem(WORKSPACE_STORAGE_KEY, kind === "corrupt" ? "{incomplete-saved-manifest" : JSON.stringify({
    schema: "terrarium.workspace/v1", revision: 7, updatedAt: 1700000000000, activeId: machines[0].id, machines, vpcs,
    activity: [{ id: machines[0].id, status: "running", updatedAt: 1700000000001 }],
  }));
  const before = Object.fromEntries([MACHINE_STORAGE_KEY, VPC_STORAGE_KEY, WORKSPACE_STORAGE_KEY].map(key => [key, localStorage.getItem(key)]));
  // Exactly the old metadata/pages schema. The new store may only add staging.
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("terrarium-volumes-v1", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("metadata", { keyPath: "id" }); request.result.createObjectStore("pages", { keyPath: ["id", "index"] }); };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  let diskBefore;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["metadata", "pages"], "readwrite", { durability: "strict" });
      tx.objectStore("metadata").add({ id: DISK_ID, name: "independent-legacy-disk", bytes: 4 * 1048576, kind: "volume", filesystem: "ext2", createdAt: 1700000000000, updatedAt: 1700000000000, revision: 0, sha256: null });
      for (const page of createExt2Pages(4, DISK_ID)) tx.objectStore("pages").add({ id: DISK_ID, ...page });
      const data = new Uint8Array(65536); data.set(PAYLOAD); tx.objectStore("pages").put({ id: DISK_ID, index: 63, data });
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Historical disk fixture did not commit."));
    });
    diskBefore = await rawDiskIdentity(db);
    check(diskBefore.databaseVersion === 1 && diskBefore.stores.join(",") === "metadata,pages", "Seed must retain the exact DBv1 store layout before application startup.");
  } finally { db.close(); }
  const objects = new CloudObjectStore();
  await objects.buckets.create({ name: "independent-retained" });
  const object = await objects.objects.put("independent-retained", "exact-bytes.bin", PAYLOAD, { contentType: "application/octet-stream" });
  await objects.close();
  const archive = await createEvidenceArchive("Synthetic historical preservation fixture", [{ path: "/fixture/exact-bytes.bin", bytes: PAYLOAD }],
    { method: "guest-assisted-logical", guestExecuted: true, machineName: "synthetic-migration-fixture" });
  const evidence = await storeEvidence(archive);
  return { kind, source, before, diskId: DISK_ID, diskBefore, payloadBytes: PAYLOAD.length, payloadSha256: await digest(PAYLOAD), objectSha256: object.sha256,
    evidenceId: evidence.id, evidenceSha256: evidence.sha256, rawArtifacts: await rawIndependentArtifacts(),
    limitation: "Historical schema fixtures in a dedicated localhost context; not a read of the user's public-origin site data. The ext2 tail and logical archive contain synthetic preservation markers, not guest acquisition evidence. The archive source fields exercise the historical format only." };
}

export async function observeMigrationArtifacts(options: { rawOnly?: boolean } = {}) {
  // Capture the version before any production store call can upgrade it. This
  // separates startup from intentional independent-artifact inspection. An
  // invalid workspace can remain rejected while the independent disk is read.
  const workspaceSource = () => Object.fromEntries([MACHINE_STORAGE_KEY, VPC_STORAGE_KEY, WORKSPACE_STORAGE_KEY].map(key => [key, localStorage.getItem(key)]));
  const workspaceBeforeInspection = workspaceSource();
  const diskAfter = await inspectExistingDiskDatabase();
  if (options.rawOnly) {
    const rawArtifacts = await rawIndependentArtifacts();
    const diskAfterRawInspection = await inspectExistingDiskDatabase();
    return { inspectionMode: "raw-only", diskAfter, diskAfterRawInspection, rawArtifacts,
      workspaceBeforeInspection, workspaceAfterInspection: workspaceSource(),
      limitation: "Direct readonly transactions over existing databases only; no production storage opener, workspace commit or schema upgrade was invoked." };
  }
  const metadata = await getVolume(DISK_ID);
  const session = await openVolume(DISK_ID, { readOnly: true });
  let disk: Uint8Array<ArrayBuffer>;
  try { disk = await session.read(63 * 65536, PAYLOAD.length); } finally { await session.close(); }
  const objects = new CloudObjectStore(); const object = await objects.objects.get("independent-retained", "exact-bytes.bin");
  await objects.close();
  const evidence = await listEvidence(); check(evidence.length === 1, "The independent historical archive was lost or duplicated.");
  const archive = await readEvidence(evidence[0].id);
  const loaded = loadWorkspaceManifest(localStorage);
  const diskAfterProductionInspection = await inspectExistingDiskDatabase();
  return { inspectionMode: "production-artifact-read", diskId: metadata.id, diskAfter, diskAfterProductionInspection,
    databaseObservation: { beforeProductionInspection: diskAfter.databaseVersion, afterProductionInspection: diskAfterProductionInspection.databaseVersion,
      upgradeObservedDuring: diskAfter.databaseVersion === 1 && diskAfterProductionInspection.databaseVersion === 2 ? "explicit-independent-artifact-inspection" : "none-during-inspection",
      limitation: "A DBv1-to-DBv2 transition during explicit artifact inspection is not evidence of successful workspace startup migration." },
    workspaceBeforeInspection, workspaceAfterInspection: workspaceSource(),
    metadataThroughProductionApi: metadata, diskSha256: await digest(disk), objectSha256: object.sha256, objectBodySha256: await digest(new Uint8Array(object.body)),
    evidenceId: archive.id, evidenceSha256: archive.sha256, evidenceBodySha256: await digest(new Uint8Array(decodeEvidenceBytes(archive.files[0]))),
    manifest: loaded.manifest, error: loaded.error, raw: localStorage.getItem(WORKSPACE_STORAGE_KEY), legacy: { machines: localStorage.getItem(MACHINE_STORAGE_KEY), vpcs: localStorage.getItem(VPC_STORAGE_KEY) } };
}

/** Explicit corruption of one dedicated fixture's metadata; original bytes are retained. */
export async function corruptMigrationDiskMetadata() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("terrarium-volumes-v1"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const read = <T>(store: string, key: IDBValidKey) => new Promise<T>((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key); request.onsuccess = () => resolve(request.result as T); request.onerror = () => reject(request.error);
  });
  const write = (value: unknown) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction("metadata", "readwrite", { durability: "strict" }); tx.objectStore("metadata").put(value);
    tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Fixture metadata did not commit."));
  });
  const original = await read<Record<string, unknown>>("metadata", DISK_ID), corrupted = { ...original, bytes: 7 };
  const before = await read<{ data: Uint8Array<ArrayBuffer> }>("pages", [DISK_ID, 63]);
  try {
    await write(corrupted); let rejection = "";
    try { await listVolumes(); } catch (error) { rejection = error instanceof Error ? error.message : String(error); }
    check(rejection.length > 0, "Corrupt disk metadata must fail visibly, not disappear from the inventory.");
    const retained = await read<Record<string, unknown>>("metadata", DISK_ID), after = await read<{ data: Uint8Array<ArrayBuffer> }>("pages", [DISK_ID, 63]);
    check(JSON.stringify(retained) === JSON.stringify(corrupted), "Inventory inspection silently overwrote corrupt metadata.");
    check(await digest(new Uint8Array(before.data)) === await digest(new Uint8Array(after.data)), "Inventory inspection changed preserved page bytes.");
    return { rejection, metadataRetained: true, pageSha256: await digest(new Uint8Array(after.data)), failureClass: "explicit corruption of actual IndexedDB metadata in a dedicated fixture" };
  } finally { await write(original); db.close(); }
}

/** Actual localStorage bytes with an explicitly injected setItem failure. */
export async function migrationCommitFailure() {
  return navigator.locks.request(WORKSPACE_LOCK, async () => {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY), loaded = loadWorkspaceManifest(localStorage);
    check(!loaded.error && loaded.migrated, "Seed a valid v1 workspace before testing interrupted migration.");
    const before = JSON.stringify(loaded.manifest);
    const storage = { getItem: (key: string) => localStorage.getItem(key), setItem: () => { throw new DOMException("Injected migration quota failure", "QuotaExceededError"); } };
    let error = "";
    try { commitWorkspaceManifest(storage, loaded.manifest, { ...loaded.manifest }); } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    check(error.includes("not saved"), "Migration must report a failed atomic save.");
    check(localStorage.getItem(WORKSPACE_STORAGE_KEY) === raw, "Failed migration changed the old source bytes.");
    check(JSON.stringify(loadWorkspaceManifest(localStorage).manifest) === before, "Failed migration lost its recoverable definition.");
    return { error, originalPreserved: true, lastValidConfigurationPreserved: true, failureClass: "explicit StorageLike setItem rejection backed by real unchanged localStorage", beforeRaw: raw };
  });
}
