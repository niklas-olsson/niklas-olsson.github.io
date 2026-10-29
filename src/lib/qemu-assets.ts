// SPDX-License-Identifier: Apache-2.0
// Historical aliases are intentionally pinned to the legacy bundle. A default
// switch must never rewrite the bytes expected by existing checkpoints.
import { LEGACY_QEMU_BUNDLE_ID, DEFAULT_QEMU_BUNDLE_ID as PUBLISHED_QEMU_BUNDLE_ID, QEMU_BUNDLES } from "../../public/runtime/qemu/catalog.js";
import { getQemuBundle } from "../../public/runtime/qemu/bundles.js";
import type { QemuAsset } from "../../public/runtime/qemu/catalog.js";
export { LEGACY_QEMU_BUNDLE_ID, OWNED_QEMU_V2_BUNDLE_ID, OWNED_QEMU_BUNDLE_ID, QEMU_BUNDLES } from "../../public/runtime/qemu/catalog.js";
export { PUBLISHED_QEMU_BUNDLE_ID };
export { getQemuBundle, isSupportedQemuBundleId } from "../../public/runtime/qemu/bundles.js";
export type { QemuAsset, QemuBundleId, QemuRuntimeBundle } from "../../public/runtime/qemu/catalog.js";

declare const __TERRARIUM_QEMU_BUNDLE_ID__: string | undefined;
/** Build-time qualification can choose only an already registered bundle. */
export const DEFAULT_QEMU_BUNDLE_ID = getQemuBundle(
  typeof __TERRARIUM_QEMU_BUNDLE_ID__ === "undefined" ? PUBLISHED_QEMU_BUNDLE_ID : __TERRARIUM_QEMU_BUNDLE_ID__,
).id;

export const QEMU_WASM = QEMU_BUNDLES[LEGACY_QEMU_BUNDLE_ID].assets.wasm;
const { wasm: _legacyWasm, ...legacyGuest } = QEMU_BUNDLES[LEGACY_QEMU_BUNDLE_ID].assets;
export const QEMU_PROFILE_ASSETS = Object.freeze({ "alpine-x86_64": Object.freeze(legacyGuest) });

/** Same resolution for pinned remote assets and owned assets beneath an app subpath. */
export function resolveQemuAssetUrl(asset: QemuAsset, documentBaseURI: string, appBase = "/"): string {
  return new URL(asset.url, new URL(appBase, documentBaseURI)).href;
}
