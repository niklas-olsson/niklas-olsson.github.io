// SPDX-License-Identifier: Apache-2.0
import { MAX_EVIDENCE_FILE_BYTES } from "./evidence.ts";

interface PinnedInode {
  size: number;
  mode: number;
  status: number;
}
interface Pinned9pFilesystem {
  SearchPath(path: string): { id: number };
  GetInode(id: number): PinnedInode;
  Read(id: number, offset: number, count: number): Promise<Uint8Array | null>;
}

/**
 * v86@0.5.472's public read_file() reads the entire host inode. Use its pinned
 * filesystem implementation to inspect size first and request only that many
 * bytes. Fail closed if this internal interface changes in a future runtime.
 *
 * This bounds extraction into an archive. It does not bound allocations made
 * earlier by v86's writable 9p server while executing guest requests.
 */
export async function readBounded9pFile(
  runtime: unknown,
  path: string,
): Promise<Uint8Array> {
  const fs = (runtime as { fs9p?: Pinned9pFilesystem } | null)?.fs9p;
  if (
    !fs ||
    typeof fs.SearchPath !== "function" ||
    typeof fs.GetInode !== "function" ||
    typeof fs.Read !== "function"
  )
    throw new Error(
      "The pinned host filesystem interface is unavailable. Evidence was not read.",
    );
  const entry = fs.SearchPath(path);
  if (!Number.isSafeInteger(entry.id) || entry.id < 0)
    throw new Error("The guest did not produce the requested staging file.");
  const inode = fs.GetInode(entry.id);
  const size = inode.size;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_EVIDENCE_FILE_BYTES)
    throw new Error(
      "The host staging inode exceeds the 1 MiB evidence limit. Its contents were not read.",
    );
  if (
    (inode.mode & 0o170000) !== 0o100000 ||
    inode.status === 2 ||
    inode.status === 4
  )
    throw new Error("Evidence staging must be an in-memory regular file.");
  const content = await fs.Read(entry.id, 0, size);
  if (
    fs.SearchPath(path).id !== entry.id ||
    fs.GetInode(entry.id).size !== size
  )
    throw new Error(
      "The staging file changed while it was being read. Retry acquisition if appropriate.",
    );
  if (content === null && size === 0) return new Uint8Array();
  if (!(content instanceof Uint8Array) || content.byteLength !== size)
    throw new Error(
      "The host filesystem returned an unexpected byte count. Evidence was not copied.",
    );
  return new Uint8Array(content);
}
