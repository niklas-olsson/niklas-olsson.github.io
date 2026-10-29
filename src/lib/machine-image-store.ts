// SPDX-License-Identifier: Apache-2.0
import { canonicalMachineImageManifest, inspectMachineImage, MACHINE_IMAGE_MAX_BYTES,
  validateMachineImageManifest, type MachineImageManifest, type ValidatedMachineImage } from "./machine-image.ts";
import { Sha256Stream } from "./sha256-stream.ts";
import { publishResourceChange, subscribeResourceChanges, withResourceMutation, type ResourceChangeListener } from "./resource-events.ts";

export const MACHINE_IMAGE_DATABASE = "terrarium-machine-images-v1";
export const MAX_SAVED_MACHINE_IMAGES = 8;
export const MAX_MACHINE_IMAGE_STORE_BYTES = 1024 * 1024 * 1024;

export interface MachineImageMeta {
  readonly schema: "terrarium.machine-image-record/v1";
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly totalBytes: number;
  readonly manifest: MachineImageManifest;
}

export interface MachineImageStoreOptions {
  /** Separate databases are used by tests and isolated workspaces, never supplied by an image manifest. */
  readonly databaseName?: string;
  readonly signal?: AbortSignal;
}

export interface MachineImageDeleteOptions extends MachineImageStoreOptions {
  readonly ifSha256?: string;
  /** Check current durable definitions/checkpoints and active machines while the exclusive image lock is held. */
  readonly assertUnreferenced: (id: string) => void | Promise<void>;
}

function validId(id: string): void {
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new Error("Choose a valid content-addressed machine image ID.");
}

function dbName(options: MachineImageStoreOptions): string {
  const name = options.databaseName ?? MACHINE_IMAGE_DATABASE;
  if (typeof name !== "string" || name.length < 1 || name.length > 160 || !/^[a-zA-Z0-9._-]+$/.test(name))
    throw new Error("The image database name is invalid.");
  return name;
}

function scope(options: MachineImageStoreOptions): string | undefined {
  const name = dbName(options);
  return name === MACHINE_IMAGE_DATABASE ? undefined : name;
}

function database(options: MachineImageStoreOptions): Promise<IDBDatabase> {
  options.signal?.throwIfAborted();
  const name = dbName(options);
  return new Promise((resolve, reject) => {
    let settled = false;
    if (typeof indexedDB === "undefined") { reject(new Error("Browser image storage is unavailable.")); return; }
    const request = indexedDB.open(name, 1);
    const finish = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); };
    const fail = (error: unknown) => { if (settled) return; settled = true; finish(); reject(error); };
    const timer = setTimeout(() => fail(new Error("Image storage did not open. Close other Terrarium tabs and retry.")), 10_000);
    const cancel = () => fail(options.signal?.reason ?? new DOMException("Image operation cancelled.", "AbortError"));
    options.signal?.addEventListener("abort", cancel, { once: true });
    request.onupgradeneeded = () => {
      if (settled) { request.transaction?.abort(); return; }
      request.result.createObjectStore("metadata", { keyPath: "id" });
      request.result.createObjectStore("bundles");
    };
    request.onsuccess = () => {
      if (settled) { request.result.close(); return; }
      settled = true; finish();
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => fail(new Error("Image storage is unavailable; keep the original bundle and retry."));
    request.onblocked = () => fail(new Error("Close other Terrarium tabs before updating image storage."));
  });
}

