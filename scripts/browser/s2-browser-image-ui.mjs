// SPDX-License-Identifier: Apache-2.0
// Actual packaged UI, browser storage and QEMU guests. This module never starts
// a browser by itself; smoke-s2.mjs owns the resource/deadline supervisor.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

const HELPER_URL = "/__browser-fixtures/acceptance/s2-browser-helper.js";
const ORCHARD = Object.freeze({
  id: "7d7b6b637e127c9089050bdbde5a10f2ae249c3163046402412f4e5e1c1a1442",
  sha256: "035dcba4955336ab1697c0c4eb842e8a7cc2feb75931793d6cdec634b5657b3d",
  name: "Terrarium Orchard Linux",
  identity: "alpine3.21.4-linux6.12.38-terrarium-s2-orchard-v1",
  hostname: "terrarium-orchard", kernel: "6.12.38-0-virt", variant: "orchard-v1",
});
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]"
    : "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";

async function streamIdentity(stream) {
  const digest = createHash("sha256"); let bytes = 0, peakChunkBytes = 0;
  for await (const chunk of stream) { bytes += chunk.length; peakChunkBytes = Math.max(peakChunkBytes, chunk.length); digest.update(chunk); }
  return { bytes, sha256: digest.digest("hex"), peakChunkBytes };
}
async function selectMachine(page, name) {
  await page.getByRole("button", { name: new RegExp("^Select " + escapeRegExp(name) + ",") }).click();
}
async function settings(page, name) {
  await selectMachine(page, name);
  await page.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Machine settings · ${name}`, exact: true });
  await dialog.waitFor({ state: "visible" }); return dialog;
}
async function closeSettings(dialog) { await dialog.getByRole("button", { name: "Close dialog", exact: true }).click(); await dialog.waitFor({ state: "hidden" }); }
async function record(page, id) { return page.evaluate(id => window.terrarium.cloud.instances.get(id), id); }
function definition(value) {
  return { id: value.id, name: value.name, imageId: value.imageId, machine: value.machine,
    memoryMiB: value.memoryMiB, vpcId: value.vpcId, subnetId: value.subnetId, ip: value.ip,
    volumeAttachments: value.volumeAttachments };
}
export async function checkpointUnavailable(page, id, name) {
  const expectedError = "RAM checkpoints require a qualified small preset with a built-in image and no external data disks or evidence. Larger/custom machines use persistent mounts.";
  const nonce = randomUUID(), sentinel = `/tmp/s2-checkpoint-${nonce}`;
  const observed = { kind: "internal-ui-action/runtime-guard", stage: "preparing", expectedError,
    route: "disabled New snapshot React onClick -> real Save modal -> normal Save in browser click -> perform -> runtime.save",
    adapter: { react: "19.3.1", reactDom: "19.3.1", testOnly: true,
      scope: "Invoke the exact existing disabled control callback once; never alter its props, disabled state, runtime or public bridge." },
    limits: { readinessMs: 20_000, commandMs: 60_000, uiStepMs: 20_000 }, workerChecks: [], downloadEvents: [] };
  const began = performance.now(); let beforeWorkers, onWorker, onDownload; const newWorkers = [];
  const ready = async () => {
    const began = performance.now();
    await page.waitForFunction(id => {
      const state = window.terrarium.get(id).status();
      return state.status === "running" && state.commandReady && state.controlReady === true && !state.commandBusy && !state.operation
        && !state.acquiringEvidence && !state.volumeOperation;
    }, id, { timeout: 20_000 });
    return Math.round(performance.now() - began);
  };
  const capture = () => page.evaluate(async ({ id, helperUrl }) => {
    const snapshots = (await (await import(helperUrl)).listSnapshots()).sort((a, b) => a.id.localeCompare(b.id));
    const instance = await window.terrarium.cloud.instances.get(id), vm = window.terrarium.get(id);
    return { snapshots, instance, state: vm.status(), initScript: vm.getInitScript(),
      publicBridgeMethods: Object.keys(vm).sort(), publicSaveType: typeof vm.save, publicSaveCheckpointType: typeof vm.saveCheckpoint };
  }, { id, helperUrl: HELPER_URL });
  const identity = value => ({ definition: definition(value.instance), initScript: value.initScript,
    policy: { networkMode: value.instance.networkMode, quarantined: value.instance.quarantined, ephemeral: value.instance.ephemeral },
    startedAt: value.state.startedAt, runtimeBundle: value.state.runtimeBundle, machineConfiguration: value.state.machineConfiguration,
    capabilities: value.state.capabilities, passiveRestore: value.state.passiveRestore ?? false,
    sourceCheckpointSha256: value.state.sourceCheckpointSha256 ?? null, evidenceAttachment: value.state.evidenceAttachment ?? null });
  const assertReady = value => {
    assert.equal(value.instance.id, id); assert.equal(value.instance.status, "running");
    assert.equal(value.instance.commandBusy, false); assert.equal(value.instance.operation, null);
    assert.equal(value.state.status, "running"); assert.equal(value.state.commandReady, true); assert.equal(value.state.controlReady, true);
    assert.equal(value.state.commandBusy, false); assert.equal(value.state.operation, null);
    assert.ok(!value.state.acquiringEvidence && !value.state.volumeOperation);
    assert.equal(value.state.capabilities.snapshots, false);
    assert.ok(Number.isFinite(value.state.startedAt) && value.state.startedAt > 0);
    assert.ok(typeof value.state.runtimeBundle?.activeBundleId === "string" && value.state.runtimeBundle.activeBundleId.length > 0);
    assert.deepEqual(value.state.machineConfiguration, value.instance.machine);
    assert.equal(value.publicSaveType, "undefined"); assert.equal(value.publicSaveCheckpointType, "undefined");
  };
  const guestProbe = async phase => {
    const script = phase === "BEFORE"
      ? `set -e; printf '%s\\n' '${nonce}' > ${sentinel}; printf 'S2_CHECKPOINT_BEFORE_BOOT_ID='; cat /proc/sys/kernel/random/boot_id; printf 'S2_CHECKPOINT_BEFORE_SENTINEL='; cat ${sentinel}; printf 'S2_CHECKPOINT_BEFORE_COMPLETE\\n'`
      : `set -e; test "$(cat ${sentinel})" = '${nonce}'; printf 'S2_CHECKPOINT_AFTER_BOOT_ID='; cat /proc/sys/kernel/random/boot_id; printf 'S2_CHECKPOINT_AFTER_SENTINEL='; cat ${sentinel}; rm ${sentinel}; printf 'S2_CHECKPOINT_GUEST_SURVIVED_REFUSAL\\n'`;
    assert.ok(Buffer.byteLength(script, "utf8") <= 8192);
    const readinessWaitMs = await ready();
    const result = await page.evaluate(async ({ id, script }) => window.terrarium.get(id).exec(script, { timeoutMs: 60_000 }), { id, script });
    // Submit each command once. A busy or other command error is a failure, not a retry.
    const entry = { script, readinessWaitMs, ...result }; observed[phase === "BEFORE" ? "guestBefore" : "guestAfter"] = entry;
    assert.equal(result.status, "exited", JSON.stringify(result)); assert.equal(result.exitCode, 0, JSON.stringify(result));
    const bootIds = [...result.output.matchAll(new RegExp(`^S2_CHECKPOINT_${phase}_BOOT_ID=([a-f0-9-]{36})\\r?$`, "gm"))];
    assert.equal(bootIds.length, 1, "The real guest must return one complete boot identity");
    assert.match(result.output, new RegExp(`^S2_CHECKPOINT_${phase}_SENTINEL=${nonce}\\r?$`, "m"));
    assert.match(result.output, new RegExp(`^${phase === "BEFORE" ? "S2_CHECKPOINT_BEFORE_COMPLETE" : "S2_CHECKPOINT_GUEST_SURVIVED_REFUSAL"}\\r?$`, "m"));
    entry.bootId = bootIds[0][1]; return entry.bootId;
  };
  const checkWorkers = label => {
    const current = page.workers(), unchangedWorkerObjects = current.length === beforeWorkers.length
      && beforeWorkers.every(worker => current.includes(worker));
    const entry = { label, beforeCount: beforeWorkers.length, afterCount: current.length,
      beforeUrls: beforeWorkers.map(worker => worker.url()), afterUrls: current.map(worker => worker.url()),
      createdDuringAttempt: newWorkers.map(worker => worker.url()), unchangedWorkerObjects,
      identityCheck: "Strict JavaScript Worker object references, with a separate creation listener; URLs retain multiplicity but are not identities." };
    observed.workerChecks.push(entry);
    assert.equal(newWorkers.length, 0, "Unsupported checkpoint attempts must create no Worker");
    assert.equal(unchangedWorkerObjects, true, "Unsupported checkpoint attempts must preserve the exact live Worker object set");
  };
  try {
    await selectMachine(page, name);
    observed.mainButtonDisabled = await page.getByRole("button", { name: "Snapshot", exact: true }).isDisabled();
    assert.equal(observed.mainButtonDisabled, true);
    await page.getByRole("button", { name: "Snapshots & evidence", exact: true }).first().click({ timeout: 20_000 });
    const newSnapshot = page.getByRole("button", { name: "New snapshot", exact: true });
    observed.newSnapshotButtonDisabled = await newSnapshot.isDisabled(); assert.equal(observed.newSnapshotButtonDisabled, true);
    const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true });
    if (await dismiss.count()) await dismiss.click({ timeout: 20_000 });
    const expectedAlert = new RegExp("^" + escapeRegExp(expectedError) + "$");
    assert.equal(await page.getByRole("alert").filter({ hasText: expectedAlert }).count(), 0, "A stale refusal must not satisfy this attempt");
    const dialog = page.getByRole("dialog", { name: `Save ${name}.`, exact: true });
    assert.equal(await dialog.count(), 0, "The internal action must open a new real save modal");
    const beforeBootId = await guestProbe("BEFORE");
    observed.beforeReadinessWaitMs = await ready(); observed.before = await capture(); assertReady(observed.before);
    observed.snapshots = observed.before.state.capabilities.snapshots; observed.publicBridgeMethods = observed.before.publicBridgeMethods;
    observed.publicCheckpointSave = { available: false, saveType: observed.before.publicSaveType,
      saveCheckpointType: observed.before.publicSaveCheckpointType, tested: "Absence only; no nonexistent public method is invoked." };
    beforeWorkers = page.workers(); assert.ok(beforeWorkers.length > 0, "The already running VM must own live Workers");
    onWorker = worker => newWorkers.push(worker); page.on("worker", onWorker);
    onDownload = download => observed.downloadEvents.push({ suggestedFilename: download.suggestedFilename().slice(0, 256), filenameLimit: 256 });
    page.on("download", onDownload);
    observed.stage = "opening-internal-ui-action";
    observed.adapter.invocation = await newSnapshot.evaluate(button => {
      if (!(button instanceof HTMLButtonElement) || button.disabled !== true || button.textContent.trim() !== "New snapshot")
        throw new Error("CHECKPOINT_UI_ADAPTER_MISMATCH: expected the exact disabled New snapshot button");
      const keys = Object.getOwnPropertyNames(button).filter(key => key.startsWith("__reactProps$"));
      if (keys.length !== 1) throw new Error("CHECKPOINT_UI_ADAPTER_MISMATCH: expected one own pinned React props key");
      const descriptor = Object.getOwnPropertyDescriptor(button, keys[0]);
      const props = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
      if (!props || props.disabled !== true || typeof props.onClick !== "function")
        throw new Error("CHECKPOINT_UI_ADAPTER_MISMATCH: expected the existing disabled props and onClick callback");
      props.onClick();
      return { invokedOnce: true, nativeDisabled: button.disabled, propsDisabled: props.disabled,
        adapter: "Own __reactProps$ data property; exact existing callback; no metadata or DOM mutation." };
    });
    assert.equal(observed.adapter.invocation.nativeDisabled, true); assert.equal(observed.adapter.invocation.propsDisabled, true);
    await dialog.waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await dialog.getByRole("alert").count(), 0, "The newly opened modal must not inherit a prior error");
    observed.attemptedTitle = `s2-unsupported-checkpoint-${nonce}`;
    await dialog.getByLabel("Snapshot name", { exact: true }).fill(observed.attemptedTitle, { timeout: 20_000 });
    observed.saveReadinessWaitMs = await ready();
    observed.stage = "normal-save-in-browser-click";
    await dialog.getByRole("button", { name: "Save in browser", exact: true }).click({ timeout: 20_000 });
    const alert = dialog.getByRole("alert").filter({ hasText: expectedAlert });
    await alert.waitFor({ state: "visible", timeout: 20_000 });
    observed.error = await alert.innerText(); assert.equal(observed.error, expectedError);
    observed.stage = "runtime-refusal-observed";
    observed.afterReadinessWaitMs = await ready(); observed.after = await capture(); assertReady(observed.after);
    assert.deepEqual(observed.after.snapshots, observed.before.snapshots, "A refused checkpoint must not create or replace a saved snapshot");
    assert.deepEqual(identity(observed.after), identity(observed.before), "Runtime, machine definition and network/quarantine policy must remain unchanged");
    assert.deepEqual(observed.after.publicBridgeMethods, observed.before.publicBridgeMethods);
    checkWorkers("after-runtime-refusal");
    assert.equal(observed.downloadEvents.length, 0, "A refused checkpoint must not produce a download");
    assert.equal(await dialog.getByRole("button", { name: "Save in browser", exact: true }).isEnabled(), true, "The failed action must release its UI busy state");
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click({ timeout: 20_000 });
    await dialog.waitFor({ state: "hidden", timeout: 20_000 }); observed.modalClosed = true;
    assert.equal(await newSnapshot.isDisabled(), true, "The UI capability guard must remain disabled after the internal attempt");
    assert.equal(await guestProbe("AFTER"), beforeBootId, "The refusal must preserve the actual guest boot identity and temporary sentinel");
    observed.finalReadinessWaitMs = await ready(); observed.final = await capture(); assertReady(observed.final);
    assert.deepEqual(observed.final.snapshots, observed.before.snapshots); assert.deepEqual(identity(observed.final), identity(observed.before));
    checkWorkers("after-survival-command");
    await selectMachine(page, name);
    assert.equal(await page.getByRole("button", { name: "Snapshot", exact: true }).isDisabled(), true);
    assert.equal(observed.downloadEvents.length, 0, "The guarded attempt and survival check must produce no download");
    observed.stage = "completed";
    observed.limitation = "Internal UI-action/runtime-guard evidence, not a public RAM API. The private callback adapter is pinned and fails closed. Actual snapshot metadata, stable configuration/policy/runtime identities, boot identity, sentinel and Worker ownership are checked; CPU/RAM bytes are not exported or compared. The temporary guest sentinel is an explicit fixture mutation, removed after readback. Supported small checkpoint execution is covered separately.";
    return observed;
  } catch (error) {
    observed.failure = { name: error.name, message: error.message };
    try { observed.afterFailure = await capture(); } catch (failure) { observed.afterFailure = { observationError: String(failure) }; }
    if (beforeWorkers) {
      const current = page.workers(); observed.workersAtFailure = { beforeCount: beforeWorkers.length, afterCount: current.length,
        newWorkerUrls: newWorkers.map(worker => worker.url()), unchangedWorkerObjects: current.length === beforeWorkers.length && beforeWorkers.every(worker => current.includes(worker)) };
    }
    error.browserEvidence = { ...(error.browserEvidence ?? {}), checkpoint: observed }; throw error;
  } finally {
    if (onWorker) page.off("worker", onWorker); if (onDownload) page.off("download", onDownload);
    observed.elapsedMs = Math.round(performance.now() - began);
  }
}

/** Build bounded negative files from the exact positive container. The tamper
 * changes one root byte; the incompatible manifest changes only architecture.
 * Files are temporary fixture inputs and are removed after the isolated case. */
async function negativeImages(imagePath, directory) {
  const source = await open(imagePath, "r"); let encoded, manifest, payloadOffset;
  try {
    const header = Buffer.alloc(12); assert.equal((await source.read(header, 0, 12, 0)).bytesRead, 12);
    assert.equal(header.subarray(0, 8).toString("ascii"), "TRMIMG01");
    const length = header.readUInt32LE(8); assert.ok(length >= 2 && length <= 65536);
    encoded = Buffer.alloc(length); assert.equal((await source.read(encoded, 0, length, 12)).bytesRead, length);
    assert.equal(hash(encoded), ORCHARD.id); manifest = JSON.parse(encoded.toString("utf8")); payloadOffset = 12 + length;
  } finally { await source.close(); }
  const tampered = join(directory, "orchard-tampered-root-byte.trmimg");
  await copyFile(imagePath, tampered);
  const offset = payloadOffset + manifest.components.kernel.bytes + manifest.components.initramfs.bytes + 4096;
  const destination = await open(tampered, "r+"); let originalByte;
  try {
    const byte = Buffer.alloc(1); assert.equal((await destination.read(byte, 0, 1, offset)).bytesRead, 1);
    originalByte = byte[0]; byte[0] ^= 1; assert.equal((await destination.write(byte, 0, 1, offset)).bytesWritten, 1);
  } finally { await destination.close(); }
  const incompatible = join(directory, "orchard-incompatible-aarch64.trmimg");
  const json = Buffer.from(canonical({ ...manifest, architecture: "aarch64" }));
  const header = Buffer.alloc(12); header.write("TRMIMG01"); header.writeUInt32LE(json.length, 8);
  await pipeline((async function* () {
    yield header; yield json;
    for await (const chunk of createReadStream(imagePath, { start: payloadOffset, highWaterMark: 1048576 })) yield chunk;
  })(), createWriteStream(incompatible));
  return [
    { path: tampered, kind: "tampered", expected: /rootfs SHA-256/, mutation: { offset, before: originalByte, after: originalByte ^ 1 }, ...await streamIdentity(createReadStream(tampered)) },
    { path: incompatible, kind: "incompatible", expected: /architecture.*x86_64/i, mutation: { architecture: "aarch64", componentsUnchanged: true }, ...await streamIdentity(createReadStream(incompatible)) },
  ];
}

export async function runImages(ctx) {
  const { run, fixtureContext, openApp, enableIsolation, createGuest, bootGuest, command, stopGuest, guestFailure, imagePath, root } = ctx;
  await run("S2-G3-custom-image-ui-and-live-state", "Import the pinned Orchard bundle through the native file input, assign an existing small machine, boot and read actual guest identity; reject tampered/incompatible files while preserving the running guest, then verify stopped dependency blocking, retained export bytes and explicit deletion", async () => {
    const test = await openApp(await fixtureContext()), observations = { steps: [] }; let id, directory;
    const step = async (name, task) => {
      const began = performance.now(), entry = { name, status: "running" }; observations.steps.push(entry);
      try { const result = await task(); entry.status = "completed"; return result; }
      catch (error) { entry.status = "failed"; throw error; }
      finally { entry.elapsedMs = Math.round(performance.now() - began); }
    };
    try {
      assert.ok(imagePath, "TERRARIUM_S2_IMAGE must identify the pinned real Orchard .trmimg input");
      observations.input = { path: imagePath, ...await streamIdentity(createReadStream(imagePath)) };
      assert.equal(observations.input.sha256, ORCHARD.sha256);
      await mkdir(join(root, ".cache"), { recursive: true }); directory = await mkdtemp(join(root, ".cache/s2-image-ui-"));
      const negatives = await negativeImages(imagePath, directory);
      observations.negativeFixtures = negatives.map(({ expected, ...fixture }) => ({ ...fixture, expectedError: expected.source }));
      observations.isolation = await enableIsolation(test.page);
      const name = "s2-orchard-import";
      observations.initial = await createGuest(test.page, "small", name); id = observations.initial.id;
      const beforeImport = definition(await record(test.page, id));
      let dialog = await settings(test.page, name);
      await step("native-file-import", async () => {
        await dialog.getByLabel("Import Linux image bundle", { exact: true }).setInputFiles(imagePath);
        await dialog.getByRole("button", { name: "Import image", exact: true }).click();
        await test.page.waitForFunction(async imageId => Boolean(await window.terrarium.cloud.machineImages.get(imageId)), ORCHARD.id, { timeout: 180000 });
        await dialog.getByRole("button", { name: "Import image", exact: true }).waitFor({ state: "hidden", timeout: 180000 });
      });
      observations.imported = await test.page.evaluate(imageId => window.terrarium.cloud.machineImages.get(imageId), ORCHARD.id);
      assert.equal(observations.imported.totalBytes, observations.input.bytes); assert.equal(observations.imported.manifest.guest.identity, ORCHARD.identity);
      assert.deepEqual(definition(await record(test.page, id)), beforeImport, "Saving an image must not silently replace an existing definition");
      await dialog.getByLabel("Boot image", { exact: true }).selectOption(ORCHARD.id);
      observations.selectedIdentityText = await dialog.getByLabel("Selected image identity", { exact: true }).innerText();
      for (const text of [ORCHARD.id, ORCHARD.name, ORCHARD.identity]) assert.ok(observations.selectedIdentityText.includes(text));
      assert.equal(await dialog.getByLabel("Guest hostname", { exact: true }).inputValue(), ORCHARD.hostname);
      assert.equal(await dialog.getByLabel("Guest hostname", { exact: true }).isDisabled(), true);
      await dialog.getByRole("button", { name: "Save machine configuration", exact: true }).click();
      await dialog.waitFor({ state: "hidden", timeout: 180000 });
      observations.assigned = await record(test.page, id);
      assert.deepEqual(observations.assigned.machine.image, { kind: "custom", id: ORCHARD.id });
      assert.equal(observations.assigned.machine.presetId, "small"); assert.equal(observations.assigned.memoryMiB, 512);
      assert.equal(observations.assigned.machine.nic.mac, observations.initial.machine.nic.mac);
      observations.boot = await step("real-custom-image-boot", () => bootGuest(test.page, id));
      assert.equal(observations.boot.status.status, "running"); assert.equal(observations.boot.status.commandReady, true);
      assert.match(observations.boot.status.message, /Terrarium Orchard Linux/);
      observations.identity = await command(test.page, id, `set -e; test "$(hostname)" = '${ORCHARD.hostname}'; test "$(uname -m)" = x86_64; test "$(uname -r)" = '${ORCHARD.kernel}'; test "$(cat /etc/terrarium-variant)" = '${ORCHARD.variant}'; printf 'S2_ORCHARD_IDENTITY_BEGIN\\n'; cat /etc/terrarium-image.json; printf '\\nS2_ORCHARD_IDENTITY_END\\n'; hostname; uname -a; printf 's2-live-image-marker\\n' > /tmp/s2-live-image-marker; cat /proc/sys/kernel/random/boot_id; printf 'S2_ORCHARD_EXECUTION_COMPLETE\\n'`);
      assert.match(observations.identity.output, /S2_ORCHARD_EXECUTION_COMPLETE/);
      const identityMatch = /S2_ORCHARD_IDENTITY_BEGIN\r?\n([\s\S]*?)\r?\nS2_ORCHARD_IDENTITY_END/.exec(observations.identity.output);
      assert.ok(identityMatch, "Actual guest command must emit complete delimited identity JSON");
      const guestIdentity = JSON.parse(identityMatch[1]);
      assert.equal(guestIdentity.image, ORCHARD.identity); assert.equal(guestIdentity.variant, ORCHARD.variant); assert.equal(guestIdentity.kernel, ORCHARD.kernel);
      observations.checkpoint = await checkpointUnavailable(test.page, id, name);
      observations.rejections = [];
      dialog = await settings(test.page, name);
      for (const fixture of negatives) {
        const before = definition(await record(test.page, id));
        const beforeIds = await test.page.evaluate(async () => (await window.terrarium.cloud.machineImages.list()).map(image => image.id).sort());
        const beforeBoot = await command(test.page, id, "set -e; cat /proc/sys/kernel/random/boot_id; cat /tmp/s2-live-image-marker");
        const began = performance.now();
        await dialog.getByLabel("Import Linux image bundle", { exact: true }).setInputFiles(fixture.path);
        await dialog.getByRole("button", { name: "Import image", exact: true }).click();
        const alert = dialog.getByRole("alert").filter({ hasText: fixture.expected });
        await alert.waitFor({ state: "visible", timeout: 180000 });
        const error = await alert.innerText(); assert.match(error, fixture.expected);
        const after = definition(await record(test.page, id));
        const afterIds = await test.page.evaluate(async () => (await window.terrarium.cloud.machineImages.list()).map(image => image.id).sort());
        assert.deepEqual(after, before); assert.deepEqual(afterIds, beforeIds);
        const afterBoot = await command(test.page, id, "set -e; cat /proc/sys/kernel/random/boot_id; cat /tmp/s2-live-image-marker");
        assert.equal(afterBoot.output, beforeBoot.output, "Invalid image import must preserve the same running guest and its ephemeral sentinel");
        assert.equal((await record(test.page, id)).status, "running");
        observations.rejections.push({ kind: fixture.kind, error, elapsedMs: Math.round(performance.now() - began), before, after, beforeIds, afterIds, beforeBoot, afterBoot });
        await dialog.getByRole("button", { name: "Clear file", exact: true }).click();
      }
      await closeSettings(dialog); await stopGuest(test.page, id);
      dialog = await settings(test.page, name);
      await dialog.getByRole("button", { name: `Delete ${ORCHARD.name}`, exact: true }).click();
      const blocked = test.page.getByRole("dialog", { name: "Delete machine image?", exact: true });
      await blocked.getByLabel("Deletion dependencies", { exact: true }).waitFor({ state: "visible" });
      observations.blockedDependencyText = await blocked.getByLabel("Deletion dependencies", { exact: true }).innerText();
      assert.ok(observations.blockedDependencyText.includes(name));
      assert.equal(await blocked.getByRole("button", { name: "Delete machine image", exact: true }).isDisabled(), true);
      observations.stoppedDeletion = await test.page.evaluate(async imageId => {
        const preview = await window.terrarium.cloud.deletions.preview({ type: "image", id: imageId }); let error;
        try { await window.terrarium.cloud.machineImages.delete(imageId, { ifSha256: imageId }).wait(); } catch (reason) { error = reason.message; }
        return { preview, error, retained: await window.terrarium.cloud.machineImages.get(imageId) };
      }, ORCHARD.id);
      assert.equal(observations.stoppedDeletion.preview.allowed, false); assert.ok(observations.stoppedDeletion.error);
      assert.equal(observations.stoppedDeletion.retained.id, ORCHARD.id);
      await blocked.getByRole("button", { name: "Cancel", exact: true }).click(); await blocked.waitFor({ state: "hidden" }); await closeSettings(dialog);
      await test.page.evaluate(async id => { await window.terrarium.cloud.instances.delete(id).wait(); }, id); id = null;
      observations.retainedAfterDefinitionDeletion = await test.page.evaluate(imageId => window.terrarium.cloud.machineImages.get(imageId), ORCHARD.id);
      assert.deepEqual(observations.retainedAfterDefinitionDeletion, observations.imported);
      const host = await createGuest(test.page, "small", "s2-image-library-host"); id = host.id;
      dialog = await settings(test.page, host.name);
      observations.export = await step("native-download-and-streaming-sha256", async () => {
        const waiting = test.page.waitForEvent("download", { timeout: 180000 });
        await dialog.getByRole("button", { name: `Export ${ORCHARD.name}`, exact: true }).click();
        const download = await waiting, stream = await download.createReadStream(); assert.ok(stream);
        const result = { filename: download.suggestedFilename(), ...await streamIdentity(stream), downloadFailure: await download.failure() };
        assert.equal(result.downloadFailure, null); assert.equal(result.sha256, ORCHARD.sha256); assert.equal(result.bytes, observations.input.bytes);
        assert.equal(result.filename, `${ORCHARD.identity}.trmimg`); return result;
      });
      await dialog.getByRole("button", { name: `Delete ${ORCHARD.name}`, exact: true }).click();
      const allowed = test.page.getByRole("dialog", { name: "Delete machine image?", exact: true });
      const deleteButton = allowed.getByRole("button", { name: "Delete machine image", exact: true });
      await deleteButton.click(); await allowed.waitFor({ state: "hidden" });
      await test.page.waitForFunction(async imageId => (await window.terrarium.cloud.machineImages.get(imageId)) === null, ORCHARD.id);
      observations.explicitDeletion = { imageMissing: true, independentHostDefinition: definition(await record(test.page, id)) };
      assert.equal(observations.explicitDeletion.independentHostDefinition.machine.image.kind, "builtin");
      await closeSettings(dialog);
      await test.page.evaluate(async id => { await window.terrarium.cloud.instances.delete(id).wait(); }, id); id = null;
      assert.equal(test.page.workers().length, 0); assert.deepEqual(test.observations.pageErrors, []);
      observations.browser = test.observations; observations.temporaryFixtureCleanup = "Negative fixtures are deleted in finally; their exact mutation and SHA identities remain in this report.";
      return observations;
    } catch (error) { return await guestFailure(test.page, id, observations, error); }
    finally { await test.close(); if (directory) await rm(directory, { recursive: true, force: true }); }
  });
}

async function rejectedPatch(page, id, patch, expected, compareManifest = true) {
  const result = await page.evaluate(async ({ id, patch, compareManifest }) => {
    const before = await window.terrarium.cloud.instances.get(id), manifestBefore = compareManifest ? window.terrarium.workspace.exportManifest() : null;
    let error;
    try { await window.terrarium.cloud.instances.update(id, patch).wait(); } catch (reason) { error = reason.message; }
    return { before, after: await window.terrarium.cloud.instances.get(id), error,
      manifestBefore, manifestAfter: compareManifest ? window.terrarium.workspace.exportManifest() : null };
  }, { id, patch, compareManifest });
  assert.ok(result.error, "Invalid or busy configuration must reject"); assert.match(result.error, expected);
  assert.deepEqual(definition(result.after), definition(result.before), "Rejected multi-field update must not partially rename or reconfigure a machine");
  if (compareManifest) assert.equal(result.manifestAfter, result.manifestBefore, "Rejected update must preserve the last committed workspace manifest exactly");
  return result;
}

export async function runUi(ctx) {
  const { run, fixtureContext, openApp, ready, server, enableIsolation, bootGuest, command, stopGuest, guestFailure } = ctx;
  await run("S2-G6-machine-settings-ui-api-parity", "Save stopped small-to-worker and worker-to-server hardware through the real UI; verify API/configuration/NIC/reopen parity, actual worker execution, atomic malformed/duplicate/busy refusals, explicit World switches, disabled worker checkpoints and cleanup", async () => {
    const test = await openApp(await fixtureContext()), observations = {}; let id;
    try {
      observations.isolation = await enableIsolation(test.page);
      // Do not use createGuest(): that helper explicitly opts into local networking.
      observations.initial = await test.page.evaluate(async helperUrl => {
        const helper = await import(helperUrl), machine = helper.defaultX86MachineConfiguration({ presetId: "small" });
        return window.terrarium.cloud.instances.create({ name: "s2-ui-small", imageId: "alpine-x86_64", machine }).wait();
      }, HELPER_URL); id = observations.initial.id;
      assert.equal(observations.initial.networkMode, "isolated");
      let dialog = await settings(test.page, observations.initial.name);
      const manifestBeforeInvalidUi = await test.page.evaluate(() => window.terrarium.workspace.exportManifest());
      await dialog.getByLabel("Guest hostname", { exact: true }).fill("Invalid Host!");
      await dialog.getByRole("alert").filter({ hasText: /lowercase hostname/ }).waitFor({ state: "visible" });
      assert.equal(await dialog.getByRole("button", { name: "Save machine configuration", exact: true }).isDisabled(), true);
      assert.equal(await test.page.evaluate(() => window.terrarium.workspace.exportManifest()), manifestBeforeInvalidUi);
      observations.invalidUi = { hostname: "Invalid Host!", error: await dialog.getByRole("alert").filter({ hasText: /lowercase hostname/ }).innerText(), saveDisabled: true, manifestUnchanged: true };
      await dialog.getByLabel("Guest hostname", { exact: true }).fill("s2-ui-worker");
      await dialog.getByLabel("x86_64 preset", { exact: true }).selectOption("worker");
      await dialog.getByLabel("Name", { exact: true }).fill("s2-ui-worker");
      const macInUi = await dialog.getByLabel("Stable NIC address", { exact: true }).inputValue();
      assert.equal(macInUi, observations.initial.machine.nic.mac);
      await dialog.getByRole("button", { name: "Save machine configuration", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
      observations.saved = await record(test.page, id);
      const expected = await test.page.evaluate(async ({ helperUrl, mac }) => (await import(helperUrl)).defaultX86MachineConfiguration({ presetId: "worker", mac, hostname: "s2-ui-worker" }), { helperUrl: HELPER_URL, mac: macInUi });
      assert.deepEqual(observations.saved.machine, expected); assert.equal(observations.saved.name, "s2-ui-worker");
      assert.equal(observations.saved.memoryMiB, 1024); assert.equal(observations.saved.networkMode, "isolated");
      await test.page.close(); test.page = await test.newPage(); await test.page.goto(server.origin, { waitUntil: "networkidle" }); await ready(test.page);
      observations.reopened = await record(test.page, id);
      assert.deepEqual(definition(observations.reopened), definition(observations.saved)); assert.equal(observations.reopened.status, "idle");
      assert.equal(observations.reopened.networkMode, "isolated"); assert.equal(test.page.workers().length, 0);
      dialog = await settings(test.page, observations.saved.name);
      assert.equal(await dialog.getByLabel("x86_64 preset", { exact: true }).inputValue(), "worker");
      assert.equal(await dialog.getByLabel("Guest hostname", { exact: true }).inputValue(), "s2-ui-worker");
      assert.equal(await dialog.getByLabel("Stable NIC address", { exact: true }).inputValue(), macInUi);
      await closeSettings(dialog);
      observations.negativeSettings = [];
      for (const [kind, invalid, expectedError] of [
        ["unknown-field", { ...expected, arbitraryEmulatorArgument: "-unsafe" }, /missing|unknown|executable/],
        ["unsupported-preset", { ...expected, presetId: "unbounded" }, /Unsupported/],
        ["invalid-hostname", { ...expected, kernelSettings: { hostname: "Invalid Host!" } }, /lowercase hostname/],
      ]) observations.negativeSettings.push({ kind, ...await rejectedPatch(test.page, id, { name: "must-not-rename", machine: invalid }, expectedError) });
      observations.peer = await test.page.evaluate(async helperUrl => {
        const helper = await import(helperUrl), machine = helper.defaultX86MachineConfiguration({ presetId: "small" });
        return window.terrarium.cloud.instances.create({ name: "s2-ui-peer", imageId: "alpine-x86_64", machine }).wait();
      }, HELPER_URL);
      observations.negativeSettings.push({ kind: "duplicate-NIC", ...await rejectedPatch(test.page, id,
        { name: "must-not-rename", machine: { ...expected, nic: observations.peer.machine.nic } }, /MAC|NIC|address|identity/i) });
      observations.negativeSettings.push({ kind: "duplicate-name", ...await rejectedPatch(test.page, id,
        { name: observations.peer.name, machine: { ...expected, kernelSettings: { hostname: "must-not-change" } } }, /name|already/i) });
      await selectMachine(test.page, observations.saved.name);
      const vpc = test.page.getByRole("switch", { name: `${observations.saved.name} VPC network`, exact: true });
      const outside = test.page.getByRole("switch", { name: `${observations.saved.name} outside access`, exact: true });
      assert.equal(await vpc.getAttribute("aria-checked"), "false"); assert.equal(await outside.getAttribute("aria-checked"), "false"); assert.equal(await outside.isDisabled(), true);
      await vpc.click(); await test.page.waitForFunction(async id => (await window.terrarium.cloud.instances.get(id)).networkMode === "local", id);
      await outside.click(); await test.page.waitForFunction(async id => (await window.terrarium.cloud.instances.get(id)).networkMode === "world", id);
      observations.worldAccess = { defaultMode: observations.initial.networkMode, outsideDisabledWhenIsolated: true, afterExplicitSwitches: (await record(test.page, id)).networkMode,
        scope: "Only explicit UI permission transitions are checked; no outside request is sent and internet reachability is not claimed." };
      await outside.click(); await test.page.waitForFunction(async id => (await window.terrarium.cloud.instances.get(id)).networkMode === "local", id);
      await vpc.click(); await test.page.waitForFunction(async id => (await window.terrarium.cloud.instances.get(id)).networkMode === "isolated", id);
      observations.boot = await bootGuest(test.page, id); assert.equal(observations.boot.status.status, "running");
      assert.equal(observations.boot.status.resourceObservation.configuredGuestMemoryMiB, 1024);
      observations.actualWorker = await command(test.page, id, "set -e; test \"$(hostname)\" = s2-ui-worker; hostname; uname -m; grep '^MemTotal:' /proc/meminfo; printf 'S2_UI_WORKER_EXECUTED\\n'");
      assert.match(observations.actualWorker.output, /S2_UI_WORKER_EXECUTED/);
      const busyReadinessStarted = performance.now();
      // Submit the deliberate busy operation once, after the same bounded
      // shared-channel readiness used by ordinary acceptance commands.
      await test.page.waitForFunction(id => {
        const state = window.terrarium.get(id).status();
        return state.status === "running" && state.commandReady && state.controlReady && !state.commandBusy;
      }, id, { timeout: 20_000 });
      observations.busySubmissionReadinessWaitMs = Math.round(performance.now() - busyReadinessStarted);
      await test.page.evaluate(id => {
        window.__s2UiBusy = { settled: false, result: null, error: null };
        void window.terrarium.get(id).exec("sleep 15; printf 'S2_UI_BUSY_COMMAND_COMPLETE\\n'", { timeoutMs: 45000 }).then(result => { window.__s2UiBusy.result = result; }, error => { window.__s2UiBusy.error = error.message; }).finally(() => { window.__s2UiBusy.settled = true; });
      }, id);
      await test.page.waitForFunction(async id => Boolean((await window.terrarium.cloud.instances.get(id)).commandBusy), id);
      dialog = await settings(test.page, observations.saved.name);
      for (const label of ["x86_64 preset", "Boot image", "Guest hostname", "Name"]) assert.equal(await dialog.getByLabel(label, { exact: true }).isDisabled(), true);
      assert.equal(await dialog.getByRole("button", { name: "Save machine configuration", exact: true }).isDisabled(), true);
      observations.busyRefusal = await rejectedPatch(test.page, id, { name: "must-not-rename", machine: expected }, /stop|idle|busy|finish|running/i, false);
      assert.equal(observations.busyRefusal.before.commandBusy, true, "The refusal must be exercised during the actual outstanding guest command");
      await closeSettings(dialog);
      await test.page.waitForFunction(() => window.__s2UiBusy.settled, null, { timeout: 60000 });
      observations.busyCommand = await test.page.evaluate(() => { const result = window.__s2UiBusy; delete window.__s2UiBusy; return result; });
      assert.equal(observations.busyCommand.error, null); assert.equal(observations.busyCommand.result.status, "exited"); assert.equal(observations.busyCommand.result.exitCode, 0);
      assert.match(observations.busyCommand.result.output, /S2_UI_BUSY_COMMAND_COMPLETE/);
      observations.runningRefusal = await rejectedPatch(test.page, id, { name: "must-not-rename", machine: expected }, /stop|idle|busy|finish|running/i, false);
      observations.checkpoint = await checkpointUnavailable(test.page, id, observations.saved.name);
      observations.afterRefusals = await command(test.page, id, "set -e; test \"$(hostname)\" = s2-ui-worker; printf 'S2_UI_GUEST_SURVIVED_REFUSALS\\n'");
      assert.match(observations.afterRefusals.output, /S2_UI_GUEST_SURVIVED_REFUSALS/);
      await stopGuest(test.page, id);
      // This is a persisted settings/UI check. Actual server execution, SMP,
      // usable RAM and checkpoint-control denial belong to the presets mode.
      dialog = await settings(test.page, observations.saved.name);
      await dialog.getByLabel("x86_64 preset", { exact: true }).selectOption("server");
      await dialog.getByLabel("Name", { exact: true }).fill("s2-ui-server");
      await dialog.getByLabel("Guest hostname", { exact: true }).fill("s2-ui-server");
      assert.equal(await dialog.getByLabel("Stable NIC address", { exact: true }).inputValue(), macInUi);
      await dialog.getByRole("button", { name: "Save machine configuration", exact: true }).click(); await dialog.waitFor({ state: "hidden" });
      const expectedServer = await test.page.evaluate(async ({ helperUrl, mac }) => (await import(helperUrl)).defaultX86MachineConfiguration({ presetId: "server", mac, hostname: "s2-ui-server" }), { helperUrl: HELPER_URL, mac: macInUi });
      observations.serverSettings = { saved: await record(test.page, id), expected: expectedServer,
        scope: "Stopped server UI/API settings and durable reopen only; actual server boot/SMP/RAM evidence is recorded by the separate presets mode." };
      assert.deepEqual(observations.serverSettings.saved.machine, expectedServer);
      assert.equal(observations.serverSettings.saved.name, "s2-ui-server");
      assert.equal(observations.serverSettings.saved.memoryMiB, 2048);
      assert.equal(observations.serverSettings.saved.machine.nic.mac, macInUi);
      assert.equal(observations.serverSettings.saved.status, "idle");
      assert.equal(observations.serverSettings.saved.networkMode, "isolated");
      assert.equal(test.page.workers().length, 0);
      await test.page.close(); test.page = await test.newPage(); await test.page.goto(server.origin, { waitUntil: "networkidle" }); await ready(test.page);
      observations.serverSettings.reopened = await record(test.page, id);
      assert.deepEqual(definition(observations.serverSettings.reopened), definition(observations.serverSettings.saved));
      assert.equal(observations.serverSettings.reopened.status, "idle");
      assert.equal(observations.serverSettings.reopened.networkMode, "isolated");
      assert.equal(test.page.workers().length, 0);
      dialog = await settings(test.page, "s2-ui-server");
      assert.equal(await dialog.getByLabel("x86_64 preset", { exact: true }).inputValue(), "server");
      assert.equal(await dialog.getByLabel("Guest hostname", { exact: true }).inputValue(), "s2-ui-server");
      assert.equal(await dialog.getByLabel("Stable NIC address", { exact: true }).inputValue(), macInUi);
      await closeSettings(dialog);
      observations.cleanup = await test.page.evaluate(async ({ id, peerId }) => {
        const retained = window.terrarium.get(id);
        await window.terrarium.cloud.instances.delete(peerId).wait(); await window.terrarium.cloud.instances.delete(id).wait();
        let revoked; try { retained.status(); } catch (error) { revoked = error.message; }
        return { retainedHandleError: revoked, remainingIds: (await window.terrarium.cloud.instances.list()).map(instance => instance.id) };
      }, { id, peerId: observations.peer.id });
      assert.ok(observations.cleanup.retainedHandleError); assert.ok(!observations.cleanup.remainingIds.includes(id)); assert.ok(!observations.cleanup.remainingIds.includes(observations.peer.id)); id = null;
      assert.equal(test.page.workers().length, 0); assert.deepEqual(test.observations.pageErrors, []); observations.browser = test.observations;
      return observations;
    } catch (error) { return await guestFailure(test.page, id, observations, error); }
    finally { await test.close(); }
  });
}
