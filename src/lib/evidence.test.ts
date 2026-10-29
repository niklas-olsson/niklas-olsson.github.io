// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEvidenceArchive,
  decodeEvidenceBytes,
  exportEvidenceArchive,
  importEvidenceArchive,
  validateEvidencePaths,
  MAX_EVIDENCE_ARCHIVE_BYTES,
  MAX_EVIDENCE_FILE_BYTES,
} from "./evidence.ts";
import { ReadonlyEvidence9p } from "./evidence-9p.ts";
import { readBounded9pFile } from "./evidence-transfer.ts";

const source = {
  method: "guest-assisted-logical",
  guestExecuted: true,
} as const;
const fixture = () =>
  createEvidenceArchive(
    "A capture",
    [
      { path: "/root/binary.dat", bytes: new Uint8Array([0, 1, 255, 65]) },
      {
        path: "/etc/message",
        bytes: new TextEncoder().encode("A bounded logical copy.\n"),
      },
    ],
    source,
  );

test("binary archives round-trip with host digests and immutable input copies", async () => {
  const bytes = new Uint8Array([0, 1, 255]);
  const pending = createEvidenceArchive(
    "copy",
    [{ path: "/root/file", bytes }],
    source,
  );
  bytes.fill(8);
  const archive = await pending;
  assert.deepEqual([...decodeEvidenceBytes(archive.files[0])], [0, 1, 255]);
  const imported = await importEvidenceArchive(exportEvidenceArchive(archive));
  assert.equal(imported.sha256, archive.sha256);
  assert.ok(Object.isFrozen(imported));
  assert.ok(Object.isFrozen(imported.files));
  const decoded = decodeEvidenceBytes(imported.files[0]);
  decoded.fill(9);
  assert.deepEqual([...decodeEvidenceBytes(imported.files[0])], [0, 1, 255]);
});

test("file corruption and changed provenance fail verification", async () => {
  const archive = await fixture();
  const corrupted = JSON.parse(
    new TextDecoder().decode(exportEvidenceArchive(archive)),
  );
  corrupted.files[0].base64 = "QQ==";
  corrupted.files[0].size = 1;
  await assert.rejects(
    importEvidenceArchive(JSON.stringify(corrupted)),
    /integrity verification failed/,
  );
  const changed = JSON.parse(
    new TextDecoder().decode(exportEvidenceArchive(archive)),
  );
  changed.source.machineName = "a different machine";
  await assert.rejects(
    importEvidenceArchive(JSON.stringify(changed)),
    /Archive integrity/,
  );
});

test("a full-size binary file imports without an unbounded decoding expression", async () => {
  const bytes = new Uint8Array(MAX_EVIDENCE_FILE_BYTES).fill(255);
  const archive = await createEvidenceArchive(
    "one MiB",
    [{ path: "/root/full.bin", bytes }],
    source,
  );
  const imported = await importEvidenceArchive(exportEvidenceArchive(archive));
  assert.equal(imported.totalBytes, MAX_EVIDENCE_FILE_BYTES);
  assert.deepEqual(decodeEvidenceBytes(imported.files[0]), bytes);
});

