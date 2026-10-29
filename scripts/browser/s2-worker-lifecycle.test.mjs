// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attachWorkerLifecycle } from './s2-worker-lifecycle.mjs';

async function fixture() {
  const session = new EventEmitter(), browser = new EventEmitter(), page = new EventEmitter();
  const pageInfo = { targetId: 'page', type: 'page', url: 'http://localhost/', browserContextId: 'context' };
  let live = [], workers = [], connected = true, closed = false;
  session.send = async method => method === 'Target.getTargets' ? { targetInfos: [pageInfo, ...live] } : {};
  browser.version = () => 'fixture'; browser.newBrowserCDPSession = async () => session; browser.isConnected = () => connected;
  const context = { browser: () => browser, newCDPSession: async () => ({ send: async method =>
    method === 'Target.getTargetInfo' ? { targetInfo: pageInfo } : { frameTree: { frame: { id: 'frame' } } } }) };
  page.context = () => context; page.isClosed = () => closed; page.workers = () => workers;
  const observer = await attachWorkerLifecycle(browser, { launchId: 'fixture' }); await observer.observePage(page);
  const create = id => {
    const worker = new EventEmitter(); worker.url = () => 'http://localhost/worker.js';
    const info = { targetId: id, type: 'worker', url: worker.url(), parentFrameId: 'frame', browserContextId: 'context' };
    live.push(info); workers.push(worker); session.emit('Target.targetCreated', { targetInfo: info }); page.emit('worker', worker);
    return worker;
  };
  const retire = () => { for (const info of live) session.emit('Target.targetDestroyed', { targetId: info.targetId });
    for (const worker of workers) worker.emit('close'); live = []; workers = []; };
  const finish = async () => { await observer.sealForBrowserClose('connected'); connected = false;
    browser.emit('disconnected'); observer.confirmBrowserClosed(); };
  return { observer, page, create, retire, finish };
}

for (const fails of [false, true]) test(`startup cohorts cover later worker generations before ${fails ? 'boot rejection' : 'success'}`, async () => {
  const f = await fixture(), injected = new Error('injected startup timeout');
  const procedure = async () => {
    f.create('one');
    while (!f.observer.snapshot().cohorts.length) await new Promise(resolve => setTimeout(resolve, 1));
    f.create('two');
    while (f.observer.snapshot().workers.some(w => !w.cohorts.length)) await new Promise(resolve => setTimeout(resolve, 1));
    f.retire(); if (fails) throw injected; return 'booted';
  };
  if (fails) await assert.rejects(f.observer.coverDuringStartup(f.page, 'boot', procedure), e => e === injected);
  else assert.equal((await f.observer.coverDuringStartup(f.page, 'boot', procedure)).result, 'booted');
  await f.finish();
  assert.equal(f.observer.snapshot().unresolvedWorkerIds.length, 0);
});

test('retirement without a live cohort still refuses cleanup', async () => {
  const f = await fixture(); f.create('uncaptured'); f.retire();
  await assert.rejects(f.observer.assertEmpty('uncaptured'), { code: 'WORKER_LIFECYCLE_UNCOVERED' });
});

test('startup observer failures cannot be hidden by successful boot', async () => {
  const f = await fixture(); const injected = new Error('cohort observation failed');
  f.observer.captureLive = async () => { throw injected; };
  await assert.rejects(f.observer.coverDuringStartup(f.page, 'boot', async () => {
    f.create('one'); await new Promise(resolve => setTimeout(resolve, 5)); f.retire(); return 'booted';
  }), e => e === injected);
});
