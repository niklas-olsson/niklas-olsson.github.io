// SPDX-License-Identifier: Apache-2.0
import {
  exportEvidenceArchive,
  importEvidenceArchive,
  type EvidenceArchive,
  type EvidenceSource,
} from "./evidence.ts";
import { publishResourceChange, subscribeResourceChanges, withResourceMutation, type ResourceChangeListener } from "./resource-events.ts";

export interface EvidenceDeleteOptions { ifSha256?: string }
export const subscribeEvidenceChanges = (listener: ResourceChangeListener): (() => void) => subscribeResourceChanges("evidence", listener);

export interface EvidenceMeta {
  id: string;
  title: string;
  createdAt: number;
  sha256: string;
  totalBytes: number;
  fileCount: number;
  source: Readonly<EvidenceSource>;
}

export const MAX_SAVED_EVIDENCE = 6;
const DB_NAME = "terrarium-evidence-v1";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(DB_NAME, 1);
    const timer = setTimeout(() => fail(new Error("Evidence storage did not open. Close other Terrarium tabs and retry.")), 10_000);
    const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
    request.onupgradeneeded = () => {
      request.result.createObjectStore("metadata", { keyPath: "id" });
      request.result.createObjectStore("archives");
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
          "Evidence storage is unavailable. Export the archive to keep it.",
        ),
      );
    };
    request.onblocked = () => {
      fail(
        new Error(
          "Close other Terrarium tabs before updating evidence storage.",
        ),
      );
    };
  });
}

function metadata(archive: EvidenceArchive): EvidenceMeta {
  return Object.freeze({
    id: archive.id,
    title: archive.title,
    createdAt: archive.createdAt,
    sha256: archive.sha256,
    totalBytes: archive.totalBytes,
    fileCount: archive.files.length,
    source: archive.source,
  });
}

export async function listEvidence(): Promise<EvidenceMeta[]> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db
        .transaction("metadata")
        .objectStore("metadata")
        .getAll();
      request.onsuccess = () =>
        resolve(
          (request.result as EvidenceMeta[])
            .filter(
              (record) =>
                record &&
                typeof record.id === "string" &&
                /^[a-zA-Z0-9-]{1,64}$/.test(record.id) &&
                typeof record.title === "string" &&
                record.title.length <= 80 &&
                typeof record.sha256 === "string" &&
                /^[a-f0-9]{64}$/.test(record.sha256) &&
                Number.isSafeInteger(record.createdAt) &&
                Number.isSafeInteger(record.totalBytes) &&
                record.totalBytes >= 0 &&
                record.totalBytes <= 8 * 1024 * 1024 &&
                Number.isInteger(record.fileCount) &&
                record.fileCount > 0 &&
                record.fileCount <= 32 &&
                record.source?.method === "guest-assisted-logical" &&
                record.source.guestExecuted === true,
            )
            .sort((a, b) => b.createdAt - a.createdAt),
        );
      request.onerror = () =>
        reject(new Error("Could not list saved evidence."));
    });
  } finally {
    db.close();
  }
}

async function writeEvidence(
  input: EvidenceArchive,
): Promise<EvidenceMeta> {
  // Verify before opening the transaction; WebCrypto must not outlive an IDB transaction.
  const bytes = exportEvidenceArchive(input);
  const archive = await importEvidenceArchive(bytes);
  const meta = metadata(archive);
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["metadata", "archives"], "readwrite");
      let reason =
        "Evidence was not saved. Export it or free browser storage and retry.";
      const count = tx.objectStore("metadata").count();
      count.onsuccess = () => {
        if (count.result >= MAX_SAVED_EVIDENCE) {
          reason =
            "Six evidence archives are already saved. Export and remove one before saving another.";
          tx.abort();
          return;
        }
        // add(), never put(): an original archive cannot be overwritten in place.
        const add = tx.objectStore("metadata").add(meta);
        add.onerror = () => {
          reason =
            "This evidence archive is already saved. Its original has not been replaced.";
        };
        tx.objectStore("archives").add(
          new Blob([bytes as Uint8Array<ArrayBuffer>], {
            type: "application/json",
          }),
          meta.id,
        );
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error(reason));
    });
    publishResourceChange({ resource: "evidence", action: "created", id: meta.id });
    return meta;
  } finally {
    db.close();
  }
}

export const storeEvidence = (input: EvidenceArchive): Promise<EvidenceMeta> => withResourceMutation("evidence", () => writeEvidence(input));

export async function readEvidence(id: string): Promise<EvidenceArchive> {
  const db = await database();
  let stored: unknown;
  let expected: EvidenceMeta | undefined;
  try {
    [stored, expected] = await new Promise<[unknown, EvidenceMeta | undefined]>(
      (resolve, reject) => {
        const tx = db.transaction(["archives", "metadata"]);
        const request = tx.objectStore("archives").get(id);
        const metadata = tx.objectStore("metadata").get(id);
        tx.oncomplete = () => resolve([request.result, metadata.result]);
        tx.onerror = tx.onabort = () =>
          reject(new Error("Could not read this evidence archive."));
      },
    );
  } finally {
    db.close();
  }
  if (!(stored instanceof Blob) || !expected)
    throw new Error("The saved evidence archive was not found.");
  const archive = await importEvidenceArchive(await stored.arrayBuffer());
  if (archive.id !== id || archive.sha256 !== expected.sha256)
    throw new Error(
      "The saved evidence differs from its preservation record. Its original has not been replaced.",
    );
  return archive;
}

async function removeEvidence(id: string, options: EvidenceDeleteOptions): Promise<void> {
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error("Choose a valid saved evidence ID.");
  const { ifSha256 } = options;
  if (ifSha256 !== undefined && (typeof ifSha256 !== "string" || !/^[a-f0-9]{64}$/.test(ifSha256)))
    throw new Error("An evidence delete digest must be a lowercase SHA-256 value.");
  const db = await database();
  let deleted = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["metadata", "archives"], "readwrite");
      let failure: Error | null = null;
      const metadata = tx.objectStore("metadata");
      const request = metadata.get(id);
      request.onsuccess = () => {
        if (ifSha256 !== undefined && request.result?.sha256 !== ifSha256) {
          failure = new Error("The evidence changed since deletion was requested. Refresh its details and review the deletion again.");
          tx.abort(); return;
        }
        deleted = request.result !== undefined;
        metadata.delete(id);
        tx.objectStore("archives").delete(id);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(failure ?? new Error("Evidence deletion did not complete."));
    });
  } finally {
    db.close();
  }
  if (deleted) publishResourceChange({ resource: "evidence", action: "deleted", id });
}

export const deleteEvidence = (id: string, options: EvidenceDeleteOptions = {}): Promise<void> => withResourceMutation("evidence", () => removeEvidence(id, options));
