import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { DEFAULT_QEMU_BUNDLE_ID } from "./public/runtime/qemu/catalog.js";
import { getQemuBundle } from "./public/runtime/qemu/bundles.js";

// Qualification may select an already registered bundle for the complete app.
// Unknown identities fail before a server/build starts; executable URLs and
// image pins always come from the fixed application-owned catalog.
const qemuBundle = getQemuBundle(process.env.TERRARIUM_QEMU_BUNDLE_ID ?? DEFAULT_QEMU_BUNDLE_ID);

export default defineConfig({
  base: "./",
  plugins: [react()],
  define: { __TERRARIUM_QEMU_BUNDLE_ID__: JSON.stringify(qemuBundle.id) },
  server: { host: "0.0.0.0" },
  build: { target: "es2022" },
});
