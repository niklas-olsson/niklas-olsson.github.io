// SPDX-License-Identifier: Apache-2.0

export const MAX_EVIDENCE_FILES = 32;
export const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;
export const MAX_EVIDENCE_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_EVIDENCE_ARCHIVE_BYTES = 12 * 1024 * 1024;
export const MAX_EVIDENCE_PATH_BYTES = 256;

export interface EvidenceSource {
  method: "guest-assisted-logical";
  machineId?: string;
  machineName?: string;
  checkpointSha256?: string;
  /** The original checkpoint is never changed by acquisition. */
  guestExecuted: true;
}

export interface EvidenceFile {
  path: string;
  size: number;
  sha256: string;
  /** Immutable binary content, encoded for a self-contained portable archive. */
  base64: string;
}

export interface EvidenceArchive {
  kind: "terrarium-logical-evidence";
  version: 1;
  id: string;
  title: string;
  createdAt: number;
  source: Readonly<EvidenceSource>;
  files: readonly Readonly<EvidenceFile>[];
  totalBytes: number;
  /** SHA-256 of the canonical payload, including file bytes and provenance. */
  sha256: string;
}

export interface EvidenceInputFile {
  path: string;
  bytes: Uint8Array;
}

const encoder = new TextEncoder();
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9-]{1,64}$/;
const LIMITATION =
  "Guest-assisted logical capture. Guest commands and metadata can be misleading on a compromised system. This is not a disk image, a complete filesystem, or authenticated forensic acquisition.";
export const EVIDENCE_LIMITATION = LIMITATION;

export async function sha256Bytes(
  bytes: Uint8Array | ArrayBuffer,
): Promise<string> {
  if (!globalThis.crypto?.subtle)
    throw new Error("SHA-256 verification requires HTTPS or localhost.");
  const copy =
    bytes instanceof Uint8Array
      ? new Uint8Array(bytes)
      : new Uint8Array(bytes.slice(0));
  const hash = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function validateEvidencePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value === "/" ||
    encoder.encode(value).byteLength > MAX_EVIDENCE_PATH_BYTES ||
    /[\u0000-\u001f\u007f\\]/.test(value) ||
    value
      .split("/")
      .slice(1)
      .some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(
      "Choose a canonical absolute file path, without traversal, control characters, or backslashes (maximum 256 UTF-8 bytes).",
    );
  }
  return value;
}

export function validateEvidencePaths(values: readonly string[]): string[] {
  if (
    !Array.isArray(values) ||
    values.length < 1 ||
    values.length > MAX_EVIDENCE_FILES
  )
    throw new Error("Select between one and 32 regular files.");
  const paths = values.map(validateEvidencePath);
  if (new Set(paths).size !== paths.length)
    throw new Error("Each evidence path must be unique.");
  for (const path of paths) {
    if (paths.some((other) => other !== path && other.startsWith(path + "/")))
      throw new Error("An evidence file cannot also be a parent directory.");
  }
  return paths;
}

export function encodeEvidenceBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192)
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

export function decodeEvidenceBytes(
  file: Pick<EvidenceFile, "base64" | "size">,
): Uint8Array {
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > MAX_EVIDENCE_FILE_BYTES ||
    typeof file.base64 !== "string" ||
    file.base64.length !== 4 * Math.ceil(file.size / 3) ||
    /[^A-Za-z0-9+/=]/.test(file.base64)
  )
    throw new Error(
      "The evidence file has invalid binary content or exceeds the 1 MiB file limit.",
    );
  const padding = file.base64.indexOf("=");
  if (
    padding !== -1 &&
    (padding < file.base64.length - 2 ||
      !/^={1,2}$/.test(file.base64.slice(padding)))
  )
    throw new Error("The evidence file has invalid binary padding.");
  let binary: string;
  try {
    binary = atob(file.base64);
  } catch {
    throw new Error("The evidence file has invalid binary content.");
  }
  if (binary.length !== file.size)
    throw new Error(
      "An evidence file's declared size does not match its bytes.",
    );
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeEvidenceBytes(bytes) !== file.base64)
    throw new Error("The evidence content has a noncanonical encoding.");
  return bytes;
}

function sourceRecord(value: unknown): EvidenceSource {
  if (!value || typeof value !== "object")
    throw new Error("Evidence provenance is missing.");
  const source = value as Record<string, unknown>;
  if (
    source.method !== "guest-assisted-logical" ||
    source.guestExecuted !== true
  )
    throw new Error(
      "This archive does not declare a supported acquisition method.",
    );
  const result: EvidenceSource = {
    method: "guest-assisted-logical",
    guestExecuted: true,
  };
  if (source.machineId !== undefined) {
    if (typeof source.machineId !== "string" || !ID.test(source.machineId))
      throw new Error("Invalid source machine ID.");
    result.machineId = source.machineId;
  }
  if (source.machineName !== undefined) {
    if (
      typeof source.machineName !== "string" ||
      source.machineName.length > 80 ||
      /[\u0000-\u001f]/.test(source.machineName)
    )
      throw new Error("Invalid source machine name.");
    result.machineName = source.machineName;
  }
  if (source.checkpointSha256 !== undefined) {
    if (
      typeof source.checkpointSha256 !== "string" ||
      !DIGEST.test(source.checkpointSha256)
    )
      throw new Error("Invalid source checkpoint digest.");
    result.checkpointSha256 = source.checkpointSha256;
  }
  return result;
}

