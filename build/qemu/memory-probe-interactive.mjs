// SPDX-License-Identifier: Apache-2.0
// The diagnostic UART shell has a separate line discipline from commandFrame.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const path = "/tmp/terrarium-memory-probe";
const first = `set -e; : > ${path}`;
const append = (base64) => `set -e; printf '%s' '${base64}' | base64 -d >> ${path}`;
const final = (sha) => `set -e; test "$(sha256sum ${path} | cut -d ' ' -f 1)" = ${sha}; chmod 700 ${path}; ${path}; rm ${path}`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function interactiveMemoryProbeSequence(sequence, expectedSha256) {
  assert.equal(sequence.schema, "terrarium.guest-command-sequence/v1");
  assert.equal(sequence.maximumCommandBytes, 8192);
  assert.match(expectedSha256, /^[a-f0-9]{64}$/);
  assert.equal(sequence.artifactSha256, expectedSha256);
  assert.ok(Number.isSafeInteger(sequence.artifactBytes) && sequence.artifactBytes > 0 && sequence.artifactBytes <= 65536);
  assert.ok(Array.isArray(sequence.commands) && sequence.commands.length >= 3 && sequence.commands.length <= 131);
  assert.equal(sequence.commands[0], first);
  assert.equal(sequence.commands.at(-1), final(expectedSha256));
  const chunks = [];
  let bytes = 0;
  for (const command of sequence.commands.slice(1, -1)) {
    assert.equal(typeof command, "string");
    assert.ok(Buffer.byteLength(command) <= 8192);
    const match = /^set -e; printf '%s' '([A-Za-z0-9+/]+={0,2})' \| base64 -d >> \/tmp\/terrarium-memory-probe$/.exec(command);
    assert.ok(match, "Only the retained data-only append command can be rechunked.");
    const chunk = Buffer.from(match[1], "base64");
    assert.equal(chunk.toString("base64"), match[1]);
    bytes += chunk.length;
    assert.ok(bytes <= sequence.artifactBytes, "The decoded payload exceeds its exact declared size.");
    chunks.push(chunk);
  }
  assert.equal(bytes, sequence.artifactBytes);
  const artifact = Buffer.concat(chunks, bytes);
  assert.equal(sha256(artifact), expectedSha256);
  const commands = [first];
  for (let offset = 0; offset < bytes; offset += 512) {
    commands.push(append(artifact.subarray(offset, offset + 512).toString("base64")));
  }
  commands.push(final(expectedSha256));
  assert.ok(commands.every(command => Buffer.byteLength(command) <= 768));
  return {
    schema: "terrarium.interactive-guest-command-sequence/v1", artifactSha256: expectedSha256,
    artifactBytes: bytes, binaryChunkBytes: 512, commands,
    commandBytes: commands.map(command => Buffer.byteLength(command)),
    maximumCommandBytes: 768,
    limitation: "Diagnostic interactive UART transport only. The production commandFrame input budget remains 8192 bytes and its original retained sequence is unchanged.",
  };
}
