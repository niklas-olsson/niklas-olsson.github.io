// SPDX-License-Identifier: Apache-2.0
import {
  MAX_SNAPSHOT_BYTES,
  RUNTIME_MEMORY_MIB,
  RUNTIME_VERSION,
} from "./runtime-types.ts";
import { sha256Bytes } from "./evidence.ts";

const STATE_MAGIC = 0x86768676;
const STATE_FORMAT = 6;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_BUFFERS = 4096;
const TYPE_WIDTHS: Readonly<Record<string, number>> = Object.freeze({
  Uint8Array: 1,
  Int8Array: 1,
  Uint16Array: 2,
  Int16Array: 2,
  Uint32Array: 4,
  Int32Array: 4,
  Float32Array: 4,
  Float64Array: 8,
});

function invalid(reason: string): Error {
  return new Error(`This is not a compatible Terrarium snapshot: ${reason}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bound the input before handing it to v86's synchronous state decoder.
 * This accepts this application's raw format, never compressed state files.
 * It is not authentication or a complete audit of every emulated device state.
 */
export function validateSnapshot(buffer: ArrayBuffer): void {
  if (
    !(buffer instanceof ArrayBuffer) ||
    buffer.byteLength < 64 ||
    buffer.byteLength > MAX_SNAPSHOT_BYTES
  ) {
    throw invalid("choose a raw state file between 64 bytes and 256 MiB.");
  }
  const header = new DataView(buffer, 0, 16);
  if (header.getUint32(0, true) !== STATE_MAGIC)
    throw invalid(
      "only uncompressed snapshots exported by this app are supported.",
    );
  if (header.getUint32(4, true) !== STATE_FORMAT)
    throw invalid("the emulator state format differs.");
  if (header.getUint32(8, true) !== buffer.byteLength)
    throw invalid("the file is incomplete or has an invalid declared size.");
  const metadataLength = header.getUint32(12, true);
  const dataOffset = Math.ceil((16 + metadataLength) / 4) * 4;
  if (
    metadataLength === 0 ||
    metadataLength > MAX_METADATA_BYTES ||
    dataOffset > buffer.byteLength
  ) {
    throw invalid("the metadata is missing or exceeds the supported size.");
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        new Uint8Array(buffer, 16, metadataLength),
      ),
    );
  } catch {
    throw invalid("the metadata cannot be read.");
  }
  if (
    !record(metadata) ||
    !Array.isArray(metadata.buffer_infos) ||
    !Array.isArray(metadata.state)
  ) {
    throw invalid("the machine description is missing.");
  }
  if (
    metadata.buffer_infos.length > MAX_BUFFERS ||
    metadata.state.length !== 94
  )
    throw invalid("the machine description does not match this runtime.");
  if (metadata.state[0] !== RUNTIME_MEMORY_MIB * 1024 * 1024)
    throw invalid("the guest memory size must be 128 MiB.");
  if (
    !Array.isArray(metadata.state[52]) ||
    metadata.state[52][0] !== 2 * 1024 * 1024
  ) {
    throw invalid("the video memory configuration differs.");
  }
  const machineState = metadata.state;
  if (![54, 79, 80, 81].every((index) => Array.isArray(machineState[index]))) {
    throw invalid(
      "this version requires four UARTs. Snapshots from the earlier single-console profile cannot be restored into this machine.",
    );
  }

  // v86 copies each described buffer. Require the contiguous, nonoverlapping
  // layout emitted by save_state(), so metadata cannot multiply allocations.
  const lengths: number[] = [];
  let expectedOffset = 0;
  for (const entry of metadata.buffer_infos) {
    if (
      !record(entry) ||
      typeof entry.offset !== "number" ||
      typeof entry.length !== "number" ||
      !Number.isSafeInteger(entry.offset) ||
      !Number.isSafeInteger(entry.length) ||
      entry.offset !== expectedOffset ||
      entry.length < 0 ||
      dataOffset + entry.offset + entry.length > buffer.byteLength
    ) {
      throw invalid(
        "a state buffer is outside the file or overlaps another buffer.",
      );
    }
    lengths.push(entry.length);
    expectedOffset = Math.ceil((expectedOffset + entry.length) / 4) * 4;
  }
  if (dataOffset + expectedOffset !== buffer.byteLength)
    throw invalid("the state buffer lengths do not match the file.");

  // Validate the serialized type constructors without recursive JS calls.
  // Only buffer-backed arrays and bounded Map entries may reach v86.
  const pending: { value: unknown; depth: number }[] = [
    { value: metadata.state, depth: 0 },
  ];
  let visited = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++visited > 100_000 || depth > 64)
      throw invalid("the machine description is too complex.");
    if (Array.isArray(value)) {
      for (const child of value)
        pending.push({ value: child, depth: depth + 1 });
    } else if (record(value)) {
      const type = value.__state_type__;
      if (type === "Map") {
        if (
          !Array.isArray(value.args) ||
          value.args.length > MAX_BUFFERS ||
          Object.keys(value).some(
            (key) => key !== "__state_type__" && key !== "args",
          ) ||
          value.args.some(
            (entry) => !Array.isArray(entry) || entry.length !== 2,
          )
        ) {
          throw invalid("a state map is malformed.");
        }
        pending.push({ value: value.args, depth: depth + 1 });
      } else {
        if (
          typeof type !== "string" ||
          !Object.hasOwn(TYPE_WIDTHS, type) ||
          typeof value.buffer_id !== "number" ||
          !Number.isInteger(value.buffer_id) ||
          value.buffer_id < 0 ||
          value.buffer_id >= lengths.length ||
          lengths[value.buffer_id] % TYPE_WIDTHS[type] !== 0 ||
          Object.keys(value).some(
            (key) => key !== "__state_type__" && key !== "buffer_id",
          )
        ) {
          throw invalid("a typed state buffer is malformed.");
        }
      }
    } else if (typeof value === "number" && !Number.isFinite(value)) {
      throw invalid("the machine description contains an invalid number.");
    }
  }
}

export interface SnapshotInspection {
  sha256: string;
  size: number;
  formatVersion: 6;
  runtimeVersion: string;
  memoryMiB: 128;
  videoMemoryMiB: 2;
  serialPorts: 4;
  metadataBytes: number;
  bufferCount: number;
  cpu: {
    /** Raw serialized linear instruction pointer, not a reconstructed stack or process list. */
    instructionPointer: number | null;
    previousInstructionPointer: number | null;
    privilegeLevel: number | null;
    protectedMode: boolean | null;
    halted: boolean | null;
    generalRegisters: Record<string, number> | null;
  };
}

/** Passive format decoding only. This never instantiates or runs an emulator. */
export async function inspectSnapshot(
  input: ArrayBuffer,
): Promise<SnapshotInspection> {
  validateSnapshot(input);
  const buffer = input.slice(0);
  const metadataBytes = new DataView(buffer).getUint32(12, true);
  const dataOffset = Math.ceil((16 + metadataBytes) / 4) * 4;
  const metadata = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 16, metadataBytes)),
  ) as {
    state: unknown[];
    buffer_infos: { offset: number; length: number }[];
  };
  const state = metadata.state;
  const integer = (index: number): number | null =>
    typeof state[index] === "number" && Number.isInteger(state[index])
      ? (state[index] as number) >>> 0
      : null;
  const flag = (index: number): boolean | null =>
    state[index] === 0 ? false : state[index] === 1 ? true : null;
  let generalRegisters: Record<string, number> | null = null;
  const reference = state[39];
  // These offsets are from CPU.get_state() in the pinned v86@0.5.472 build.
  // reg32 uses the architectural EAX,ECX,EDX,EBX,ESP,EBP,ESI,EDI order.
  if (
    record(reference) &&
    (reference.__state_type__ === "Int32Array" ||
      reference.__state_type__ === "Uint32Array") &&
    typeof reference.buffer_id === "number"
  ) {
    const info = metadata.buffer_infos[reference.buffer_id];
    if (info?.length === 32) {
      const values = new DataView(
        buffer,
        dataOffset + info.offset,
        info.length,
      );
      generalRegisters = Object.fromEntries(
        ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"].map(
          (name, index) => [name, values.getUint32(index * 4, true)],
        ),
      );
    }
  }
  return Object.freeze({
    sha256: await sha256Bytes(buffer),
    size: buffer.byteLength,
    formatVersion: 6,
    runtimeVersion: RUNTIME_VERSION,
    memoryMiB: 128,
    videoMemoryMiB: 2,
    serialPorts: 4,
    metadataBytes,
    bufferCount: metadata.buffer_infos.length,
    cpu: Object.freeze({
      instructionPointer: integer(37),
      previousInstructionPointer: integer(38),
      privilegeLevel:
        typeof state[11] === "number" &&
        [0, 1, 2, 3].includes(state[11] as number)
          ? (state[11] as number)
          : null,
      protectedMode: flag(4),
      halted: flag(17),
      generalRegisters: generalRegisters
        ? Object.freeze(generalRegisters)
        : null,
    }),
  });
}