function metadata(value: unknown): MachineImageMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Saved image metadata is invalid and has been quarantined.");
  const data = value as Record<string, unknown>;
  const keys = ["schema", "id", "name", "createdAt", "totalBytes", "manifest"];
  if (Object.keys(data).length !== keys.length || Object.keys(data).some((key) => !keys.includes(key)) ||
      data.schema !== "terrarium.machine-image-record/v1" || typeof data.id !== "string" ||
      !Number.isSafeInteger(data.createdAt) || (data.createdAt as number) < 0)
    throw new Error("Saved image metadata is invalid and has been quarantined.");
  validId(data.id);
  const manifest = validateMachineImageManifest(data.manifest);
  const encoded = new TextEncoder().encode(canonicalMachineImageManifest(manifest));
  const id = new Sha256Stream().update(encoded).digestHex();
  const totalBytes = 12 + encoded.byteLength + manifest.components.kernel.bytes + manifest.components.initramfs.bytes + manifest.components.rootfs.bytes;
  if (id !== data.id || data.name !== manifest.guest.name || data.totalBytes !== totalBytes || totalBytes > MACHINE_IMAGE_MAX_BYTES)
    throw new Error("Saved image identity or size differs from its metadata; the record has been quarantined.");
  return Object.freeze({ schema: "terrarium.machine-image-record/v1", id, name: manifest.guest.name,
    createdAt: data.createdAt as number, totalBytes, manifest });
}

async function lock<T>(id: string, mode: "shared" | "exclusive", work: () => Promise<T>, options: MachineImageStoreOptions): Promise<T> {
  validId(id); options.signal?.throwIfAborted();
  if (typeof navigator === "undefined" || !navigator.locks)
    return Promise.reject(new Error("Machine image assignment and changes require browser Web Locks for safe cross-tab coordination."));
  return await navigator.locks.request(`terrarium.image.${dbName(options)}.${id}`, { mode, ...(options.signal ? { signal: options.signal } : {}) }, work);
}

/** Hold this through the durable machine-definition write, so deletion cannot race a new reference. */
export function withMachineImageLease<T>(id: string, work: () => Promise<T>, options: MachineImageStoreOptions = {}): Promise<T> {
  return lock(id, "shared", work, options);
}

export const subscribeMachineImageChanges = (listener: ResourceChangeListener, options: MachineImageStoreOptions = {}): (() => void) =>
  subscribeResourceChanges("image", listener, scope(options));

export async function listMachineImages(options: MachineImageStoreOptions = {}): Promise<MachineImageMeta[]> {
  const db = await database(options);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("metadata");
      const request = tx.objectStore("metadata").getAll();
      tx.oncomplete = () => {
        try { resolve((request.result as unknown[]).map(metadata).sort((a, b) => b.createdAt - a.createdAt)); }
        catch (error) { reject(error); }
      };
      tx.onabort = tx.onerror = () => reject(new Error("Could not list saved machine images."));
    });
  } finally { db.close(); }
}

export async function getMachineImage(id: string, options: MachineImageStoreOptions = {}): Promise<MachineImageMeta | null> {
  validId(id);
  const db = await database(options);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("metadata");
      const request = tx.objectStore("metadata").get(id);
      tx.oncomplete = () => {
        try { resolve(request.result === undefined ? null : metadata(request.result)); }
        catch (error) { reject(error); }
      };
      tx.onabort = tx.onerror = () => reject(new Error("Could not inspect this saved machine image."));
    });
  } finally { db.close(); }
}

export async function readMachineImage(id: string, options: MachineImageStoreOptions = {}): Promise<ValidatedMachineImage> {
  validId(id);
  const db = await database(options);
  let stored: unknown, expected: MachineImageMeta;
  try {
    [stored, expected] = await new Promise<[unknown, MachineImageMeta]>((resolve, reject) => {
      const tx = db.transaction(["metadata", "bundles"]);
      const meta = tx.objectStore("metadata").get(id);
      const bundle = tx.objectStore("bundles").get(id);
      tx.oncomplete = () => {
        try {
          if (meta.result === undefined || bundle.result === undefined) throw new Error("The saved machine image was not found or is incomplete.");
          resolve([bundle.result, metadata(meta.result)]);
        } catch (error) { reject(error); }
      };
      tx.onabort = tx.onerror = () => reject(new Error("Could not read this saved machine image."));
    });
  } finally { db.close(); }
  if (!(stored instanceof Blob)) throw new Error("The saved image payload is invalid and has been quarantined.");
  const image = await inspectMachineImage(stored, options);
  if (image.id !== id || image.totalBytes !== expected.totalBytes ||
      canonicalMachineImageManifest(image.manifest) !== canonicalMachineImageManifest(expected.manifest))
    throw new Error("The saved image no longer matches its preservation record and has been quarantined.");
  return image;
}

