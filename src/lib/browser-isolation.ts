// SPDX-License-Identifier: Apache-2.0

export interface SharedMemorySupport {
  ready: boolean;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  secureContext: boolean;
  serviceWorkerAvailable: boolean;
  embedded: boolean;
  message: string;
}

export function getSharedMemorySupport(): SharedMemorySupport {
  const crossOriginIsolated = globalThis.crossOriginIsolated === true;
  const sharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";
  const secureContext = globalThis.isSecureContext === true;
  const serviceWorkerAvailable = Boolean(globalThis.navigator?.serviceWorker?.register);
  let embedded = false;
  try { embedded = typeof window !== "undefined" && window.top !== window; }
  catch { embedded = true; }
  const ready = crossOriginIsolated && sharedArrayBuffer;
  const message = ready
    ? "Shared memory is available. This page can start the experimental x86_64 runtime."
    : embedded
      ? "Open Terrarium in its own tab to enable the x86_64 runtime. An embedded page depends on its parent’s isolation policy."
      : !secureContext
        ? "The x86_64 runtime requires HTTPS or localhost."
        : !serviceWorkerAvailable
          ? "This browser or hosting context does not allow the service worker needed to enable shared memory."
          : crossOriginIsolated
            ? "This page is isolated, but this browser does not expose SharedArrayBuffer. Use a browser with shared WebAssembly memory support."
            : "Enable the x86_64 runtime here, then stop guests and reload to activate shared memory.";
  return { ready, crossOriginIsolated, sharedArrayBuffer, secureContext, serviceWorkerAvailable, embedded, message };
}

/** Resolve only the current app directory, including GitHub Pages project paths. */
export function sharedMemoryRuntimeUrls(baseURI: string, basePath: string, pageOrigin: string): { scope: string; script: string } {
  const scope = new URL(basePath, baseURI);
  if (scope.origin !== pageOrigin || !scope.pathname.endsWith("/") || scope.search || scope.hash || scope.username || scope.password)
    throw new Error("The shared-memory helper must stay inside this application’s directory.");
  return { scope: scope.href, script: new URL("terrarium-isolation.js", scope).href };
}

type RegistrationIdentity = Pick<ServiceWorkerRegistration, "scope" | "active" | "waiting" | "installing">;

/** Never replace, shadow, or widen an unrelated application's worker. */
export function assertIsolationWorkerOwnership(registrations: readonly RegistrationIdentity[], scope: string, script: string): void {
  for (const registration of registrations) {
    if (!registration.scope.startsWith(scope) && !scope.startsWith(registration.scope)) continue;
    const workers = [registration.active, registration.waiting, registration.installing].filter((worker): worker is ServiceWorker => worker !== null);
    if (registration.scope !== scope || !workers.length || workers.some((worker) => worker.scriptURL !== script))
      throw new Error("Another application already controls an overlapping service-worker scope. Terrarium did not replace it. Use a separate hosting path or configure isolation headers on the host.");
  }
}

function waitForActivation(registration: ServiceWorkerRegistration): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const watched = new Set<ServiceWorker>();
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      registration.removeEventListener("updatefound", check);
      for (const worker of watched) worker.removeEventListener("statechange", check);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      for (const worker of [registration.installing, registration.waiting, registration.active]) {
        if (worker && !watched.has(worker)) { watched.add(worker); worker.addEventListener("statechange", check); }
      }
      if (registration.active?.state === "activated") finish();
      else if (watched.size && [...watched].every((worker) => worker.state === "redundant"))
        finish(new Error("The shared-memory service worker could not activate. This page was kept open."));
    };
    const timer = setTimeout(() => finish(new Error("The shared-memory service worker did not activate within 30 seconds. This page was kept open.")), 30_000);
    registration.addEventListener("updatefound", check);
    check();
  });
}

/** Installs and activates only. The caller owns the safe shutdown and reload. */
export async function prepareSharedMemoryRuntime(): Promise<SharedMemorySupport> {
  const support = getSharedMemorySupport();
  if (support.ready) return support;
  if (support.embedded || !support.secureContext || !support.serviceWorkerAvailable || support.crossOriginIsolated)
    throw new Error(support.message);
  const { scope, script } = sharedMemoryRuntimeUrls(document.baseURI, import.meta.env?.BASE_URL ?? "./", window.location.origin);
  const container = navigator.serviceWorker;
  if (container.controller && container.controller.scriptURL !== script)
    throw new Error("Another application’s service worker controls this page. Terrarium did not replace it.");
  assertIsolationWorkerOwnership(await container.getRegistrations(), scope, script);
  const registration = await container.register(script, { scope, updateViaCache: "none" });
  assertIsolationWorkerOwnership([registration], scope, script);
  await waitForActivation(registration);
  return getSharedMemorySupport();
}
