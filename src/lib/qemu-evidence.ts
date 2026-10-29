// SPDX-License-Identifier: Apache-2.0
import {
  decodeEvidenceBytes,
  evidenceManifest,
  MAX_EVIDENCE_FILE_BYTES,
  MAX_EVIDENCE_TOTAL_BYTES,
  validateEvidencePaths,
  type EvidenceArchive,
  type EvidenceInputFile,
} from "./evidence.ts";
import { shellQuote } from "./command-protocol.ts";
import type { EvidenceExecutor } from "./runtime-types.ts";

const BLOCK = 4096;
const IMAGE_BYTES = 32 * 1024 * 1024;
const encoder = new TextEncoder();
interface Entry {
  inode: number;
  name: string;
  parent: Entry | null;
  children: Map<string, Entry> | null;
  bytes: Uint8Array;
}

/**
 * A bounded ext2 evidence view. The emulator must independently reject writes
 * to this image; file modes and guest mount flags are not the write boundary.
 * One block group and single-indirect blocks cover the 1 MiB file limit.
 */
export function createQemuEvidenceImage(archive: EvidenceArchive): ArrayBuffer {
  validateEvidencePaths(archive.files.map((file) => file.path));
  if (!/^[a-f0-9]{64}$/.test(archive.sha256)) throw new Error("Evidence needs a verified archive digest.");
  const root: Entry = { inode: 2, name: "", parent: null, children: new Map(), bytes: new Uint8Array() };
  const entries = [root];
  let nextInode = 11;
  let total = 0;
  const insert = (path: string, bytes: Uint8Array) => {
    const parts = path.split("/");
    let parent = root;
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index];
      if (!name || name === "." || name === ".." || encoder.encode(name).length > 255 || !parent.children)
        throw new Error("Invalid evidence filesystem path.");
      const last = index === parts.length - 1;
      let entry = parent.children.get(name);
      if (!entry) {
        entry = { inode: nextInode++, name, parent, children: last ? null : new Map(), bytes: last ? new Uint8Array(bytes) : new Uint8Array() };
        if (nextInode > 8192) throw new Error("Evidence filesystem has too many entries.");
        parent.children.set(name, entry); entries.push(entry);
      } else if (last || !entry.children) throw new Error("Conflicting evidence filesystem paths.");
      parent = entry;
    }
  };
  insert("manifest.json", encoder.encode(evidenceManifest(archive)));
  for (const file of archive.files) {
    const bytes = decodeEvidenceBytes(file);
    total += bytes.length;
    if (total > MAX_EVIDENCE_TOTAL_BYTES) throw new Error("Evidence exceeds the 8 MiB total limit.");
    insert("files" + file.path, bytes);
  }
  if (total !== archive.totalBytes) throw new Error("Evidence size does not match its manifest.");

  const inodes = Math.max(128, Math.ceil(nextInode / 32) * 32);
  const tableBlocks = inodes / 32;
  const blocks = IMAGE_BYTES / BLOCK;
  const image = new ArrayBuffer(IMAGE_BYTES);
  const data = new Uint8Array(image), view = new DataView(image);
  const u16 = (offset: number, value: number) => view.setUint16(offset, value, true);
  const u32 = (offset: number, value: number) => view.setUint32(offset, value, true);
  let nextBlock = 4 + tableBlocks;
  const allocate = (): number => {
    if (nextBlock >= blocks) throw new Error("Evidence filesystem exceeds its bounded image.");
    return nextBlock++;
  };
  const timestamp = Math.max(0, Math.min(0xffffffff, Math.floor(archive.createdAt / 1000)));
  for (const entry of entries) {
    let bytes = entry.bytes;
    if (entry.children) {
      const directory: { inode: number; name: string; directory: boolean }[] = [
        { inode: entry.inode, name: ".", directory: true },
        { inode: entry.parent?.inode ?? entry.inode, name: "..", directory: true },
        ...[...entry.children.values()].map((child) => ({ inode: child.inode, name: child.name, directory: !!child.children })),
      ];
      const chunks: Uint8Array[] = [];
      let chunk = new Uint8Array(BLOCK), offset = 0, previous = -1;
      const finish = () => {
        if (previous >= 0) new DataView(chunk.buffer).setUint16(previous + 4, BLOCK - previous, true);
        chunks.push(chunk); chunk = new Uint8Array(BLOCK); offset = 0; previous = -1;
      };
      for (const child of directory) {
        const name = encoder.encode(child.name), size = Math.ceil((8 + name.length) / 4) * 4;
        if (offset + size > BLOCK) finish();
        const item = new DataView(chunk.buffer);
        item.setUint32(offset, child.inode, true); item.setUint16(offset + 4, size, true);
        chunk[offset + 6] = name.length; chunk[offset + 7] = child.directory ? 2 : 1;
        chunk.set(name, offset + 8); previous = offset; offset += size;
      }
      finish();
      bytes = new Uint8Array(chunks.length * BLOCK);
      chunks.forEach((chunk, index) => bytes.set(chunk, index * BLOCK));
    }
    const content: number[] = [];
    for (let offset = 0; offset < bytes.length; offset += BLOCK) {
      const block = allocate(); content.push(block); data.set(bytes.subarray(offset, offset + BLOCK), block * BLOCK);
    }
    if (content.length > 12 + BLOCK / 4) throw new Error("Evidence entry exceeds the supported ext2 block map.");
    const indirect = content.length > 12 ? allocate() : 0;
    const inode = 4 * BLOCK + (entry.inode - 1) * 128;
    u16(inode, entry.children ? 0x416d : 0x8124); // directory 0555, regular 0444
    u32(inode + 4, bytes.length);
    for (const offset of [8, 12, 16]) u32(inode + offset, timestamp);
    u16(inode + 26, entry.children ? 2 + [...entry.children.values()].filter((child) => child.children).length : 1);
    u32(inode + 28, (content.length + (indirect ? 1 : 0)) * (BLOCK / 512));
    content.slice(0, 12).forEach((block, index) => u32(inode + 40 + index * 4, block));
    if (indirect) {
      u32(inode + 40 + 12 * 4, indirect);
      content.slice(12).forEach((block, index) => u32(indirect * BLOCK + index * 4, block));
    }
  }
  const usedInodes = 10 + entries.length - 1;
  const directories = entries.filter((entry) => entry.children).length;
  const sb = 1024;
  u32(sb, inodes); u32(sb + 4, blocks); u32(sb + 12, blocks - nextBlock); u32(sb + 16, inodes - usedInodes);
  u32(sb + 24, 2); u32(sb + 28, 2); u32(sb + 32, 32768); u32(sb + 36, 32768); u32(sb + 40, inodes);
  u32(sb + 48, timestamp); u16(sb + 54, 0xffff); u16(sb + 56, 0xef53); u16(sb + 58, 1); u16(sb + 60, 1);
  u32(sb + 76, 1); u32(sb + 84, 11); u16(sb + 88, 128); u32(sb + 96, 2);
  for (let index = 0; index < 16; index++) data[sb + 104 + index] = parseInt(archive.sha256.slice(index * 2, index * 2 + 2), 16);
  data.set(encoder.encode("terrarium-proof"), sb + 120);
  u32(BLOCK, 2); u32(BLOCK + 4, 3); u32(BLOCK + 8, 4);
  u16(BLOCK + 12, blocks - nextBlock); u16(BLOCK + 14, inodes - usedInodes); u16(BLOCK + 16, directories);
  const setBit = (at: number, bit: number) => { data[at + (bit >>> 3)] |= 1 << (bit & 7); };
  for (let block = 0; block < nextBlock; block++) setBit(2 * BLOCK, block);
  for (let block = blocks; block < 32768; block++) setBit(2 * BLOCK, block);
  for (let inode = 0; inode < usedInodes; inode++) setBit(3 * BLOCK, inode);
  for (let inode = inodes; inode < 32768; inode++) setBit(3 * BLOCK, inode);
  return image;
}

