// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { buildGuestCapabilityProbe, describeKubernetesPrerequisites, parseGuestCapabilityReport } from "./guest-capabilities.ts";

const token = "test_123";
const payload = [
  `__TRM_CAPS_V1_${token}_BEGIN__`,
  "architecture\tx86_64", "kernel\t6.12.43-0-virt", "memory_kib\t491520", "cpus\t1",
  "cgroup_mode\tv2", "controllers\tcpuset cpu io memory pids", "namespaces\tcgroup ipc mnt net pid user uts ",
  "overlay\tmodule-present", "command_containerd\t0", "command_runc\t0", "command_k3s\t0",
  "command_kubectl\t0", "command_crictl\t0", "command_ctr\t0",
  `__TRM_CAPS_V1_${token}_END__`,
].join("\n");

test("capability observations retain actual guest values without claiming Kubernetes readiness", () => {
  const report = parseGuestCapabilityReport(`boot noise\r\n${payload.replace(/\n/g, "\r\n")}\r\nprompt> `, token);
  assert.equal(report.architecture, "x86_64");
  assert.equal(report.kernelRelease, "6.12.43-0-virt");
  assert.equal(report.memoryKiB, 491520);
  assert.equal(report.onlineCpus, 1);
  assert.deepEqual(report.cgroupControllers, ["cpuset", "cpu", "io", "memory", "pids"]);
  assert.equal(report.overlay, "module-present");
  assert.equal(report.source, "guest-reported");
  assert.equal(report.kubernetesExecution, "not-verified");
  const checks = describeKubernetesPrerequisites(report);
  assert.equal(checks.find((check) => check.id === "k3s")?.state, "missing");
  assert.equal(checks.find((check) => check.id === "overlay")?.state, "unverified");
  assert.equal(checks.find((check) => check.id === "execution")?.state, "unverified");
});

test("empty measurements remain unknown and installed commands do not prove execution", () => {
  const report = parseGuestCapabilityReport(payload.replace("memory_kib\t491520", "memory_kib\t").replace("cpus\t1", "cpus\t").replace("command_k3s\t0", "command_k3s\t1"), token);
  assert.equal(report.memoryKiB, null);
  assert.equal(report.onlineCpus, null);
  assert.equal(report.commands.k3s, true);
  assert.equal(report.kubernetesExecution, "not-verified");
  assert.equal(describeKubernetesPrerequisites(report).at(-1)?.state, "unverified");
});

test("asynchronous kernel console records do not replace or corrupt required observations", () => {
  const kernelLine = "[  115.376595] random: crng init done";
  const interleaved = payload.replace("memory_kib\t", `${kernelLine}\nmemory_kib\t`);
  assert.deepEqual(parseGuestCapabilityReport(interleaved, token), parseGuestCapabilityReport(payload, token));
  assert.throws(() => parseGuestCapabilityReport(interleaved.replace(kernelLine, "random: crng init done"), token), /malformed field/);
  assert.throws(() => parseGuestCapabilityReport(interleaved.replace(kernelLine, "[  115.376595] architecture\tx86_64"), token), /malformed field/);
  assert.throws(() => parseGuestCapabilityReport(interleaved.replace("architecture\tx86_64\n", ""), token), /required observations/);
  assert.throws(() => parseGuestCapabilityReport(interleaved.replace(kernelLine, Array(17).fill(kernelLine).join("\n")), token), /too many interleaved/);
});

test("wrong or incomplete frames, duplicate fields and misleading measurements are rejected", () => {
  assert.throws(() => parseGuestCapabilityReport(payload, "different"), /matching frame/);
  assert.throws(() => parseGuestCapabilityReport(payload.slice(0, -10), token), /matching frame/);
  assert.throws(() => parseGuestCapabilityReport(`${payload}\n${payload}`, token), /matching frame/);
  for (const replacement of ["-1", "0", "1.5", "NaN", "999999999999999999999"]) {
    assert.throws(() => parseGuestCapabilityReport(payload.replace("cpus\t1", `cpus\t${replacement}`), token), /CPU count/);
  }
  assert.throws(() => parseGuestCapabilityReport(payload.replace("kernel\t", "architecture\tx86_64\nkernel\t"), token), /duplicate/);
  assert.throws(() => parseGuestCapabilityReport(payload.replace("overlay\tmodule-present", "overlay\tyes"), token), /overlay/);
  assert.throws(() => parseGuestCapabilityReport(payload.replace("command_k3s\t0", "command_k3s\ttrue"), token), /must be 0 or 1/);
  assert.throws(() => parseGuestCapabilityReport(payload.replace("namespaces\tcgroup", "namespaces\tipc cgroup"), token), /duplicate entries/);
  assert.throws(() => parseGuestCapabilityReport(payload.replace("kernel\t6.12.43-0-virt", "kernel\t\u001b[31m6.12"), token), /printable ASCII/);
  assert.throws(() => parseGuestCapabilityReport(`${"x".repeat(16384)}${payload}`, token), /16 KiB/);
  assert.throws(() => buildGuestCapabilityProbe("'; touch /tmp/no; '"), /probe token/);
});

test("legacy kernels and incomplete cgroups are described as missing prerequisites", () => {
  const report = parseGuestCapabilityReport(payload.replace("architecture\tx86_64", "architecture\triscv64").replace("kernel\t6.12.43-0-virt", "kernel\t4.15.0").replace("cgroup_mode\tv2", "cgroup_mode\thybrid").replace("namespaces\tcgroup ipc mnt net pid user uts ", "namespaces\tipc mnt "), token);
  const checks = describeKubernetesPrerequisites(report);
  for (const id of ["architecture", "kernel", "cgroups", "namespaces"])
    assert.equal(checks.find((check) => check.id === id)?.state, "missing");
});

test("the read-only POSIX probe emits a complete parseable Linux observation", { skip: process.platform !== "linux" }, () => {
  const script = buildGuestCapabilityProbe("shell_roundtrip");
  assert.ok(new TextEncoder().encode(script).byteLength < 8192);
  const output = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", timeout: 5000, maxBuffer: 16_384 });
  const report = parseGuestCapabilityReport(output, "shell_roundtrip");
  assert.ok(report.architecture.length > 0);
  assert.ok(report.kernelRelease.length > 0);
  assert.ok(report.memoryKiB && report.memoryKiB > 0);
  assert.equal(report.kubernetesExecution, "not-verified");
});
