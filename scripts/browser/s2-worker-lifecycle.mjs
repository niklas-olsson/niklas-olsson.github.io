// SPDX-License-Identifier: Apache-2.0
// Acceptance observer for one exclusive Chromium browser launch. It never
// terminates workers, pauses targets, or substitutes browser shutdown for proof.
import { performance } from "node:perf_hooks";

const MAX_BOUNDARY_MS = 10_000;
const TARGET_FILTER = [{}];
const NON_WORKER_TYPES = new Set(["browser", "tab", "page", "iframe", "service_worker"]);
const now = () => new Date().toISOString();
const clone = value => value === undefined ? null : JSON.parse(JSON.stringify(value));
const multiset = values => {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([url, count]) => ({ url, count }));
};

export class WorkerLifecycleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkerLifecycleError";
    this.code = code;
    this.details = details;
  }
}
const insist = (condition, code, message, details) => {
  if (!condition) throw new WorkerLifecycleError(code, message, details);
};
const deadlineFor = options => {
  const began = performance.now(), deadline = options?.deadline ?? began + MAX_BOUNDARY_MS;
  insist(Number.isFinite(deadline) && deadline > began && deadline <= began + MAX_BOUNDARY_MS,
    "WORKER_LIFECYCLE_DEADLINE", "Use an unexpired absolute monotonic deadline of at most 10000 ms.");
  return deadline;
};
const beforeDeadline = (deadline, message) =>
  insist(performance.now() < deadline, "WORKER_LIFECYCLE_DEADLINE", message);
async function bounded(promise, deadline, message) {
  const remaining = deadline - performance.now();
  insist(remaining > 0, "WORKER_LIFECYCLE_DEADLINE", message);
  let timer;
  try {
    const result = await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new WorkerLifecycleError("WORKER_LIFECYCLE_DEADLINE", message)), remaining);
    })]);
    // A ready microtask can win after an event-loop stall but before the timer.
    beforeDeadline(deadline, message);
    return result;
  } finally { clearTimeout(timer); }
}

