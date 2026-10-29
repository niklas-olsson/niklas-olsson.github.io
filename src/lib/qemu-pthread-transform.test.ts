// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { resolvePthreadWasmPath, transformQemuPthread, UPSTREAM_PTHREAD_SHA256, PTHREAD_TRANSFORM_ID,
  transformOwnedQemuPthread, OWNED_PTHREAD_SHA256, OWNED_PTHREAD_TRANSFORM_ID } from "../../scripts/qemu-pthread-transform.mjs";
import { OWNED_QEMU_BUNDLE_ID, getQemuBundle } from "./qemu-assets.ts";

const upstreamUrl = new URL("../../vendor/qemu/qemu-system-x86_64.worker.upstream.js", import.meta.url);

test("the browser pthread URL hook resolves only the expected Wasm name on root and subpath hosts", () => {
  assert.throws(() => new URL("qemu-system-x86_64.wasm", "blob:https://terrarium.example/verified-module"), /Invalid URL/);
  for (const prefix of ["", "/terrarium"]) {
    assert.equal(resolvePthreadWasmPath("qemu-system-x86_64.wasm", `https://terrarium.example${prefix}/runtime/qemu/qemu-system-x86_64.worker.js`),
      `https://terrarium.example${prefix}/runtime/qemu/qemu-system-x86_64.wasm`);
  }
  for (const path of ["", "../qemu-system-x86_64.wasm", "https://outside.example/qemu-system-x86_64.wasm", "another.wasm", "qemu-system-x86_64.worker.js"])
    assert.throws(() => resolvePthreadWasmPath(path, "https://terrarium.example/runtime/qemu/qemu-system-x86_64.worker.js"), /Unconfigured QEMU pthread asset/);
});

test("the derived bootstrap is deterministic, preserves upstream source identity and matches the distribution manifest", async () => {
  const source = await readFile(upstreamUrl);
  assert.equal(source.length, 5772);
  assert.equal(createHash("sha256").update(source).digest("hex"), UPSTREAM_PTHREAD_SHA256);
  const first = transformQemuPthread(source), second = transformQemuPthread(source.toString("utf8"));
  assert.equal(first, second);
  assert.equal(first, await readFile(new URL("../../public/runtime/qemu/qemu-system-x86_64.worker.js", import.meta.url), "utf8"));
  assert.match(first, /Copyright 2015 The Emscripten Authors/);
  assert.match(first, /SPDX-License-Identifier: MIT/);
  assert.match(first, /if \(!ENVIRONMENT_IS_NODE\) \{\s+Module\['locateFile'\]/);
  assert.ok(first.includes(resolvePthreadWasmPath.toString()), "the injected hook is exactly the tested resolver source");
  const provenance = JSON.parse(await readFile(new URL("../../public/runtime/qemu/provenance.json", import.meta.url), "utf8"));
  const artifact = provenance.localAssets.find((asset: { file: string }) => asset.file === "qemu-system-x86_64.worker.js");
  assert.equal(artifact.bytes, Buffer.byteLength(first));
  assert.equal(artifact.sha256, createHash("sha256").update(first).digest("hex"));
  assert.equal(provenance.localLoaderSource.sha256, UPSTREAM_PTHREAD_SHA256);
  assert.equal(provenance.localLoaderSource.transformId, PTHREAD_TRANSFORM_ID);
  assert.match(provenance.correspondingSourceStatus, /not attested/, "the bootstrap repair must not claim an owned QEMU binary build");
});

test("the pthread transform refuses altered input instead of silently repinning upstream code", async () => {
  const source = await readFile(upstreamUrl);
  source[0] ^= 1;
  assert.throws(() => transformQemuPthread(source), /pinned upstream SHA-256/);
  assert.throws(() => transformQemuPthread("arbitrary loader"), /pinned upstream SHA-256/);
});

test("the owned minified pthread has a separate measured source and deterministic bounded browser derivation", async () => {
  const source = await readFile(new URL("../../vendor/qemu/owned-s1-candidate-v2/qemu-system-x86_64.worker.original.js", import.meta.url));
  assert.equal(source.length, 2773);
  assert.equal(createHash("sha256").update(source).digest("hex"), OWNED_PTHREAD_SHA256);
  const first = transformOwnedQemuPthread(source);
  assert.equal(first, transformOwnedQemuPthread(source.toString("utf8")));
  const bundle = getQemuBundle(OWNED_QEMU_BUNDLE_ID);
  assert.equal(first, await readFile(new URL(`../../public/runtime/qemu/${bundle.pthread.file}`, import.meta.url), "utf8"));
  assert.equal(Buffer.byteLength(first), bundle.pthread.bytes);
  assert.equal(createHash("sha256").update(first).digest("hex"), bundle.pthread.sha256);
  assert.match(first, /SPDX-License-Identifier: MIT/);
  assert.match(first, /if \(!ENVIRONMENT_IS_NODE\) \{ Module\["locateFile"\]/);
  assert.ok(first.includes(resolvePthreadWasmPath.toString()));
  assert.ok(first.includes(OWNED_PTHREAD_TRANSFORM_ID));
  assert.throws(() => transformQemuPthread(source), /pinned upstream SHA-256/);
  assert.throws(() => transformOwnedQemuPthread("arbitrary loader"), /measured SHA-256/);
});
