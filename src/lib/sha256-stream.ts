// SPDX-License-Identifier: Apache-2.0
import { Sha256Stream } from "../../public/runtime/qemu/sha256.js";
export { Sha256Stream };

export const HASH_CHUNK_BYTES = 1024 * 1024;
export async function hashBlob(blob: Blob, options: { signal?: AbortSignal; chunkBytes?: number } = {}): Promise<string> {
  const chunkBytes = options.chunkBytes ?? HASH_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > HASH_CHUNK_BYTES)
    throw new Error("Hash chunks must contain 1–1048576 bytes.");
  const hash = new Sha256Stream();
  for (let offset = 0; offset < blob.size; offset += chunkBytes) {
    options.signal?.throwIfAborted();
    const chunk = await blob.slice(offset, offset + chunkBytes).arrayBuffer();
    options.signal?.throwIfAborted(); hash.update(new Uint8Array(chunk));
  }
  options.signal?.throwIfAborted();
  return hash.digestHex();
}
