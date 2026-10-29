// SPDX-License-Identifier: Apache-2.0
// A bounded read-only 9P2000.L server for v86's documented handle9p adapter.
// Mutations are rejected on the host, independently of guest mount options.

import {
  decodeEvidenceBytes,
  evidenceManifest,
  validateEvidencePaths,
  type EvidenceArchive,
} from "./evidence.ts";

const MAX_FRAME = 65_536;
const MAX_FIDS = 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MUTATIONS = new Set([
  14, 16, 18, 20, 26, 32, 70, 72, 74, 76, 114, 118, 122, 126,
]);

class ProtocolError extends Error {
  readonly errno: number;
  constructor(errno: number) {
    super("9p error " + errno);
    this.errno = errno;
  }
}

class Reader {
  offset = 7;
  readonly bytes: Uint8Array;
  readonly view: DataView;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private reserve(length: number): number {
    if (length < 0 || this.offset + length > this.bytes.byteLength)
      throw new ProtocolError(22);
    const start = this.offset;
    this.offset += length;
    return start;
  }
  u8(): number {
    return this.view.getUint8(this.reserve(1));
  }
  u16(): number {
    return this.view.getUint16(this.reserve(2), true);
  }
  u32(): number {
    return this.view.getUint32(this.reserve(4), true);
  }
  u64(): bigint {
    return this.view.getBigUint64(this.reserve(8), true);
  }
  string(): string {
    const length = this.u16();
    if (length > 4096) throw new ProtocolError(36);
    const start = this.reserve(length);
    return decoder.decode(this.bytes.subarray(start, start + length));
  }
}

class Writer {
  private parts: Uint8Array[] = [];
  length = 0;
  add(bytes: Uint8Array): this {
    if (this.length + bytes.byteLength > MAX_FRAME - 7)
      throw new ProtocolError(22);
    this.parts.push(bytes);
    this.length += bytes.byteLength;
    return this;
  }
  u8(value: number): this {
    return this.add(new Uint8Array([value]));
  }
  u16(value: number): this {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value, true);
    return this.add(bytes);
  }
  u32(value: number): this {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value, true);
    return this.add(bytes);
  }
  u64(value: number | bigint): this {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    return this.add(bytes);
  }
  string(value: string): this {
    const bytes = encoder.encode(value);
    return this.u16(bytes.byteLength).add(bytes);
  }
  bytes(): Uint8Array {
    const bytes = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  }
}

interface Node {
  id: number;
  name: string;
  parent: Node | null;
  children: Map<string, Node> | null;
  bytes: Uint8Array;
}

function qid(writer: Writer, node: Node): Writer {
  return writer
    .u8(node.children ? 0x80 : 0)
    .u32(0)
    .u64(node.id);
}
function response(type: number, tag: number, body = new Writer()): Uint8Array {
  const data = body.bytes();
  const bytes = new Uint8Array(7 + data.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.byteLength, true);
  view.setUint8(4, type);
  view.setUint16(5, tag, true);
  bytes.set(data, 7);
  return bytes;
}

export class ReadonlyEvidence9p {
  private readonly root: Node = {
    id: 1,
    name: "",
    parent: null,
    children: new Map(),
    bytes: new Uint8Array(),
  };
  private readonly fids = new Map<number, Node>();
  private nextId = 2;
  private msize = MAX_FRAME;
  private readonly timestamp: number;
  private totalBytes = 0;
  private deniedWrites = 0;

  constructor(archive: EvidenceArchive) {
    validateEvidencePaths(archive.files.map((file) => file.path));
    this.timestamp = Math.floor(archive.createdAt / 1000);
    this.insert("manifest.json", encoder.encode(evidenceManifest(archive)));
    for (const file of archive.files)
      this.insert("files" + file.path, decodeEvidenceBytes(file));
  }

  getDeniedWrites(): number {
    return this.deniedWrites;
  }

  private insert(path: string, bytes: Uint8Array): void {
    const parts = path.split("/");
    let parent = this.root;
    for (const [index, name] of parts.entries()) {
      if (!name || name === "." || name === ".." || !parent.children)
        throw new Error("Invalid evidence tree.");
      const last = index === parts.length - 1;
      let node = parent.children.get(name);
      if (!node) {
        node = {
          id: this.nextId++,
          name,
          parent,
          children: last ? null : new Map(),
          bytes: last ? new Uint8Array(bytes) : new Uint8Array(),
        };
        parent.children.set(name, node);
      } else if (last || !node.children)
        throw new Error("Conflicting evidence paths.");
      parent = node;
    }
    this.totalBytes += bytes.byteLength;
  }

  private fid(id: number): Node {
    const node = this.fids.get(id);
    if (!node) throw new ProtocolError(9);
    return node;
  }

  private setFid(id: number, node: Node): void {
    if (!this.fids.has(id) && this.fids.size >= MAX_FIDS)
      throw new ProtocolError(24);
    this.fids.set(id, node);
  }

