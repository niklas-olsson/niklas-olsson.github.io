#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Run with Node >=24: node --experimental-strip-types scripts/image-bundle.mjs ...
import { createHash } from "node:crypto";
import { openAsBlob, createReadStream } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createMachineImageBundle, inspectMachineImage } from "../src/lib/machine-image.ts";

function args() {
  const [command, ...rest] = process.argv.slice(2);
  if (!new Set(["pack", "inspect"]).has(command)) throw new Error("Usage: image-bundle.mjs pack --manifest file.json --kernel vmlinuz --initramfs initramfs --rootfs disk.img --output image.trmimg [--report report.json] | inspect --input image.trmimg [--report report.json]");
  const allowed = command === "pack" ? ["manifest", "kernel", "initramfs", "rootfs", "output", "report"] : ["input", "report"];
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]?.replace(/^--/, "");
    const value = rest[index + 1];
    if (!rest[index]?.startsWith("--") || !allowed.includes(key) || Object.hasOwn(values, key) || !value || value.startsWith("--"))
      throw new Error("Unsupported, duplicate, or incomplete image bundle option.");
    values[key] = resolve(value);
  }
  for (const key of allowed.filter((key) => key !== "report")) if (!values[key]) throw new Error(`Missing --${key}.`);
  return { command, ...values };
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest("hex");
}

async function saveBlob(blob, output) {
  // Exclusive creation preserves prior work; a failed write removes only this invocation's partial output.
  const handle = await open(output, "wx", 0o644);
  try {
    const reader = blob.stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
          if (!bytesWritten) throw new Error("The image output write made no progress.");
          offset += bytesWritten;
        }
      }
    } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    await handle.sync();
  } catch (error) {
    await handle.close(); await unlink(output).catch(() => {}); throw error;
  }
  await handle.close();
}

try {
  const options = args();
  let image;
  if (options.command === "pack") {
    const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
    const components = { kernel: await openAsBlob(options.kernel), initramfs: await openAsBlob(options.initramfs), rootfs: await openAsBlob(options.rootfs) };
    image = await createMachineImageBundle(manifest, components);
    await saveBlob(image.blob, options.output);
  } else image = await inspectMachineImage(await openAsBlob(options.input));
  const artifact = options.output ?? options.input;
  const report = { schema: "terrarium.machine-image-tool-result/v1", status: "data-validated-not-boot-qualified",
    command: options.command, node: process.version, file: artifact, bytes: image.totalBytes,
    imageId: image.id, imageIdentityMeaning: "SHA-256 of canonical manifest; manifest binds every component byte count and SHA-256",
    bundleSha256: await sha256(artifact), manifest: image.manifest,
    limits: ["Data validation does not prove guest boot compatibility or filesystem correctness.",
      "Root writes use an ephemeral overlay; persistence requires separately attached durable volumes."] };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (options.report) {
    const handle = await open(options.report, "wx", 0o644);
    try { await handle.writeFile(json); await handle.sync(); } finally { await handle.close(); }
  }
  process.stdout.write(json);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 1;
}
