export const UPSTREAM_PTHREAD_SHA256: string;
export const PTHREAD_TRANSFORM_ID: string;
export const OWNED_PTHREAD_SHA256: string;
export const OWNED_PTHREAD_TRANSFORM_ID: string;
export function resolvePthreadWasmPath(path: string, locationHref: string): string;
export function transformQemuPthread(source: string | Uint8Array): string;
export function transformOwnedQemuPthread(source: string | Uint8Array): string;