  handle = (bytes: Uint8Array, reply: (bytes: Uint8Array) => void): void => {
    let tag = 0xffff;
    try {
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength < 7 ||
        bytes.byteLength > MAX_FRAME
      )
        throw new ProtocolError(22);
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      tag = view.getUint16(5, true);
      if (view.getUint32(0, true) !== bytes.byteLength)
        throw new ProtocolError(22);
      const type = view.getUint8(4);
      if (MUTATIONS.has(type)) {
        this.deniedWrites++;
        throw new ProtocolError(30);
      }
      const reader = new Reader(bytes);
      const out = new Writer();
      switch (type) {
        case 100: {
          // Tversion
          const size = reader.u32(),
            version = reader.string();
          if (size < 256) throw new ProtocolError(22);
          this.msize = Math.min(size, MAX_FRAME);
          this.fids.clear();
          out
            .u32(this.msize)
            .string(version === "9P2000.L" ? "9P2000.L" : "unknown");
          break;
        }
        case 104: {
          // Tattach; no authentication or host paths exist.
          const fid = reader.u32(),
            auth = reader.u32();
          reader.string();
          const name = reader.string();
          reader.u32();
          if (auth !== 0xffffffff || (name !== "" && name !== "/"))
            throw new ProtocolError(13);
          if (this.fids.has(fid)) throw new ProtocolError(17);
          this.setFid(fid, this.root);
          qid(out, this.root);
          break;
        }
        case 110: {
          // Twalk
          const fid = reader.u32(),
            next = reader.u32(),
            count = reader.u16();
          if (count > 128 || (next !== fid && this.fids.has(next)))
            throw new ProtocolError(22);
          let node = this.fid(fid);
          const walked: Node[] = [];
          for (let index = 0; index < count; index++) {
            const name = reader.string();
            if (!name || name.includes("/") || name.includes("\0"))
              throw new ProtocolError(22);
            const child =
              name === "."
                ? node
                : name === ".."
                  ? (node.parent ?? this.root)
                  : node.children?.get(name);
            if (!child) {
              if (!walked.length) throw new ProtocolError(2);
              break;
            }
            node = child;
            walked.push(node);
          }
          this.setFid(next, node);
          out.u16(walked.length);
          for (const child of walked) qid(out, child);
          break;
        }
        case 12: // Tlopen
        case 112: {
          // Topen compatibility
          const node = this.fid(reader.u32());
          const flags = type === 12 ? reader.u32() : reader.u8();
          if ((flags & 3) !== 0 || (flags & (64 | 512 | 1024)) !== 0) {
            this.deniedWrites++;
            throw new ProtocolError(30);
          }
          qid(out, node).u32(this.msize - 24);
          break;
        }
        case 24: {
          // Tgetattr. Attributes describe the exported view, not source inode metadata.
          const node = this.fid(reader.u32());
          reader.u64();
          out.u64(0x7ff);
          qid(out, node);
          out
            .u32(node.children ? 0o40555 : 0o100444)
            .u32(0)
            .u32(0)
            .u64(node.children ? 2 : 1)
            .u64(0)
            .u64(node.bytes.byteLength)
            .u64(4096)
            .u64(Math.ceil(node.bytes.byteLength / 512));
          for (let index = 0; index < 3; index++)
            out.u64(this.timestamp).u64(0);
          out.u64(0).u64(0).u64(0).u64(0);
          break;
        }
        case 8: {
          // Tstatfs
          this.fid(reader.u32());
          out
            .u32(0x01021997)
            .u32(4096)
            .u64(Math.ceil(this.totalBytes / 4096))
            .u64(0)
            .u64(0)
            .u64(this.nextId - 1)
            .u64(0)
            .u64(0)
            .u32(255);
          break;
        }
        case 116: {
          // Tread
          const node = this.fid(reader.u32()),
            offset = reader.u64();
          const count = Math.min(reader.u32(), this.msize - 11);
          if (node.children) throw new ProtocolError(21);
          const start =
            offset > BigInt(node.bytes.length)
              ? node.bytes.length
              : Number(offset);
          const data = node.bytes.subarray(
            start,
            Math.min(node.bytes.length, start + count),
          );
          out.u32(data.byteLength).add(data);
          break;
        }
        case 40: {
          // Treaddir; offsets are stable entry indices.
          const node = this.fid(reader.u32()),
            offset = reader.u64();
          const count = Math.min(reader.u32(), this.msize - 11);
          if (!node.children) throw new ProtocolError(20);
          const entries = [
            { name: ".", node },
            { name: "..", node: node.parent ?? node },
            ...Array.from(node.children.values(), (child) => ({
              name: child.name,
              node: child,
            })),
          ];
          const body = new Writer();
          for (
            let index =
              offset > BigInt(entries.length) ? entries.length : Number(offset);
            index < entries.length;
            index++
          ) {
            const entry = entries[index],
              record = new Writer();
            qid(record, entry.node)
              .u64(index + 1)
              .u8(entry.node.children ? 4 : 8)
              .string(entry.name);
            if (body.length + record.length > count) break;
            body.add(record.bytes());
          }
          out.u32(body.length).add(body.bytes());
          break;
        }
        case 120: {
          // Tclunk
          const fid = reader.u32();
          this.fid(fid);
          this.fids.delete(fid);
          break;
        }
        case 108:
          reader.u16();
          break; // Tflush: requests are synchronous.
        case 50:
          this.fid(reader.u32());
          reader.u32();
          break; // Tfsync has no pending writes.
        case 30:
          throw new ProtocolError(61); // No source xattrs are represented.
        default:
          throw new ProtocolError(95);
      }
      reply(response(type + 1, tag, out));
    } catch (error) {
      reply(
        response(
          7,
          tag,
          new Writer().u32(error instanceof ProtocolError ? error.errno : 22),
        ),
      );
    }
  };
}