function payload(
  archive: Omit<EvidenceArchive, "sha256"> | EvidenceArchive,
): Omit<EvidenceArchive, "sha256"> {
  return {
    kind: "terrarium-logical-evidence",
    version: 1,
    id: archive.id,
    title: archive.title,
    createdAt: archive.createdAt,
    source: sourceRecord(archive.source),
    files: [...archive.files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((file) => ({
        path: file.path,
        size: file.size,
        sha256: file.sha256,
        base64: file.base64,
      })),
    totalBytes: archive.totalBytes,
  };
}

function freezeArchive(value: EvidenceArchive): EvidenceArchive {
  return Object.freeze({
    ...value,
    source: Object.freeze({ ...value.source }),
    files: Object.freeze(value.files.map((file) => Object.freeze({ ...file }))),
  });
}

export async function createEvidenceArchive(
  title: string,
  files: readonly EvidenceInputFile[],
  source: EvidenceSource,
): Promise<EvidenceArchive> {
  validateEvidencePaths(files.map((file) => file.path));
  let totalBytes = 0;
  const immutable = files.map((file) => {
    if (
      !(file.bytes instanceof Uint8Array) ||
      file.bytes.byteLength > MAX_EVIDENCE_FILE_BYTES
    )
      throw new Error("Each captured file is limited to 1 MiB.");
    totalBytes += file.bytes.byteLength;
    if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES)
      throw new Error("A logical capture is limited to 8 MiB in total.");
    return { path: file.path, bytes: new Uint8Array(file.bytes) };
  });
  const captured = await Promise.all(
    immutable.map(async (file) => ({
      path: file.path,
      size: file.bytes.byteLength,
      sha256: await sha256Bytes(file.bytes),
      base64: encodeEvidenceBytes(file.bytes),
    })),
  );
  const value = payload({
    kind: "terrarium-logical-evidence",
    version: 1,
    id: crypto.randomUUID(),
    title: title.trim().slice(0, 80) || "Logical file capture",
    createdAt: Date.now(),
    source: sourceRecord(source),
    files: captured,
    totalBytes,
  });
  const sha256 = await sha256Bytes(encoder.encode(JSON.stringify(value)));
  return freezeArchive({ ...value, sha256 });
}

export function exportEvidenceArchive(archive: EvidenceArchive): Uint8Array {
  return encoder.encode(
    JSON.stringify({ ...payload(archive), sha256: archive.sha256 }),
  );
}

export async function importEvidenceArchive(
  input: ArrayBuffer | Uint8Array | string,
): Promise<EvidenceArchive> {
  if (typeof input === "string" && input.length > MAX_EVIDENCE_ARCHIVE_BYTES)
    throw new Error("Evidence archives are limited to 12 MiB.");
  const bytes =
    typeof input === "string"
      ? encoder.encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  if (bytes.byteLength > MAX_EVIDENCE_ARCHIVE_BYTES)
    throw new Error("Evidence archives are limited to 12 MiB.");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("This is not a readable Terrarium evidence archive.");
  }
  if (!value || typeof value !== "object")
    throw new Error("Evidence metadata is missing.");
  const archive = value as Record<string, unknown>;
  if (
    archive.kind !== "terrarium-logical-evidence" ||
    archive.version !== 1 ||
    typeof archive.id !== "string" ||
    !ID.test(archive.id) ||
    typeof archive.title !== "string" ||
    archive.title.length > 80 ||
    typeof archive.createdAt !== "number" ||
    !Number.isSafeInteger(archive.createdAt) ||
    archive.createdAt < 0 ||
    typeof archive.sha256 !== "string" ||
    !DIGEST.test(archive.sha256) ||
    !Array.isArray(archive.files) ||
    archive.files.length < 1 ||
    archive.files.length > MAX_EVIDENCE_FILES
  )
    throw new Error(
      "The evidence archive has invalid or unsupported metadata.",
    );
  const files: EvidenceFile[] = [];
  let totalBytes = 0;
  for (const candidate of archive.files) {
    if (!candidate || typeof candidate !== "object")
      throw new Error("Invalid evidence file record.");
    const file = candidate as EvidenceFile;
    const path = validateEvidencePath(file.path);
    if (typeof file.sha256 !== "string" || !DIGEST.test(file.sha256))
      throw new Error("An evidence file is missing its SHA-256 digest.");
    const content = decodeEvidenceBytes(file);
    totalBytes += content.byteLength;
    if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES)
      throw new Error("A logical capture is limited to 8 MiB in total.");
    if ((await sha256Bytes(content)) !== file.sha256)
      throw new Error("File integrity verification failed for " + path + ".");
    files.push({
      path,
      size: content.byteLength,
      sha256: file.sha256,
      base64: file.base64,
    });
  }
  validateEvidencePaths(files.map((file) => file.path));
  if (archive.totalBytes !== totalBytes)
    throw new Error("The archive's total byte count does not match its files.");
  const canonical = payload({
    kind: "terrarium-logical-evidence",
    version: 1,
    id: archive.id,
    title: archive.title,
    createdAt: archive.createdAt,
    source: sourceRecord(archive.source),
    files,
    totalBytes,
  });
  if (
    (await sha256Bytes(encoder.encode(JSON.stringify(canonical)))) !==
    archive.sha256
  )
    throw new Error(
      "Archive integrity verification failed. The content or provenance changed.",
    );
  return freezeArchive({ ...canonical, sha256: archive.sha256 });
}

export function evidenceManifest(archive: EvidenceArchive): string {
  return JSON.stringify(
    {
      ...payload(archive),
      files: archive.files.map(({ path, size, sha256 }) => ({
        path,
        size,
        sha256,
      })),
      sha256: archive.sha256,
      limitation: LIMITATION,
    },
    null,
    2,
  );
}
