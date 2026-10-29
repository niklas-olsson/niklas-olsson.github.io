// SPDX-License-Identifier: Apache-2.0
// Actual Node pthread-loader/bootstrap fixtures, not QEMU/Linux execution.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { test } from "node:test";
import { LEGACY_QEMU_BUNDLE_ID, OWNED_QEMU_BUNDLE_ID } from "../public/runtime/qemu/catalog.js";
import { getQemuBundle } from "../public/runtime/qemu/bundles.js";
import { installQemuTestPthread } from "./qemu-test-assets.mjs";

async function fixture(run) {
  const parent = new URL("../.cache/pthread-scope-fixtures/", import.meta.url);
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(new URL("case-", parent));
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    const temporary = join(directory, "generated");
    await mkdir(temporary);
    return await run({ directory, temporary });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function pinnedPthread(bundle) {
  const bytes = await readFile(new URL("../public/runtime/qemu/" + bundle.pthread.file, import.meta.url));
  assert.equal(bytes.length, bundle.pthread.bytes);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), bundle.pthread.sha256);
  return bytes;
}

async function loadRealBootstrap(temporary, bundle) {
  // The .mjs factory is intentionally a fixture. The exact pinned pthread
  // loader executes in a real Node Worker and dynamically imports that factory.
  const modulePath = join(temporary, "bootstrap-fixture.mjs");
  await writeFile(modulePath, `export default function (options) {
    if (!options.ENVIRONMENT_IS_PTHREAD || !(options.wasmMemory.buffer instanceof SharedArrayBuffer))
      throw new Error("Invalid pthread fixture initialization");
    globalThis.startWorker(options);
  }\n`);
  const worker = new Worker(pathToFileURL(join(temporary, bundle.pthread.file)));
  try {
    const loaded = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("Pinned pthread loader did not initialize within 5 seconds")), 5000);
      const finish = (error, value) => {
        clearTimeout(timeout);
        worker.off("message", onMessage); worker.off("error", onError); worker.off("exit", onExit);
        error ? reject(error) : resolve(value);
      };
      const onMessage = message => finish(null, message);
      const onError = error => finish(error);
      const onExit = code => finish(new Error(`Pinned pthread loader exited before ready (${code})`));
      worker.once("message", onMessage); worker.once("error", onError); worker.once("exit", onExit);
    });
    worker.postMessage({ cmd: "load", handlers: [],
      wasmModule: new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0])),
      wasmMemory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }),
      urlOrBlob: pathToFileURL(modulePath).href });
    assert.deepEqual(await loaded, { cmd: "loaded" });
  } finally { await worker.terminate(); }
}

for (const id of [LEGACY_QEMU_BUNDLE_ID, OWNED_QEMU_BUNDLE_ID]) {
  test(`exact ${id} pthread loader initializes below an ES-module project`, { timeout: 10000 }, () => fixture(async ({ temporary }) => {
    const bundle = getQemuBundle(id), bytes = await pinnedPthread(bundle);
    await installQemuTestPthread(temporary, bundle, bytes);
    await loadRealBootstrap(temporary, bundle);
    assert.deepEqual(await readFile(join(temporary, bundle.pthread.file)), bytes);
  }));
}

test("repeated installation preserves exact pthread bytes and its explicit package scope", () => fixture(async ({ temporary }) => {
  const bundle = getQemuBundle(OWNED_QEMU_BUNDLE_ID), bytes = await pinnedPthread(bundle);
  await installQemuTestPthread(temporary, bundle, bytes);
  const packagePath = join(dirname(join(temporary, bundle.pthread.file)), "package.json");
  const before = await readFile(packagePath);
  assert.equal(JSON.parse(before).type, "commonjs");
  await installQemuTestPthread(temporary, bundle, bytes);
  assert.deepEqual(await readFile(packagePath), before);
  assert.deepEqual(await readFile(join(temporary, bundle.pthread.file)), bytes);
}));

test("conflicting temporary pthread package metadata is refused without replacing its contents", () => fixture(async ({ temporary }) => {
  const bundle = getQemuBundle(OWNED_QEMU_BUNDLE_ID), bytes = await pinnedPthread(bundle);
  const loaderPath = join(temporary, bundle.pthread.file), packagePath = join(dirname(loaderPath), "package.json");
  await mkdir(dirname(loaderPath), { recursive: true });
  const conflict = '{"type":"module","userOwned":true}\n';
  await writeFile(packagePath, conflict);
  await assert.rejects(installQemuTestPthread(temporary, bundle, bytes), /package scope|package metadata/i);
  assert.equal(await readFile(packagePath, "utf8"), conflict);
  await assert.rejects(readFile(loaderPath), { code: "ENOENT" });
}));