/** Hashing finishes before the single metadata+payload transaction; any failed transaction leaves no partial image. */
export function importMachineImage(blob: Blob, options: MachineImageStoreOptions = {}): Promise<MachineImageMeta> {
  return withResourceMutation("image", async () => {
    const image = await inspectMachineImage(blob, options);
    const meta = metadata({ schema: "terrarium.machine-image-record/v1", id: image.id, name: image.manifest.guest.name,
      createdAt: Date.now(), totalBytes: image.totalBytes, manifest: image.manifest });
    return lock(image.id, "exclusive", async () => {
      const db = await database(options);
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(["metadata", "bundles"], "readwrite", { durability: "strict" });
          let failure: unknown = new Error("The machine image was not saved. Keep the original bundle, free browser storage, and retry.");
          const cancel = () => { failure = options.signal?.reason ?? new DOMException("Image import cancelled.", "AbortError"); try { tx.abort(); } catch { /* Already committed. */ } };
          options.signal?.addEventListener("abort", cancel, { once: true });
          const records = tx.objectStore("metadata").getAll();
          records.onsuccess = () => {
            try {
              options.signal?.throwIfAborted();
              const existing = (records.result as unknown[]).map(metadata);
              if (existing.some((item) => item.id === image.id)) throw new Error("This machine image is already saved; its immutable original has not been replaced.");
              if (existing.length >= MAX_SAVED_MACHINE_IMAGES) throw new Error("Eight machine images are already saved. Remove an unreferenced image before importing another.");
              if (existing.reduce((sum, item) => sum + item.totalBytes, 0) + image.totalBytes > MAX_MACHINE_IMAGE_STORE_BYTES)
                throw new Error("The 1 GiB saved-image budget would be exceeded. Remove an unreferenced image before importing another.");
              tx.objectStore("metadata").add(meta);
              tx.objectStore("bundles").add(image.blob, image.id);
            } catch (error) { failure = error; tx.abort(); }
          };
          tx.oncomplete = () => { options.signal?.removeEventListener("abort", cancel); resolve(); };
          tx.onabort = tx.onerror = () => { options.signal?.removeEventListener("abort", cancel); reject(failure); };
        });
      } finally { db.close(); }
      publishResourceChange({ resource: "image", action: "created", id: image.id, scope: scope(options) });
      return meta;
    }, options);
  });
}

export async function exportMachineImage(id: string, options: MachineImageStoreOptions = {}): Promise<Blob> {
  return (await readMachineImage(id, options)).blob;
}

export function deleteMachineImage(id: string, options: MachineImageDeleteOptions): Promise<void> {
  validId(id);
  if (!options || typeof options.assertUnreferenced !== "function")
    return Promise.reject(new Error("Image deletion requires a current dependency check; deleting a machine never deletes its image."));
  if (options.ifSha256 !== undefined && options.ifSha256 !== id)
    return Promise.reject(new Error("The image identity changed since deletion was requested."));
  return withResourceMutation("image", () => lock(id, "exclusive", async () => {
    await options.assertUnreferenced(id);
    options.signal?.throwIfAborted();
    const db = await database(options);
    let deleted = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["metadata", "bundles"], "readwrite", { durability: "strict" });
        const request = tx.objectStore("metadata").get(id);
        request.onsuccess = () => {
          deleted = request.result !== undefined;
          tx.objectStore("metadata").delete(id);
          tx.objectStore("bundles").delete(id);
        };
        tx.oncomplete = () => resolve();
        tx.onabort = tx.onerror = () => reject(new Error("Machine image deletion did not complete."));
      });
    } finally { db.close(); }
    if (deleted) publishResourceChange({ resource: "image", action: "deleted", id, scope: scope(options) });
  }, options));
}
