// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { assertLiveOwnerRefusal } from './s2-readiness-evidence.mjs';

// Compile only the current production collector, never the top-level browser
// harness. Exact, unique line anchors make source drift fail closed.
const source = await readFile(new URL('./smoke-s2.mjs', import.meta.url), 'utf8');
function extractReady(text) {
  const starts = [...text.matchAll(/^async function ready\(page, \{ closedOwner \} = \{\}\) \{$/gm)];
  const ends = [...text.matchAll(/^async function fixtureContext\(\) \{$/gm)];
  assert.equal(starts.length, 1, 'Expected one explicit ready anchor');
  assert.equal(ends.length, 1, 'Expected one explicit fixtureContext anchor');
  assert.ok(ends[0].index > starts[0].index, 'Collector boundaries must be ordered');
  const body = text.slice(starts[0].index, ends[0].index).trimEnd();
  assert.ok(body.endsWith('\n}'), 'Collector must end at its closing brace');
  return body;
}
const readySource = extractReady(source);
const snapshot = () => ({ workspace: { mode: 'read-only' }, manifest: 'saved',
  locks: { held: [{ name: 'terrarium-workspace-writer-v1' }], pending: [] } });

test('collector extraction fails closed on missing, duplicate or reversed anchors', () => {
  assert.throws(() => extractReady(source.replace('async function ready(', 'async function renamed(')));
  assert.throws(() => extractReady(source + '\nasync function ready(page, { closedOwner } = {}) {\n'));
  assert.throws(() => extractReady(source.replace('async function fixtureContext()', 'async function renamedContext()')));
  assert.throws(() => extractReady('async function fixtureContext() {\nasync function ready(page, { closedOwner } = {}) {\n}'));
});

async function collect(scenario, { realClock = false } = {}) {
  let clock = 100, calls = 0, nextTimer = 0, releaseQuery, pendingQuery;
  const timers = new Map(), context = {};
  const ready = vm.runInNewContext(`(${readySource})`, {
    assert, performance: realClock ? performance : { now: () => clock },
    setTimeout: (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const page = {
    context: () => context,
    waitForFunction: async () => {},
    evaluate: async (query, budgetMs) => {
      calls++;
      assert.match(String(query), /navigator\.locks\.query\(\)/, 'Exercise the native-query Page boundary');
      if (calls === 1 && scenario === 'initial-query-error') {
        clock = 112; throw new Error('Injected native query failure');
      }
      if (calls === 2 && scenario !== 'initial-query-error') {
        assert.equal(budgetMs, 30000, 'Initial observation must leave the original budget intact');
        if (scenario === 'poll-query-error') {
          clock = 112; throw new Error('Injected native query failure');
        }
        if (scenario === 'budget-boundary') {
          clock = 30100;
          throw new Error("The closed owner's workspace lock was not released within the readiness budget");
        }
        assert.equal(scenario, 'outer-timeout');
        pendingQuery = new Promise((_, reject) => { releaseQuery = reject; });
        return pendingQuery;
      }
      // Only failure diagnostics advance the synthetic clock by 40 seconds.
      // Recorded failure elapsed must already have been captured by ready().
      if (calls > 1 && !realClock) clock += 40000;
      return snapshot();
    },
  };
  let guard;
  try {
    const pending = ready(page, { closedOwner: { context: () => context, isClosed: () => true } });
    // Attach rejection handling before invoking any injected timer callback.
    const outcome = pending.then(() => { throw new Error('Collector unexpectedly succeeded'); },
      error => ({ error: String(error), ...error.browserEvidence }));
    if (scenario === 'outer-timeout') {
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls, 2);
      assert.equal(timers.size, 1);
      const outer = [...timers.values()][0];
      assert.equal(outer.ms, 30000);
      clock = 30100; outer.callback(); // Actual ready() outer timeout callback.
    }
    const refusal = await Promise.race([outcome, new Promise((_, reject) => {
      guard = setTimeout(() => reject(new Error('Collector fixture did not settle')), 500);
    })]);
    assert.equal(calls, scenario === 'initial-query-error' ? 2 : 3);
    assert.deepEqual(refusal.readiness, snapshot(), 'Failure diagnostics retain unchanged bytes and the held owner');
    assert.equal(refusal.takeControlRequested, false);
    assert.equal(timers.size, 0, 'Collector must clear both outer and diagnostic timers');
    console.log('COLLECTOR_RECEIPT ' + JSON.stringify({ scenario,
      clock: realClock ? 'actual Node monotonic; fake Page' : 'synthetic monotonic; fake Page; no real full-budget wait', refusal }));
    return refusal;
  } finally {
    clearTimeout(guard);
    // The outer timeout wins while the Page query is unresolved. Explicitly
    // reject and drain it so no unfinished fixture task escapes this case.
    releaseQuery?.(new Error('Fixture query cleanup'));
    await pendingQuery?.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(timers.size, 0, 'No fake timer may escape the isolated VM');
  }
}

for (const scenario of ['initial-query-error', 'poll-query-error']) {
  test(`collector rejects early native failure: ${scenario}`, { timeout: 2000 }, async () => {
    const refusal = await collect(scenario);
    assert.equal(refusal.readinessFailure.stage, scenario === 'initial-query-error' ? 'initial-observation' : 'lock-release');
    assert.equal(refusal.readinessFailure.budgetMs, 30000);
    assert.equal(refusal.readinessFailure.elapsedMs, 12, 'Slow failure diagnostics must not inflate elapsed');
    assert.match(refusal.error, /Injected native query failure/);
    if (scenario === 'initial-query-error') assert.equal(refusal.beforeTakeControl, null);
    else assert.deepEqual(refusal.beforeTakeControl, snapshot());
    assert.throws(() => assertLiveOwnerRefusal(refusal, 'saved'), { code: 'ERR_ASSERTION' });
  });
}
test('collector rejects fast initial native failure with actual monotonic clock', { timeout: 2000 }, async () => {
  const refusal = await collect('initial-query-error', { realClock: true });
  assert.equal(refusal.readinessFailure.stage, 'initial-observation');
  assert.ok(refusal.readinessFailure.elapsedMs < 29999);
  assert.equal(refusal.beforeTakeControl, null);
  assert.throws(() => assertLiveOwnerRefusal(refusal, 'saved'), { code: 'ERR_ASSERTION' });
});
for (const scenario of ['budget-boundary', 'outer-timeout']) {
  test(`collector synthetic positive control: ${scenario}`, { timeout: 2000 }, async () => {
    const refusal = await collect(scenario);
    assert.equal(refusal.readinessFailure.stage, 'lock-release');
    assert.equal(refusal.readinessFailure.elapsedMs, 30000);
    assert.deepEqual(refusal.beforeTakeControl, snapshot());
    assertLiveOwnerRefusal(refusal, 'saved');
  });
}
