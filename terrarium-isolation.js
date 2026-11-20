// SPDX-License-Identifier: Apache-2.0
// Explicitly enabled from Workspace & storage. No caches, offline fallback,
// URL rewriting, external fetch interception, or automatic page reload.
const terrariumScope = new URL(self.registration.scope);

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== terrariumScope.origin ||
    !url.pathname.startsWith(terrariumScope.pathname) ||
    !["document", "worker", "sharedworker"].includes(request.destination)
  ) return;
  event.respondWith(fetch(request).then((response) => {
    // Do not synthesize a readable response from an opaque response or redirect.
    if (response.type === "opaque" || response.type === "opaqueredirect" || response.status === 0 || response.redirected) return response;
    if (response.url) {
      const destination = new URL(response.url);
      if (destination.origin !== terrariumScope.origin || !destination.pathname.startsWith(terrariumScope.pathname)) return response;
    }
    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }));
});
