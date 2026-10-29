import assert from "node:assert/strict";
import test from "node:test";
import { validateSnapshot, inspectSnapshot } from "./snapshot-format.ts";

function metadata() {
  const state: unknown[] = Array.from({ length: 94 }, () => null);
  state[0] = 128 * 1024 * 1024;
  state[1] = { __state_type__: "Uint8Array", buffer_id: 0 };
  state[52] = [2 * 1024 * 1024];
  for (const index of [54, 79, 80, 81]) state[index] = [];
  return { state, buffer_infos: [{ offset: 0, length: 8 }] };
}

function snapshot(description = metadata(), dataBytes = 8): ArrayBuffer {
  const text = new TextEncoder().encode(JSON.stringify(description));
  const dataOffset = Math.ceil((16 + text.length) / 4) * 4;
  const buffer = new ArrayBuffer(dataOffset + dataBytes);
  const header = new DataView(buffer);
  header.setUint32(0, 0x86768676, true);
  header.setUint32(4, 6, true);
  header.setUint32(8, buffer.byteLength, true);
  header.setUint32(12, text.length, true);
  new Uint8Array(buffer, 16, text.length).set(text);
  return buffer;
}

test("accepts the current raw header, machine profile, and contiguous buffer layout", () => {
  assert.doesNotThrow(() => validateSnapshot(snapshot()));
});

test("rejects compressed, truncated, and foreign-version states before decoding", () => {
  for (const [offset, value] of [
    [0, 0xfd2fb528],
    [4, 5],
    [8, 64],
  ]) {
    const buffer = snapshot();
    new DataView(buffer).setUint32(offset, value, true);
    assert.throws(
      () => validateSnapshot(buffer),
      /compatible Terrarium snapshot/,
    );
  }
  assert.throws(() => validateSnapshot(new ArrayBuffer(32)), /64 bytes/);
});

test("enforces bounded metadata and valid UTF-8 JSON", () => {
  const oversized = snapshot();
  new DataView(oversized).setUint32(12, 1024 * 1024 + 1, true);
  assert.throws(() => validateSnapshot(oversized), /metadata/);
  const malformed = snapshot();
  new Uint8Array(malformed)[16] = 0xff;
  assert.throws(() => validateSnapshot(malformed), /metadata/);
});

test("rejects incompatible memory profiles", () => {
  const ram = metadata();
  ram.state[0] = 1024 * 1024 * 1024;
  assert.throws(() => validateSnapshot(snapshot(ram)), /128 MiB/);
  const vga = metadata();
  vga.state[52] = [256 * 1024 * 1024];
  assert.throws(() => validateSnapshot(snapshot(vga)), /video memory/);
});

test("rejects earlier single-UART snapshots before replacing a live machine", () => {
  const old = metadata();
  old.state[79] = null;
  old.state[80] = null;
  old.state[81] = null;
  assert.throws(() => validateSnapshot(snapshot(old)), /four UARTs/);
});

test("rejects overlapping, negative, and out-of-range buffers", () => {
  for (const entries of [
    [
      { offset: 0, length: 8 },
      { offset: 0, length: 8 },
    ],
    [{ offset: 0, length: -8 }],
    [{ offset: 0, length: 128 }],
  ]) {
    const description = metadata();
    description.buffer_infos = entries;
    assert.throws(() => validateSnapshot(snapshot(description)), /buffer/);
  }
});

test("rejects typed-array constructor arguments and invalid buffer references", () => {
  for (const value of [
    { __state_type__: "Uint8Array", args: 2 ** 31 },
    { __state_type__: "Uint8Array", buffer_id: 1 },
    { __state_type__: "constructor", buffer_id: 0 },
    { __state_type__: "Uint8Array", buffer_id: 0, args: [] },
  ]) {
    const description = metadata();
    description.state[1] = value;
    assert.throws(
      () => validateSnapshot(snapshot(description)),
      /typed state buffer/,
    );
  }
});

test("rejects deeply nested metadata before v86 recurses into it", () => {
  const description = metadata();
  let nested: unknown = 0;
  for (let i = 0; i < 70; i++) nested = [nested];
  description.state[2] = nested;
  assert.throws(() => validateSnapshot(snapshot(description)), /too complex/);
});

test("permits bounded serialized maps while rejecting malformed entries", () => {
  const description = metadata();
  description.state[2] = { __state_type__: "Map", args: [["hello", 1]] };
  assert.doesNotThrow(() => validateSnapshot(snapshot(description)));
  description.state[2] = { __state_type__: "Map", args: [1, 2] };
  assert.throws(() => validateSnapshot(snapshot(description)), /state map/);
});

test("passive inspection decodes the pinned CPU fields and preserves original bytes", async () => {
  const description = metadata();
  description.state[37] = -1;
  description.state[38] = 0x12345678;
  description.state[4] = 1;
  description.state[17] = 0;
  description.state[11] = 3;
  description.state[39] = { __state_type__: "Int32Array", buffer_id: 0 };
  description.buffer_infos[0].length = 32;
  const buffer = snapshot(description, 32);
  const dataOffset = buffer.byteLength - 32;
  for (let index = 0; index < 8; index++)
    new DataView(buffer).setUint32(dataOffset + index * 4, index + 1, true);
  const before = new Uint8Array(buffer).slice();
  const inspection = await inspectSnapshot(buffer);
  assert.equal(inspection.cpu.instructionPointer, 0xffffffff);
  assert.equal(inspection.cpu.previousInstructionPointer, 0x12345678);
  assert.equal(inspection.cpu.protectedMode, true);
  assert.equal(inspection.cpu.halted, false);
  assert.equal(inspection.cpu.privilegeLevel, 3);
  assert.deepEqual(inspection.cpu.generalRegisters, {
    eax: 1,
    ecx: 2,
    edx: 3,
    ebx: 4,
    esp: 5,
    ebp: 6,
    esi: 7,
    edi: 8,
  });
  assert.match(inspection.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(new Uint8Array(buffer), before);
});
