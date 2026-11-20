// SPDX-License-Identifier: Apache-2.0
// Linux initramfs permits concatenated compressed and uncompressed newc archives:
// https://www.kernel.org/doc/html/latest/driver-api/early-userspace/buffer-format.html

const encoder = new TextEncoder();
const MAX_EXTRA_BYTES = 1024 * 1024;
const MAX_BASE_BYTES = 64 * 1024 * 1024;
const align4 = (value) => Math.ceil(value / 4) * 4;

/** Create bounded regular-file entries only. No host filesystem paths or symlinks. */
export function buildNewcArchive(files) {
  if (!Array.isArray(files) || files.length > 128)
    throw new Error("An initramfs overlay supports at most 128 regular files.");
  const seen = new Set();
  let total = 0;
  const entries = files.map((file, index) => {
    if (!file || typeof file !== "object" || typeof file.path !== "string"
      || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(file.path)
      || file.path.split("/").some((part) => part === "." || part === "..")
      || file.path === "TRAILER!!!" || file.path.length > 255 || seen.has(file.path))
      throw new Error("Initramfs overlay paths must be unique relative regular-file paths.");
    seen.add(file.path);
    const mode = file.mode ?? 0o644;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777)
      throw new Error("Initramfs file permissions must be between 000 and 777.");
    if (typeof file.data === "string" && file.data.length > MAX_EXTRA_BYTES)
      throw new Error("The initramfs overlay exceeds 1 MiB.");
    const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    if (!(data instanceof Uint8Array)) throw new Error("Initramfs file data must be text or bytes.");
    const name = encoder.encode(file.path + "\0");
    const bytes = align4(align4(110 + name.length) + data.byteLength);
    total += bytes;
    if (total > MAX_EXTRA_BYTES) throw new Error("The initramfs overlay exceeds 1 MiB.");
    return { name, mode: 0o100000 | mode, data, inode: index + 1, bytes };
  });
  const trailerName = encoder.encode("TRAILER!!!\0");
  const trailerBytes = align4(110 + trailerName.length);
  const result = new Uint8Array(Math.ceil((total + trailerBytes) / 512) * 512);
  let offset = 0;
  const writeEntry = (name, mode, data, inode) => {
    const fields = [inode, mode, 0, 0, 1, 0, data.byteLength, 0, 0, 0, 0, name.length, 0];
    const header = "070701" + fields.map((value) => value.toString(16).padStart(8, "0")).join("");
    result.set(encoder.encode(header), offset);
    result.set(name, offset + 110);
    const contentOffset = align4(offset + 110 + name.length);
    result.set(data, contentOffset);
    offset = align4(contentOffset + data.byteLength);
  };
  for (const entry of entries) writeEntry(entry.name, entry.mode, entry.data, entry.inode);
  writeEntry(trailerName, 0, new Uint8Array(), entries.length + 1);
  return result;
}

/** Append without decoding or modifying the verified upstream gzip member. */
export function appendInitramfsArchive(original, files) {
  if (!(original instanceof Uint8Array) || original.byteLength < 10 || original.byteLength > MAX_BASE_BYTES
    || original[0] !== 0x1f || original[1] !== 0x8b || original[2] !== 8)
    throw new Error("The base initramfs must be a verified gzip image of at most 64 MiB.");
  const archive = buildNewcArchive(files);
  const start = align4(original.byteLength);
  const result = new Uint8Array(start + archive.byteLength);
  result.set(original);
  result.set(archive, start);
  return result;
}

/** Remove only the pinned upstream demo's networking assumptions after mounting root. */
export function alpineDemoCleanupScript() {
  return [
    "for _trm_service in /sysroot/etc/runlevels/*/setup-wasm-networking; do",
    "  if [ -L \"$_trm_service\" ]; then",
    "    case \"$(readlink \"$_trm_service\")\" in /etc/init.d/setup-wasm-networking|../../init.d/setup-wasm-networking) rm -f \"$_trm_service\";; esac",
    "  fi",
    "done",
    "_trm_demo_profile='export SSL_CERT_FILE=/etc/wasmenv/proxy.crt",
    "export https_proxy=http://192.168.127.253:80",
    "export http_proxy=http://192.168.127.253:80",
    "export HTTPS_PROXY=http://192.168.127.253:80",
    "export HTTP_PROXY=http://192.168.127.253:80'",
    "if [ -f /sysroot/root/.profile ] && [ \"$(cat /sysroot/root/.profile)\" = \"$_trm_demo_profile\" ]; then",
    "  printf '%s\\n' 'export TERM=xterm-256color' > /sysroot/root/.profile",
    "fi",
    "if [ -f /sysroot/etc/fstab ]; then",
    "  sed -i '/^UUID=37dd7022-86ff-4bef-b817-52606811f9b2[[:space:]][[:space:]]*\\/boot[[:space:]]/s/^/# Terrarium unused build boot partition: /' /sysroot/etc/fstab",
    "fi",
    "unset _trm_service _trm_demo_profile",
  ].join("\n");
}

/** Image-specific /init policy. Writable mode requires a writable host block backend. */
export function alpineInitScript(rootMode = "overlay") {
  if (rootMode !== "overlay" && rootMode !== "writable")
    throw new Error("Alpine root mode must be overlay or writable.");
  const commands = [
    "#!/bin/sh",
    "set -eu",
    "/bin/busybox mkdir -p /bin /dev",
    "/bin/busybox --install -s /bin",
    "export PATH=\"$PATH:/bin\"",
    "modprobe -a ext4 virtio_blk virtio_net",
    "mount -t devtmpfs devtmpfs /dev",
  ];
  if (rootMode === "overlay") {
    commands.push(
      "mkdir /sysroot /sysroot-ovl /sysroot-lower",
      "mount -t tmpfs tmpfs /sysroot-ovl",
      "mkdir /sysroot-ovl/upper /sysroot-ovl/work",
      "mount -t ext4 -o ro,noatime /dev/vda /sysroot-lower",
      "mount -t overlay -o lowerdir=/sysroot-lower,upperdir=/sysroot-ovl/upper,workdir=/sysroot-ovl/work overlayfs /sysroot",
    );
  } else {
    commands.push("mkdir /sysroot", "mount -t ext4 -o rw,noatime /dev/vda /sysroot");
  }
  commands.push(alpineDemoCleanupScript(), "mount -t devtmpfs devtmpfs /sysroot/dev", "exec switch_root /sysroot /sbin/init", "");
  return commands.join("\n");
}

export function appendAlpineBootInitramfs(original, rootMode = "overlay") {
  return appendInitramfsArchive(original, [{ path: "init", mode: 0o755, data: alpineInitScript(rootMode) }]);
}
