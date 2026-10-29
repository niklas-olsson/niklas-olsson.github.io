import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const runtimeDirectory = path.join(root, "public", "runtime");
const packageDirectory = path.join(root, "node_modules", "v86");
const version = "0.5.472";
// The published package embeds its build commit as SemVer metadata.
const embeddedVersion = "0.5.472+gcc37f35";
const sourceCommit = "cc37f35c43bf14865d74ad76879ecf9410f69eb1";
const packageIntegrity =
  "sha512-x2uw/IeJvIxSelkHvM3BzfhJ0KQOo3fFEOyMxIiOjMeCZFrR+UYwJ44/swRabcP/5QL1hBimUewpRPYWOwFI0A==";
const assets = [
  {
    file: "libv86.js",
    bytes: 359839,
    sha256: "1b41074f7a5604f528dac6842baf7afccd79d7370b97ea3241944c275b67bec1",
  },
  {
    file: "v86.wasm",
    bytes: 2007347,
    sha256: "2f0c4150f266415b754a84a32e6f8e4c975a1d3abb94c78b047fa30027db1ef1",
  },
  {
    file: "v86-fallback.wasm",
    bytes: 2040034,
    sha256: "4eb64c9b7908d5931c1868eea4824b3a0a628eb86e6eac09d133776b50922d81",
  },
];

// These binaries remain at their upstream origins. The browser fetches and
// verifies them after Boot. They must not silently enter a public build.
const guestAssets = [
  {
    file: "buildroot-bzimage68.bin",
    role: "Linux kernel with embedded root filesystem",
    url: "https://i.copy.sh/buildroot-bzimage68.bin",
    bytes: 10068480,
    sha256: "507a759c70ab7a490a233be454d0b5b88bc667956a410b531cb4edc091e2eb1c",
    observedKernelVersion: "6.8.12",
    sourceBundleStatus:
      "Exact Buildroot configuration and complete corresponding source bundle not established; not redistributed by this project.",
  },
  {
    file: "seabios.bin",
    role: "PC firmware",
    url: `https://raw.githubusercontent.com/copy/v86/${sourceCommit}/bios/seabios.bin`,
    bytes: 131072,
    sha256: "73e3f359102e3a9982c35fce98eb7cd08f18303ac7f1ba6ebfbe6cdc1c244d98",
    source: "https://github.com/coreboot/seabios/tree/rel-1.16.2",
    buildRecipe: `https://github.com/copy/v86/blob/${sourceCommit}/bios/fetch-and-build-seabios.sh`,
  },
  {
    file: "vgabios.bin",
    role: "VGA firmware",
    url: `https://raw.githubusercontent.com/copy/v86/${sourceCommit}/bios/vgabios.bin`,
    bytes: 36352,
    sha256: "a4bc0d80cc3ca028c73dafa8fee396b8d054ce87ebd8abfbd31b06b437607880",
    source: "https://github.com/coreboot/seabios/tree/rel-1.16.2",
    buildRecipe: `https://github.com/copy/v86/blob/${sourceCommit}/bios/fetch-and-build-seabios.sh`,
  },
];

