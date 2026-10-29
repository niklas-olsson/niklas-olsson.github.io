// SPDX-License-Identifier: Apache-2.0
import { MAX_CHECKPOINT_BYTES, inspectCheckpoint, type CheckpointKind, type CheckpointProfile } from "./checkpoint-format.ts";
import { sha256Bytes } from "./evidence.ts";
import { publishResourceChange, subscribeResourceChanges, withResourceMutation, type ResourceChangeListener } from "./resource-events.ts";

export interface SnapshotDeleteOptions { ifSha256?: string }
export const subscribeSnapshotChanges = (listener: ResourceChangeListener): (() => void) => subscribeResourceChanges("snapshot", listener);

export interface SnapshotProvenance {
  origin: "created" | "imported";
  machineId?: string;
  machineName?: string;
  parentSha256?: string;
}

export interface SnapshotMeta {
  id: string;
  title: string;
  createdAt: number;
  size: number;
  runtime: string;
  sha256?: string;
  kind?: CheckpointKind;
  profileId?: CheckpointProfile;
  provenance?: SnapshotProvenance;
}

const DB_NAME = "terrarium-snapshots-v1";
const MAX_SNAPSHOTS = 3;

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DB_NAME, 1);
    const timer = setTimeout(() => fail(new Error("Snapshot storage did not open. Close other Terrarium tabs and retry.")), 10_000);
    const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
    request.onupgradeneeded = () => {
      request.result.createObjectStore("metadata", { keyPath: "id" });
      request.result.createObjectStore("state");
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true; clearTimeout(timer);
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => {
      fail(
        new Error(
          "Browser storage is unavailable. Use a snapshot download instead.",
        ),
      );
    };
    request.onblocked = () => {
      fail(
        new Error("Close other Terrarium tabs to update snapshot storage."),
      );
    };
  });
}

export async function listSnapshots(): Promise<SnapshotMeta[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db
        .transaction("metadata")
        .objectStore("metadata")
        .getAll();
      request.onsuccess = () => {
        const records = (request.result as unknown[]).filter(
          (value): value is SnapshotMeta => {
            if (!value || typeof value !== "object") return false;
            const record = value as Partial<SnapshotMeta>;
            return (
              typeof record.id === "string" &&
              record.id.length <= 100 &&
              typeof record.title === "string" &&
              record.title.length <= 80 &&
              typeof record.createdAt === "number" &&
              Number.isFinite(record.createdAt) &&
              typeof record.size === "number" &&
              record.size > 0 &&
              record.size <= MAX_CHECKPOINT_BYTES &&
              typeof record.runtime === "string" &&
              record.runtime.length <= 100 &&
              (record.kind === undefined || record.kind === "v86-checkpoint" || record.kind === "qemu-checkpoint") &&
              (record.profileId === undefined || record.profileId === "x86" || record.profileId === "alpine-x86_64") &&
              (record.sha256 === undefined ||
                /^[a-f0-9]{64}$/.test(record.sha256))
            );
          },
        );
        resolve(records.map((record) => record.profileId === undefined && record.runtime.startsWith("v86@")
          ? { ...record, kind: "v86-checkpoint" as const, profileId: "x86" as const }
          : record).sort((a, b) => b.createdAt - a.createdAt));
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function writeSnapshot(
  title: string,
  buffer: ArrayBuffer,
  provenance: SnapshotProvenance = { origin: "created" },
): Promise<SnapshotMeta> {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_CHECKPOINT_BYTES)
    throw new Error("Checkpoint exceeds the supported runtime size limit.");
  // Copy immediately, before asynchronous hashing or storage. Callers can
  // mutate their working copy without changing the preserved original.
  const original = buffer.slice(0);
  const inspection = await inspectCheckpoint(original);
  if (provenance.origin !== "created" && provenance.origin !== "imported")
    throw new Error("Unknown snapshot provenance.");
  const cleanProvenance: SnapshotProvenance = { origin: provenance.origin };
  if (provenance.machineId !== undefined) {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(provenance.machineId))
      throw new Error("Invalid source machine ID.");
    cleanProvenance.machineId = provenance.machineId;
  }
  if (provenance.machineName !== undefined)
    cleanProvenance.machineName = provenance.machineName.slice(0, 80);
  if (provenance.parentSha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/.test(provenance.parentSha256))
      throw new Error("Invalid parent checkpoint digest.");
    cleanProvenance.parentSha256 = provenance.parentSha256;
  }
  const sha256 = inspection.sha256;
  const db = await database();
  const meta: SnapshotMeta = {
    id: crypto.randomUUID(),
    title: title.trim().slice(0, 80) || "Untitled experiment",
    createdAt: Date.now(),
    size: original.byteLength,
    runtime: inspection.runtimeVersion,
    kind: inspection.kind,
    profileId: inspection.profileId,
    sha256,
    provenance: cleanProvenance,
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["metadata", "state"], "readwrite");
      const count = tx.objectStore("metadata").count();
      count.onsuccess = () => {
        if (count.result >= MAX_SNAPSHOTS) {
          tx.abort();
          reject(
            new Error(
              "Three snapshots are already saved. Download and remove one before adding another.",
            ),
          );
          return;
        }
        tx.objectStore("metadata").add(meta);
        tx.objectStore("state").add(original, meta.id);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () =>
        reject(
          new Error(
            "Could not save the snapshot. Browser storage may be full; use Download instead.",
          ),
        );
      tx.onabort = () =>
        reject(
          new Error(
            "Snapshot was not saved. Download it or free browser storage and retry.",
          ),
        );
    });
    publishResourceChange({ resource: "snapshot", action: "created", id: meta.id });
    return meta;
  } finally {
    db.close();
  }
}

