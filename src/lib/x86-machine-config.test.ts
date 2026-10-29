// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultX86MachineConfiguration, validateX86MachineConfiguration, qemuPresetBootOptions, migratedMachineMac } from "./x86-machine-config.ts";
import { LEGACY_QEMU_BUNDLE_ID, OWNED_QEMU_BUNDLE_ID } from "./qemu-assets.ts";
import { QEMU_BUNDLES, SERVER_QEMU_BUNDLE_ID } from "../../public/runtime/qemu/catalog.js";

test("fixed machine presets preserve small boot geometry and explicitly enable APIC for workers", () => {
  const small = defaultX86MachineConfiguration({ mac: "02:00:00:00:00:01" });
  assert.equal(small.runtimeBundleId, LEGACY_QEMU_BUNDLE_ID);
  assert.deepEqual(qemuPresetBootOptions(small), { memoryMiB: 512, virtualCpus: 1, memoryLayout: "single-ram-block-v1",
    kernelAppend: "console=ttyS0 root=/dev/vda noautodetect hostname=terrarium clocksource=tsc noapic 8250.nr_uarts=4",
    checkpointSupported: true, reservedWasmMiB: 2300, translationCacheMiB: 500 });
  const worker = defaultX86MachineConfiguration({ presetId: "worker", mac: small.nic.mac });
  assert.equal(worker.runtimeBundleId, OWNED_QEMU_BUNDLE_ID);
  assert.equal(qemuPresetBootOptions(worker).memoryMiB, 1024);
  assert.equal(qemuPresetBootOptions(worker).checkpointSupported, false);
  assert.doesNotMatch(qemuPresetBootOptions(worker).kernelAppend, /noapic/);
  assert.throws(() => defaultX86MachineConfiguration({ presetId: "server", runtimeBundleId: OWNED_QEMU_BUNDLE_ID }), /too small/);
  assert.throws(() => defaultX86MachineConfiguration({ presetId: "worker", runtimeBundleId: LEGACY_QEMU_BUNDLE_ID }), /owned runtime/);
});

test("machine settings reject executable fields, arbitrary arguments, and mismatched topology before mutation", () => {
  const original = defaultX86MachineConfiguration();
  for (const patch of [{ memoryMiB: 4096 }, { cpus: 9 }, { arguments: ["-smp", "9"] },
    { consoles: [0, 1, 2] }, { diskSlots: [{ slot: 0, serial: "untrusted" }, { slot: 1, serial: "terrarium-volume1" }] },
    { diskPolicy: "durable-root" }, { kernelSettings: { append: "init=/bin/sh" } },
    { kernelSettings: { hostname: "bad name" } }, { nic: { mac: "ff:ff:ff:ff:ff:ff" } },
    { image: { kind: "builtin", id: "foreign" } }, { presetId: "__proto__" }])
    assert.throws(() => validateX86MachineConfiguration({ ...original, ...patch }));
  let reads = 0;
  const accessor = { ...original };
  Object.defineProperty(accessor, "nic", { get() { reads++; return original.nic; } });
  assert.throws(() => validateX86MachineConfiguration(accessor), /executable fields/);
  assert.equal(reads, 0);
  const source = structuredClone(original); const stable = validateX86MachineConfiguration(source);
  Object.assign(source.nic, { mac: "02:00:00:00:00:03" });
  assert.notEqual(stable.nic.mac, source.nic.mac);
});

test("installed runtime capacity does not qualify other worker or custom-small combinations", () => {
  const worker = defaultX86MachineConfiguration({ presetId: "worker", mac: "02:00:00:00:00:04" });
  const customImage = { kind: "custom" as const, id: "b".repeat(64) };
  for (const { id: runtimeBundleId } of Object.values(QEMU_BUNDLES)) {
    if (runtimeBundleId === OWNED_QEMU_BUNDLE_ID) continue;
    assert.throws(() => validateX86MachineConfiguration({ ...worker, runtimeBundleId, image: { kind: "builtin", id: runtimeBundleId } }), /owned runtime|qualified owned runtime/);
    assert.throws(() => defaultX86MachineConfiguration({ presetId: "small", runtimeBundleId, image: customImage }), /qualified|owned runtime/);
  }
  assert.equal(defaultX86MachineConfiguration({ presetId: "worker", image: customImage }).runtimeBundleId, OWNED_QEMU_BUNDLE_ID);
  assert.equal(defaultX86MachineConfiguration({ presetId: "small", runtimeBundleId: OWNED_QEMU_BUNDLE_ID, image: customImage }).runtimeBundleId, OWNED_QEMU_BUNDLE_ID);
});

test("server selection uses its exact current identity rather than the first installed large candidate", () => {
  const current = defaultX86MachineConfiguration({ presetId: "server", mac: "02:00:00:00:00:05" });
  assert.equal(current.runtimeBundleId, SERVER_QEMU_BUNDLE_ID);
  for (const bundle of Object.values(QEMU_BUNDLES)) {
    if (bundle.id === SERVER_QEMU_BUNDLE_ID || bundle.resources.reservedWasmMiB < 3584) continue;
    assert.throws(() => validateX86MachineConfiguration({ ...current, runtimeBundleId: bundle.id, image: { kind: "builtin", id: bundle.id } }), /exact registered/);
  }
});

test("custom image identity disables RAM checkpoint claims and migration NICs remain deterministic", () => {
  const custom = defaultX86MachineConfiguration({ runtimeBundleId: OWNED_QEMU_BUNDLE_ID, image: { kind: "custom", id: "a".repeat(64) }, hostname: "orchard-v1" });
  assert.equal(qemuPresetBootOptions(custom).checkpointSupported, false);
  assert.match(qemuPresetBootOptions(custom).kernelAppend, /hostname=orchard-v1/);
  assert.equal(migratedMachineMac("stable-v07-definition"), migratedMachineMac("stable-v07-definition"));
  assert.notEqual(migratedMachineMac("stable-v07-definition"), migratedMachineMac("other-definition"));
});
