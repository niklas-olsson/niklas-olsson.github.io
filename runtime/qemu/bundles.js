// SPDX-License-Identifier: Apache-2.0
import { QEMU_BUNDLES, SERVER_QEMU_V1_BUNDLE_ID, SERVER_QEMU_V2_BUNDLE_ID, SERVER_QEMU_BUNDLE_ID } from "./catalog.js";

export function isSupportedQemuBundleId(value) {
  return typeof value === "string" && Object.hasOwn(QEMU_BUNDLES, value);
}

/** Only application-owned compatibility IDs can choose executable or guest bytes. */
export function getQemuBundle(id) {
  if (!isSupportedQemuBundleId(id)) throw new Error("Unsupported QEMU runtime compatibility identity.");
  const bundle = QEMU_BUNDLES[id];
  // Only these app-owned build identities can declare either fixed allocation.
  // A registry entry identifies bytes; acceptance evidence qualifies behavior.
  const server = bundle.id === SERVER_QEMU_V1_BUNDLE_ID || bundle.id === SERVER_QEMU_V2_BUNDLE_ID || bundle.id === SERVER_QEMU_BUNDLE_ID;
  const splitServer = bundle.id === SERVER_QEMU_V2_BUNDLE_ID || bundle.id === SERVER_QEMU_BUNDLE_ID;
  if (bundle.profileId !== "alpine-x86_64" || bundle.architecture !== "x86_64"
    || bundle.memoryMiB !== (server ? 2048 : 512) || bundle.virtualCpus !== (server ? 2 : 1) || bundle.serialPorts !== 4 || bundle.integration !== "terrarium-qemu-uart4-v1"
    || bundle.resources.guestMemoryMiB !== (server ? 2048 : 512) || bundle.resources.reservedWasmMiB !== (server ? 3584 : 2300)
    || bundle.resources.translationCacheMiB !== 500
    || bundle.machineMemoryLayout !== (splitServer ? "split-2x1024m-ram-blocks-v1" : undefined))
    throw new Error("The QEMU bundle requires an unsupported machine or resource profile.");
  return bundle;
}

/** Reject the wrong data index before the engine can install files or start QEMU. */
export function assertQemuBundleManifest(manifest, bundle) {
  if (!manifest || manifest.schema !== "terrarium.qemu-packages/v1"
    || manifest.guest?.architecture !== bundle.architecture
    || manifest.guest?.distribution !== bundle.guest.userland
    || manifest.guest?.kernel !== bundle.guest.kernel
    || manifest.guest?.rootBytes !== bundle.guest.rootBytes)
    throw new Error("The QEMU guest manifest does not match its runtime bundle.");
  for (const name of ["kernel", "initramfs", "rom", "rootfs"]) {
    const pack = manifest.packages?.[name], asset = bundle.assets[name];
    if (!pack || pack.bytes !== asset.bytes || pack.sha256 !== asset.sha256)
      throw new Error("The QEMU guest package pins do not match their runtime bundle.");
  }
}

/** Read exactly the catalog's bounded, hash-pinned local data-only manifest. */
export async function readQemuBundleManifest(response, bundle) {
  if (!response.ok) throw new Error("The QEMU guest manifest could not be loaded.");
  const bytes = new Uint8Array(bundle.manifest.bytes);
  let received = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (received + part.value.length > bytes.length) throw new Error("The QEMU guest manifest exceeds its pinned size.");
        bytes.set(part.value, received); received += part.value.length;
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  } else {
    const input = new Uint8Array(await response.arrayBuffer());
    if (input.length > bytes.length) throw new Error("The QEMU guest manifest exceeds its pinned size.");
    bytes.set(input); received = input.length;
  }
  if (received !== bytes.length) throw new Error("The QEMU guest manifest download was incomplete.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (sha256 !== bundle.manifest.sha256) throw new Error("The QEMU guest manifest failed its integrity check.");
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assertQemuBundleManifest(manifest, bundle);
  return manifest;
}
