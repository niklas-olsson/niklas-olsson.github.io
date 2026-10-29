// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MACHINE, parseMachineConfigs } from "./machine-config.ts";
import { consoleDeviceLabel, isQemuProfileId, isTinyEmuProfileId, RUNTIME_PROFILES, type QemuProfileId, type TinyEmuProfileId } from "./runtime-profiles.ts";
import { TINYEMU_PROFILE_ASSETS } from "./tinyemu-assets.ts";
import { DEFAULT_VPCS } from "./vpc-config.ts";
import { validateWorkspaceManifest } from "./workspace-persistence.ts";
import { defaultX86MachineConfiguration, migratedMachineMac } from "./x86-machine-config.ts";

test("the x86_64 profile is assigned to QEMU while all RV64 profiles retain TinyEMU assets", () => {
  const qemu: QemuProfileId = "alpine-x86_64";
  assert.equal(isQemuProfileId(qemu), true);
  assert.equal(isTinyEmuProfileId(qemu), false);
  assert.equal(RUNTIME_PROFILES[qemu].architecture, "x86_64");
  assert.equal(RUNTIME_PROFILES[qemu].bits, 64);
  const tiny: TinyEmuProfileId[] = ["riscv64", "alpine-riscv64", "debian-riscv64"];
  for (const id of tiny) {
    assert.equal(isTinyEmuProfileId(id), true);
    assert.equal(isQemuProfileId(id), false);
    assert.ok(TINYEMU_PROFILE_ASSETS[id]);
  }
  assert.equal(isQemuProfileId("x86"), false);
  assert.equal(isTinyEmuProfileId("x86"), false);
});

test("existing v0.5 definitions and the new x86_64 definition survive strict workspace validation", () => {
  const machines = ["x86", "riscv64", "alpine-riscv64", "debian-riscv64", "alpine-x86_64"].map((profile, index) => ({
    ...structuredClone(DEFAULT_MACHINE), id: `profile-${index}`, name: `profile-${index}`, ip: `192.168.76.${10 + index}`, profile,
  }));
  assert.deepEqual(parseMachineConfigs(machines), machines);
  const manifest = {
    schema: "terrarium.workspace/v1", revision: 4, updatedAt: 1_700_000_000_000,
    activeId: machines[4].id, machines, vpcs: structuredClone(DEFAULT_VPCS), activity: [],
  };
  assert.deepEqual(validateWorkspaceManifest(manifest), { ...manifest, schema: "terrarium.workspace/v2", machines: machines.map(machine => machine.profile === "alpine-x86_64"
    ? { ...machine, x86: defaultX86MachineConfiguration({ mac: migratedMachineMac(machine.id) }) } : machine) });
  const unknown = structuredClone(manifest);
  unknown.machines[4].profile = "arm64-not-implemented";
  assert.throws(() => validateWorkspaceManifest(unknown), /invalid/);
});

test("console labels follow actual guest devices, not a binary x86/RISC-V assumption", () => {
  assert.equal(consoleDeviceLabel("x86", 3), "ttyS3");
  assert.equal(consoleDeviceLabel("alpine-x86_64", 0), "ttyS0");
  assert.equal(consoleDeviceLabel("alpine-x86_64", 1), "ttyS1");
  assert.equal(consoleDeviceLabel("alpine-x86_64", 2), "ttyS2");
  assert.equal(consoleDeviceLabel("alpine-x86_64", 3), "ttyS3");
  assert.equal(consoleDeviceLabel("alpine-riscv64", 0), "hvc0");
});
