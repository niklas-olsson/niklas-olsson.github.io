// SPDX-License-Identifier: Apache-2.0
// Recover a fixed public test image into ignored cache output; never execute it.
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, link, unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
const compressed = new URL("./browser/fixtures/orchard-v2.trmimg.gz", import.meta.url);
const output = new URL("../.cache/browser-fixtures/orchard-v2.trmimg", import.meta.url);
const pin = {"bytes": 29035630, "sha256": "8ae93d4b64667b6c963082f3e34ba5e9df462383030c77d72ab1467f3d3a7d82", "decodedBytes": 178056621, "decodedSha256": "035dcba4955336ab1697c0c4eb842e8a7cc2feb75931793d6cdec634b5657b3d"};
async function identity(path) {
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest("hex") };
}
async function verifyOutput() {
  const value = await identity(output);
  if (value.bytes !== pin.decodedBytes || value.sha256 !== pin.decodedSha256) throw new Error("Cached image fixture differs from its exact pin; preserve and inspect it before retrying.");
}
try {
  await verifyOutput();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const input = await identity(compressed);
  if (input.bytes !== pin.bytes || input.sha256 !== pin.sha256) throw new Error("Compressed image fixture differs from its exact distribution pin.");
  await mkdir(new URL("./", output), { recursive: true });
  const partial = new URL(output.href + "." + randomUUID() + ".partial");
  const hash = createHash("sha256"); let bytes = 0;
  try {
    await pipeline(createReadStream(compressed), createGunzip(), new Transform({ transform(chunk, _encoding, next) {
      bytes += chunk.length;
      if (bytes > pin.decodedBytes) return next(new Error("Decoded fixture exceeds its pinned size."));
      hash.update(chunk); next(null, chunk);
    } }), createWriteStream(partial, { flags: "wx" }));
    if (bytes !== pin.decodedBytes || hash.digest("hex") !== pin.decodedSha256) throw new Error("Decoded fixture differs from its exact image pin.");
    try { await link(partial, output); }
    catch (error) { if (error.code !== "EEXIST") throw error; await verifyOutput(); }
  } finally { await unlink(partial).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
console.log("S2_IMAGE_FIXTURE_READY " + output.pathname);
