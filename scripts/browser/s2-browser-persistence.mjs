// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
const hash = value => createHash("sha256").update(value).digest("hex");

export async function runPersistence({ run, fixtureContext, openApp, ready, enableIsolation, createGuest, bootGuest, command, executeGuestCommand, stopGuest, guestFailure, server }) {
  await run("S2-G4-browser-disk-durability", "Use an8GiB sparse disk with real guest high-offset blockI/O; preserve exact text/binary data across clean stop,pageclose,one same-profile browser restart,and independent boot; separately observe an abrupt page close", async () => {
    const test = await openApp(await fixtureContext()), observations = {}; let id, primaryError;
    const binary = Buffer.from(Array.from({ length: 16384 }, (_, index) => (index * 73 + (index >>> 5)) & 255));
    const text = Buffer.from("Terrarium persistent text: åäö café 雪 ☘\nsecond exact line\n", "utf8");
    const binarySha = hash(binary), markerSha = hash(binary.subarray(0, 4096));
    const offsets = [4 * 1073741824 + 64 * 1048576, 7 * 1073741824 + 64 * 1048576];
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const checkFiles = `set -e; printf 'S2_TEXT_BEGIN\\n'; cat /mnt/volumes/disk0/terrarium/applications/reference/exact.txt; printf 'S2_TEXT_END\\n'; sha256sum /mnt/volumes/disk0/terrarium/applications/reference/exact.txt; test "$(wc -c < /mnt/volumes/disk0/terrarium/applications/reference/exact.txt)" -eq ${text.length}; sha256sum /mnt/volumes/disk0/terrarium/applications/reference/exact.bin; test "$(wc -c < /mnt/volumes/disk0/terrarium/applications/reference/exact.bin)" -eq ${binary.length}; for _trm_dir in containerd k3s kubelet; do test "$(cat /mnt/volumes/disk0/terrarium/$_trm_dir/policy-marker)" = 'persistent-mount-policy'; done; printf 'S2_FILES_VERIFIED\\n'`;
    const checkMarkers = "set -e; " + offsets.map(offset => `_trm_digest=$(dd if=/dev/terrarium-volume0 bs=4096 count=1 skip=${offset / 4096} 2>/dev/null | sha256sum); test "\${_trm_digest%% *}" = ${markerSha}; printf 'S2_HIGH_OFFSET_VERIFIED offset=${offset} sha256=%s\\n' "\${_trm_digest%% *}"`).join("; ");
    const readHostMarkers = async () => test.page.evaluate(async ({ volumeId, offsets }) => {
      const helper = await import("/__browser-fixtures/acceptance/s2-browser-helper.js"), disk = await helper.openVolume(volumeId, { readOnly: true });
      try {
        const ranges = [];
        for (const offset of offsets) { const bytes = await disk.read(offset, 4096); const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join(""); ranges.push({ offset, bytes: bytes.length, sha256: digest }); }
        return { ranges, metadata: await helper.getVolume(volumeId), cache: disk.getStorageStats() };
      } finally { await disk.close(); }
    }, { volumeId: observations.volume.id, offsets });
    const assertMarkers = result => { assert.equal(result.ranges.length, offsets.length); assert.ok(result.ranges.every(range => range.sha256 === markerSha)); };
    const mounted = async expected => {
      const result = await command(test.page, id, "set -e; awk '$2 == \"/mnt/volumes/disk0\" { print \"S2_MOUNT\", $1, $2, $3, $4; found=1 } END { if (!found) exit 1 }' /proc/mounts");
      const match = /^S2_MOUNT\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/m.exec(result.output); assert.ok(match);
      const flags = match[4].split(","); assert.equal(match[3], "ext2"); for (const flag of expected) assert.ok(flags.includes(flag), `Expected actual mount option ${flag}`);
      return { ...result, device: match[1], path: match[2], filesystem: match[3], flags };
    };
    try {
      observations.isolation = await enableIsolation(test.page);
      observations.initialInstances = await test.page.evaluate(() => window.terrarium.cloud.instances.list());
      observations.expected = { textUtf8: text.toString("utf8"), textSha256: hash(text), binaryBytes: binary.length, binarySha256: binarySha, rawMarkerSha256: markerSha, rawMarkerOffsets: offsets };
      observations.volume = await test.page.evaluate(async () => window.terrarium.cloud.volumes.create({ name: "s2-durable-8gib", sizeMiB: 8192 }).wait());
      observations.source = await createGuest(test.page, "small", "s2-persistence-source"); id = observations.source.id;
      await test.page.evaluate(async ({ id, volumeId }) => { await window.terrarium.cloud.instances.attachVolume(id, { volumeId, slot: 0 }).wait(); }, { id, volumeId: observations.volume.id });
      observations.boot = await bootGuest(test.page, id); assert.equal(observations.boot.status.status, "running");
      observations.bootWorkers = await test.workerLifecycle.captureLive(test.page, "source-guest-running");
      observations.initialMount = await mounted(["rw", "sync"]);
      observations.prepare = await command(test.page, id, `set -e; test "$(blockdev --getsize64 /dev/terrarium-volume0)" = 8589934592; df -k /mnt/volumes/disk0; mkdir -p /mnt/volumes/disk0/terrarium/applications/reference; for _trm_dir in containerd k3s kubelet; do mkdir -p /mnt/volumes/disk0/terrarium/$_trm_dir; printf 'persistent-mount-policy\\n' > /mnt/volumes/disk0/terrarium/$_trm_dir/policy-marker; done; printf '%s' ${quote(text.toString("base64"))} | base64 -d > /mnt/volumes/disk0/terrarium/applications/reference/exact.txt; : > /mnt/volumes/disk0/terrarium/applications/reference/exact.bin; printf 'ephemeral root marker\\n' > /root/s2-ephemeral`);
      observations.binaryTransfer = [];
      for (let at = 0; at < binary.length; at += 4096) {
        const chunk = binary.subarray(at, at + 4096), script = `set -e; printf '%s' ${quote(chunk.toString("base64"))} | base64 -d >> /mnt/volumes/disk0/terrarium/applications/reference/exact.bin; test "$(wc -c < /mnt/volumes/disk0/terrarium/applications/reference/exact.bin)" -eq ${at + chunk.length}`;
        const commandBytes = Buffer.byteLength(script, "utf8"); assert.ok(commandBytes <= 8192, "Fixture transport must fit the unchanged production command budget");
        observations.binaryTransfer.push({ offset: at, bytes: chunk.length, sha256: hash(chunk), commandBytes, result: await command(test.page, id, script) });
      }
      observations.write = await command(test.page, id, `set -e; ${offsets.map(offset => `dd if=/mnt/volumes/disk0/terrarium/applications/reference/exact.bin of=/dev/terrarium-volume0 bs=4096 count=1 seek=${offset / 4096} conv=notrunc; dd if=/dev/terrarium-volume0 bs=4096 count=1 skip=${offset / 4096} | sha256sum;`).join(" ")} sync; printf 'S2_GUEST_HIGH_OFFSET_WRITE_COMPLETE\\n'`);
      assert.equal(observations.write.output.split(markerSha).length - 1, offsets.length);
      observations.checkBeforeStop = await command(test.page, id, checkFiles);
      assert.ok(observations.checkBeforeStop.output.includes(text.toString("utf8"))); assert.match(observations.checkBeforeStop.output, new RegExp(hash(text))); assert.match(observations.checkBeforeStop.output, new RegExp(binarySha));
      observations.deletionWhileAttached = await test.page.evaluate(async volumeId => {
        const inspection = await window.terrarium.cloud.deletions.preview({ type: "volume", id: volumeId }); let rejection;
        try { await window.terrarium.cloud.volumes.delete(volumeId).wait(); } catch (error) { rejection = error.message; }
        return { inspection, rejection };
      }, observations.volume.id);
      assert.equal(observations.deletionWhileAttached.inspection.allowed, false); assert.ok(observations.deletionWhileAttached.rejection);
      observations.beforeCleanStopWorkers = await test.workerLifecycle.captureLive(test.page, "source-guest-before-clean-stop");
      observations.cleanStopWorkerProof = await stopGuest(test.page, id);
      observations.stoppedReference = await test.page.evaluate(volumeId => window.terrarium.cloud.deletions.preview({ type: "volume", id: volumeId }), observations.volume.id);
      assert.equal(observations.stoppedReference.allowed, false, "A stopped definition still owns its disk reference");
      observations.hostReadback = await readHostMarkers(); assertMarkers(observations.hostReadback);
      await test.page.evaluate(async id => { await window.terrarium.cloud.instances.delete(id).wait(); }, id); id = null;
      observations.instancesAfterSourceDeletion = await test.page.evaluate(() => window.terrarium.cloud.instances.list());
      assert.ok(!observations.instancesAfterSourceDeletion.some(instance => instance.id === observations.source.id),
        "The deleted source guest must be absent before page close");
      assert.deepEqual(observations.instancesAfterSourceDeletion, observations.initialInstances,
        "Deleting the fixture guest must preserve the exact initial instance inventory");
      const cleanOwner = test.page;
      observations.cleanPageClose = await test.workerLifecycle.closePage(test.page, "clean-source-page-close");
      test.page = await test.newPage(); await test.page.goto(server.origin, { waitUntil: "networkidle" });
      observations.cleanReopenReadiness = await ready(test.page, { closedOwner: cleanOwner });
      observations.retainedAfterClose = await test.page.evaluate(volumeId => window.terrarium.cloud.volumes.get(volumeId), observations.volume.id);
      assert.equal(observations.retainedAfterClose.id, observations.volume.id);
      assert.equal(typeof test.restartBrowser, "function", "G4 requires a persistent-profile browser restart");
      observations.browserRestart = await test.restartBrowser();
      await test.page.goto(server.origin, { waitUntil: "networkidle" }); await ready(test.page);
      observations.isolationAfterBrowserRestart = await enableIsolation(test.page);
      observations.retainedAfterBrowserRestart = await test.page.evaluate(async volumeId => ({
        volume: await window.terrarium.cloud.volumes.get(volumeId), workspace: window.terrarium.workspace.status(),
        instances: await window.terrarium.cloud.instances.list(),
      }), observations.volume.id);
      assert.deepEqual(observations.retainedAfterBrowserRestart.volume, observations.retainedAfterClose,
        "The saved volume metadata must survive the actual same-profile browser restart unchanged");
      assert.equal(observations.retainedAfterBrowserRestart.workspace.mode, "writable");
      assert.ok(!observations.retainedAfterBrowserRestart.instances.some(instance => instance.id === observations.source.id),
        "Browser restart must not resurrect the deleted source guest");
      assert.deepEqual(observations.retainedAfterBrowserRestart.instances, observations.initialInstances,
        "The browser restart must preserve the exact initial instance inventory");
      assert.equal(test.page.workers().length, 0);
      observations.hostReadbackAfterBrowserRestart = await readHostMarkers(); assertMarkers(observations.hostReadbackAfterBrowserRestart);
      observations.independent = await createGuest(test.page, "small", "s2-independent-reader"); id = observations.independent.id;
      assert.notEqual(id, observations.source.id); assert.notEqual(observations.independent.machine.nic.mac, observations.source.machine.nic.mac);
      await test.page.evaluate(async ({ id, volumeId }) => { await window.terrarium.cloud.instances.attachVolume(id, { volumeId, slot: 0 }).wait(); }, { id, volumeId: observations.volume.id });
      observations.independentBoot = await bootGuest(test.page, id); assert.equal(observations.independentBoot.status.status, "running");
      observations.independentBootWorkers = await test.workerLifecycle.captureLive(test.page, "independent-guest-running");
      observations.independentMount = await mounted(["rw", "sync"]);
      observations.independentHighOffsets = await command(test.page, id, checkMarkers);
      observations.independentFiles = await command(test.page, id, checkFiles + "; test ! -e /root/s2-ephemeral; printf 'S2_EPHEMERAL_ROOT_RESET_COMPLETE\\n'");
      assert.ok(observations.independentFiles.output.includes(text.toString("utf8"))); assert.match(observations.independentFiles.output, new RegExp(hash(text))); assert.match(observations.independentFiles.output, new RegExp(binarySha));
      assert.match(observations.independentFiles.output, /S2_EPHEMERAL_ROOT_RESET_COMPLETE/);
      observations.anchorWrite = await command(test.page, id, "set -e; printf 'committed-before-abrupt-close\\n' > /mnt/volumes/disk0/terrarium/applications/reference/anchor.txt; sync");
      observations.anchorCommitted = await test.page.evaluate(async id => window.terrarium.cloud.instances.syncVolumes(id).wait(), id);
      // No additional explicit sync follows these writes. The actual mount is
      // synchronous; do not describe an acknowledged write as unsent dirty data.
      observations.unsyncedWrite = await command(test.page, id, "set -e; printf 'unsynced-close-observation\\n' > /mnt/volumes/disk0/terrarium/applications/reference/unsynced.txt; printf 'S2_UNSYNCED_GUEST_COMMAND_COMPLETED\\n'");
      const writer = ["#!/bin/sh", "set -eu", "i=0", "while [ \"$i\" -lt 16 ]; do",
        "  printf 'writing %s\\n' \"$i\" > /tmp/s2-abrupt-phase",
        "  cat /tmp/s2-abrupt-payload >> /mnt/volumes/disk0/terrarium/applications/reference/inflight.bin",
        "  i=$((i+1))", "  printf 'completed %s\\n' \"$i\" > /tmp/s2-abrupt-phase", "  sleep 1", "done",
        "printf 'complete\\n' > /tmp/s2-abrupt-complete", ""].join("\n");
      observations.backgroundStart = await command(test.page, id, `set -e; cat /mnt/volumes/disk0/terrarium/applications/reference/exact.bin /mnt/volumes/disk0/terrarium/applications/reference/exact.bin /mnt/volumes/disk0/terrarium/applications/reference/exact.bin /mnt/volumes/disk0/terrarium/applications/reference/exact.bin > /tmp/s2-abrupt-payload; test "$(wc -c < /tmp/s2-abrupt-payload)" -eq 65536; printf '%s' ${quote(writer)} > /tmp/s2-abrupt-writer.sh; printf 'pending\\n' > /tmp/s2-abrupt-phase; sh /tmp/s2-abrupt-writer.sh </dev/null >/tmp/s2-abrupt-writer.log 2>&1 & _trm_writer=$!; printf '%s\\n' "$_trm_writer" > /tmp/s2-abrupt-writer.pid; printf 'S2_BOUNDED_WRITER_STARTED pid=%s iterations=16 chunk_bytes=65536 interval_seconds=1\\n' "$_trm_writer"`);
      observations.backgroundRunning = await command(test.page, id, "set -e; _trm_writer=$(cat /tmp/s2-abrupt-writer.pid); kill -0 \"$_trm_writer\"; test ! -e /tmp/s2-abrupt-complete; printf 'S2_WRITER_RUNNING pid=%s phase=' \"$_trm_writer\"; cat /tmp/s2-abrupt-phase; printf 'S2_WRITER_PENDING_AT_OBSERVATION\\n'");
      assert.match(observations.backgroundRunning.output, /S2_WRITER_PENDING_AT_OBSERVATION/);
      observations.pendingHostIo = await test.page.evaluate(async id => {
        const began = performance.now(); let samples = 0, peakPendingWrites = 0, volumes = [];
        while (performance.now() - began < 3500) {
          volumes = window.terrarium.get(id).status().volumes ?? []; samples++;
          peakPendingWrites = Math.max(peakPendingWrites, ...volumes.map(volume => volume.pendingWrites ?? 0));
          if (peakPendingWrites > 0) break;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return { samples, elapsedMs: Math.round(performance.now() - began), peakPendingWrites, pendingObserved: peakPendingWrites > 0, volumes };
      }, id);
      observations.abrupt = { mechanism: "close the page with an independently observed running bounded guest writer; no additional explicit sync, graceful stop or host flush", mountFlags: observations.independentMount.flags,
        writer: { maximumIterations: 16, chunkBytes: 65536, maximumFileBytes: 1048576, intervalSeconds: 1, script: writer },
        hostPendingRequestObserved: observations.pendingHostIo.pendingObserved,
        dirtyWriteGuarantee: "The mount uses rw,sync. An active guest writer is verified; sampled host pending I/O is reported separately. Neither sampling nor page-close timing proves a particular transaction was interrupted, and unsent guest cache is not promised." };
      const abruptWorkerDeadline = performance.now() + 10_000;
      observations.beforeAbruptCloseWorkers = await test.workerLifecycle.captureLive(test.page, "independent-writer-before-abrupt-close", { deadline: abruptWorkerDeadline });
      const abruptOwner = test.page;
      observations.abruptPageClose = await test.workerLifecycle.closePage(test.page, "abrupt-writer-page-close", { deadline: abruptWorkerDeadline });
      test.page = await test.newPage(); await test.page.goto(server.origin, { waitUntil: "networkidle" });
      observations.abruptReopenReadiness = await ready(test.page, { closedOwner: abruptOwner });
      observations.afterAbrupt = await test.page.evaluate(async id => ({ workspace: window.terrarium.workspace.status(), instance: await window.terrarium.cloud.instances.get(id), state: window.terrarium.get(id).status() }), id);
      assert.equal(observations.afterAbrupt.instance.status, "idle"); assert.equal(test.page.workers().length, 0);
      assert.ok(observations.afterAbrupt.workspace.recovery.some(item => item.id === id));
      await test.page.evaluate(async ({ id, volumeId }) => {
        await window.terrarium.cloud.instances.detachVolume(id, volumeId).wait();
        await window.terrarium.cloud.instances.attachVolume(id, { volumeId, slot: 0, readOnly: true }).wait();
      }, { id, volumeId: observations.volume.id });
      observations.recoveryBoot = await bootGuest(test.page, id); assert.equal(observations.recoveryBoot.status.status, "running");
      observations.recoveryBootWorkers = await test.workerLifecycle.captureLive(test.page, "read-only-recovery-guest-running");
      observations.recoveryMount = await mounted(["ro"]);
      observations.recoveryHighOffsets = await command(test.page, id, checkMarkers);
      observations.recoveredFiles = await command(test.page, id, checkFiles + "; test \"$(cat /mnt/volumes/disk0/terrarium/applications/reference/anchor.txt)\" = committed-before-abrupt-close; printf 'S2_COMMITTED_ANCHOR_SURVIVED\\n'; if test -e /mnt/volumes/disk0/terrarium/applications/reference/unsynced.txt; then printf 'UNSYNCED_PRESENT '; sha256sum /mnt/volumes/disk0/terrarium/applications/reference/unsynced.txt; else printf 'UNSYNCED_ABSENT\\n'; fi");
      assert.ok(observations.recoveredFiles.output.includes(text.toString("utf8"))); assert.match(observations.recoveredFiles.output, new RegExp(hash(text))); assert.match(observations.recoveredFiles.output, new RegExp(binarySha)); assert.match(observations.recoveredFiles.output, /S2_COMMITTED_ANCHOR_SURVIVED/);
      observations.inflightRecovery = await command(test.page, id, "set -e; _trm_file=/mnt/volumes/disk0/terrarium/applications/reference/inflight.bin; if test -f \"$_trm_file\"; then _trm_bytes=$(wc -c < \"$_trm_file\"); test \"$_trm_bytes\" -le 1048576; printf 'S2_INFLIGHT_PRESENT bytes=%s\\n' \"$_trm_bytes\"; sha256sum \"$_trm_file\"; else test ! -e \"$_trm_file\"; printf 'S2_INFLIGHT_ABSENT\\n'; fi");
      const recoveredSize = /S2_INFLIGHT_PRESENT bytes=(\d+)/.exec(observations.inflightRecovery.output);
      observations.inflightRecovery.classification = recoveredSize ? Number(recoveredSize[1]) === 1048576 ? "complete-observed" : Number(recoveredSize[1]) === 0 ? "empty-observed" : "partial-observed" : "absent-observed";
      observations.beforeReadOnlyDenials = await test.page.evaluate(async volumeId => (await import("/__browser-fixtures/acceptance/s2-browser-helper.js")).getVolume(volumeId), observations.volume.id);
      observations.readOnlyDenial = [];
      for (const script of ["printf forbidden > /mnt/volumes/disk0/terrarium/applications/reference/exact.txt",
        `dd if=/dev/zero of=/dev/terrarium-volume0 bs=4096 count=1 seek=${offsets[0] / 4096} conv=notrunc`])
        observations.readOnlyDenial.push(await executeGuestCommand(test.page, id, script, 30_000));
      assert.ok(observations.readOnlyDenial.every(result => result.status === "exited" && result.exitCode !== 0));
      observations.afterReadOnlyFiles = await command(test.page, id, checkFiles);
      assert.ok(observations.afterReadOnlyFiles.output.includes(text.toString("utf8"))); assert.match(observations.afterReadOnlyFiles.output, new RegExp(hash(text))); assert.match(observations.afterReadOnlyFiles.output, new RegExp(binarySha));
      observations.afterReadOnlyHighOffsets = await command(test.page, id, checkMarkers);
      observations.beforeReadOnlyStopWorkers = await test.workerLifecycle.captureLive(test.page, "read-only-guest-before-clean-stop");
      observations.readOnlyStopWorkerProof = await stopGuest(test.page, id);
      observations.afterReadOnlyHostReopen = await readHostMarkers(); assertMarkers(observations.afterReadOnlyHostReopen);
      assert.deepEqual(observations.afterReadOnlyHostReopen.metadata, observations.beforeReadOnlyDenials, "Read-only failures and teardown must not change saved bytes, metadata or revision");
      await test.page.evaluate(async ({ id, volumeId }) => { await window.terrarium.cloud.instances.delete(id).wait(); await window.terrarium.cloud.volumes.delete(volumeId).wait(); }, { id, volumeId: observations.volume.id }); id = null;
      observations.cleanup = await test.page.evaluate(() => window.terrarium.cloud.volumes.list()); assert.deepEqual(observations.cleanup, []);
      observations.finalWorkerProof = await test.workerLifecycle.assertEmpty("G4-final-worker-cleanup");
      assert.deepEqual(test.observations.pageErrors, []);
      return { ...observations, browser: test.observations, limitation: "Filesystem-backed sample paths verify the persistence policy only; no OCI or Kubernetes execution is claimed. Raw high-offset markers use known free blocks of this dedicated fixture. A clean persistent-profile browser restart is distinct from the later abrupt page close; OS reboot, power loss and origin eviction remain outside the clean-stop guarantee." };
    } catch (error) {
      primaryError = error instanceof Error ? error : new Error(String(error));
      return await guestFailure(test.page, id, { ...observations, browser: test.observations }, primaryError);
    } finally {
      try { await test.close(); }
      catch (error) {
        const cleanupError = error instanceof Error ? error : new Error(String(error));
        const failure = primaryError ?? cleanupError;
        const evidence = failure.browserEvidence ?? observations;
        failure.browserEvidence = { ...evidence, browser: test.observations,
          cleanupErrors: [...(evidence.cleanupErrors ?? []), {
            phase: "persistent-context-close", error: cleanupError.stack ?? String(cleanupError),
          }] };
        // Preserve the procedure failure and guest evidence already in flight.
        // A cleanup-only failure still rejects the case with its observations.
        if (!primaryError) throw cleanupError;
      }
    }
  });
}
