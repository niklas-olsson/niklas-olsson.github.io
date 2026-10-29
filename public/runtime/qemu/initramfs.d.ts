export interface InitramfsFile {
  path: string;
  data: string | Uint8Array;
  mode?: number;
}
export type AlpineRootMode = "overlay" | "writable";
export function buildNewcArchive(files: InitramfsFile[]): Uint8Array;
export function appendInitramfsArchive(original: Uint8Array, files: InitramfsFile[]): Uint8Array;
export function alpineDemoCleanupScript(): string;
export function alpineInitScript(rootMode?: AlpineRootMode): string;
export function appendAlpineBootInitramfs(original: Uint8Array, rootMode?: AlpineRootMode): Uint8Array;
