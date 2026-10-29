// SPDX-License-Identifier: Apache-2.0
// Identify the public source independently of generated reports.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const [mode = "create", output = ".cache/source-manifest.json"] = process.argv.slice(2);
if (!["create", "verify"].includes(mode) || process.argv.length > 4) {
  throw new Error("Usage: node scripts/source-manifest.mjs [create|verify] [manifest-path]");
}
const target = resolve(root, output);
if (!target.startsWith(root)) throw new Error("Source manifest must remain in this project.");
const targetRelative = relative(root, target).split(sep).join("/");
const excludedDirectoryPaths = new Set([".git", ".agents", ".codex", ".aws", "node_modules", "dist", ".cache", ".playwright-cli", "output"]);
// Workspace synchronization uses rsync --partial-dir=.rsync-tmp. Only actual
// directories with this exact basename are generated staging, at any depth.
const excludedDirectoryNames = new Set([".rsync-tmp"]);
const excludedFiles = new Set([".git", ".chatgpt-project.json", targetRelative]);
const excludedPrefixes = [];

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function visit(directory, prefix = "") {
  const results = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const name = prefix + entry.name;
    if (excludedFiles.has(name) || excludedPrefixes.some((p) => name.startsWith(p)) || name.endsWith(".tsbuildinfo")) continue;
    if (entry.isDirectory() && (excludedDirectoryPaths.has(name) || excludedDirectoryNames.has(entry.name))) continue;
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unaccounted source symlink: ${name}. Declare its distribution policy first.`);
    if (entry.isDirectory()) results.push(...await visit(path, name + "/"));
    else if (entry.isFile()) results.push({ path: name, bytes: (await lstat(path)).size, sha256: await sha256(path) });
    else throw new Error(`Unsupported source entry: ${name}`);
  }
  return results;
}
const files = (await visit(root)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
for (const required of ["package.json", "package-lock.json", "README.md", "public/runtime/qemu/provenance.json"]) {
  if (!files.some((f) => f.path === required)) throw new Error(`Required source identity input missing: ${required}`);
}
const manifest = {
  schema: "terrarium.source-manifest/v1",
  algorithm: "sha256",
  sourceDigest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  exclusions: {
    rootRelativeDirectoryPaths: [...excludedDirectoryPaths],
    directoryNamesAtAnyDepth: [...excludedDirectoryNames],
    files: [...excludedFiles],
    prefixes: excludedPrefixes,
    suffixes: [".tsbuildinfo"],
    reason: "Generated build output, exact .rsync-tmp directories used by workspace rsync --partial-dir=.rsync-tmp, and local reports are identified separately. Ordinary dotfiles, similarly named directories, lockfiles, build recipes, workflows, source documentation, and committed runtime assets remain included.",
  },
  files,
};
if (mode === "verify") {
  const previous = JSON.parse(await readFile(target, "utf8"));
  if (previous.schema !== manifest.schema || previous.sourceDigest !== manifest.sourceDigest || JSON.stringify(previous.files) !== JSON.stringify(files)) {
    throw new Error("Source changed since the recorded manifest. Retain old evidence and identify the changed candidate before retesting affected gates.");
  }
  console.log(`Verified ${files.length} source files: ${manifest.sourceDigest}`);
} else {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Recorded ${files.length} source files: ${manifest.sourceDigest}`);
}
