// SPDX-License-Identifier: Apache-2.0
// Serve the packaged application without synthesizing isolation headers.
// The browser must activate the production service worker itself.
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { Transform } from "node:stream";
import { lstat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png" };
const conflictWorker = `self.addEventListener("install", e => e.waitUntil(self.skipWaiting()));
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));`;

export async function serveBuiltApplication(directory, guestAssets = new Map(), acceptanceFiles = new Map()) {
  const root = resolve(directory);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("The built application root must be a real directory.");
  const controls = { failWorker: false, workerFailureResponses: 0 };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith("/terrarium/")) pathname = pathname.slice("/terrarium".length);
      if (pathname.startsWith("/__browser-fixtures/acceptance/")) {
        const fixture = acceptanceFiles.get(pathname.slice("/__browser-fixtures/acceptance/".length));
        if (!fixture) throw new Error("missing");
        const size = (await lstat(fixture.path)).size;
        response.writeHead(200, { "Content-Type": fixture.contentType ?? "application/octet-stream", "Content-Length": size, "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" });
        const stream = createReadStream(fixture.path); response.on("close", () => stream.destroy());
        stream.on("error", () => response.destroy()); stream.pipe(response); return;
      }
      if (pathname.startsWith("/__browser-fixtures/qemu/")) {
        const asset = guestAssets.get(pathname.slice("/__browser-fixtures/qemu/".length));
        if (!asset) throw new Error("missing");
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": asset.bytes, "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin", "Cache-Control": "no-store" });
        const stream = createReadStream(asset.path);
        response.on("close", () => stream.destroy());
        stream.on("error", () => response.destroy());
        if (url.searchParams.get("corrupt") === "1") {
          let first = true;
          stream.pipe(new Transform({ transform(chunk, _encoding, callback) { if (first) { chunk[0] ^= 1; first = false; } callback(null, chunk); } })).pipe(response);
        } else stream.pipe(response);
        return;
      }
      if (pathname === "/__browser-fixtures/conflict-worker.js") {
        response.writeHead(200, { "Content-Type": "text/javascript", "Service-Worker-Allowed": "/", "Cache-Control": "no-store" });
        response.end(conflictWorker); return;
      }
      if (controls.failWorker && pathname === "/runtime/qemu/worker.js") {
        controls.workerFailureResponses++;
        response.writeHead(503, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
        response.end("Intentional S1 browser worker-load failure"); return;
      }
      if (pathname.endsWith("/")) pathname += "index.html";
      const path = resolve(root, `.${pathname}`);
      if (!path.startsWith(root + sep)) throw new Error("missing");
      let checked = root;
      for (const segment of path.slice(root.length + 1).split(sep)) {
        checked = join(checked, segment);
        const entry = await lstat(checked);
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("unsupported file type");
      }
      if (!(await lstat(path)).isFile()) throw new Error("missing");
      response.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream", "Cache-Control": "no-store" });
      createReadStream(path).on("error", () => response.destroy()).pipe(response);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      response.end("Not found");
    }
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    controls,
    close: () => new Promise((resolveClose, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolveClose()); }),
  };
}
