// SPDX-License-Identifier: Apache-2.0
// Minimal qcow2 v3 container used only by QEMU to hold its private VM state.
// Format: https://www.qemu.org/docs/master/interop/qcow2.html

export const MAX_CHECKPOINT_BYTES = 768 * 1024 * 1024;
const CLUSTER = 65_536;

export function createCheckpointDisk() {
  const bytes = new Uint8Array(CLUSTER * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x514649fb); // QFI\xfb
  view.setUint32(4, 3);
  view.setUint32(20, 16);
  view.setBigUint64(24, 8n * 1024n * 1024n);
  view.setUint32(36, 1);
  view.setBigUint64(40, BigInt(CLUSTER * 3));
  view.setBigUint64(48, BigInt(CLUSTER));
  view.setUint32(56, 1);
  view.setUint32(96, 4);
  view.setUint32(100, 104);
  view.setBigUint64(CLUSTER, BigInt(CLUSTER * 2));
  for (let cluster = 0; cluster < 4; cluster++) view.setUint16(CLUSTER * 2 + cluster * 2, 1);
  return bytes;
}

/** An outer archive validates identity/hash too; this refuses unsafe file features. */
export function validateCheckpointDisk(bytes, requireSnapshot = true) {
  if (!(bytes instanceof Uint8Array) || bytes.length < CLUSTER * 4 || bytes.length > MAX_CHECKPOINT_BYTES || bytes.length % CLUSTER)
    throw new Error("Invalid x86_64 checkpoint container size.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x514649fb || view.getUint32(4) !== 3 || view.getUint32(20) !== 16
    || view.getBigUint64(8) !== 0n || view.getUint32(16) !== 0 || view.getBigUint64(24) !== 8n * 1024n * 1024n
    || view.getUint32(32) !== 0 || view.getBigUint64(72) !== 0n || view.getBigUint64(80) !== 0n
    || view.getBigUint64(88) !== 0n || view.getUint32(96) !== 4 || view.getUint32(100) !== 104
    || view.getUint32(104) !== 0 || view.getUint32(108) !== 0)
    throw new Error("Unsupported x86_64 checkpoint file features.");
  const pointer = (offset, count) => {
    const position = Number(view.getBigUint64(offset));
    if (!Number.isSafeInteger(position) || position < CLUSTER || position % CLUSTER || count < 1 || position + count > bytes.length)
      throw new Error("The x86_64 checkpoint has an invalid metadata extent.");
  };
  const l1Entries = view.getUint32(36);
  if (l1Entries < 1 || l1Entries > 1024) throw new Error("Invalid x86_64 checkpoint mapping table.");
  pointer(40, l1Entries * 8);
  const refcountClusters = view.getUint32(56);
  if (refcountClusters < 1 || refcountClusters > 4) throw new Error("Invalid x86_64 checkpoint reference table.");
  pointer(48, refcountClusters * CLUSTER);
  const snapshots = view.getUint32(60);
  if (snapshots > 1 || (requireSnapshot && snapshots !== 1)) throw new Error("The x86_64 checkpoint must contain exactly one VM state.");
  if (snapshots) pointer(64, 40);
  else if (view.getBigUint64(64) !== 0n) throw new Error("Invalid empty checkpoint directory.");
  return bytes;
}

/** Bound metadata growth before QEMU can allocate an oversized memory file. */
export function installCheckpointFile(FS, saved) {
  const bytes = saved ? validateCheckpointDisk(new Uint8Array(saved)) : createCheckpointDisk();
  FS.mkdirTree("/checkpoint");
  FS.writeFile("/checkpoint/state.qcow2", bytes);
  const node = FS.lookupPath("/checkpoint/state.qcow2").node;
  const original = node.stream_ops, originalNode = node.node_ops;
  const checkEnd = (end) => { if (!Number.isSafeInteger(end) || end < 0 || end > MAX_CHECKPOINT_BYTES) throw new FS.ErrnoError(22); };
  node.node_ops = { ...originalNode,
    setattr(target, attributes) { if (attributes.size !== undefined) checkEnd(attributes.size); return originalNode.setattr(target, attributes); },
  };
  node.stream_ops = { ...original,
    write(stream, buffer, offset, length, position, canOwn) { checkEnd(position + length); return original.write(stream, buffer, offset, length, position, canOwn); },
    allocate(stream, offset, length) { checkEnd(offset + length); return original.allocate(stream, offset, length); },
    mmap() { throw new FS.ErrnoError(43); },
    msync() { throw new FS.ErrnoError(43); },
  };
}
