// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { hashBlob, Sha256Stream } from "./sha256-stream.ts";

test("incremental SHA-256 matches published empty, abc and million-a vectors", () => {
  for (const [input, expected] of [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["a".repeat(1_000_000), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"],
  ]) assert.equal(new Sha256Stream().update(new TextEncoder().encode(input)).digestHex(), expected);
});

test("arbitrary SHA-256 chunk boundaries and nonzero byte offsets match native crypto", () => {
  for (const length of [0,1,55,56,63,64,65,127,128,129,4097,1_048_579]) {
    const backing = new Uint8Array(length + 19);
    const input = backing.subarray(7, 7 + length);
    for (let i = 0; i < input.length; i++) input[i] = (i * 31 + (i >>> 8)) & 255;
    for (const chunk of [1,63,64,65,4096,65537]) {
      const hash = new Sha256Stream();
      for (let offset = 0; offset < length; offset += chunk) hash.update(input.subarray(offset, offset + chunk));
      const result = hash.digestHex();
      assert.equal(result, createHash("sha256").update(input).digest("hex"), `length=${length}, chunk=${chunk}`);
      assert.equal(hash.digestHex(), result);
      assert.throws(() => hash.update(new Uint8Array()), /finalized/);
    }
  }
});

test("Blob hashing observes bounded slices and cancellation", async () => {
  const data = new Uint8Array(1_048_589).fill(173);
  const blob = new Blob([data]);
  let maxSlice = 0;
  const slice = blob.slice.bind(blob);
  blob.slice = (start, end, type) => { maxSlice = Math.max(maxSlice, (end ?? blob.size) - (start ?? 0)); return slice(start, end, type); };
  assert.equal(await hashBlob(blob, { chunkBytes: 65536 }), createHash("sha256").update(data).digest("hex"));
  assert.equal(maxSlice, 65536);
  await assert.rejects(hashBlob(blob, { chunkBytes: 1048577 }), /chunks/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(hashBlob(blob, { signal: controller.signal }), { name: "AbortError" });
});

test("SHA-256 length encoding crosses the32-bit bit-count boundary without buffering512MiB", () => {
  const chunk = new Uint8Array(1024 * 1024).fill(173), streamed = new Sha256Stream(), native = createHash("sha256");
  for (let i = 0; i < 512; i++) { streamed.update(chunk); native.update(chunk); }
  const tail = new Uint8Array([7, 8, 9]); streamed.update(tail); native.update(tail);
  assert.equal(streamed.digestHex(), native.digest("hex"));
});
