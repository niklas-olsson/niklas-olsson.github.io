// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import { assertIsolationWorkerOwnership, getSharedMemorySupport, prepareSharedMemoryRuntime, sharedMemoryRuntimeUrls } from "./browser-isolation.ts";

test("isolation URLs remain inside a GitHub Pages project directory", () => {
  assert.deepEqual(sharedMemoryRuntimeUrls("https://example.test/terrarium/", "./", "https://example.test"), {
    scope: "https://example.test/terrarium/", script: "https://example.test/terrarium/terrarium-isolation.js",
  });
  assert.throws(() => sharedMemoryRuntimeUrls("https://example.test/terrarium/", "https://other.test/", "https://example.test"), /inside this application/);
  assert.throws(() => sharedMemoryRuntimeUrls("https://example.test/terrarium/", "./?broader=1", "https://example.test"), /inside this application/);
  assert.throws(() => sharedMemoryRuntimeUrls("https://example.test/terrarium/", "./worker", "https://example.test"), /inside this application/);
});

test("foreign service workers are never replaced or shadowed", () => {
  const scope = "https://example.test/terrarium/";
  const script = `${scope}terrarium-isolation.js`;
  const registration = (registrationScope: string, scriptURL: string) => ({ scope: registrationScope, active: { scriptURL } as ServiceWorker, waiting: null, installing: null });
  assert.doesNotThrow(() => assertIsolationWorkerOwnership([registration(scope, script)], scope, script));
  assert.doesNotThrow(() => assertIsolationWorkerOwnership([registration("https://example.test/another/", "https://example.test/another/sw.js")], scope, script));
  for (const registrationScope of ["https://example.test/", scope, `${scope}nested/`]) {
    assert.throws(() => assertIsolationWorkerOwnership([registration(registrationScope, "https://example.test/foreign.js")], scope, script), /Another application/);
  }
});

test("shared memory is not advertised solely because SharedArrayBuffer exists", () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "crossOriginIsolated");
  try {
    Object.defineProperty(globalThis, "crossOriginIsolated", { value: false, configurable: true });
    assert.equal(getSharedMemorySupport().ready, false);
    Object.defineProperty(globalThis, "crossOriginIsolated", { value: true, configurable: true });
    assert.equal(getSharedMemorySupport().ready, typeof SharedArrayBuffer !== "undefined");
  } finally {
    if (prior) Object.defineProperty(globalThis, "crossOriginIsolated", prior);
    else delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  }
});

function mockPage(serviceWorker: unknown): () => void {
  const page: Record<string, unknown> = { location: { origin: "https://example.test", reload: () => { throw new Error("The preparation helper must never reload the page."); } } };
  page.top = page;
  const values: Record<string, unknown> = {
    window: page, document: { baseURI: "https://example.test/terrarium/" },
    navigator: { serviceWorker }, isSecureContext: true, crossOriginIsolated: false,
  };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true });
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

test("preparation waits for activation and leaves reload to the workspace owner", async () => {
  const scope = "https://example.test/terrarium/";
  const script = `${scope}terrarium-isolation.js`;
  const worker = Object.assign(new EventTarget(), { scriptURL: script, state: "installing" });
  const registration = Object.assign(new EventTarget(), { scope, installing: worker, waiting: null, active: null as typeof worker | null });
  let registered = 0;
  const restore = mockPage({
    controller: null,
    getRegistrations: async () => [],
    register: async (url: string, options: unknown) => {
      registered++;
      assert.equal(url, script);
      assert.deepEqual(options, { scope, updateViaCache: "none" });
      setTimeout(() => { worker.state = "activated"; registration.active = worker; worker.dispatchEvent(new Event("statechange")); }, 0);
      return registration;
    },
  });
  try {
    const support = await prepareSharedMemoryRuntime();
    assert.equal(registered, 1);
    assert.equal(worker.state, "activated");
    assert.equal(support.ready, false, "activation alone does not claim the current document is isolated");
  } finally { restore(); }
});