const licenses = [
  ["v86/LICENSE", "v86-BSD-2-Clause.txt"],
  ["react/LICENSE", "React-MIT.txt"],
  ["react-dom/LICENSE", "React-DOM-MIT.txt"],
  ["scheduler/LICENSE", "React-scheduler-MIT.txt"],
  ["@xterm/xterm/LICENSE", "xterm-MIT.txt"],
  ["@xterm/addon-fit/LICENSE", "xterm-addon-fit-MIT.txt"],
  ["lucide-react/LICENSE", "Lucide-ISC.txt"],
  ["@fontsource-variable/dm-sans/LICENSE", "DM-Sans-OFL-1.1.txt"],
  ["@fontsource-variable/manrope/LICENSE", "Manrope-OFL-1.1.txt"],
];

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function prepare() {
  const metadata = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  if (metadata.version !== embeddedVersion) {
    throw new Error(
      `Expected v86@${version}, found ${metadata.version}. Run npm ci with the committed lockfile.`,
    );
  }

  await mkdir(path.join(runtimeDirectory, "licenses"), { recursive: true });
  for (const guest of guestAssets) {
    if (await exists(path.join(runtimeDirectory, guest.file))) {
      throw new Error(
        `public/runtime/${guest.file} is a guest binary. Move it outside public/ before building. See docs/release-audit.md for image redistribution requirements.`,
      );
    }
  }

  const redistributedAssets = [];
  for (const asset of assets) {
    const bytes = await readFile(
      path.join(packageDirectory, "build", asset.file),
    );
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== asset.bytes || hash !== asset.sha256) {
      throw new Error(
        `Integrity check failed for v86@${version}/${asset.file}. Do not update the expected hash without reviewing the upstream release.`,
      );
    }
    let output = bytes;
    if (asset.file === "libv86.js") {
      // This exact source is hash-checked above. Export existing network
      // backends for lazy per-port creation and the generic VirtIO transport
      // for Terrarium's durable block device. No upstream implementation changes.
      const source = bytes.toString("utf8");
      const ending = "}).call(this);";
      if (
        !source.trimEnd().endsWith(ending) ||
        !source.includes("function Xb(") ||
        !source.includes("function $b(") ||
        !source.includes("function Oc(") ||
        !source.includes('this.virtio=new Oc(a,{name:"virtio-console"')
      ) {
        throw new Error(
          "The pinned v86 adapter-export patch no longer matches its verified source.",
        );
      }
      const position = source.lastIndexOf(ending);
      output = Buffer.from(
        `${source.slice(0, position)}\n/* Terrarium integration: expose existing BSD-licensed network backends and generic VirtIO PCI transport. */\nglobalThis.TerrariumNetworkAdapters = { Fetch: Xb, Wisp: $b };\nglobalThis.TerrariumVirtIO = Oc;\n${source.slice(position)}`,
      );
    }
    await writeFile(path.join(runtimeDirectory, asset.file), output);
    redistributedAssets.push({
      file: asset.file,
      bytes: output.byteLength,
      sha256: createHash("sha256").update(output).digest("hex"),
    });
  }

  for (const [source, destination] of licenses) {
    await writeFile(
      path.join(runtimeDirectory, "licenses", destination),
      await readFile(path.join(root, "node_modules", source)),
    );
  }

  for (const file of [
    "SoftFloat-notices.txt",
    "Zstandard-BSD.txt",
    "v86-QEMU-MIT.txt",
  ]) {
    if (!(await exists(path.join(runtimeDirectory, "licenses", file)))) {
      throw new Error(
        `Missing committed runtime license: ${file}. Restore it before publishing.`,
      );
    }
  }

  const provenance = {
    schemaVersion: 1,
    package: {
      name: "v86",
      version,
      embeddedVersion,
      license: "BSD-2-Clause",
      integrity: packageIntegrity,
      sourceCommit,
      source: `https://github.com/copy/v86/tree/${sourceCommit}`,
    },
    upstreamEmulatorAssets: assets,
    redistributedEmulatorAssets: redistributedAssets,
    localPatches: [
      {
        file: "libv86.js",
        description:
          "Export existing FetchNetworkAdapter and WispNetworkAdapter constructors as globalThis.TerrariumNetworkAdapters, and the generic VirtIO PCI transport as globalThis.TerrariumVirtIO. Terrarium implements its block-device request handler separately. No upstream algorithm is replaced.",
        implementation: "scripts/prepare-runtime.mjs",
      },
    ],
    guestAssetPolicy:
      "Fetched directly by the browser on explicit Boot, with byte-length and SHA-256 checks; not included in the repository or build output.",
    externalGuestAssets: guestAssets,
    provenanceReference:
      "https://registry.npmjs.org/-/npm/v1/attestations/v86@0.5.472",
  };
  await writeFile(
    path.join(runtimeDirectory, "provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  await writeFile(
    path.join(runtimeDirectory, "THIRD_PARTY_NOTICES.md"),
    (await readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8"))
      .replace("[runtime source guide](docs/runtime-sources.md)",
        "[runtime source guide](../../docs/runtime-sources.md)"),
  );
  await writeFile(
    path.join(runtimeDirectory, "LICENSE"),
    await readFile(path.join(root, "LICENSE")),
  );
  await writeFile(
    path.join(runtimeDirectory, "NOTICE"),
    await readFile(path.join(root, "NOTICE")),
  );
  console.log(
    `Prepared ${assets.length} verified v86@${version} assets and third-party notices. Guest images remain upstream.`,
  );
}

prepare().catch((error) => {
  console.error(`Runtime preparation failed: ${error.message}`);
  process.exitCode = 1;
});
