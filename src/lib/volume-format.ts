// SPDX-License-Identifier: Apache-2.0
import { MAX_BUFFERED_VOLUME_MIB, VOLUME_PAGE_BYTES, validateVolumeSize } from "./volume-types.ts";

/**
 * Generate an empty ext2 filesystem, not a redistributed guest image.
 * One block group, 4096-byte blocks, 128-byte inodes, no journal/extents.
 * Layout follows the Linux ext filesystem on-disk specification; the same
 * arguments produce identical bytes. A root directory is the only user inode.
 */
export function createExt2Image(sizeMiB: number, uuid: string): ArrayBuffer {
  validateVolumeSize(sizeMiB);
  if (sizeMiB > MAX_BUFFERED_VOLUME_MIB) throw new Error("Buffered ext2 images are limited to 128 MiB; use the sparse page generator.");
  const hex = uuid.replaceAll("-", "");
  if (!/^[a-fA-F0-9]{32}$/.test(hex)) throw new Error("The filesystem UUID must contain 16 bytes.");
  const buffer = new ArrayBuffer(sizeMiB * 1024 * 1024);
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const blockSize = 4096;
  const blocks = buffer.byteLength / blockSize;
  const inodes = sizeMiB * 64;
  const tableBlocks = inodes * 128 / blockSize;
  const rootBlock = 4 + tableBlocks;
  const allocated = rootBlock + 1;
  const u32 = (offset: number, value: number) => view.setUint32(offset, value, true);
  const u16 = (offset: number, value: number) => view.setUint16(offset, value, true);
  const sb = 1024;
  u32(sb + 0x00, inodes);
  u32(sb + 0x04, blocks);
  u32(sb + 0x0c, blocks - allocated);
  u32(sb + 0x10, inodes - 10);
  u32(sb + 0x18, 2);
  u32(sb + 0x1c, 2);
  u32(sb + 0x20, 32768);
  u32(sb + 0x24, 32768);
  u32(sb + 0x28, inodes);
  u16(sb + 0x36, 0xffff);
  u16(sb + 0x38, 0xef53);
  u16(sb + 0x3a, 1); // EXT2_VALID_FS
  u16(sb + 0x3c, 1); // Continue on errors; guest can choose stricter policy.
  u32(sb + 0x4c, 1); // Dynamic revision, explicit inode size and feature bits.
  u32(sb + 0x54, 11);
  u16(sb + 0x58, 128);
  u32(sb + 0x60, 2); // Directory entries contain file type.
  for (let index = 0; index < 16; index++) data[sb + 0x68 + index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  data.set(new TextEncoder().encode("terrarium-data"), sb + 0x78);

  const group = blockSize;
  u32(group, 2); u32(group + 4, 3); u32(group + 8, 4);
  u16(group + 12, blocks - allocated); u16(group + 14, inodes - 10); u16(group + 16, 1);
  const setBit = (offset: number, bit: number) => { data[offset + (bit >>> 3)] |= 1 << (bit & 7); };
  for (let block = 0; block < allocated; block++) setBit(blockSize * 2, block);
  for (let block = blocks; block < 32768; block++) setBit(blockSize * 2, block);
  for (let inode = 0; inode < 10; inode++) setBit(blockSize * 3, inode);
  for (let inode = inodes; inode < 32768; inode++) setBit(blockSize * 3, inode);

  const root = 4 * blockSize + 128; // inode 2
  u16(root, 0x41ed); // directory, 0755
  u32(root + 4, blockSize);
  u16(root + 26, 2);
  u32(root + 28, blockSize / 512);
  u32(root + 40, rootBlock);
  const directory = rootBlock * blockSize;
  u32(directory, 2); u16(directory + 4, 12);
  data[directory + 6] = 1; data[directory + 7] = 2; data[directory + 8] = 46;
  u32(directory + 12, 2); u16(directory + 16, blockSize - 12);
  data[directory + 18] = 2; data[directory + 19] = 2;
  data[directory + 20] = 46; data[directory + 21] = 46;
  return buffer;
}

export interface Ext2Page { index: number; data: Uint8Array<ArrayBuffer> }

/**
 * Sparse ext2 creation, up to 64 block groups (8GiB). Every group has a backup
 * superblock and descriptor table; no sparse_super, journal or extents features
 * are advertised. Zero inode-table/data pages are implicit, not allocated.
 * Small images preserve the existing single-group byte layout exactly.
 */
export function* createExt2Pages(sizeMiB: number, uuid: string): Generator<Ext2Page> {
  validateVolumeSize(sizeMiB);
  const hex = uuid.replaceAll("-", "");
  if (!/^[a-fA-F0-9]{32}$/.test(hex)) throw new Error("The filesystem UUID must contain 16 bytes.");
  const blockSize = 4096, blocksPerGroup = 32768, blocks = sizeMiB * 256;
  const groups = Math.ceil(blocks / blocksPerGroup);
  const lastGroupBlocks = blocks - (groups - 1) * blocksPerGroup;
  // The final partial group must fit its inode table as well as its bitmaps.
  const inodesPerGroup = groups === 1 ? sizeMiB * 64 : Math.min(8192, (lastGroupBlocks - 4) * 32);
  const inodes = inodesPerGroup * groups, tableBlocks = inodesPerGroup / 32;
  const rootBlock = 4 + tableBlocks;
  const allocated = groups * (4 + tableBlocks) + 1;
  const descriptors = new Uint8Array(blockSize);
  const gd = new DataView(descriptors.buffer);
  for (let group = 0; group < groups; group++) {
    const base = group * blocksPerGroup, at = group * 32;
    const groupBlocks = Math.min(blocksPerGroup, blocks - base);
    gd.setUint32(at, base + 2, true); gd.setUint32(at + 4, base + 3, true); gd.setUint32(at + 8, base + 4, true);
    gd.setUint16(at + 12, groupBlocks - 4 - tableBlocks - (group === 0 ? 1 : 0), true);
    gd.setUint16(at + 14, inodesPerGroup - (group === 0 ? 10 : 0), true);
    gd.setUint16(at + 16, group === 0 ? 1 : 0, true);
  }
  for (let group = 0; group < groups; group++) {
    const data = new Uint8Array(VOLUME_PAGE_BYTES), view = new DataView(data.buffer);
    const u32 = (at: number, value: number) => view.setUint32(at, value, true);
    const u16 = (at: number, value: number) => view.setUint16(at, value, true);
    const sb = group === 0 ? 1024 : 0;
    u32(sb, inodes); u32(sb + 4, blocks); u32(sb + 12, blocks - allocated); u32(sb + 16, inodes - 10);
    u32(sb + 0x18, 2); u32(sb + 0x1c, 2); u32(sb + 0x20, blocksPerGroup); u32(sb + 0x24, blocksPerGroup); u32(sb + 0x28, inodesPerGroup);
    u16(sb + 0x36, 0xffff); u16(sb + 0x38, 0xef53); u16(sb + 0x3a, 1); u16(sb + 0x3c, 1);
    u32(sb + 0x4c, 1); u32(sb + 0x54, 11); u16(sb + 0x58, 128); u16(sb + 0x5a, group); u32(sb + 0x60, 2);
    for (let i = 0; i < 16; i++) data[sb + 0x68 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    data.set(new TextEncoder().encode("terrarium-data"), sb + 0x78);
    data.set(descriptors, blockSize);
    const setBit = (offset: number, bit: number) => { data[offset + (bit >>> 3)] |= 1 << (bit & 7); };
    const used = 4 + tableBlocks + (group === 0 ? 1 : 0);
    const groupBlocks = Math.min(blocksPerGroup, blocks - group * blocksPerGroup);
    for (let block = 0; block < used; block++) setBit(2 * blockSize, block);
    for (let block = groupBlocks; block < blocksPerGroup; block++) setBit(2 * blockSize, block);
    if (group === 0) for (let inode = 0; inode < 10; inode++) setBit(3 * blockSize, inode);
    for (let inode = inodesPerGroup; inode < 32768; inode++) setBit(3 * blockSize, inode);
    if (group === 0) {
      const root = 4 * blockSize + 128;
      u16(root, 0x41ed); u32(root + 4, blockSize); u16(root + 26, 2); u32(root + 28, blockSize / 512); u32(root + 40, rootBlock);
      const directoryOffset = rootBlock * blockSize;
      const directoryPage = Math.floor(directoryOffset / VOLUME_PAGE_BYTES);
      const directory = directoryPage === 0 ? data : new Uint8Array(VOLUME_PAGE_BYTES);
      const at = directoryOffset % VOLUME_PAGE_BYTES, dv = new DataView(directory.buffer);
      dv.setUint32(at, 2, true); dv.setUint16(at + 4, 12, true);
      directory[at + 6] = 1; directory[at + 7] = 2; directory[at + 8] = 46;
      dv.setUint32(at + 12, 2, true); dv.setUint16(at + 16, blockSize - 12, true);
      directory[at + 18] = 2; directory[at + 19] = 2; directory[at + 20] = 46; directory[at + 21] = 46;
      yield { index: 0, data };
      if (directoryPage !== 0) yield { index: directoryPage, data: directory };
    } else yield { index: group * blocksPerGroup * blockSize / VOLUME_PAGE_BYTES, data };
  }
}