export const storeSnapshot = (title: string, buffer: ArrayBuffer, provenance: SnapshotProvenance = { origin: "created" }): Promise<SnapshotMeta> => withResourceMutation("snapshot", () => writeSnapshot(title, buffer, provenance));

export async function readSnapshot(id: string): Promise<ArrayBuffer> {
  const db = await database();
  let original: ArrayBuffer;
  let metadata: SnapshotMeta | undefined;
  try {
    [original, metadata] = await new Promise<
      [ArrayBuffer, SnapshotMeta | undefined]
    >((resolve, reject) => {
      const tx = db.transaction(["state", "metadata"]);
      const state = tx.objectStore("state").get(id);
      const meta = tx.objectStore("metadata").get(id);
      tx.oncomplete = () =>
        state.result instanceof ArrayBuffer && meta.result?.id === id && meta.result.size === state.result.byteLength
          ? resolve([state.result, meta.result])
          : reject(new Error("Snapshot data or its matching preservation record was not found."));
      tx.onerror = tx.onabort = () =>
        reject(new Error("Could not read this snapshot."));
    });
  } finally {
    db.close();
  }
  if (original.byteLength > MAX_CHECKPOINT_BYTES) throw new Error("The stored checkpoint exceeds the supported runtime size limit.");
  if (metadata?.sha256 && (await sha256Bytes(original)) !== metadata.sha256)
    throw new Error(
      "The saved checkpoint failed SHA-256 verification. Its original bytes have not been replaced.",
    );
  return original;
}

async function removeSnapshot(id: string, options: SnapshotDeleteOptions): Promise<void> {
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new Error("Choose a valid saved snapshot ID.");
  const { ifSha256 } = options;
  if (ifSha256 !== undefined && (typeof ifSha256 !== "string" || !/^[a-f0-9]{64}$/.test(ifSha256)))
    throw new Error("A snapshot delete digest must be a lowercase SHA-256 value.");
  const db = await database();
  let deleted = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["metadata", "state"], "readwrite");
      let failure: Error | null = null;
      const metadata = tx.objectStore("metadata");
      const request = metadata.get(id);
      request.onsuccess = () => {
        if (ifSha256 !== undefined && request.result?.sha256 !== ifSha256) {
          failure = new Error("The snapshot changed since deletion was requested. Refresh its details and review the deletion again.");
          tx.abort(); return;
        }
        deleted = request.result !== undefined;
        metadata.delete(id);
        tx.objectStore("state").delete(id);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () =>
        reject(
          failure ?? new Error(
            "Snapshot deletion was interrupted. No change was committed.",
          ),
        );
    });
  } finally {
    db.close();
  }
  if (deleted) publishResourceChange({ resource: "snapshot", action: "deleted", id });
}

export const deleteSnapshot = (id: string, options: SnapshotDeleteOptions = {}): Promise<void> => withResourceMutation("snapshot", () => removeSnapshot(id, options));

export function downloadFile(
  name: string,
  data: BlobPart,
  type = "application/octet-stream",
): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
