// SPDX-License-Identifier: Apache-2.0
// Run with: node --experimental-strip-types scripts/smoke-vm.mjs
// This exercises the real guest under v86's Node host. It does not validate
// browser rendering, cross-origin downloads, permissions, or interaction.

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { V86 } from "v86";
import {
  commandFrame,
  parseCommandFrame,
  recoveryFrame,
  hasRecoveryFrame,
} from "../src/lib/command-protocol.ts";
import { validateSnapshot } from "../src/lib/snapshot-format.ts";
import { RUNTIME_MEMORY_MIB } from "../src/lib/runtime-types.ts";
import { sessionBootstrapCommand } from "../src/lib/guest-startup.ts";

const report = (name, details = {}) =>
  console.log(JSON.stringify({ name, passed: true, ...details }));

async function fetchGuestAsset(asset) {
  if (process.env.TERRARIUM_VM_ASSET_DIR) {
    const directory = process.env.TERRARIUM_VM_ASSET_DIR;
    const local = await readFile(
      resolve(
        directory,
        asset.file === "buildroot-bzimage68.bin"
          ? asset.file
          : `bios/${asset.file}`,
      ),
    );
    assert.equal(
      local.byteLength,
      asset.bytes,
      `${asset.file}: local asset size mismatch`,
    );
    assert.equal(
      createHash("sha256").update(local).digest("hex"),
      asset.sha256,
      `${asset.file}: local asset SHA-256 mismatch`,
    );
    report("verified local test asset", {
      file: asset.file,
      bytes: local.byteLength,
    });
    return local.buffer.slice(
      local.byteOffset,
      local.byteOffset + local.byteLength,
    );
  }
  const response = await fetch(asset.url, {
    signal: AbortSignal.timeout(60_000),
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok)
    throw new Error(
      `${asset.file}: upstream returned HTTP ${response.status}.`,
    );
  const bytes = new Uint8Array(asset.bytes);
  let received = 0;
  if (!response.body)
    throw new Error(`${asset.file}: upstream returned no body.`);
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.byteLength > asset.bytes)
        throw new Error(`${asset.file}: unexpected download size.`);
      bytes.set(value, received);
      received += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  assert.equal(received, asset.bytes, `${asset.file}: incomplete download`);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    asset.sha256,
    `${asset.file}: SHA-256 mismatch`,
  );
  report("verified upstream asset", { file: asset.file, bytes: received });
  // Guest assets exist only in memory. Do not write them into the repository.
  return bytes.buffer;
}