test("archive imports reject traversal, conflicting paths, malformed encodings, and size expansion", async () => {
  for (const path of [
    "/../etc/passwd",
    "/root/./a",
    "/root//a",
    "/root/a\nb",
    "relative",
    "/root\\a",
  ])
    assert.throws(() => validateEvidencePaths([path]), /canonical absolute/);
  assert.throws(
    () => validateEvidencePaths(["/file", "/file/child"]),
    /parent directory/,
  );
  await assert.rejects(
    createEvidenceArchive(
      "large",
      [{ path: "/file", bytes: new Uint8Array(MAX_EVIDENCE_FILE_BYTES + 1) }],
      source,
    ),
    /1 MiB/,
  );
  await assert.rejects(
    importEvidenceArchive(new Uint8Array(MAX_EVIDENCE_ARCHIVE_BYTES + 1)),
    /12 MiB/,
  );
  const corrupt = JSON.parse(
    new TextDecoder().decode(exportEvidenceArchive(await fixture())),
  );
  corrupt.files[0].base64 = "not-base64";
  corrupt.files[0].size = 1;
  await assert.rejects(
    importEvidenceArchive(JSON.stringify(corrupt)),
    /invalid binary/,
  );
});

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}
function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}
function string(value: string): Uint8Array {
  const text = new TextEncoder().encode(value),
    bytes = new Uint8Array(text.length + 2);
  bytes.set(u16(text.length));
  bytes.set(text, 2);
  return bytes;
}
function packet(type: number, ...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(
    7 + parts.reduce((size, part) => size + part.length, 0),
  );
  bytes.set(u32(bytes.length));
  bytes[4] = type;
  bytes.set(u16(23), 5);
  let offset = 7;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
function send(server: ReadonlyEvidence9p, input: Uint8Array): Uint8Array {
  let response: Uint8Array | undefined;
  server.handle(input, (bytes) => {
    response = bytes;
  });
  assert.ok(response);
  return response;
}

test("host 9p export reads exact bytes and rejects writes regardless of guest mount flags", async () => {
  const archive = await fixture(),
    server = new ReadonlyEvidence9p(archive);
  assert.equal(
    send(server, packet(100, u32(65536), string("9P2000.L")))[4],
    101,
  );
  assert.equal(
    send(
      server,
      packet(104, u32(1), u32(0xffffffff), string("root"), string(""), u32(0)),
    )[4],
    105,
  );
  assert.equal(
    send(
      server,
      packet(
        110,
        u32(1),
        u32(2),
        u16(3),
        string("files"),
        string("root"),
        string("binary.dat"),
      ),
    )[4],
    111,
  );
  assert.equal(send(server, packet(12, u32(2), u32(0)))[4], 13);
  const read = send(
    server,
    packet(116, u32(2), new Uint8Array(8), u32(0xffffffff)),
  );
  assert.equal(read[4], 117);
  assert.deepEqual([...read.subarray(11)], [0, 1, 255, 65]);
  for (const request of [
    packet(12, u32(2), u32(1)),
    packet(118),
    packet(26),
    packet(76),
    packet(114),
  ]) {
    const response = send(server, request);
    assert.equal(response[4], 7);
    assert.equal(new DataView(response.buffer).getUint32(7, true), 30);
  }
  assert.equal(server.getDeniedWrites(), 5);
  assert.deepEqual(
    [
      ...send(server, packet(116, u32(2), new Uint8Array(8), u32(4))).subarray(
        11,
      ),
    ],
    [0, 1, 255, 65],
  );
});

test("malformed 9p requests return bounded errors without touching evidence", async () => {
  const server = new ReadonlyEvidence9p(await fixture());
  const malformed = packet(100);
  new DataView(malformed.buffer).setUint32(0, 0xffffffff, true);
  const result = send(server, malformed);
  assert.equal(result.byteLength, 11);
  assert.equal(result[4], 7);
  assert.equal(new DataView(result.buffer).getUint32(7, true), 22);
});

test("host staging size is rejected before read and extraction requests a bounded count", async () => {
  let size = MAX_EVIDENCE_FILE_BYTES + 1;
  let reads = 0;
  const fs9p = {
    SearchPath: () => ({ id: 1 }),
    GetInode: () => ({ size, mode: 0o100644, status: 0 }),
    Read: async (_id: number, offset: number, count: number) => {
      reads++;
      assert.equal(offset, 0);
      assert.equal(count, 4);
      return new Uint8Array([0, 1, 2, 3]);
    },
  };
  await assert.rejects(
    readBounded9pFile({ fs9p }, "capture.bin"),
    /contents were not read/,
  );
  assert.equal(reads, 0);
  size = 4;
  assert.deepEqual(
    [...(await readBounded9pFile({ fs9p }, "capture.bin"))],
    [0, 1, 2, 3],
  );
  assert.equal(reads, 1);
});

test("staging growth during an asynchronous read fails before a capture is produced", async () => {
  let size = 4;
  const fs9p = {
    SearchPath: () => ({ id: 1 }),
    GetInode: () => ({ size, mode: 0o100644, status: 0 }),
    Read: async () => {
      size = 8;
      return new Uint8Array(4);
    },
  };
  await assert.rejects(
    readBounded9pFile({ fs9p }, "capture.bin"),
    /changed while it was being read/,
  );
});
