// SPDX-License-Identifier: Apache-2.0

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CommandFrameReader,
  MAX_OUTPUT_BYTES,
  commandFrame,
  hasRecoveryFrame,
  parseCommandFrame,
  partialCommandOutput,
  recoveryFrame,
  shellQuote,
  truncateUtf8,
} from "./command-protocol.ts";

test("shell quoting preserves quotes and does not interpolate command substitution in the outer shell", () => {
  assert.equal(
    shellQuote("printf '%s' '$(uname)'"),
    `'printf '"'"'%s'"'"' '"'"'$(uname)'"'"''`,
  );
});

test("echoed wrapper is not a completion and a nonzero exit code remains nonzero", () => {
  const wrapper = commandFrame("false", "abc123");
  assert.equal(parseCommandFrame(wrapper, "abc123"), null);
  assert.deepEqual(
    parseCommandFrame(
      `${wrapper}\r\n__TRM_BEGIN_abc123__\r\n\r\n__TRM_END_abc123__:1\r\n`,
      "abc123",
    ),
    { output: "", exitCode: 1 },
  );
});

test("partial markers and unrelated markers cannot finish another command", () => {
  assert.equal(
    parseCommandFrame(
      "\n__TRM_BEGIN_abc__\nhello\n__TRM_END_other__:0\n",
      "abc",
    ),
    null,
  );
  assert.equal(
    parseCommandFrame("\n__TRM_BEGIN_abc__\nhello\n__TRM_END_abc__:0", "abc"),
    null,
  );
  assert.equal(
    partialCommandOutput("echo wrapper\n__TRM_BEGIN_abc__\nhello", "abc"),
    "hello",
  );
});

test("real output is separated from framing and guest exit status is returned", () => {
  const data =
    "~% wrapper\r\n__TRM_BEGIN_abc__\r\nLinux\r\n\r\n__TRM_END_abc__:127\r\n~% ";
  assert.deepEqual(parseCommandFrame(data, "abc"), {
    output: "Linux\n",
    exitCode: 127,
  });
});

test("invalid and oversized commands are rejected before sending", () => {
  assert.throws(() => commandFrame(" ", "abc"));
  assert.throws(() => commandFrame("x".repeat(8193), "abc"));
  assert.throws(() => commandFrame("printf x", "not;a-token"));
  assert.throws(() => commandFrame("a\0b", "abc"));
  assert.throws(() => commandFrame("🤖".repeat(2049), "abc"));
  assert.throws(() => parseCommandFrame("", ".*"));
});

test("framing encodes control characters, quotes, and long UTF-8 without oversized terminal lines", () => {
  const command =
    'printf "quotes" ' + "'single'" + "\n\x03\x1b\r" + "å🤖".repeat(1100);
  const frame = commandFrame(command, "encoded");
  const encoded = [...frame.matchAll(/printf '%s' '([A-Za-z0-9+/=]+)'/g)]
    .map((part) => part[1])
    .join("");
  assert.equal(
    new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
    ),
    command,
  );
  assert.ok(frame.split("\n").every((line) => line.length < 600));
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f]/.test(frame));
  assert.ok(frame.includes('/bin/sh "$_trm_dir/run.sh" </dev/null'));
});

test("UTF-8 truncation obeys byte limits without cutting a code point", () => {
  assert.equal(truncateUtf8("å🤖z", 5), "å");
  assert.equal(truncateUtf8("å🤖z", 6), "å🤖");
  assert.equal(truncateUtf8("å🤖z", 7), "å🤖z");
  const output = truncateUtf8("🤖".repeat(20_000), MAX_OUTPUT_BYTES);
  assert.equal(new TextEncoder().encode(output).byteLength, MAX_OUTPUT_BYTES);
  assert.equal(output.length, 32_768);
});

test("stream collection tolerates split CRLF and split markers with exact output limits", () => {
  const reader = new CommandFrameReader("stream");
  reader.push("old output".repeat(50_000));
  assert.equal(reader.push("\r\n__TRM_BEGIN_stream__\r").complete, false);
  assert.equal(reader.push("\n" + "x".repeat(MAX_OUTPUT_BYTES)).limited, false);
  assert.equal(reader.push("\r\n__TRM_END_stream__:").limited, false);
  assert.equal(reader.push("0\r").complete, false);
  const result = reader.push("\n~% ");
  assert.equal(result.complete, true);
  assert.equal(result.limited, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "x".repeat(MAX_OUTPUT_BYTES));
});

test("a large live output event is capped by UTF-8 bytes before completion", () => {
  const reader = new CommandFrameReader("limit");
  const result = reader.push("\n__TRM_BEGIN_limit__\n" + "🤖".repeat(500_000));
  assert.equal(result.limited, true);
  assert.equal(result.complete, false);
  assert.equal(result.exitCode, null);
  assert.equal(
    new TextEncoder().encode(result.output).byteLength,
    MAX_OUTPUT_BYTES,
  );
  assert.equal(reader.getOutput(), result.output);
});

test("recovery requires a fresh, complete acknowledgment rather than echoed probe text", () => {
  const probe = recoveryFrame("recover");
  assert.equal(hasRecoveryFrame(probe, "recover"), false);
  assert.equal(hasRecoveryFrame("\n__TRM_READY_old__\n", "recover"), false);
  assert.equal(hasRecoveryFrame("\n__TRM_READY_recover__", "recover"), false);
  assert.equal(
    hasRecoveryFrame("\r\n__TRM_READY_recover__\r\n", "recover"),
    true,
  );
});
