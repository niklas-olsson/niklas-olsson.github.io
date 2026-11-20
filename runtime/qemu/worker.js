// SPDX-License-Identifier: Apache-2.0
import { createQemuDispatcher } from "./dispatch.js";
import { readQemuBundleManifest } from "./bundles.js";

const receive = createQemuDispatcher({
  emit: (message, transfer) => self.postMessage(message, transfer),
  close: () => self.close(),
  isIsolated: () => self.crossOriginIsolated,
  async loadBundle(bundle) {
    const response = await fetch(new URL(bundle.manifest.file, import.meta.url), { credentials: "omit", referrerPolicy: "no-referrer" });
    return {
      manifest: await readQemuBundleManifest(response, bundle),
      pthreadUrl: new URL(bundle.pthread.file, import.meta.url).href,
    };
  },
  async loadModule(bytes) {
    // This is exact hash-verified upstream emulator glue, never guest input.
    const url = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
    try { const loaded = await import(url); return { factory: loaded.default, url, dispose: () => URL.revokeObjectURL(url) }; }
    catch (error) { URL.revokeObjectURL(url); throw error; }
  },
});
self.onmessage = ({ data }) => { void receive(data); };
