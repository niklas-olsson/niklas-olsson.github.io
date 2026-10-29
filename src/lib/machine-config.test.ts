import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_MACHINE,
  parseMachineConfigs,
  validateInitScript,
  validateMachineName,
} from "./machine-config.ts";

test("saved machines never silently reenable world access", () => {
  const [machine] = parseMachineConfigs([
    { ...DEFAULT_MACHINE, network: "world" },
  ]);
  assert.equal(machine.network, "local");
});
test("duplicate addresses and IDs cannot create ambiguous peers", () => {
  assert.equal(
    parseMachineConfigs([
      DEFAULT_MACHINE,
      { ...DEFAULT_MACHINE, id: "two", name: "two" },
    ]).length,
    1,
  );
});
test("corrupt or accessor-based configuration cannot break startup", () => {
  let accessed = false;
  const bad = { ...DEFAULT_MACHINE };
  Object.defineProperty(bad, "initScript", {
    get() {
      accessed = true;
      throw new Error("accessed");
    },
  });
  assert.deepEqual(parseMachineConfigs([bad]), [DEFAULT_MACHINE]);
  assert.equal(accessed, false);
  assert.deepEqual(parseMachineConfigs(null), [DEFAULT_MACHINE]);
});
test("script limits measure UTF-8 bytes and preserve shell newlines", () => {
  assert.throws(() => validateInitScript("🌱".repeat(2_049)), /8 KiB/);
  assert.throws(() => validateInitScript("echo\0oops"), /null bytes/);
  assert.equal(validateInitScript("pwd\r\necho done\r\n"), "pwd\necho done\n");
});
test("machine names remain usable as labels and shell hostnames", () => {
  assert.equal(validateMachineName("  Moss-02  "), "moss-02");
  assert.throws(() => validateMachineName("bad; reboot"));
  assert.throws(() => validateMachineName("-bad"));
});

test("VPC attachments migrate old configs and retain duplicate addresses across boundaries", () => {
  const vpcs = [
    {
      id: "one",
      name: "One",
      cidr: "10.10.0.0/16",
      subnets: [{ id: "subnet", name: "Default", cidr: "10.10.1.0/24" }],
    },
    {
      id: "two",
      name: "Two",
      cidr: "10.10.0.0/16",
      subnets: [{ id: "subnet", name: "Default", cidr: "10.10.1.0/24" }],
    },
  ];
  const first = {
    ...DEFAULT_MACHINE,
    vpcId: "one",
    subnetId: "subnet",
    ip: "10.10.1.10",
  };
  const configs = parseMachineConfigs(
    [first, { ...first, id: "second", name: "second", vpcId: "two" }],
    vpcs,
  );
  assert.equal(configs.length, 2);
  assert.equal(configs[0].ip, configs[1].ip);
  assert.notEqual(configs[0].vpcId, configs[1].vpcId);
  const legacy = { ...DEFAULT_MACHINE } as Partial<typeof DEFAULT_MACHINE>;
  delete legacy.vpcId;
  delete legacy.subnetId;
  delete legacy.policy;
  assert.deepEqual(parseMachineConfigs([legacy]), [DEFAULT_MACHINE]);
});

test("invalid saved packet rules fail closed, and stale placements do not resurrect a network", () => {
  const [invalidPolicy] = parseMachineConfigs([
    {
      ...DEFAULT_MACHINE,
      policy: { ingress: [{ protocol: "tcp", cidr: "bad" }], egress: [] },
    },
  ]);
  assert.deepEqual(invalidPolicy.policy, { ingress: [], egress: [] });
  const [invalidAttachment] = parseMachineConfigs([
    { ...DEFAULT_MACHINE, vpcId: "removed", network: "world" },
  ]);
  assert.equal(invalidAttachment.network, "isolated");
  assert.equal(invalidAttachment.vpcId, "default");
});

test("new genuine 64-bit profiles survive configuration persistence", () => {
  for (const profile of ["alpine-riscv64", "debian-riscv64"] as const) {
    assert.equal(
      parseMachineConfigs([{ ...DEFAULT_MACHINE, profile }])[0].profile,
      profile,
    );
  }
});

test("x86_64 data disks survive configuration persistence while unsupported profiles reject attachments", () => {
  const volumes = [{ id: "disk-data", slot: 0, readOnly: false }, { id: "disk-snapshot", slot: 1, readOnly: true }];
  const [parsed] = parseMachineConfigs([{ ...DEFAULT_MACHINE, profile: "alpine-x86_64", volumes }]);
  assert.equal(parsed.profile, "alpine-x86_64");
  assert.deepEqual(parsed.volumes, volumes);
  for (const profile of ["riscv64", "alpine-riscv64", "debian-riscv64"])
    assert.notEqual(parseMachineConfigs([{ ...DEFAULT_MACHINE, profile, volumes }])[0]?.profile, profile);
});

test("saved configurations retain more than four machines without a hidden reload ceiling", () => {
  const machines = Array.from({ length: 32 }, (_, index) => ({
    ...DEFAULT_MACHINE,
    id: `machine-${index}`,
    name: `machine-${index}`,
    ip: `192.168.76.${index + 10}`,
  }));
  const parsed = parseMachineConfigs(machines);
  assert.equal(parsed.length, 32);
  assert.equal(parsed.at(-1)?.name, "machine-31");
});
