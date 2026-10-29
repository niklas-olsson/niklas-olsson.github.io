// SPDX-License-Identifier: Apache-2.0
// Shared implementation is used by the browser runtime worker and Node boot tests.
export { buildNewcArchive, appendInitramfsArchive, alpineDemoCleanupScript, alpineInitScript, appendAlpineBootInitramfs } from "../../public/runtime/qemu/initramfs.js";
export type { InitramfsFile, AlpineRootMode } from "../../public/runtime/qemu/initramfs.js";