async function main() {
  const provenance = JSON.parse(
    await readFile(
      new URL("../public/runtime/provenance.json", import.meta.url),
      "utf8",
    ),
  );
  const installedModule = new URL(import.meta.resolve("v86"));
  const installedPackage = JSON.parse(
    await readFile(new URL("../package.json", installedModule), "utf8"),
  );
  assert.equal(
    installedPackage.version,
    provenance.package.embeddedVersion,
    "Installed v86 differs from the pinned provenance. Run npm ci.",
  );
  const wasmPath = fileURLToPath(new URL("v86.wasm", installedModule));
  const wasm = await readFile(wasmPath);
  const expectedWasm = provenance.redistributedEmulatorAssets.find(
    (asset) => asset.file === "v86.wasm",
  );
  assert.ok(expectedWasm, "The runtime provenance must declare v86.wasm.");
  assert.equal(
    wasm.byteLength,
    expectedWasm.bytes,
    "Wasm size differs from the pinned provenance.",
  );
  assert.equal(
    createHash("sha256").update(wasm).digest("hex"),
    expectedWasm.sha256,
    "Wasm digest differs from the pinned provenance.",
  );

  const guest = (file) => {
    const matches = provenance.externalGuestAssets.filter(
      (asset) => asset.file === file,
    );
    assert.equal(
      matches.length,
      1,
      `Expected one provenance entry for ${file}.`,
    );
    return matches[0];
  };
  console.log("Downloading and verifying upstream guest assets in memory…");
  const [kernel, bios, vga] = await Promise.all([
    fetchGuestAsset(guest("buildroot-bzimage68.bin")),
    fetchGuestAsset(guest("seabios.bin")),
    fetchGuestAsset(guest("vgabios.bin")),
  ]);

  const emulator = new V86({
    wasm_path: wasmPath,
    memory_size: RUNTIME_MEMORY_MIB * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    bios: { buffer: bios },
    vga_bios: { buffer: vga },
    bzimage: { buffer: kernel },
    filesystem: {},
    cmdline: "console=ttyS0,115200 tsc=reliable random.trust_cpu=on",
    autostart: false,
    disable_keyboard: true,
    disable_mouse: true,
    disable_speaker: true,
    uart1: true,
    uart2: true,
    uart3: true,
    mac_address_translation: true,
    preserve_mac_from_state_image: false,
  });
  let output = "";
  const serialOutput = ["", "", "", ""];
  const decoders = serialOutput.map(() => new TextDecoder());
  const listeners = new Set();
  emulator.add_listener("emulator-ready", () => {
    for (const port of [1, 2, 3])
      emulator.serial_set_carrier_detect(port, true);
    void emulator.run();
  });
  for (const port of [0, 1, 2, 3])
    emulator.add_listener(`serial${port}-output-byte`, (byte) => {
      serialOutput[port] += decoders[port].decode(new Uint8Array([byte]), {
        stream: true,
      });
      if (port === 0) output = serialOutput[0];
      for (const callback of listeners) callback();
    });

  function waitFor(predicate, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      let timer;
      const check = () => {
        const result = predicate();
        if (result) {
          clearTimeout(timer);
          listeners.delete(check);
          resolve(result);
        }
      };
      timer = setTimeout(() => {
        listeners.delete(check);
        reject(
          new Error(
            `Timed out. Recent serial output: ${serialOutput.map((text, port) => `\nPORT ${port}:\n${text.slice(-1600)}`).join("")}`,
          ),
        );
      }, timeoutMs);
      listeners.add(check);
      check();
    });
  }

  async function run(command) {
    const token = randomUUID().replaceAll("-", "");
    const start = output.length;
    const result = waitFor(() => parseCommandFrame(output.slice(start), token));
    emulator.serial_send_bytes(
      0,
      new TextEncoder().encode(commandFrame(command, token)),
    );
    const value = await result;
    await waitFor(() => output.endsWith("~% "));
    return value;
  }

  async function interactive(port, command) {
    const token = randomUUID().replaceAll("-", "");
    const start = serialOutput[port].length;
    const pending = waitFor(() =>
      parseCommandFrame(serialOutput[port].slice(start), token),
    );
    emulator.serial_send_bytes(
      port,
      new TextEncoder().encode(
        `printf '\\n__TRM_BEGIN_${token}__\\n'; ${command}; _trm_rc=$?; printf '\\n__TRM_END_${token}__:%s\\n' "$_trm_rc"\n`,
      ),
    );
    const result = await pending;
    await waitFor(() => serialOutput[port].endsWith(`shell-${port}> `));
    return result;
  }

  function check(name, actual, expected) {
    assert.deepEqual(actual, expected, name);
    report(name, { actual });
  }

  try {
    await waitFor(() => output.endsWith("~% "), 60_000);
    report("boot", { shellPrompt: "~% " });
    check("independent shell bootstrap", await run(sessionBootstrapCommand()), {
      output: "",
      exitCode: 0,
    });
    await waitFor(() =>
      [1, 2, 3].every((port) => serialOutput[port].endsWith(`shell-${port}> `)),
    );
    const pids = [];
    for (const port of [1, 2, 3]) {
      const session = await interactive(
        port,
        'printf "%s\\n" "$$"; tty; set -o | grep monitor',
      );
      assert.equal(session.exitCode, 0);
      assert.match(session.output, new RegExp(`/dev/ttyS${port}`));
      assert.match(session.output, /monitor\s+on/);
      pids.push(session.output.split("\n")[0]);
    }
    assert.equal(new Set(pids).size, 3);
    report("three controlling terminals and independent shell PIDs", { pids });
    await interactive(1, "export TRM_SESSION=one; cd /tmp");
    check(
      "persistent cwd and environment in shell one",
      await interactive(1, 'printf "%s:" "$TRM_SESSION"; pwd'),
      { output: "one:/tmp\n", exitCode: 0 },
    );
    check(
      "shell two has independent state",
      await interactive(2, 'printf "%s:" "${TRM_SESSION-unset}"; pwd'),
      { output: "unset:/root\n", exitCode: 0 },
    );
    check(
      "host resize targets one independent TTY",
      await run("stty -F /dev/ttyS2 rows 31 cols 96"),
      { output: "", exitCode: 0 },
    );
    check(
      "guest sees fitted terminal dimensions",
      await interactive(2, "stty size"),
      { output: "31 96\n", exitCode: 0 },
    );
    const jobStart = serialOutput[1].length;
    // BusyBox may execute sleep as a nofork shell applet. A child shell is a
    // real foreground job, so this exercises the terminal's job control.
    emulator.serial_send_bytes(
      1,
      new TextEncoder().encode("/bin/sh -c 'sleep 20'\n"),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    check(
      "other shell stays usable during foreground job",
      await interactive(2, "printf other-shell"),
      { output: "other-shell", exitCode: 0 },
    );
    check(
      "control channel stays usable during foreground job",
      await run("printf control-channel"),
      { output: "control-channel", exitCode: 0 },
    );
    emulator.serial_send_bytes(1, new Uint8Array([26]));
    await waitFor(
      () =>
        /Stopped/.test(serialOutput[1].slice(jobStart)) &&
        serialOutput[1].endsWith("shell-1> "),
    );
    assert.match((await interactive(1, "jobs")).output, /Stopped/);
    emulator.serial_send_bytes(1, new TextEncoder().encode("fg\n"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const interruptStart = serialOutput[1].length;
    emulator.serial_send_bytes(1, new Uint8Array([3]));
    await waitFor(() =>
      serialOutput[1].slice(interruptStart).includes("shell-1> "),
    );
    report("foreground job suspend, jobs, resume, and Ctrl-C");
    check(
      "persist pane size for shell respawn",
      await run(
        "stty -F /dev/ttyS3 rows 29 cols 91 && printf '29 91\\n' > /run/terrarium/ttyS3.size",
      ),
      { output: "", exitCode: 0 },
    );
    const beforeExit = (await interactive(3, 'printf "%s" "$$"')).output;
    const exitStart = serialOutput[3].length;
    emulator.serial_send_bytes(3, new TextEncoder().encode("exit\n"));
    await waitFor(() => serialOutput[3].slice(exitStart).includes("shell-3> "));
    assert.notEqual(
      (await interactive(3, 'printf "%s" "$$"')).output,
      beforeExit,
    );
    report("interactive shell respawns after exit");
    check(
      "respawned shell retains fitted pane dimensions",
      await interactive(3, "stty size"),
      { output: "29 91\n", exitCode: 0 },
    );
    if (process.argv.includes("--sessions-only")) return;
    const identity = await run("uname -a");
    assert.equal(identity.exitCode, 0);
    assert.match(identity.output, /Linux .*6\.8\.12.*i686/);
    report("kernel identity", { result: identity });
    check("echo", await run("echo hi"), { output: "hi\n", exitCode: 0 });
    check("nonzero exit", await run("false"), { output: "", exitCode: 1 });
    check(
      "guest file create/read",
      await run("printf 'before' > /root/trm-smoke; cat /root/trm-smoke"),
      { output: "before", exitCode: 0 },
    );
    check("quoted command", await run("printf '%s' \"a'b c\""), {
      output: "a'b c",
      exitCode: 0,
    });

    const longUnicode = "å🤖".repeat(1_100);
    const unicodeCommand = `printf '%s' '${longUnicode}'`;
    const unicodeResult = await run(unicodeCommand);
    assert.equal(unicodeResult.output, longUnicode);
    assert.equal(unicodeResult.exitCode, 0);
    report("long Unicode command", {
      commandBytes: new TextEncoder().encode(unicodeCommand).byteLength,
      outputBytes: new TextEncoder().encode(unicodeResult.output).byteLength,
    });
    check(
      "noninteractive stdin",
      await run('read answer; echo "read_exit=$?"'),
      { output: "read_exit=1\n", exitCode: 0 },
    );
    const tools = await run(
      "command -v lua; command -v curl; command -v python; command -v node; command -v gcc; true",
    );
    check("guest tool availability", tools, {
      output: "/usr/bin/lua\n/usr/bin/curl\n",
      exitCode: 0,
    });

    await emulator.stop();
    const state = await emulator.save_state();
    validateSnapshot(state);
    report("real raw snapshot passes preflight", { bytes: state.byteLength });
    await emulator.run();
    await run("printf 'after' > /root/trm-smoke");
    await emulator.stop();
    await emulator.restore_state(state);
    await emulator.run();
    emulator.serial0_send("\n");
    await waitFor(() => output.endsWith("~% "));
    await run(sessionBootstrapCommand());
    check(
      "snapshot restores guest filesystem",
      await run("cat /root/trm-smoke"),
      { output: "before", exitCode: 0 },
    );
    check(
      "snapshot preserves independent shell cwd and environment",
      await interactive(1, 'printf "%s:" "$TRM_SESSION"; pwd'),
      { output: "one:/tmp\n", exitCode: 0 },
    );

    const start = output.length;
    const interruptedToken = randomUUID().replaceAll("-", "");
    emulator.serial0_send(commandFrame("sleep 20", interruptedToken));
    await waitFor(() =>
      output.slice(start).includes(`\n__TRM_BEGIN_${interruptedToken}__\r\n`),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    emulator.serial0_send("\x03");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const recoveryToken = randomUUID().replaceAll("-", "");
    emulator.serial0_send(recoveryFrame(recoveryToken));
    await waitFor(
      () => hasRecoveryFrame(output.slice(start), recoveryToken),
      2_000,
    );
    await waitFor(() => output.endsWith("~% "));
    check("interrupt and acknowledged recovery", await run("echo recovered"), {
      output: "recovered\n",
      exitCode: 0,
    });
    report("real Linux smoke test complete", {
      runtime: provenance.package.version,
    });
  } finally {
    await emulator.destroy();
  }
}

main().catch((error) => {
  console.error(
    `VM smoke test failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
