// SPDX-License-Identifier: Apache-2.0
// Synthetic QEMU 8.2 monitor-format fixture. These numbers are not guest evidence.
export const QEMU_JIT_FIXTURE_TEXT = [
  "Accelerator settings:",
  "one-insn-per-tb: off", "",
  "Translation buffer state:",
  "gen code size       12345678/524221440",
  "TB count            1234",
  "TB avg target size  18 max=4096 bytes",
  "TB avg host size    180 bytes (expansion ratio: 10.0)",
  "cross page TB count 12 (0%)",
  "direct jump count   789 (63%) (2 jumps=456 36%)",
  "TB hash buckets     1234/32768 (3.77% head buckets used)",
  "TB hash occupancy   3.77% avg chain occ. Histogram: 0%|▁▂▃▄▅▆▇█|100%",
  "TB hash avg chain   1.001 buckets. Histogram: 1|█|1", "",
  "Statistics:",
  "TB flush count      2",
  "TB invalidate count 34",
  "TLB full flushes    56",
  "TLB partial flushes 78",
  "TLB elided flushes  90",
  "[TCG profiler not compiled]",
].join("\n");

export const QEMU_JIT_FIXTURE_STATS = Object.freeze({
  generatedCodeUsedBytes: 12345678,
  generatedCodeCapacityBytes: 524221440,
  translationBlockCount: 1234,
  translationBlockFlushCount: 2,
  translationBlockInvalidateCount: 34,
});
