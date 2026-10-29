// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLiveOwnerRefusal } from './s2-readiness-evidence.mjs';
const snapshot = () => ({ workspace: { mode: 'read-only' }, manifest: 'saved',
  locks: { held: [{ name: 'terrarium-workspace-writer-v1' }] } });
const evidence = () => ({ error: 'Error: Workspace readiness exceeded 30000 ms',
  readinessFailure: { stage: 'lock-release', budgetMs: 30000, elapsedMs: 30000 },
  beforeTakeControl: snapshot(), takeControlRequested: false, readiness: snapshot() });

// Each fixture changes exactly one material predicate. A different rejection
// (including a malformed fixture throwing TypeError) must not count as coverage.
const predicates = [
  ['failure-stage', r => { r.readinessFailure.stage = 'initial-observation'; }, 'strictEqual'],
  ['budget-30000', r => { r.readinessFailure.budgetMs = 29999; }, 'strictEqual'],
  ['elapsed-lower-bound', r => { r.readinessFailure.elapsedMs = 29998; }, '=='],
  ['expected-category', r => { r.error = 'Error: injected native query failure'; }, 'match'],
  ['initial-read-only', r => { r.beforeTakeControl.workspace.mode = 'writable'; }, 'strictEqual'],
  ['initial-owner-held', r => { r.beforeTakeControl.locks.held = []; }, 'strictEqual'],
  ['no-takeover', r => { r.takeControlRequested = true; }, 'strictEqual'],
  ['final-read-only', r => { r.readiness.workspace.mode = 'writable'; }, 'strictEqual'],
  ['saved-bytes-unchanged', r => { r.readiness.manifest = 'changed'; }, 'strictEqual'],
  ['final-owner-held', r => { r.readiness.locks.held = []; }, 'strictEqual'],
];
for (const [id, mutate, operator] of predicates) {
  test(`live-owner predicate: ${id}`, () => {
    const value = evidence();
    assertLiveOwnerRefusal(value, 'saved');
    mutate(value);
    assert.throws(() => assertLiveOwnerRefusal(value, 'saved'),
      { code: 'ERR_ASSERTION', operator });
  });
}
test('live-owner rejects null initial observation', () => {
  const value = evidence(); value.beforeTakeControl = null;
  assert.throws(() => assertLiveOwnerRefusal(value, 'saved'), { code: 'ERR_ASSERTION' });
});
for (const elapsedMs of [29998, 29999, 30000]) {
  test(`live-owner elapsed boundary: ${elapsedMs}`, () => {
    const value = evidence(); value.readinessFailure.elapsedMs = elapsedMs;
    if (elapsedMs === 29998) assert.throws(() => assertLiveOwnerRefusal(value, 'saved'),
      { code: 'ERR_ASSERTION', message: 'The live-owner negative must exercise the full readiness budget' });
    else assertLiveOwnerRefusal(value, 'saved');
  });
}
