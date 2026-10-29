// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';

export function assertLiveOwnerRefusal(refusal, saved) {
  assert.ok(refusal, 'Readiness must not bypass the replacement live owner');
  assert.equal(refusal.readinessFailure?.stage, 'lock-release');
  assert.equal(refusal.readinessFailure.budgetMs, 30_000);
  // setTimeout truncates fractional milliseconds; permit only that small
  // scheduling boundary, never an unrelated early failure or diagnostic time.
  assert.ok(refusal.readinessFailure.elapsedMs >= 29_999, 'The live-owner negative must exercise the full readiness budget');
  assert.match(refusal.error, /Workspace readiness exceeded 30000 ms|The closed owner's workspace lock was not released within the readiness budget/);
  assert.equal(refusal.beforeTakeControl?.workspace.mode, 'read-only');
  assert.equal(refusal.beforeTakeControl?.locks.held.filter(lock => lock.name === 'terrarium-workspace-writer-v1').length, 1);
  assert.equal(refusal.takeControlRequested, false);
  assert.equal(refusal.readiness.workspace.mode, 'read-only');
  assert.equal(refusal.readiness.manifest, saved);
  assert.equal(refusal.readiness.locks.held.filter(lock => lock.name === 'terrarium-workspace-writer-v1').length, 1);
}
