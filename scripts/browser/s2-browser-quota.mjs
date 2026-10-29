// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";

export async function runQuota({ run, fixtureContext, openApp, server }) {
  await run("S2-G2-browser-enforced-quota", "Set an actual Chromium origin quota, fill it with bounded native IndexedDB commits, and verify native quota rejection preserves the previous revision and bytes", async () => {
    const test = await openApp(await fixtureContext()), observations = {}, session = await test.context.newCDPSession(test.page);
    try {
      observations.before = await session.send("Storage.getUsageAndQuota", { origin: server.origin });
      const quotaSize = Math.ceil(observations.before.usage) + 2 * 1048576;
      observations.override = { method: "Storage.overrideQuotaForOrigin", origin: server.origin, quotaSize,
        documentation: "https://chromedevtools.github.io/devtools-protocol/tot/Storage/#method-overrideQuotaForOrigin", checkedAt: "2026-10-30" };
      await session.send("Storage.overrideQuotaForOrigin", { origin: server.origin, quotaSize });
      observations.effective = await session.send("Storage.getUsageAndQuota", { origin: server.origin });
      assert.equal(observations.effective.overrideActive, true); assert.equal(observations.effective.quota, quotaSize);
      observations.nativeFailure = await test.page.evaluate(async () => {
        const helper = await import("/__browser-fixtures/acceptance/s2-browser-helper.js");
        const check = (condition, message) => { if (!condition) throw new Error(message); };
        const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
        const meta = await helper.createVolume({ name: "native-quota-fixture", sizeMiB: 16 });
        const disk = await helper.openVolume(meta.id);
        const anchor = new TextEncoder().encode("acknowledged-before-native-quota\n");
        const completed = []; let failure = null, closeError = null;
        try {
          await disk.write(65536, anchor); await disk.flush();
          for (let index = 0; index < 8; index++) {
            const offset = 1048576 + index * 1048576, bytes = new Uint8Array(1048576);
            for (let at = 0; at < bytes.length; at += 65536) crypto.getRandomValues(bytes.subarray(at, at + 65536));
            const sha256 = await digest(bytes);
            const before = disk.getMetadata();
            try { await disk.write(offset, bytes); completed.push({ offset, bytes: bytes.length, sha256, revision: disk.getMetadata().revision }); }
            catch (error) {
              failure = { offset, message: error.message, before, after: disk.getMetadata(), state: disk.getState(), cache: disk.getStorageStats() };
              check(failure.message.includes("QuotaExceededError"), "Expected native Chromium quota exhaustion, not another storage failure.");
              check(JSON.stringify(failure.before) === JSON.stringify(failure.after), "Rejected write advanced committed metadata.");
              check(disk.cachedRead(offset, 65536).every(byte => byte === 0), "Rejected data entered the committed cache.");
              let latched; try { await disk.write(65536, new Uint8Array([255])); } catch (error) { latched = error.message; }
              check(latched === failure.message, "The storage failure did not latch before a later write.");
              failure.latched = true; break;
            }
          }
          check(failure, "The bounded quota fixture did not reach the configured browser quota.");
          check(completed.length > 0, "The fixture must commit at least one full random chunk before testing quota preservation.");
        } finally { try { await disk.close(); } catch (error) { closeError = error.message; } }
        check(closeError === failure.message, "Close must report the original failed commit while releasing ownership.");
        const reopened = await helper.openVolume(meta.id, { readOnly: true });
        try {
          const anchorBytes = await reopened.read(65536, anchor.length), failedBytes = await reopened.read(failure.offset, 1048576);
          check(new TextDecoder().decode(anchorBytes) === new TextDecoder().decode(anchor), "Last acknowledged anchor was lost.");
          check(failedBytes.every(byte => byte === 0), "Native quota failure partially committed a rejected range.");
          check(reopened.getMetadata().revision === failure.before.revision, "Native abort changed the saved revision.");
          const verifiedCommittedChunks = [];
          for (const chunk of completed) {
            const bytes = await reopened.read(chunk.offset, chunk.bytes), sha256 = await digest(bytes);
            check(sha256 === chunk.sha256, `Native quota abort changed a previously committed chunk at offset ${chunk.offset}.`);
            verifiedCommittedChunks.push({ offset: chunk.offset, bytes: bytes.length, sha256 });
          }
          check(verifiedCommittedChunks.length === completed.length, "Every prior committed random chunk must be verified after reopening.");
          return { volumeId: meta.id, completed, verifiedCommittedChunks, failure, closeError, anchorPreserved: true, failedRangePreserved: true, savedRevision: reopened.getMetadata().revision,
            mechanism: "Chromium native IndexedDB commit under a DevTools-enforced origin quota; production transaction methods are unchanged", maximumInputChunkBytes: 1048576 };
        } finally { await reopened.close(); }
      });
      observations.after = await session.send("Storage.getUsageAndQuota", { origin: server.origin });
      await session.send("Storage.overrideQuotaForOrigin", { origin: server.origin });
      observations.reset = await session.send("Storage.getUsageAndQuota", { origin: server.origin }); assert.equal(observations.reset.overrideActive, false);
      await test.page.evaluate(async id => { await window.terrarium.cloud.volumes.delete(id).wait(); }, observations.nativeFailure.volumeId);
      assert.deepEqual(await test.page.evaluate(() => window.terrarium.cloud.volumes.list()), []);
      assert.deepEqual(test.observations.pageErrors, []);
      return { ...observations, browser: test.observations, limitation: "This is an enforced browser-origin quota, not exhaustion of the host disk, origin eviction, or a browser crash." };
    } catch (error) { error.browserEvidence = { ...observations, browser: test.observations }; throw error; }
    finally { await session.send("Storage.overrideQuotaForOrigin", { origin: server.origin }).catch(() => {}); try { await session.detach(); } finally { await test.close(); } }
  });
}
