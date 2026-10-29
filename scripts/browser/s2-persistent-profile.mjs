// SPDX-License-Identifier: Apache-2.0
// A validation-owned fresh profile, never an existing user's Chromium profile.
import assert from "node:assert/strict";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export async function reservePersistentProfile(projectRoot, requestedPath) {
  assert.ok(typeof requestedPath === "string" && isAbsolute(requestedPath),
    "Persistence validation requires an explicit absolute TERRARIUM_S2_PROFILE_DIR");
  const root = resolve(projectRoot);
  assert.equal(await realpath(root), root, "The validation project root must not use symbolic links");
  const parent = join(root, ".cache", "s2-browser-profiles"), path = resolve(requestedPath);
  assert.match(relative(parent, path), /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/,
    "The profile must be a named direct child of the project's .cache/s2-browser-profiles directory");
  for (const directory of [join(root, ".cache"), parent]) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await lstat(directory);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "Profile parents must be real directories");
    assert.equal(await realpath(directory), directory, "Profile parents must not redirect through symbolic links");
  }
  // Refuse existing empty directories too. A caller cannot accidentally select
  // a pre-existing profile or turn a failed run into a resumed clean baseline.
  await mkdir(path, { mode: 0o700 });
  const stat = await lstat(path);
  return { path, initiallyAbsent: true, device: stat.dev, inode: stat.ino,
    mode: (stat.mode & 0o777).toString(8), createdAt: new Date().toISOString(),
    policy: "A new validation-owned profile; the same directory is reused only for the single declared restart." };
}

export async function verifyPersistentProfile(identity) {
  const stat = await lstat(identity.path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), "The owned profile must remain a real directory");
  assert.equal(await realpath(identity.path), identity.path, "The owned profile path must not redirect");
  assert.equal(stat.dev, identity.device, "The owned profile device changed");
  assert.equal(stat.ino, identity.inode, "The owned profile directory was replaced");
}
