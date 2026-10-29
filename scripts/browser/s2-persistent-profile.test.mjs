// SPDX-License-Identifier: Apache-2.0
// Filesystem guard fixtures only. These do not execute Chromium or qualify G4.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reservePersistentProfile, verifyPersistentProfile } from "./s2-persistent-profile.mjs";

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "terrarium-profile-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, profile: join(root, ".cache", "s2-browser-profiles", "g4-fixture") };
}

test("fresh validation-owned profile remains the same directory across verification", async t => {
  const { root, profile } = await workspace(t);
  const identity = await reservePersistentProfile(root, profile);
  assert.equal(identity.path, profile); assert.equal(identity.initiallyAbsent, true);
  assert.equal(identity.mode, "700"); assert.deepEqual(await readdir(profile), []);
  await writeFile(join(profile, "browser-storage-fixture"), "retained");
  await verifyPersistentProfile(identity);
  assert.equal(await readFile(join(profile, "browser-storage-fixture"), "utf8"), "retained");
});

test("existing empty or populated destinations cannot be silently reused", async t => {
  const { root, profile } = await workspace(t);
  await mkdir(profile, { recursive: true });
  await assert.rejects(reservePersistentProfile(root, profile), { code: "EEXIST" });
  await writeFile(join(profile, "preserved"), "user bytes");
  await assert.rejects(reservePersistentProfile(root, profile), { code: "EEXIST" });
  assert.equal(await readFile(join(profile, "preserved"), "utf8"), "user bytes");
});

test("implicit, relative, parent, outside and nested profile destinations are refused", async t => {
  const { root, profile } = await workspace(t);
  for (const candidate of [undefined, "profile", root, join(root, ".cache", "s2-browser-profiles"),
    join(root, "ordinary-profile"), join(profile, "nested"), join(root, ".cache", "s2-browser-profiles", "..")])
    await assert.rejects(reservePersistentProfile(root, candidate), /explicit absolute|named direct child/);
  assert.deepEqual(await readdir(root), []);
});

test("symbolic-link parents cannot redirect profile creation", async t => {
  const { root, profile } = await workspace(t);
  const outside = join(root, "outside"); await mkdir(outside);
  await symlink(outside, join(root, ".cache"));
  await assert.rejects(reservePersistentProfile(root, profile), /real directories/);
  assert.deepEqual(await readdir(outside), []);
});

test("regular-file and symbolic-link destinations retain their prior contents", async t => {
  const { root, profile } = await workspace(t);
  await mkdir(join(root, ".cache", "s2-browser-profiles"), { recursive: true });
  await writeFile(profile, "preserved file");
  await assert.rejects(reservePersistentProfile(root, profile), { code: "EEXIST" });
  assert.equal(await readFile(profile, "utf8"), "preserved file");
  const symbolic = profile + "-link"; await symlink(profile, symbolic);
  await assert.rejects(reservePersistentProfile(root, symbolic), { code: "EEXIST" });
  assert.equal(await readFile(symbolic, "utf8"), "preserved file");
});

test("replaced or redirected owned profiles are refused before relaunch", async t => {
  const { root, profile } = await workspace(t);
  const identity = await reservePersistentProfile(root, profile);
  const retained = profile + "-retained"; await rename(profile, retained); await mkdir(profile);
  await assert.rejects(verifyPersistentProfile(identity), /directory was replaced/);
  await rm(profile, { recursive: true }); await symlink(retained, profile);
  await assert.rejects(verifyPersistentProfile(identity), /real directory/);
});
