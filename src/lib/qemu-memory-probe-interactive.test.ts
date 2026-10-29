// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { interactiveMemoryProbeSequence } from "../../build/qemu/memory-probe-interactive.mjs";

const inputBytes = await readFile(new URL("../../build/qemu/fixtures/memory-probe-command-sequence.json", import.meta.url));
assert.equal(createHash("sha256").update(inputBytes).digest("hex"), "860e128b767ae829a5b4356367448f3d7ce00b34b67d9aabcadd55a6c3210375");
const original = JSON.parse(inputBytes.toString());
const expectedSha = "025d6c95b2e2e3f355246258ba09addac784b43546bff31da5a3e0493e13532a";

test("interactive probe transport reassembles the exact ELF within bounded UART lines", () => {
  const before = JSON.stringify(original);
  const result = interactiveMemoryProbeSequence(original, expectedSha);
  const recovered = Buffer.concat(result.commands.slice(1, -1).map(command => Buffer.from(command.split("'")[3], "base64")));
  assert.equal(recovered.length, 8680);
  assert.equal(createHash("sha256").update(recovered).digest("hex"), expectedSha);
  assert.equal(result.commands.length, 19);
  assert.equal(Math.max(...result.commandBytes), 749);
  assert.ok(result.commandBytes.every(length => length + 200 < 1024), "Leave space for completion framing.");
  assert.equal(JSON.stringify(original), before, "The production control-channel sequence stays unchanged.");
});

test("interactive probe transport rejects altered data and foreign executable commands", () => {
  for (const edit of [
    (value: any) => { value.commands[1] = value.commands[1].replace("f0VM", "A0VM"); },
    (value: any) => { value.commands[1] += "; arbitrary-command"; },
    (value: any) => { value.commands[0] = "set -e; : > /some/other/path"; },
    (value: any) => { value.commands[value.commands.length - 1] = "echo marker"; },
    (value: any) => { value.artifactBytes = 65537; },
    (value: any) => { value.maximumCommandBytes = 16384; },
  ]) {
    const copy = structuredClone(original); edit(copy);
    assert.throws(() => interactiveMemoryProbeSequence(copy, expectedSha));
  }
});
