// SPDX-License-Identifier: Apache-2.0
// Small filesystem identity fixtures; these do not build or execute a guest.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const script = await readFile(new URL("./source-manifest.mjs", import.meta.url));
const manifestPath = ".cache/source-manifest.json";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t) {
  const parent = join(project, ".cache", "source-manifest-fixtures");
  await mkdir(parent, { recursive: true });
  const base = await mkdtemp(join(parent, "case-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "terrarium-playground");
  async function put(name, value) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  }
  await put("scripts/source-manifest.mjs", script);
  await put("package.json", '{"private":true}\n');
  await put("package-lock.json", '{"lockfileVersion":3}\n');
  await put("README.md", "Fixture documentation.\n");
  await put("public/runtime/qemu/provenance.json", '{"fixture":true}\n');
  const run = (mode) => spawnSync(process.execPath, ["scripts/source-manifest.mjs", mode], {
    cwd: root, encoding: "utf8", timeout: 15000,
  });
  return { base, root, put, run,
    readManifest: async () => JSON.parse(await readFile(join(root, manifestPath), "utf8")) };
}

function passed(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
}

function refused(result, pattern) {
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(result.stderr, pattern);
}

test("only exact staging directories at any depth are omitted and may change", async (t) => {
  const f = await fixture(t);
  await f.put(".rsync-tmp/root-part", "root transfer prefix");
  await f.put("src/nested/.rsync-tmp/nested-part", "nested transfer prefix");
  await f.put("src/current.txt", "authored bytes");
  passed(f.run("create"));
  const before = await f.readManifest();
  assert.deepEqual(before.exclusions.directoryNamesAtAnyDepth, [".rsync-tmp"]);
  assert.ok(before.files.some((item) => item.path === "src/current.txt"));
  assert.equal(before.files.some((item) => item.path.split("/").includes(".rsync-tmp")), false);
  await f.put(".rsync-tmp/root-part", "longer current root transfer prefix");
  await f.put("src/nested/.rsync-tmp/new-part", "new incomplete transfer");
  passed(f.run("verify"));
  assert.deepEqual(await f.readManifest(), before);
});

test("ordinary dotfiles, lookalikes and a regular file named .rsync-tmp remain identity inputs", async (t) => {
  const f = await fixture(t);
  const included = [".ordinary", "src/.hidden", ".rsync-tmp-backup/file", "src/rsync-tmp/file",
    "src/.rsync-tmp.extra/file", "src/files/.rsync-tmp", "src/.artifact.bin.A1b2C3"];
  for (const name of included) await f.put(name, "authored " + name);
  passed(f.run("create"));
  const original = await readFile(join(f.root, manifestPath));
  const names = new Set((await f.readManifest()).files.map((item) => item.path));
  for (const name of included) assert.ok(names.has(name), name);
  await f.put("src/files/.rsync-tmp", "changed ordinary regular file");
  const result = f.run("verify");
  refused(result, /Source changed since the recorded manifest/);
  assert.deepEqual(await readFile(join(f.root, manifestPath)), original);
});

test("a symlink named .rsync-tmp is refused without reading its destination", async (t) => {
  const f = await fixture(t);
  const outside = join(f.base, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "retained.txt"), "outside bytes");
  await mkdir(join(f.root, "src"));
  await symlink(outside, join(f.root, "src", ".rsync-tmp"), "dir");
  const result = f.run("create");
  refused(result, /Unaccounted source symlink: src\/\.rsync-tmp/);
  assert.equal(await readFile(join(outside, "retained.txt"), "utf8"), "outside bytes");
});

test("a historical manifest containing a staging path is refused and never rewritten", async (t) => {
  const f = await fixture(t);
  const staged = "historically included transfer bytes";
  await f.put("src/.rsync-tmp/previous", staged);
  passed(f.run("create"));
  const previous = await f.readManifest();
  previous.files.push({ path: "src/.rsync-tmp/previous", bytes: Buffer.byteLength(staged), sha256: sha256(staged) });
  previous.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  previous.sourceDigest = sha256(JSON.stringify(previous.files));
  const recorded = JSON.stringify(previous, null, 2) + "\n";
  await f.put(manifestPath, recorded);
  const result = f.run("verify");
  refused(result, /Source changed since the recorded manifest/);
  assert.equal(await readFile(join(f.root, manifestPath), "utf8"), recorded);
  assert.equal(await readFile(join(f.root, "src/.rsync-tmp/previous"), "utf8"), staged);
});