/** Bounded serial transfer from a running, explicitly quarantined guest. */
export async function captureQemuEvidenceFiles(paths: string[], execute: EvidenceExecutor, assertCurrent: () => void): Promise<EvidenceInputFile[]> {
  const selected = validateEvidencePaths(paths);
  const directory = "/tmp/terrarium-capture-" + crypto.randomUUID().replaceAll("-", "");
  const staged = directory + "/capture.bin";
  const run = async (command: string) => {
    assertCurrent();
    const result = await execute(command);
    assertCurrent();
    if (result.status !== "exited" || result.exitCode !== 0)
      throw new Error("Guest-assisted acquisition failed: " + (result.output.slice(-600) || result.message || result.status));
    return result.output;
  };
  const captured: EvidenceInputFile[] = [];
  let total = 0;
  try {
    await run("umask 077; mkdir " + shellQuote(directory));
    for (const path of selected) {
      const sizeOutput = await run([
        "set -e", "_trm_source=" + shellQuote(path),
        '[ -f "$_trm_source" ] && [ ! -L "$_trm_source" ] || { echo "Select a regular file, not a directory or symlink"; exit 1; }',
        '_trm_size=$(wc -c < "$_trm_source")',
        'case "$_trm_size" in ""|*[!0-9]*) echo "Cannot determine file size"; exit 1;; esac',
        `[ "$_trm_size" -le ${MAX_EVIDENCE_FILE_BYTES} ] || { echo "File exceeds 1 MiB"; exit 1; }`,
        `dd if="$_trm_source" of=${shellQuote(staged)} bs=16384 count=65 2>/dev/null`,
        `wc -c < ${shellQuote(staged)}`,
      ].join("\n"));
      if (!/^\d+\s*$/.test(sizeOutput)) throw new Error("The guest returned an invalid staged-file size.");
      const size = Number(sizeOutput.trim());
      if (!Number.isSafeInteger(size) || size > MAX_EVIDENCE_FILE_BYTES) throw new Error("The staged evidence file exceeds 1 MiB.");
      total += size;
      if (total > MAX_EVIDENCE_TOTAL_BYTES) throw new Error("The selected evidence exceeds 8 MiB.");
      const bytes = new Uint8Array(size);
      for (let offset = 0; offset < size; offset += 16_384) {
        const output = await run(`dd if=${shellQuote(staged)} bs=16384 skip=${offset / 16_384} count=1 2>/dev/null | base64`);
        const chunk = decodeEvidenceBytes({ size: Math.min(16_384, size - offset), base64: output.replace(/\r?\n/g, "") });
        bytes.set(chunk, offset);
      }
      captured.push({ path, bytes });
      await run("rm -f " + shellQuote(staged));
    }
    return captured;
  } finally {
    try { assertCurrent(); await execute("rm -f " + shellQuote(staged) + "; rmdir " + shellQuote(directory)); }
    catch { /* A cancelled or unresponsive guest cannot confirm staging cleanup. */ }
  }
}
