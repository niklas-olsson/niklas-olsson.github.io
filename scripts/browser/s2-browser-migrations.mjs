// SPDX-License-Identifier: Apache-2.0
import { assertLiveOwnerRefusal } from "./s2-readiness-evidence.mjs";
import assert from "node:assert/strict";

export async function runMigrations({ run, fixtureContext, server, ready, helperCall, createGuest }) {
  const inspect = async (page, seed, { workspaceRejected = false } = {}) => {
    const result = await helperCall(page, "observeMigrationArtifacts");
    assert.equal(seed.diskBefore.databaseVersion, 1);
    if (workspaceRejected) assert.ok([1, 2].includes(result.diskAfter.databaseVersion),
      "Workspace rejection may leave the independent DBv1 disk untouched or follow an already completed startup storage upgrade");
    else assert.equal(result.diskAfter.databaseVersion, 2,
      "A valid migration must upgrade DBv1 in the packaged app before the observer invokes production store APIs");
    assert.deepEqual(seed.diskBefore.stores, ["metadata", "pages"]);
    assert.deepEqual(result.diskAfter.stores, result.diskAfter.databaseVersion === 1 ? ["metadata", "pages"] : ["metadata", "pages", "staging"]);
    assert.equal(result.diskAfterProductionInspection.databaseVersion, 2, "Explicit independent-artifact inspection must use the current production storage schema");
    assert.deepEqual(result.diskAfterProductionInspection.stores, ["metadata", "pages", "staging"]);
    for (const disk of [result.diskAfter, result.diskAfterProductionInspection]) {
      assert.equal(disk.logicalBytes, 4 * 1048576);
      assert.equal(disk.rawSha256, seed.diskBefore.rawSha256, "Every historical logical disk byte must survive both startup and explicit artifact inspection");
      assert.deepEqual(disk.metadata, seed.diskBefore.metadata, "Neither migration nor explicit inspection may change historical disk metadata");
      assert.equal(disk.storedPages, seed.diskBefore.storedPages);
    }
    assert.deepEqual(result.metadataThroughProductionApi, seed.diskBefore.metadata);
    assert.equal(result.diskSha256, seed.payloadSha256);
    assert.equal(result.objectSha256, seed.objectSha256);
    assert.equal(result.objectBodySha256, seed.payloadSha256);
    assert.equal(result.evidenceId, seed.evidenceId);
    assert.equal(result.evidenceSha256, seed.evidenceSha256);
    assert.equal(result.evidenceBodySha256, seed.payloadSha256);
    return result;
  };
  for (const kind of ["v04", "v07", "empty", "corrupt"]) await run(`S2-G5-migration-${kind}`, "Seed the pinned historical schema in actual Chromium origin storage, reopen the packaged application, and compare independent disk/object/archive bytes", async () => {
    const test = await fixtureContext(), observations = {};
    try {
      await test.page.goto(`${server.origin}/__browser-fixtures/acceptance/blank.html`);
      observations.seed = await helperCall(test.page, "seedMigrationFixture", kind);
      if (kind === "v07") observations.failedCommit = await helperCall(test.page, "migrationCommitFailure");
      await test.page.close(); test.page = await test.newPage();
      await test.page.goto(server.origin, { waitUntil: "networkidle" });
      if (kind === "corrupt") await test.page.waitForFunction(() => window.terrarium?.workspace?.status().mode === "error");
      else await ready(test.page);
      observations.after = await inspect(test.page, observations.seed, { workspaceRejected: kind === "corrupt" });
      observations.workspace = await test.page.evaluate(async () => ({ status: window.terrarium.workspace.status(), instances: await window.terrarium.cloud.instances.list(), vpcs: await window.terrarium.cloud.vpcs.list() }));
      assert.equal(test.page.workers().length, 0, "Migration must not resume guest execution");
      if (kind === "corrupt") {
        assert.ok(observations.after.error);
        assert.equal(observations.after.raw, observations.seed.before["terrarium.workspace.v1"]);
        assert.deepEqual(observations.after.workspaceBeforeInspection, observations.seed.before);
        assert.deepEqual(observations.after.workspaceAfterInspection, observations.seed.before);
        assert.deepEqual(observations.workspace.instances, []);
      } else {
        assert.equal(observations.after.error, null); assert.equal(observations.after.manifest.schema, "terrarium.workspace/v2");
        assert.ok(observations.after.manifest.revision > (kind === "v07" ? 7 : 0));
        assert.ok(observations.workspace.instances.every(instance => instance.status === "idle" && instance.networkMode === "isolated"));
        if (kind === "v07") {
          assert.equal(observations.workspace.instances[0].machine.presetId, "small");
          assert.equal(observations.workspace.instances[0].machine.runtimeBundleId, "qemu@8.2.0-b7c549b5-uart4-v1");
          assert.equal(observations.workspace.status.recovery[0].id, "v07-retained");
        }
        if (kind === "empty") { assert.deepEqual(observations.workspace.instances, []); assert.deepEqual(observations.workspace.vpcs, []); }
        if (kind === "v04" || kind === "empty") {
          assert.equal(observations.after.legacy.machines, observations.seed.before["terrarium.machines.v1"]);
          assert.equal(observations.after.legacy.vpcs, observations.seed.before["terrarium.vpcs.v1"]);
        }
        if (kind === "v04") observations.corruptDisk = await helperCall(test.page, "corruptMigrationDiskMetadata");
        for (const instance of observations.workspace.instances) await test.page.evaluate(async id => { await window.terrarium.cloud.instances.delete(id).wait(); }, instance.id);
        await test.page.close(); test.page = await test.newPage(); await test.page.goto(server.origin, { waitUntil: "networkidle" }); await ready(test.page);
        observations.reopened = await inspect(test.page, observations.seed);
        assert.deepEqual(await test.page.evaluate(() => window.terrarium.cloud.instances.list()), []);
        assert.deepEqual(observations.reopened.manifest.machines, []);
      }
      assert.deepEqual(test.observations.pageErrors, []); return { ...observations, browser: test.observations };
    } catch (error) { error.browserEvidence = { ...observations, browser: test.observations }; throw error; }
    finally { await test.close(); }
  });

  for (const kind of ["legacy-config-injection", "duplicate-nic"]) await run(`S2-G5-${kind}`, "Reject invalid historical or v2 machine identities before adopting the inventory, while preserving raw source and independent artifacts", async () => {
    const test = await fixtureContext(), observations = {};
    try {
      await test.page.goto(`${server.origin}/__browser-fixtures/acceptance/blank.html`);
      observations.seed = await helperCall(test.page, "seedMigrationFixture", kind === "duplicate-nic" ? "v07" : "v04");
      observations.injected = await test.page.evaluate(async kind => {
        const helper = await import("/__browser-fixtures/acceptance/s2-browser-helper.js");
        let key, value;
        if (kind === "legacy-config-injection") {
          key = helper.MACHINE_STORAGE_KEY; const machines = JSON.parse(localStorage.getItem(key));
          machines[0].profile = "alpine-x86_64"; machines[0].x86 = helper.defaultX86MachineConfiguration(); value = machines;
        } else {
          key = helper.WORKSPACE_STORAGE_KEY; value = helper.loadWorkspaceManifest(localStorage).manifest;
          value.machines.push({ ...structuredClone(value.machines[0]), id: "duplicate-nic", name: "duplicate-nic", ip: "192.168.76.11" });
        }
        const raw = JSON.stringify(value); localStorage.setItem(key, raw); return { key, raw };
      }, kind);
      await test.page.goto(server.origin, { waitUntil: "networkidle" });
      await test.page.waitForFunction(() => window.terrarium?.workspace?.status().mode === "error");
      observations.state = await test.page.evaluate(key => ({ workspace: window.terrarium.workspace.status(), raw: localStorage.getItem(key), instances: window.terrarium.list() }), observations.injected.key);
      assert.equal(observations.state.raw, observations.injected.raw); assert.deepEqual(observations.state.instances, []); assert.equal(test.page.workers().length, 0);
      observations.after = await inspect(test.page, observations.seed, { workspaceRejected: true });
      assert.ok(observations.after.error);
      const rejectedSource = { ...observations.seed.before, [observations.injected.key]: observations.injected.raw };
      assert.deepEqual(observations.after.workspaceBeforeInspection, rejectedSource);
      assert.deepEqual(observations.after.workspaceAfterInspection, rejectedSource);
      assert.deepEqual(test.observations.pageErrors, []); return { ...observations, browser: test.observations };
    } catch (error) { error.browserEvidence = { ...observations, browser: test.observations }; throw error; }
    finally { await test.close(); }
  });

  await run("S2-G5-page-close-before-migration-commit", "Close the actual packaged app while a separate page holds its real workspace writer lock; preserve original v0.7 bytes and raw independent artifacts, then release ownership and reopen for a successful v2 migration", async () => {
    const test = await fixtureContext(), observations = {};
    const holder = test.page;
    try {
      await holder.goto(`${server.origin}/__browser-fixtures/acceptance/blank.html`);
      observations.seed = await helperCall(holder, "seedMigrationFixture", "v07");
      observations.held = await holder.evaluate(async () => {
        const { WORKSPACE_LOCK } = await import("/__browser-fixtures/acceptance/s2-browser-helper.js");
        let release, grant, rejectGrant;
        const held = new Promise(resolve => { release = resolve; });
        const granted = new Promise((resolve, reject) => { grant = resolve; rejectGrant = reject; });
        const completion = navigator.locks.request(WORKSPACE_LOCK, { mode: "exclusive", ifAvailable: true }, async lock => {
          if (!lock) throw new Error("The fresh migration fixture could not hold its workspace writer lock.");
          grant({ name: lock.name, mode: lock.mode }); await held;
        });
        void completion.catch(rejectGrant);
        window.__terrariumMigrationOwnershipHold = { release, completion };
        return { ...await granted, locks: await navigator.locks.query() };
      });
      assert.equal(observations.held.mode, "exclusive");
      assert.equal(observations.held.locks.held.filter(lock => lock.name === observations.held.name).length, 1);
      const interruptedPage = await test.newPage();
      await interruptedPage.goto(server.origin, { waitUntil: "networkidle" });
      await interruptedPage.waitForFunction(() => window.terrarium?.workspace?.status().mode === "read-only");
      observations.beforeClose = await interruptedPage.evaluate(async () => {
        const helper = await import("/__browser-fixtures/acceptance/s2-browser-helper.js");
        return { workspace: window.terrarium.workspace.status(), instances: await window.terrarium.cloud.instances.list(),
          raw: Object.fromEntries([helper.MACHINE_STORAGE_KEY, helper.VPC_STORAGE_KEY, helper.WORKSPACE_STORAGE_KEY].map(key => [key, localStorage.getItem(key)])) };
      });
      assert.equal(observations.beforeClose.workspace.mode, "read-only");
      assert.equal(observations.beforeClose.workspace.revision, 7);
      assert.deepEqual(observations.beforeClose.raw, observations.seed.before);
      assert.equal(observations.beforeClose.instances.length, 1);
      assert.equal(observations.beforeClose.instances[0].id, "v07-retained");
      assert.equal(observations.beforeClose.instances[0].machine.presetId, "small");
      assert.equal(observations.beforeClose.instances[0].machine.runtimeBundleId, "qemu@8.2.0-b7c549b5-uart4-v1");
      assert.equal(observations.beforeClose.instances[0].status, "idle");
      assert.equal(observations.beforeClose.instances[0].networkMode, "isolated");
      assert.equal(interruptedPage.workers().length, 0);
      await interruptedPage.close();
      observations.pageClosedBeforeCommit = interruptedPage.isClosed();
      assert.equal(observations.pageClosedBeforeCommit, true);
      observations.interrupted = await helperCall(holder, "observeMigrationArtifacts", { rawOnly: true });
      assert.equal(observations.interrupted.inspectionMode, "raw-only");
      assert.deepEqual(observations.interrupted.workspaceBeforeInspection, observations.seed.before);
      assert.deepEqual(observations.interrupted.workspaceAfterInspection, observations.seed.before);
      assert.deepEqual(observations.interrupted.diskAfter, observations.seed.diskBefore);
      assert.deepEqual(observations.interrupted.diskAfterRawInspection, observations.seed.diskBefore);
      assert.deepEqual(observations.interrupted.rawArtifacts, observations.seed.rawArtifacts);
      observations.released = await holder.evaluate(async () => {
        const state = window.__terrariumMigrationOwnershipHold;
        if (!state) throw new Error("The fixture lost its held workspace lock before release.");
        state.release(); await state.completion; delete window.__terrariumMigrationOwnershipHold;
        return { locks: await navigator.locks.query() };
      });
      assert.equal(observations.released.locks.held.filter(lock => lock.name === observations.held.name).length, 0);
      test.page = await test.newPage();
      await test.page.goto(server.origin, { waitUntil: "networkidle" }); await ready(test.page);
      observations.resumed = await inspect(test.page, observations.seed);
      assert.equal(observations.resumed.error, null);
      assert.equal(observations.resumed.manifest.schema, "terrarium.workspace/v2");
      assert.ok(observations.resumed.manifest.revision > 7);
      assert.equal(observations.resumed.manifest.machines[0].id, "v07-retained");
      observations.resumedRawArtifacts = await helperCall(test.page, "observeMigrationArtifacts", { rawOnly: true });
      assert.deepEqual(observations.resumedRawArtifacts.rawArtifacts, observations.seed.rawArtifacts);
      assert.deepEqual(observations.resumedRawArtifacts.diskAfter, observations.resumed.diskAfterProductionInspection);
      assert.deepEqual(observations.resumedRawArtifacts.diskAfterRawInspection, observations.resumed.diskAfterProductionInspection);
      assert.equal(test.observations.workersCreated, 0); assert.deepEqual(test.observations.pageErrors, []);
      return { ...observations, browser: test.observations,
        interruptionBoundary: "Actual app page closed while denied writer ownership, before any migration commit",
        limitations: ["This is a known pre-commit page-close boundary, not a torn atomic localStorage write or a killed IndexedDB schema-upgrade transaction.",
          "The separate injected StorageLike.setItem failure remains a modeled commit-failure case."] };
    } catch (error) { error.browserEvidence = { ...observations, browser: test.observations }; throw error; }
    finally { await test.close(); }
  });

  await run("S2-G5-real-browser-ownership-transfer", "Hold the actual workspace Web Lock in one page, reject writes from a second page, then adopt the latest committed configuration after the owner closes", async () => {
    const test = await fixtureContext(), observations = {};
    try {
      await test.page.goto(server.origin, { waitUntil: "networkidle" }); await ready(test.page);
      observations.created = await createGuest(test.page, "small", "ownership-transfer");
      const secondary = await test.newPage(); await secondary.goto(server.origin, { waitUntil: "networkidle" });
      await secondary.waitForFunction(() => window.terrarium?.workspace?.status().mode === "read-only");
      observations.readOnly = await secondary.evaluate(async id => {
        const before = await window.terrarium.cloud.instances.get(id); let rejection;
        try { await window.terrarium.cloud.instances.update(id, { name: "forbidden-write" }).wait(); } catch (error) { rejection = error.message; }
        return { before, rejection, after: await window.terrarium.cloud.instances.get(id) };
      }, observations.created.id);
      assert.match(observations.readOnly.rejection, /read.only|owns|control/i); assert.deepEqual(observations.readOnly.before, observations.readOnly.after);
      observations.liveOwnerRefusal = await secondary.evaluate(async () => {
        const before = localStorage.getItem("terrarium.workspace.v1"), now = Date.now;
        let rejection;
        try {
          // Advancing wall time must not turn a live Web Lock into an expired
          // lease. This clock fixture changes neither timers nor stored bytes.
          Date.now = () => now() + 365 * 24 * 60 * 60 * 1000;
          await window.terrarium.workspace.takeControl();
        } catch (error) { rejection = error.message; }
        finally { Date.now = now; }
        return { before, after: localStorage.getItem("terrarium.workspace.v1"), rejection,
          workspace: window.terrarium.workspace.status(), locks: await navigator.locks.query() };
      });
      assert.match(observations.liveOwnerRefusal.rejection, /Another Terrarium tab owns/);
      assert.equal(observations.liveOwnerRefusal.workspace.mode, "read-only");
      assert.equal(observations.liveOwnerRefusal.before, observations.liveOwnerRefusal.after);
      observations.latest = await test.page.evaluate(async id => {
        const helper = await import("/__browser-fixtures/acceptance/s2-browser-helper.js");
        const current = await window.terrarium.cloud.instances.get(id);
        const machine = helper.defaultX86MachineConfiguration({ presetId: "worker", mac: current.machine.nic.mac });
        return window.terrarium.cloud.instances.update(id, { name: "latest-owned-worker", machine }).wait();
      }, observations.created.id);
      const closedOwner = test.page;
      await test.page.close(); test.page = secondary;
      observations.lockRelease = await test.page.evaluate(async () => {
        const { WORKSPACE_LOCK } = await import("/__browser-fixtures/acceptance/s2-browser-helper.js");
        const budgetMs = 5000, started = performance.now();
        let queries = 0, first = null, last = null;
        const result = (status, error) => ({ status, lockName: WORKSPACE_LOCK, budgetMs,
          elapsedMs: performance.now() - started, queries, first, last, ...(error ? { error } : {}) });
        while (performance.now() - started < budgetMs) {
          let timer;
          try {
            const remaining = budgetMs - (performance.now() - started);
            const snapshot = await Promise.race([navigator.locks.query(), new Promise(resolve => { timer = setTimeout(() => resolve(null), remaining); })]);
            if (snapshot === null) return result("timeout");
            queries++;
            last = { elapsedMs: performance.now() - started,
              held: snapshot.held.filter(lock => lock.name === WORKSPACE_LOCK),
              pending: snapshot.pending.filter(lock => lock.name === WORKSPACE_LOCK) };
            first ??= last;
            if (last.elapsedMs >= budgetMs) return result("timeout");
            if (last.held.length === 0) return result("released");
          } catch (error) { return result("query-error", String(error)); }
          finally { clearTimeout(timer); }
          const remaining = budgetMs - (performance.now() - started);
          if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
        }
        return result("timeout");
      });
      assert.equal(observations.lockRelease.status, "released",
        `The closed owner's workspace lock did not disappear within the measured 5-second budget: ${JSON.stringify(observations.lockRelease)}`);
      // Exercise the same reopen coordinator as abrupt-close persistence. The
      // secondary deterministically refused ownership while the owner was live.
      observations.recoveryReadiness = await ready(test.page, { closedOwner });
      assert.equal(observations.recoveryReadiness.takeControlRequested, true);
      assert.equal(observations.recoveryReadiness.beforeTakeControl.workspace.mode, "read-only");
      observations.adopted = await test.page.evaluate(id => window.terrarium.cloud.instances.get(id), observations.created.id);
      assert.deepEqual(observations.adopted.machine, observations.latest.machine); assert.equal(observations.adopted.name, "latest-owned-worker"); assert.equal(observations.adopted.memoryMiB, 1024);
      // A retired prior page does not authorize taking a replacement live
      // owner's lock. The full unchanged readiness budget must refuse it.
      const contender = await test.newPage(); await contender.goto(server.origin, { waitUntil: "networkidle" });
      await contender.waitForFunction(() => window.terrarium?.workspace?.status().mode === "read-only");
      const saved = await test.page.evaluate(() => localStorage.getItem("terrarium.workspace.v1"));
      let refusal;
      try { await ready(contender, { closedOwner }); }
      catch (error) { refusal = { error: String(error), ...error.browserEvidence }; }
      observations.replacementLiveOwnerRefusal = refusal;
      assertLiveOwnerRefusal(refusal, saved);
      assert.equal(await test.page.evaluate(() => window.terrarium.workspace.status().mode), "writable");
      await contender.close();
      assert.equal(test.page.workers().length, 0); assert.deepEqual(test.observations.pageErrors, []);
      return { ...observations, browser: test.observations };
    } catch (error) { error.browserEvidence = { ...error.browserEvidence, ...observations, browser: test.observations }; throw error; }
    finally { await test.close(); }
  });
}
