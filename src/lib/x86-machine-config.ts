// SPDX-License-Identifier: Apache-2.0
export * from "../../public/runtime/qemu/machine-config.js";

/** Pre-S2 definitions never stored a NIC. A migration derives one once from the stable machine ID. */
export function migratedMachineMac(id: string): string {
  let left = 0x811c9dc5, right = 0x9e3779b9;
  for (const char of id) { left = Math.imul(left ^ char.charCodeAt(0), 0x01000193); right = Math.imul(right ^ char.charCodeAt(0), 0x85ebca6b); }
  return [0x02, (left >>> 24) & 255, (left >>> 16) & 255, (left >>> 8) & 255, left & 255, right & 255]
    .map(byte => byte.toString(16).padStart(2, "0")).join(":");
}
