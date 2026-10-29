import type { QemuBundleId, QemuRuntimeBundle } from "./catalog.js";
export function isSupportedQemuBundleId(value: unknown): value is QemuBundleId;
export function getQemuBundle(id: unknown): QemuRuntimeBundle;
export function assertQemuBundleManifest(manifest: unknown, bundle: QemuRuntimeBundle): void;
export function readQemuBundleManifest(response: Response, bundle: QemuRuntimeBundle): Promise<unknown>;
