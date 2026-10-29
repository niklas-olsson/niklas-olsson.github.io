// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";
import { alpineDemoCleanupScript, alpineInitScript, appendAlpineBootInitramfs, appendInitramfsArchive, buildNewcArchive } from "./qemu-initramfs.ts";

function readArchive(input: Uint8Array): { path: string; mode: number; data: Uint8Array }[] {
  const decoder = new TextDecoder();
  const entries: { path: string; mode: number; data: Uint8Array }[] = [];
  let offset = 0;
  while (offset + 110 <= input.length) {
    assert.equal(decoder.decode(input.subarray(offset, offset + 6)), "070701");
    const number = (index: number) => Number.parseInt(decoder.decode(input.subarray(offset + 6 + index * 8, offset + 14 + index * 8)), 16);
    const fileSize = number(6);
    const nameSize = number(11);
    assert.equal(number(4), 1, "Every entry has an independent inode, with no hardlink semantics");
    assert.equal(number(12), 0, "newc checksum field is zero");
    const path = decoder.decode(input.subarray(offset + 110, offset + 110 + nameSize - 1));
    assert.equal(input[offset + 110 + nameSize - 1], 0);
    const start = (offset + 110 + nameSize + 3) & ~3;
    if (path === "TRAILER!!!") { assert.equal(fileSize, 0); return entries; }
    entries.push({ path, mode: number(1), data: input.slice(start, start + fileSize) });
    offset = (start + fileSize + 3) & ~3;
  }
  throw new Error("Missing cpio trailer");
}

test("newc archive preserves binary file data, executable permissions and alignment", () => {
  const archive = buildNewcArchive([{ path: "init", mode: 0o755, data: "#!/bin/sh\necho boot\n" }, { path: "bytes", data: new Uint8Array([0, 255, 3]) }]);
  assert.equal(archive.length % 512, 0);
  const entries = readArchive(archive);
  assert.deepEqual(entries.map((entry) => [entry.path, entry.mode]), [["init", 0o100755], ["bytes", 0o100644]]);
  assert.equal(new TextDecoder().decode(entries[0].data), "#!/bin/sh\necho boot\n");
  assert.deepEqual(entries[1].data, new Uint8Array([0, 255, 3]));
  assert.deepEqual(archive, buildNewcArchive([{ path: "init", mode: 0o755, data: "#!/bin/sh\necho boot\n" }, { path: "bytes", data: new Uint8Array([0, 255, 3]) }]));
});

test("boot overlay leaves upstream gzip bytes intact and selects an explicit root policy", () => {
  const original = new Uint8Array(gzipSync(buildNewcArchive([{ path: "init", data: "upstream" }])));
  const modified = appendAlpineBootInitramfs(original, "writable");
  assert.deepEqual(modified.subarray(0, original.length), original);
  assert.equal(new TextDecoder().decode(readArchive(gunzipSync(original))[0].data), "upstream");
  const start = (original.length + 3) & ~3;
  const entries = readArchive(modified.subarray(start));
  assert.equal(entries.length, 1);
  const script = new TextDecoder().decode(entries[0].data);
  assert.equal(script, alpineInitScript("writable"));
  assert.match(script, /mount -t ext4 -o rw,noatime \/dev\/vda \/sysroot/);
  assert.doesNotMatch(script, /mount -t tmpfs|upperdir/);
  assert.match(alpineInitScript(), /lowerdir=.*upperdir=/);
});

test("overlay builder rejects unsafe paths, unsupported file types and excessive allocations", () => {
  for (const path of ["/init", "../init", "a/../init", "./init", "a//b", "a\\b", "a\0b", "x".repeat(256)])
    assert.throws(() => buildNewcArchive([{ path, data: "x" }]), /paths/);
  assert.throws(() => buildNewcArchive([{ path: "a", data: "1" }, { path: "a", data: "2" }]), /unique/);
  assert.throws(() => buildNewcArchive([{ path: "init", mode: 0o120777, data: "somewhere" }]), /permissions/);
  assert.throws(() => buildNewcArchive([{ path: "large", data: new Uint8Array(1024 * 1024) }]), /1 MiB/);
  assert.throws(() => appendInitramfsArchive(new Uint8Array([1, 2, 3]), []), /gzip/);
  assert.throws(() => alpineInitScript("unknown" as never), /root mode/);
});

test("guest boot cleanup removes only pinned demo services, profile and obsolete boot partition", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "terrarium-init-"));
  try {
    for (const path of ["root", "etc/runlevels/additional", "etc/runlevels/default", "etc/runlevels/custom"])
      mkdirSync(join(root, path), { recursive: true });
    symlinkSync("/etc/init.d/setup-wasm-networking", join(root, "etc/runlevels/additional/setup-wasm-networking"));
    symlinkSync("../../init.d/setup-wasm-networking", join(root, "etc/runlevels/default/setup-wasm-networking"));
    symlinkSync("/etc/init.d/user-owned-service", join(root, "etc/runlevels/custom/setup-wasm-networking"));
    writeFileSync(join(root, "etc/runlevels/default/other-service"), "keep");
    const profile = "export SSL_CERT_FILE=/etc/wasmenv/proxy.crt\nexport https_proxy=http://192.168.127.253:80\nexport http_proxy=http://192.168.127.253:80\nexport HTTPS_PROXY=http://192.168.127.253:80\nexport HTTP_PROXY=http://192.168.127.253:80\n";
    writeFileSync(join(root, "root/.profile"), profile);
    const oldBoot = "UUID=37dd7022-86ff-4bef-b817-52606811f9b2\t/boot\text4\trw,relatime 0 2";
    const keep = "UUID=different /boot ext4 defaults 0 2\nUUID=37dd7022-86ff-4bef-b817-52606811f9b2 /boot-other ext4 defaults 0 2\n/dev/vda / ext4 defaults 0 1\n";
    writeFileSync(join(root, "etc/fstab"), `${oldBoot}\n${keep}`);
    const script = "set -eu\n" + alpineDemoCleanupScript().replaceAll("/sysroot", root);
    execFileSync("/bin/sh", ["-c", script], { timeout: 5000 });
    assert.equal(readFileSync(join(root, "root/.profile"), "utf8"), "export TERM=xterm-256color\n");
    assert.equal(readFileSync(join(root, "etc/fstab"), "utf8"), `# Terrarium unused build boot partition: ${oldBoot}\n${keep}`);
    assert.throws(() => lstatSync(join(root, "etc/runlevels/additional/setup-wasm-networking")), { code: "ENOENT" });
    assert.throws(() => lstatSync(join(root, "etc/runlevels/default/setup-wasm-networking")), { code: "ENOENT" });
    assert.equal(readlinkSync(join(root, "etc/runlevels/custom/setup-wasm-networking")), "/etc/init.d/user-owned-service");
    assert.equal(readFileSync(join(root, "etc/runlevels/default/other-service"), "utf8"), "keep");
    const changedProfile = profile + "export USER_SETTING=preserved\n";
    writeFileSync(join(root, "root/.profile"), changedProfile);
    execFileSync("/bin/sh", ["-c", script], { timeout: 5000 });
    assert.equal(readFileSync(join(root, "root/.profile"), "utf8"), changedProfile);
    assert.equal(readFileSync(join(root, "etc/fstab"), "utf8"), `# Terrarium unused build boot partition: ${oldBoot}\n${keep}`, "Repeated boot does not repeatedly comment the fstab entry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
