// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalMachineImageManifest, inspectMachineImage, MACHINE_IMAGE_LIMITS, validateMachineImageManifest } from "./machine-image.ts";
import { fixtureComponents, fixtureImage, fixtureManifest, uncheckedFixtureBundle } from "./machine-image.test-fixtures.ts";

test("data-only image roundtrip binds canonical metadata and each component (unit fixture, not guest execution)", async () => {
  const original = await fixtureImage();
  const imported = await inspectMachineImage(original.blob);
  assert.equal(imported.id, createHash("sha256").update(canonicalMachineImageManifest(original.manifest)).digest("hex"));
  assert.deepEqual(imported.manifest, original.manifest);
  assert.equal(imported.components.rootfs.size, 4 * 1024 * 1024);
  assert.equal(imported.manifest.boot.rootMode, "ephemeral-overlay");
  assert.ok(Object.isFrozen(imported.manifest.provenance.inputs));
});

test("exact allowlists reject executable, path, backing-reference, device and command-line extensions", () => {
  const base = fixtureManifest();
  for (const [path, key, value] of [
    [[], "javascript", "alert(1)"], [[], "runtimeUrl", "https://invalid.example/runtime.js"],
    [["boot"], "kernelArgs", "init=/bin/sh"], [["components", "rootfs"], "backingFile", "../../host"],
    [["components", "kernel"], "path", "../kernel"], [["devices"], "hostBridge", true],
  ] as [string[], string, unknown][]) {
    const changed = structuredClone(base) as unknown as Record<string, unknown>;
    let object = changed;
    for (const segment of path) object = object[segment] as Record<string, unknown>;
    object[key] = value;
    assert.throws(() => validateMachineImageManifest(changed), /unsupported fields/);
  }
  assert.throws(() => validateMachineImageManifest({ ...base, architecture: "aarch64" }), /architecture/);
  assert.throws(() => validateMachineImageManifest({ ...base, boot: { ...base.boot, hostname: "guest init=/bin/sh" } }), /hostname/);
  assert.throws(() => validateMachineImageManifest({ ...base, boot: { ...base.boot, rootMode: "persistent" } }), /persistence policy/);
  assert.throws(() => validateMachineImageManifest({ ...base, provenance: { ...base.provenance, recipe: "../recipe" } }), /identifier/);
  const accessor = Object.defineProperty({ ...base }, "schema", { get() { throw new Error("must not run"); }, enumerable: true });
  assert.throws(() => validateMachineImageManifest(accessor), /accessors/);
  let getterRan = false;
  const inputs = [base.provenance.inputs[0]];
  Object.defineProperty(inputs, "0", { get() { getterRan = true; return base.provenance.inputs[0]; }, enumerable: true });
  assert.throws(() => validateMachineImageManifest({ ...base, provenance: { ...base.provenance, inputs } }), /accessors/);
  assert.equal(getterRan, false);
  const holes = new Array(1);
  assert.throws(() => validateMachineImageManifest({ ...base, provenance: { ...base.provenance, inputs: holes } }), /holes/);
  const extended = Object.assign([base.provenance.inputs[0]], { execute: "unused" });
  assert.throws(() => validateMachineImageManifest({ ...base, provenance: { ...base.provenance, inputs: extended } }), /extra fields/);
  assert.throws(() => validateMachineImageManifest({ ...base, guest: { ...base.guest, name: "friendly\u202eexe" } }), /printable/);
});

test("bounded header rejects duplicate/noncanonical JSON, truncation, trailing data and declared oversized components", async () => {
  const manifest = fixtureManifest();
  const canonical = canonicalMachineImageManifest(manifest);
  await assert.rejects(inspectMachineImage(uncheckedFixtureBundle(manifest, undefined, canonical.replace('"architecture":"x86_64"', '"architecture":"aarch64","architecture":"x86_64"'))), /canonical encoding/);
  await assert.rejects(inspectMachineImage(uncheckedFixtureBundle(manifest, undefined, canonical + "\n")), /canonical encoding/);
  const valid = uncheckedFixtureBundle(manifest);
  await assert.rejects(inspectMachineImage(valid.slice(0, valid.size - 1)), /payload lengths/);
  await assert.rejects(inspectMachineImage(new Blob([valid, new Uint8Array([0])])), /payload lengths/);
  const oversized = { ...manifest, components: { ...manifest.components, rootfs: { ...manifest.components.rootfs, bytes: MACHINE_IMAGE_LIMITS.rootfsBytes + 4096 } } };
  await assert.rejects(inspectMachineImage(uncheckedFixtureBundle(manifest, undefined, JSON.stringify(oversized))), /budget/);
  const header = new Uint8Array(12); header.set(new TextEncoder().encode("TRMIMG01")); new DataView(header.buffer).setUint32(8, 65537, true);
  await assert.rejects(inspectMachineImage(new Blob([header])), /manifest length/);
});

test("verified hashes and structural policies reject tampering, 32-bit kernel, unsupported filesystem and external journal", async () => {
  const manifest = fixtureManifest();
  const altered = fixtureComponents(); altered.rootfs[altered.rootfs.length - 1] = 1;
  await assert.rejects(inspectMachineImage(uncheckedFixtureBundle(manifest, altered)), /rootfs SHA-256/);
  const badKernel = fixtureComponents(); new DataView(badKernel.kernel.buffer).setUint16(0x236, 0, true);
  await assert.rejects(inspectMachineImage(uncheckedFixtureBundle(fixtureManifest(badKernel), badKernel)), /x86_64 bzImage/);
  const badRoot = fixtureComponents(); new DataView(badRoot.rootfs.buffer).setUint32(1024 + 0x60, 0x282, true);
  await assert.rejects(inspectMachineImage(uncheckedFixtureBundle(fixtureManifest(badRoot), badRoot)), /clean ext4/);
  const externalJournal = fixtureComponents(); new DataView(externalJournal.rootfs.buffer).setUint32(1024 + 0xe4, 1, true);
  await assert.rejects(inspectMachineImage(uncheckedFixtureBundle(fixtureManifest(externalJournal), externalJournal)), /external dependencies/);
});

test("import hashing reads at most one MiB slices and cancellation stops before a complete result", async () => {
  const fixture = uncheckedFixtureBundle(fixtureManifest());
  const original = Blob.prototype.arrayBuffer;
  const sizes: number[] = [];
  Blob.prototype.arrayBuffer = function () { sizes.push(this.size); return original.call(this); };
  try {
    await inspectMachineImage(fixture);
    assert.ok(sizes.length > 5);
    assert.ok(Math.max(...sizes) <= MACHINE_IMAGE_LIMITS.chunkBytes);
  } finally { Blob.prototype.arrayBuffer = original; }
  const controller = new AbortController();
  let count = 0;
  Blob.prototype.arrayBuffer = function () { if (++count === 5) controller.abort(); return original.call(this); };
  try { await assert.rejects(inspectMachineImage(fixture, { signal: controller.signal }), { name: "AbortError" }); }
  finally { Blob.prototype.arrayBuffer = original; }
});
