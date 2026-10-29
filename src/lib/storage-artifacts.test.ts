// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import "fake-indexeddb/auto";
import { storeSnapshot, readSnapshot, deleteSnapshot, listSnapshots, subscribeSnapshotChanges } from "./snapshots.ts";
import { createEvidenceArchive, decodeEvidenceBytes } from "./evidence.ts";
import { storeEvidence, readEvidence, deleteEvidence, listEvidence, subscribeEvidenceChanges } from "./evidence-store.ts";
import { assertNoPendingResourceMutations } from "./resource-events.ts";

function checkpoint(): ArrayBuffer {
  const state: unknown[] = Array.from({ length: 94 }, () => null);
  state[0] = 128 * 1024 * 1024;
  state[1] = { __state_type__: "Uint8Array", buffer_id: 0 };
  state[52] = [2 * 1024 * 1024];
  for (const index of [54, 79, 80, 81]) state[index] = [];
  const metadata = new TextEncoder().encode(JSON.stringify({ state, buffer_infos: [{ offset: 0, length: 8 }] }));
  const buffer = new ArrayBuffer(Math.ceil((16 + metadata.length) / 4) * 4 + 8);
  const header = new DataView(buffer);
  header.setUint32(0, 0x86768676, true); header.setUint32(4, 6, true);
  header.setUint32(8, buffer.byteLength, true); header.setUint32(12, metadata.length, true);
  new Uint8Array(buffer, 16, metadata.length).set(metadata);
  return buffer;
}

test("snapshot deletion is conditional, atomic and does not invalidate an already loaded copy", async () => {
  const events: string[] = [];
  const unsubscribe = subscribeSnapshotChanges((change) => events.push(change.action));
  const bytes = checkpoint();
  const saving = storeSnapshot("preserved state", bytes);
  assert.throws(assertNoPendingResourceMutations, /snapshot/);
  const meta = await saving;
  assert.doesNotThrow(assertNoPendingResourceMutations);
  try {
    assert.deepEqual(events, ["created"]);
    await assert.rejects(deleteSnapshot(meta.id, { ifSha256: "0".repeat(64) }), /changed since deletion/);
    assert.deepEqual(await readSnapshot(meta.id), bytes);
    assert.deepEqual(events, ["created"]);
    const loaded = await readSnapshot(meta.id);
    await deleteSnapshot(meta.id, { ifSha256: meta.sha256 });
    assert.deepEqual(loaded, bytes);
    assert.equal((await listSnapshots()).some((entry) => entry.id === meta.id), false);
    await assert.rejects(readSnapshot(meta.id), /not found/);
    assert.deepEqual(events, ["created", "deleted"]);
    await deleteSnapshot(meta.id);
    assert.equal(events.length, 2);
  } finally { unsubscribe(); await deleteSnapshot(meta.id); }
});

test("evidence deletion preserves independent loaded bytes and emits only after successful changes", async () => {
  const events: string[] = [];
  const unsubscribe = subscribeEvidenceChanges((change) => events.push(change.action));
  const archive = await createEvidenceArchive("binary evidence", [{ path: "/root/capture.bin", bytes: new Uint8Array([0, 255, 17]) }], { method: "guest-assisted-logical", guestExecuted: true });
  const saving = storeEvidence(archive);
  assert.throws(assertNoPendingResourceMutations, /evidence/);
  const meta = await saving;
  assert.doesNotThrow(assertNoPendingResourceMutations);
  try {
    await assert.rejects(storeEvidence(archive), /already saved/);
    await assert.rejects(deleteEvidence(meta.id, { ifSha256: "0".repeat(64) }), /changed since deletion/);
    assert.deepEqual(events, ["created"]);
    const loaded = await readEvidence(meta.id);
    await deleteEvidence(meta.id, { ifSha256: meta.sha256 });
    assert.deepEqual(decodeEvidenceBytes(loaded.files[0]), new Uint8Array([0, 255, 17]));
    assert.equal((await listEvidence()).some((entry) => entry.id === meta.id), false);
    await assert.rejects(readEvidence(meta.id), /not found/);
    assert.deepEqual(events, ["created", "deleted"]);
    await deleteEvidence(meta.id);
    assert.equal(events.length, 2);
  } finally { unsubscribe(); await deleteEvidence(meta.id); }
});
