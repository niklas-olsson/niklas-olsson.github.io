// SPDX-License-Identifier: Apache-2.0

const DATA_BYTES = 65_536;
const HEADER_BYTES = 16;
const IO_DEADLINE_MS = 30_000;

// Emscripten doReadv/doWritev use signed HEAP8; filesystem helpers also use
// Uint8Array. Both represent bytes, and all ranges must be complete before I/O.
const validBufferRange = (buffer, offset, length) =>
  (buffer instanceof Uint8Array || buffer instanceof Int8Array)
  && Number.isSafeInteger(offset) && Number.isSafeInteger(length)
  && offset >= 0 && length >= 0 && offset + length <= buffer.byteLength;

/** Immutable image supplied by the host. Even direct FS writes cannot change it. */
export function installEvidenceDisk(FS, image) {
  if (!(image instanceof ArrayBuffer) || image.byteLength < 4 * 1024 * 1024
    || image.byteLength > 128 * 1024 * 1024 || image.byteLength % 512)
    throw new Error("The evidence disk must be a bounded raw filesystem image.");
  FS.mkdirTree("/evidence");
  FS.writeFile("/evidence/disk.raw", new Uint8Array(image), { canOwn: true });
  const node = FS.lookupPath("/evidence/disk.raw").node;
  const originalNode = node.node_ops;
  const deny = () => { throw new FS.ErrnoError(69); };
  node.node_ops = { ...originalNode,
    setattr(target, attributes) {
      if (attributes.size !== undefined || attributes.mode !== undefined) deny();
      return originalNode.setattr(target, attributes);
    },
  };
  node.stream_ops = { ...node.stream_ops, write: deny, allocate: deny, mmap: deny, msync: deny };
}

/** Sparse QEMU backend. Reads and writes use a fixed host-owned commit mailbox. */
export function installPersistentDisks(FS, definitions, emit, onError) {
  if (!Array.isArray(definitions) || definitions.length > 2) throw new Error("At most two QEMU data disks are supported.");
  const disks = new Map();
  FS.mkdirTree("/volumes");
  let closed = false;
  for (const definition of definitions) {
    const { slot, bytes, readOnly, transport, mailbox } = definition;
    if ((slot !== 0 && slot !== 1) || disks.has(slot) || !Number.isSafeInteger(bytes)
      || bytes < 4 * 1024 * 1024 || bytes > 8 * 1024 * 1024 * 1024 || bytes % 512
      || typeof readOnly !== "boolean" || transport !== "paged-v1"
      || !(mailbox instanceof SharedArrayBuffer) || mailbox.byteLength !== HEADER_BYTES + DATA_BYTES)
      throw new Error("Invalid QEMU persistent disk descriptor.");
    const header = new Int32Array(mailbox, 0, 4), data = new Uint8Array(mailbox, HEADER_BYTES);
    let sequence = 0, failed = false;
    const request = (operation, offset = 0, chunk = null, length = chunk?.byteLength ?? 0) => {
      if (closed || failed) throw new FS.ErrnoError(29);
      if (++sequence > 0x7fffffff) throw new FS.ErrnoError(29);
      Atomics.store(header, 1, sequence);
      if (chunk) data.set(chunk);
      Atomics.store(header, 0, 0);
      emit({ type: "disk-request", operation, slot, sequence, offset, length });
      const until = performance.now() + IO_DEADLINE_MS;
      while (Atomics.load(header, 0) === 0) {
        const remaining = until - performance.now();
        if (remaining <= 0 || Atomics.wait(header, 0, 0, remaining) === "timed-out") break;
      }
      const status = Atomics.load(header, 0);
      if (status !== 1 || Atomics.load(header, 1) !== sequence) {
        failed = true;
        onError(new Error(status === 0 ? "The persistent disk I/O timed out." : "The persistent disk rejected an I/O operation."));
        throw new FS.ErrnoError(status === -2 ? 69 : 29);
      }
    };
    const path = `/volumes/disk${slot}.raw`;
    FS.writeFile(path, new Uint8Array());
    const node = FS.lookupPath(path).node;
    node.usedBytes = bytes; // contents remains empty; logical size must never allocate MEMFS storage.
    const original = node.stream_ops, originalNode = node.node_ops;
    node.node_ops = {
      ...originalNode,
      setattr(target, attributes) {
        if (attributes.size !== undefined && attributes.size !== bytes) throw new FS.ErrnoError(28);
        const remaining = { ...attributes };
        delete remaining.size; // Even an equal-size setattr must not resize the empty MEMFS array.
        originalNode.setattr(target, remaining);
      },
    };
    node.stream_ops = {
      ...original,
      read(_stream, buffer, offset, length, position) {
        if (closed || failed) throw new FS.ErrnoError(29);
        if (!validBufferRange(buffer, offset, length) || !Number.isSafeInteger(position) || position < 0)
          throw new FS.ErrnoError(28);
        const count = Math.max(0, Math.min(length, bytes - position));
        for (let at = 0; at < count; at += DATA_BYTES) {
          const part = Math.min(DATA_BYTES, count - at);
          request("read", position + at, null, part);
          buffer.set(data.subarray(0, part), offset + at);
        }
        return count;
      },
      write(_stream, buffer, offset, length, position) {
        if (closed || failed) throw new FS.ErrnoError(29);
        if (readOnly) throw new FS.ErrnoError(69);
        if (!validBufferRange(buffer, offset, length) || !Number.isSafeInteger(position) || position < 0 || position + length > bytes)
          throw new FS.ErrnoError(28);
        for (let at = 0; at < length; at += DATA_BYTES) {
          const count = Math.min(DATA_BYTES, length - at);
          const chunk = new Uint8Array(count);
          chunk.set(new Uint8Array(buffer.buffer, buffer.byteOffset + offset + at, count));
          request("write", position + at, chunk);
        }
        return length;
      },
      allocate(_stream, offset, length) {
        if (closed || failed) throw new FS.ErrnoError(29);
        if (readOnly) throw new FS.ErrnoError(69);
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes)
          throw new FS.ErrnoError(28);
      },
      mmap() { throw new FS.ErrnoError(43); },
      msync() { throw new FS.ErrnoError(43); },
    };
    // Emscripten fd_sync invokes the file node's mount syncfs callback.
    // Each successful write has already committed; this still propagates a
    // failed flush and orders the host store before the guest FLUSH reply.
    node.mount = { ...node.mount, type: { ...node.mount.type,
      syncfs(_mount, populate, done) {
        try { if (populate) throw new Error("Unexpected disk populate."); request("flush"); done(null); }
        catch (error) { done(error); }
      },
    } };
    disks.set(slot, { header, request });
  }
  return {
    flush() { for (const disk of disks.values()) disk.request("flush"); },
    close() {
      closed = true;
      for (const { header } of disks.values()) { Atomics.store(header, 0, -3); Atomics.notify(header, 0); }
    },
  };
}