test("failed activation rejects without navigating, and foreign controller rejects before registration", async () => {
  const scope = "https://example.test/terrarium/";
  const worker = Object.assign(new EventTarget(), { scriptURL: `${scope}terrarium-isolation.js`, state: "installing" });
  const registration = Object.assign(new EventTarget(), { scope, installing: worker, waiting: null, active: null });
  let registered = 0;
  const container = {
    controller: null as { scriptURL: string } | null,
    getRegistrations: async () => [],
    register: async () => {
      registered++;
      setTimeout(() => { worker.state = "redundant"; worker.dispatchEvent(new Event("statechange")); }, 0);
      return registration;
    },
  };
  const restore = mockPage(container);
  try {
    await assert.rejects(prepareSharedMemoryRuntime(), /could not activate/);
    container.controller = { scriptURL: "https://example.test/foreign.js" };
    await assert.rejects(prepareSharedMemoryRuntime(), /Another application/);
    assert.equal(registered, 1);
  } finally { restore(); }
});

const workerSource = await readFile(new URL("../../public/terrarium-isolation.js", import.meta.url), "utf8");
function workerHarness(response: Response = new Response("page", { headers: { "Content-Type": "text/html", "X-Kept": "yes" } })) {
  const handlers = new Map<string, (event: unknown) => void>();
  const requests: unknown[] = [];
  let claimed = 0;
  let skipped = 0;
  const context = vm.createContext({
    URL, Headers, Response,
    self: {
      registration: { scope: "https://example.test/terrarium/" },
      addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
      skipWaiting: async () => { skipped++; },
      clients: { claim: async () => { claimed++; } },
    },
    fetch: async (request: unknown) => { requests.push(request); return response; },
  });
  vm.runInContext(workerSource, context);
  const fetchEvent = (request: Record<string, string>): Promise<Response> | null => {
    let result: Promise<Response> | null = null;
    handlers.get("fetch")!({ request, respondWith: (value: Promise<Response>) => { result = value; } });
    return result;
  };
  return { handlers, requests, fetchEvent, lifecycle: () => ({ claimed, skipped }) };
}

test("service worker only modifies scoped same-origin document and worker responses", async () => {
  for (const destination of ["document", "worker", "sharedworker"]) {
    const harness = workerHarness();
    const request = { url: "https://example.test/terrarium/runtime/worker.js", method: "GET", destination };
    const response = await harness.fetchEvent(request);
    assert.ok(response);
    assert.equal(response.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
    assert.equal(response.headers.get("Cross-Origin-Embedder-Policy"), "require-corp");
    assert.equal(response.headers.get("X-Kept"), "yes");
    assert.equal(await response.text(), "page");
    assert.equal(harness.requests[0], request, "original credentials and request options are preserved");
  }
  const harness = workerHarness();
  for (const request of [
    { url: "https://upstream.test/image", method: "GET", destination: "document" },
    { url: "https://example.test/other/", method: "GET", destination: "document" },
    { url: "https://example.test/terrarium-other/", method: "GET", destination: "document" },
    { url: "https://example.test/terrarium/", method: "POST", destination: "document" },
    { url: "https://example.test/terrarium/guest.bin", method: "GET", destination: "" },
    { url: "https://example.test/terrarium/image.png", method: "GET", destination: "image" },
  ]) assert.equal(harness.fetchEvent(request), null);
  assert.equal(harness.requests.length, 0);
});

test("redirects and opaque responses pass through without isolation rewriting", async () => {
  for (const change of [{ redirected: true }, { type: "opaque", status: 0 }, { url: "https://other.test/login" }]) {
    const response = new Response("untouched");
    for (const [key, value] of Object.entries(change)) Object.defineProperty(response, key, { value });
    const harness = workerHarness(response);
    const actual = await harness.fetchEvent({ url: "https://example.test/terrarium/", method: "GET", destination: "document" });
    assert.equal(actual, response);
    assert.equal(actual?.headers.get("Cross-Origin-Embedder-Policy"), null);
  }
});

test("service-worker activation claims its scope without navigating any page", async () => {
  const harness = workerHarness();
  for (const eventName of ["install", "activate"]) {
    const pending: Promise<unknown>[] = [];
    harness.handlers.get(eventName)!({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
  }
  assert.deepEqual(harness.lifecycle(), { claimed: 1, skipped: 1 });
});