class WorkerLifecycleObserver {
  constructor(browser, options) {
    insist(browser?.isConnected(), "WORKER_LIFECYCLE_DISCONNECTED", "Observer requires a connected browser.");
    insist(typeof options.launchId === "string" && options.launchId.length > 0,
      "WORKER_LIFECYCLE_OBSERVER_ERROR", "A browser-launch identity is required.");
    this.browser = browser;
    this.targets = new Map();
    this.pages = new Map();
    this.workers = new Map();
    this.sequence = 0;
    this.allowedServiceWorkerUrls = new Set(options.allowedServiceWorkerUrls ?? []);
    this.data = { schema: "terrarium.browser-worker-lifecycle/v1", launchId: options.launchId,
      browserVersion: browser.version(), startedAt: now(), targetFilter: clone(TARGET_FILTER),
      allowedServiceWorkerUrls: [...this.allowedServiceWorkerUrls], armedAt: null,
      workersCreated: 0, workersClosed: 0, pages: [], workers: [], cohorts: [], proofs: [],
      refusals: [], errors: [], events: [], disconnected: null, sealed: null,
      limitation: "Native target retirement proves browser-observed dedicated-worker cleanup, not immediate RSS or native-thread memory reclamation. Raw Playwright close callbacks remain separate." };
    browser.once("disconnected", () => {
      this.data.disconnected = { at: now(), expectedAfterSealedProof: this.data.sealed !== null };
      if (!this.data.sealed) this.latch("WORKER_LIFECYCLE_DISCONNECTED", "Browser disconnected before cleanup proof.");
    });
  }
  latch(code, message, details = {}) {
    if (this.data.errors.length < 16) this.data.errors.push({ at: now(), code, message, details });
  }
  healthy({ allowSealed = false } = {}) {
    insist(this.browser.isConnected(), "WORKER_LIFECYCLE_DISCONNECTED",
      "Worker cleanup must be observed while this browser is still connected.");
    const error = this.data.errors[0];
    if (error) throw new WorkerLifecycleError(error.code, error.message, error.details);
    insist(allowSealed || !this.data.sealed, "WORKER_LIFECYCLE_OBSERVER_ERROR",
      "This launch was already sealed for browser shutdown.");
  }
  event(type, details) {
    if (this.data.events.length >= 4096) {
      this.latch("WORKER_LIFECYCLE_OBSERVER_ERROR", "Worker observer event budget exceeded.");
      return;
    }
    this.data.events.push({ sequence: ++this.sequence, at: now(), type, ...details });
  }
  merge(info, source, querySequence = null) {
    if (!info || typeof info.targetId !== "string" || typeof info.type !== "string") {
      this.latch("WORKER_LIFECYCLE_OBSERVER_ERROR", "CDP returned an unidentifiable target.");
      return false;
    }
    let target = this.targets.get(info.targetId);
    if (!target) {
      if (this.targets.size >= 512) {
        this.latch("WORKER_LIFECYCLE_OBSERVER_ERROR", "Worker observer target budget exceeded.");
        return false;
      }
      target = { targetId: info.targetId, firstObservedAt: now(), createdAt: null,
        destroyedAt: null, destroyedSequence: null, info: null, cohorts: [] };
      this.targets.set(info.targetId, target);
    }
    if (target.destroyedAt) {
      // A response can describe the instant before an event already delivered
      // while its query was pending. Retain the tombstone and take a new query.
      if (source === "snapshot" && target.destroyedSequence > querySequence) return true;
      this.latch("WORKER_LIFECYCLE_OBSERVER_ERROR", "A destroyed target reappeared.", { targetId: info.targetId, source });
      return false;
    }
    if (target.info && target.info.type !== info.type)
      this.latch("WORKER_LIFECYCLE_OBSERVER_ERROR", "A target changed type.", { targetId: info.targetId });
    if (target.cohorts.length && target.info?.url && target.info.url !== info.url)
      this.latch("WORKER_LIFECYCLE_OBSERVER_ERROR", "A covered worker target changed URL.", { targetId: info.targetId });
    target.info = clone(info);
    if (source === "created") target.createdAt ??= now();
    target.lastObservedAt = now();
    if (info.type !== "worker" && !NON_WORKER_TYPES.has(info.type))
      this.latch("WORKER_LIFECYCLE_OBSERVER_ERROR", "Unexpected target kind cannot be excluded from worker cleanup.",
        { targetId: info.targetId, type: info.type, url: info.url });
    if (this.data.sealed && info.type === "worker")
      this.latch("WORKER_LIFECYCLE_OBSERVER_ERROR", "A worker appeared after this launch was sealed.", { targetId: info.targetId });
    return false;
  }
  async send(session, method, parameters, deadline) {
    this.healthy();
    const transportFailure = error => {
      this.latch("WORKER_LIFECYCLE_CDP_ERROR", "CDP observation failed: " + method, { error: String(error) });
      return new WorkerLifecycleError("WORKER_LIFECYCLE_CDP_ERROR", "CDP observation failed: " + method, { error: String(error) });
    };
    try {
      // Keep a real transport rejection visible even if the observation budget
      // expires first. The budget's own typed refusal is not a transport fault.
      const response = Promise.resolve(session.send(method, parameters)).catch(error => {
        if (error instanceof WorkerLifecycleError) throw error;
        throw transportFailure(error);
      });
      const result = await bounded(response, deadline, method + " exceeded the cleanup deadline.");
      this.healthy();
      return result;
    } catch (error) {
      if (error instanceof WorkerLifecycleError) throw error;
      throw transportFailure(error);
    }
  }
  async initialize(deadline) {
    try {
      this.session = await bounded(this.browser.newBrowserCDPSession(), deadline, "Browser CDP setup exceeded its deadline.");
      this.session.on("Target.targetCreated", ({ targetInfo }) => {
        this.event("targetCreated", { targetInfo: clone(targetInfo) }); this.merge(targetInfo, "created");
      });
      this.session.on("Target.targetInfoChanged", ({ targetInfo }) => {
        this.event("targetInfoChanged", { targetInfo: clone(targetInfo) }); this.merge(targetInfo, "changed");
      });
      this.session.on("Target.targetDestroyed", ({ targetId }) => {
        if (typeof targetId !== "string") {
          this.latch("WORKER_LIFECYCLE_OBSERVER_ERROR", "CDP destruction event had no target identity."); return;
        }
        this.event("targetDestroyed", { targetId });
        let target = this.targets.get(targetId);
        if (!target) {
          if (this.targets.size >= 512) {
            this.latch("WORKER_LIFECYCLE_OBSERVER_ERROR", "Worker observer target budget exceeded."); return;
          }
          target = { targetId, firstObservedAt: now(), createdAt: null, info: null, cohorts: [] };
          this.targets.set(targetId, target);
        }
        target.destroyedAt ??= now(); target.destroyedSequence ??= this.sequence;
      });
      this.session.on("close", () => {
        if (!this.data.sealed) this.latch("WORKER_LIFECYCLE_CDP_ERROR", "Browser CDP observation closed before sealed cleanup.");
      });
      await this.send(this.session, "Target.setDiscoverTargets", { discover: true, filter: TARGET_FILTER }, deadline);
      this.data.armedAt = now();
      await this.assertEmpty("observer-armed-baseline", { deadline });
      return this;
    } catch (error) { error.workerLifecycle = this.snapshot(); throw error; }
  }
  async targetsNow(deadline) {
    const sequence = this.sequence;
    const result = await this.send(this.session, "Target.getTargets", { filter: TARGET_FILTER }, deadline);
    insist(Array.isArray(result.targetInfos), "WORKER_LIFECYCLE_OBSERVER_ERROR", "CDP returned no target inventory.");
    let stale = false;
    for (const info of result.targetInfos) stale = this.merge(info, "snapshot", sequence) || stale;
    this.healthy();
    for (const target of this.targets.values()) {
      insist(target.info, "WORKER_LIFECYCLE_OBSERVER_ERROR", "A destroyed target has no known kind or ownership.", { targetId: target.targetId });
      if (target.info.type === "service_worker") {
        insist(this.allowedServiceWorkerUrls.has(target.info.url), "WORKER_LIFECYCLE_OBSERVER_ERROR",
          "Only the declared isolation service worker may be excluded.", { targetId: target.targetId, url: target.info.url });
      }
    }
    return { at: now(), stale, infos: result.targetInfos };
  }
  async observePage(page, label = "page") {
    this.healthy();
    if (this.pages.has(page)) return clone(this.pages.get(page).record);
    insist(this.pages.size < 32, "WORKER_LIFECYCLE_OBSERVER_ERROR", "Worker observer page budget exceeded.");
    insist(page.context().browser() === this.browser && !page.isClosed(), "WORKER_LIFECYCLE_OBSERVER_ERROR",
      "The page must belong to this live browser launch.");
    insist(page.workers().length === 0, "WORKER_LIFECYCLE_UNCOVERED", "Attach the page observer before creating workers.");
    const deadline = deadlineFor();
    const record = { id: this.data.launchId + ":page-" + (this.pages.size + 1), label, observedAt: now(),
      targetId: null, frameId: null, browserContextId: null, closedAt: null };
    const owned = { record, page, session: null };
    this.pages.set(page, owned); this.data.pages.push(record);
    page.once("close", () => { record.closedAt = now(); this.event("pageClose", { pageId: record.id }); });
    page.on("worker", worker => {
      if (this.workers.has(worker)) {
        this.latch("WORKER_LIFECYCLE_OBSERVER_ERROR", "A Worker object was announced twice."); return;
      }
      if (this.workers.size >= 256) {
        this.latch("WORKER_LIFECYCLE_OBSERVER_ERROR", "Worker observer Worker budget exceeded."); return;
      }
      const entry = { id: this.data.launchId + ":worker-" + (this.workers.size + 1), pageId: record.id,
        url: worker.url(), createdAt: now(), closedAt: null, cohorts: [], resolution: null };
      this.workers.set(worker, { record: entry, owned });
      this.data.workers.push(entry); this.data.workersCreated++;
      if (this.data.sealed) this.latch("WORKER_LIFECYCLE_OBSERVER_ERROR", "A Worker was created after sealed cleanup.");
      worker.once("close", () => { entry.closedAt = now(); this.data.workersClosed++; });
    });
    owned.session = await bounded(page.context().newCDPSession(page), deadline, "Page identity setup exceeded its deadline.");
    const { targetInfo } = await this.send(owned.session, "Target.getTargetInfo", {}, deadline);
    const { frameTree } = await this.send(owned.session, "Page.getFrameTree", {}, deadline);
    insist(targetInfo?.type === "page" && typeof frameTree?.frame?.id === "string",
      "WORKER_LIFECYCLE_OBSERVER_ERROR", "Page target/frame identities were unavailable.");
    record.targetId = targetInfo.targetId; record.frameId = frameTree.frame.id;
    record.browserContextId = targetInfo.browserContextId ?? null;
    this.merge(targetInfo, "page-identity");
    return clone(record);
  }
  ownedPage(page) {
    const owned = this.pages.get(page);
    insist(owned, "WORKER_LIFECYCLE_UNCOVERED", "The page was never observed before its workers.");
    return owned;
  }
  async refusal(label, procedure) {
    try { return await procedure(); }
    catch (error) {
      if (this.data.refusals.length < 128) this.data.refusals.push({ label, at: now(),
        code: error.code ?? "UNEXPECTED_ERROR", message: error.message ?? String(error), details: error.details ?? null });
      throw error;
    }
  }
  async pause(deadline) {
    const remaining = deadline - performance.now();
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
  }
  async captureLive(page, label, options = {}) {
    return this.refusal(label, async () => {
      this.healthy();
      const deadline = deadlineFor(options), owned = this.ownedPage(page), began = performance.now();
      insist(!page.isClosed(), "WORKER_LIFECYCLE_COVERAGE", "Live worker coverage requires an open owning page.");
      let mismatch = {};
      while (performance.now() < deadline) {
        const snapshot = await this.targetsNow(deadline);
        const live = snapshot.infos.filter(target => target.type === "worker");
        const workers = page.workers(), entries = workers.map(worker => this.workers.get(worker));
        const urls = multiset(workers.map(worker => worker.url())), targetUrls = multiset(live.map(target => target.url));
        const otherWorkers = [...this.pages.values()].filter(other => other !== owned && !other.page.isClosed())
          .flatMap(other => other.page.workers());
        const covered = !snapshot.stale && workers.length > 0 && live.length === workers.length && !otherWorkers.length
          && entries.every(entry => entry && entry.owned === owned && !entry.record.closedAt)
          && live.every(target => target.parentFrameId === owned.record.frameId
            && target.browserContextId === owned.record.browserContextId && this.targets.get(target.targetId).createdAt)
          && JSON.stringify(urls) === JSON.stringify(targetUrls);
        if (covered) {
          this.healthy();
          beforeDeadline(deadline, "Live cohort capture exceeded its absolute deadline.");
          insist(this.data.cohorts.length < 64, "WORKER_LIFECYCLE_OBSERVER_ERROR", "Worker cohort budget exceeded.");
          const cohort = { id: this.data.launchId + ":cohort-" + (this.data.cohorts.length + 1), label,
            pageId: owned.record.id, frameId: owned.record.frameId, capturedAt: now(),
            elapsedMs: Math.round(performance.now() - began), workerIds: entries.map(entry => entry.record.id),
            targetIds: live.map(target => target.targetId).sort(), urlMultiset: urls,
            ownership: live.map(target => ({ targetId: target.targetId, parentFrameId: target.parentFrameId,
              parentId: target.parentId ?? null, browserContextId: target.browserContextId })), retiredBy: null };
          this.data.cohorts.push(cohort);
          for (const entry of entries) entry.record.cohorts.push(cohort.id);
          for (const target of live) this.targets.get(target.targetId).cohorts.push(cohort.id);
          const result = clone(cohort);
          beforeDeadline(deadline, "Live cohort capture exceeded its absolute deadline.");
          return result;
        }
        mismatch = { liveTargetIds: live.map(target => target.targetId), liveWorkerCount: workers.length,
          workerUrls: urls, targetUrls, owningFrameId: owned.record.frameId, staleSnapshot: snapshot.stale };
        await this.pause(deadline);
      }
      throw new WorkerLifecycleError("WORKER_LIFECYCLE_COVERAGE",
        "Nonempty native/Playwright worker multiplicity and ownership were not established.", mismatch);
    });
  }
  async coverDuringStartup(page, label, procedure) {
    this.healthy();
    this.ownedPage(page);
    const cohorts = [];
    let pending = Promise.resolve(), coverageError = null;
    const capture = () => {
      pending = pending.then(async () => {
        if (coverageError || !page.workers().some(worker => !this.workers.get(worker)?.record.cohorts.length)) return;
        try { cohorts.push(await this.captureLive(page, label + ":startup")); }
        catch (error) { coverageError = error; }
      });
    };
    // Arm before boot creates even its first Worker. Each newly announced
    // generation must join a genuinely live cohort, including later pthreads.
    page.on("worker", capture);
    let result, startupError;
    try { capture(); result = await procedure(); }
    catch (error) { startupError = error; }
    finally { page.removeListener("worker", capture); }
    await pending;
    const failure = startupError ?? coverageError;
    if (failure) {
      failure.browserEvidence = { ...failure.browserEvidence, startupWorkerCohorts: cohorts,
        ...(coverageError ? { startupWorkerCoverageError: { code: coverageError.code ?? null,
          error: coverageError.stack ?? String(coverageError) } } : {}) };
      throw failure;
    }
    return { result, cohorts };
  }
  async assertEmpty(label, options = {}) {
    return this.refusal(label, async () => {
      this.healthy();
      const deadline = deadlineFor(options), began = performance.now();
      const closingPage = options.closedPage ? this.ownedPage(options.closedPage) : null;
      let failedObservation = null, deadlineCause = null;
      while (performance.now() < deadline) {
        let snapshot;
        try { snapshot = await this.targetsNow(deadline); }
        catch (error) {
          if (error instanceof WorkerLifecycleError && error.code === "WORKER_LIFECYCLE_DEADLINE") {
            this.healthy();
            if (failedObservation && performance.now() >= deadline) {
              deadlineCause = { code: error.code, message: error.message, at: now() };
              break;
            }
          }
          throw error;
        }
        if (snapshot.stale) { await this.pause(deadline); continue; }
        const native = [...this.targets.values()].filter(target => target.info?.type === "worker");
        const uncoveredTargets = native.filter(target => !target.cohorts.length).map(target => target.targetId);
        const uncoveredWorkers = this.data.workers.filter(worker => !worker.cohorts.length).map(worker => worker.id);
        insist(!uncoveredTargets.length && !uncoveredWorkers.length, "WORKER_LIFECYCLE_UNCOVERED",
          "A worker generation was never covered by a live native/Playwright cohort.", { uncoveredTargets, uncoveredWorkers });
        const liveTargets = snapshot.infos.filter(target => target.type === "worker");
        const unretiredTargets = native.filter(target => !target.destroyedAt);
        const presentIds = new Set(snapshot.infos.map(target => target.targetId));
        const openWorkers = [...this.pages.values()].filter(owned => !owned.page.isClosed())
          .flatMap(owned => owned.page.workers()).map(worker => this.workers.get(worker)?.record.id ?? "unobserved-worker");
        const unresolved = [];
        for (const { record, owned } of this.workers.values()) {
          if (record.closedAt) continue;
          if (!owned.record.closedAt || !owned.page.isClosed() || presentIds.has(owned.record.targetId))
            unresolved.push(record.id);
        }
        const closingPagePending = closingPage && (!closingPage.record.closedAt || !closingPage.page.isClosed()
          || presentIds.has(closingPage.record.targetId));
        if (!liveTargets.length && !unretiredTargets.length && !openWorkers.length && !unresolved.length && !closingPagePending) {
          this.healthy();
          beforeDeadline(deadline, "Worker cleanup proof exceeded its absolute deadline.");
          const proof = { id: this.data.launchId + ":proof-" + (this.data.proofs.length + 1), label,
            completedAt: now(), elapsedMs: Math.round(performance.now() - began), browserStillConnected: true,
            liveDedicatedTargetIds: [], retiredTargetIds: native.map(target => target.targetId).sort(),
            workerIds: this.data.workers.map(worker => worker.id).sort(),
            pageStates: this.data.pages.map(pageRecord => ({ pageId: pageRecord.id, closedAt: pageRecord.closedAt,
              targetId: pageRecord.targetId, targetAbsent: !presentIds.has(pageRecord.targetId),
              targetDestroyedAt: this.targets.get(pageRecord.targetId)?.destroyedAt ?? null })) };
          this.healthy();
          insist(this.data.proofs.length < 128, "WORKER_LIFECYCLE_OBSERVER_ERROR", "Worker proof budget exceeded.");
          this.data.proofs.push(proof);
          for (const cohort of this.data.cohorts) cohort.retiredBy ??= proof.id;
          for (const { record, owned } of this.workers.values()) record.resolution ??= {
            proofId: proof.id, at: now(), method: record.closedAt ? "close-callback-and-native-retirement" : "owner-page-close-and-native-retirement",
            ownerPageClosedAt: owned.record.closedAt };
          const result = clone(proof);
          beforeDeadline(deadline, "Worker cleanup proof exceeded its absolute deadline.");
          return result;
        }
        const code = liveTargets.length || openWorkers.length ? "WORKER_LIFECYCLE_NOT_EMPTY"
          : closingPagePending ? "WORKER_LIFECYCLE_PAGE_OPEN" : "WORKER_LIFECYCLE_UNRETIRED";
        failedObservation = { code, at: snapshot.at, details: { liveTargetIds: liveTargets.map(target => target.targetId),
          unretiredTargetIds: unretiredTargets.map(target => target.targetId), openWorkerIds: openWorkers,
          unresolvedWorkerIds: unresolved, closingPageTargetPending: closingPagePending ? closingPage.record.targetId : null } };
        await this.pause(deadline);
      }
      this.healthy();
      if (!failedObservation) throw new WorkerLifecycleError("WORKER_LIFECYCLE_DEADLINE",
        "No completed nonstale worker inventory established a result within the shared deadline.");
      throw new WorkerLifecycleError(failedObservation.code,
        "Worker cleanup was not proved within the shared deadline; the last completed inventory remained unsuccessful.",
        { ...failedObservation.details, lastValidObservationAt: failedObservation.at, deadlineCause });
    });
  }
  async closePage(page, label, options = {}) {
    return this.refusal(label, async () => {
      this.healthy();
      const deadline = deadlineFor(options), owned = this.ownedPage(page), began = performance.now();
      insist(!page.isClosed(), "WORKER_LIFECYCLE_OBSERVER_ERROR", "closePage requires its still-open owning page.");
      if (page.workers().length) {
        const entries = page.workers().map(worker => this.workers.get(worker));
        insist(entries.every(entry => entry?.record.cohorts.length), "WORKER_LIFECYCLE_UNCOVERED",
          "Capture this live worker generation before closing its page.");
        const snapshot = await this.targetsNow(deadline), live = snapshot.infos.filter(target => target.type === "worker");
        insist(live.every(target => this.targets.get(target.targetId).cohorts.length), "WORKER_LIFECYCLE_UNCOVERED",
          "A native worker generation was not captured before page closure.");
        insist(!snapshot.stale && live.length === entries.length
          && live.every(target => target.parentFrameId === owned.record.frameId && target.browserContextId === owned.record.browserContextId)
          && JSON.stringify(multiset(live.map(target => target.url))) === JSON.stringify(multiset(entries.map(entry => entry.record.url))),
          "WORKER_LIFECYCLE_COVERAGE", "The captured live worker cohort changed before page closure.");
      }
      const requestedAt = now();
      await bounded(page.close(), deadline, "Owning page close exceeded the shared cleanup deadline.");
      insist(owned.record.closedAt && page.isClosed(), "WORKER_LIFECYCLE_PAGE_OPEN", "The owning page-close event was not observed.");
      const proof = await this.assertEmpty(label, { deadline, closedPage: page });
      const pageState = proof.pageStates.find(state => state.pageId === owned.record.id);
      insist(pageState?.targetAbsent, "WORKER_LIFECYCLE_PAGE_OPEN", "The owning native page target is still present.");
      const result = { ...proof, closeRequestedAt: requestedAt, pageClosedAt: owned.record.closedAt,
        pageId: owned.record.id, totalBoundaryMs: Math.round(performance.now() - began) };
      beforeDeadline(deadline, "Owning page cleanup exceeded its absolute deadline.");
      return result;
    });
  }
  resolvedMembership(proof) {
    insist([...this.targets.values()].every(target => target.info), "WORKER_LIFECYCLE_OBSERVER_ERROR",
      "A target of unknown kind cannot be excluded from the sealed proof.");
    const native = [...this.targets.values()].filter(target => target.info.type === "worker");
    insist(this.data.workers.every(worker => worker.cohorts.length && worker.resolution)
      && this.data.cohorts.every(cohort => cohort.retiredBy)
      && native.every(target => target.cohorts.length && target.destroyedAt), "WORKER_LIFECYCLE_UNRETIRED",
      "The launch has unresolved workers, cohorts or native worker targets.");
    const membership = { workerIds: this.data.workers.map(worker => worker.id).sort(),
      workerTargetIds: native.map(target => target.targetId).sort() };
    insist(JSON.stringify(membership.workerIds) === JSON.stringify(proof.workerIds)
      && JSON.stringify(membership.workerTargetIds) === JSON.stringify(proof.retiredTargetIds),
      "WORKER_LIFECYCLE_OBSERVER_ERROR", "Worker membership changed after the connected cleanup proof.", membership);
    return membership;
  }
  async sealForBrowserClose(label, options = {}) {
    this.healthy();
    const deadline = deadlineFor(options);
    const proof = await this.assertEmpty(label, { ...options, deadline });
    this.healthy();
    const membership = this.resolvedMembership(proof);
    beforeDeadline(deadline, "Sealed cleanup proof exceeded its absolute deadline.");
    this.data.sealed = { at: now(), proofId: proof.id, label, ...membership };
    return proof;
  }
  confirmBrowserClosed() {
    insist(this.data.sealed, "WORKER_LIFECYCLE_OBSERVER_ERROR", "Browser shutdown had no prior connected cleanup proof.");
    insist(!this.browser.isConnected() && this.data.disconnected?.expectedAfterSealedProof,
      "WORKER_LIFECYCLE_OBSERVER_ERROR", "The sealed browser's disconnect event was not observed.");
    const error = this.data.errors[0];
    if (error) throw new WorkerLifecycleError(error.code, error.message, error.details);
    this.resolvedMembership({ workerIds: this.data.sealed.workerIds, retiredTargetIds: this.data.sealed.workerTargetIds });
    return this.snapshot();
  }
  snapshot() {
    return clone({ ...this.data, targets: [...this.targets.values()],
      unresolvedWorkerIds: this.data.workers.filter(worker => !worker.resolution).map(worker => worker.id),
      unretiredCohortIds: this.data.cohorts.filter(cohort => !cohort.retiredBy).map(cohort => cohort.id) });
  }
}

export async function attachWorkerLifecycle(browser, options = {}) {
  const observer = new WorkerLifecycleObserver(browser, options);
  return observer.initialize(deadlineFor(options));
}

