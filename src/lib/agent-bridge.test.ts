// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { CommandRunner, createMachineBridge, installAgentBridge, type RunnerRuntime, type BridgeMachine } from "./agent-bridge.ts";
import { MAX_OUTPUT_BYTES } from "./command-protocol.ts";
import type { RuntimeSnapshot, MachineRuntime, RuntimeCapabilities } from "./runtime-types.ts";

class FakeRuntime implements RunnerRuntime {
  state: RuntimeSnapshot = {
    status: "running",
    operation: null,
    message: "Ready",
    downloadProgress: 100,
    startedAt: 1,
  };
  outputListeners = new Set<(data: string) => void>();
  stateListeners = new Set<(state: RuntimeSnapshot) => void>();
  replay = "";
  sent: string[] = [];
  onSend: ((text: string) => void) | null = null;
  interruptNextSubscription = false;

  getSnapshot(): RuntimeSnapshot {
    return this.state;
  }
  send(text: string): void {
    this.sent.push(text);
    this.onSend?.(text);
  }
  onOutput(listener: (data: string) => void): () => void {
    this.outputListeners.add(listener);
    if (this.replay) listener(this.replay);
    return () => {
      this.outputListeners.delete(listener);
    };
  }
  subscribe(listener: (state: RuntimeSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    if (this.interruptNextSubscription) {
      this.interruptNextSubscription = false;
      this.state = { ...this.state, status: "paused" };
    }
    listener(this.state);
    return () => {
      this.stateListeners.delete(listener);
    };
  }
  emit(data: string): void {
    this.outputListeners.forEach((listener) => listener(data));
  }
  update(status: RuntimeSnapshot["status"]): void {
    this.state = { ...this.state, status };
    this.stateListeners.forEach((listener) => listener(this.state));
  }
  updateOperation(operation: RuntimeSnapshot["operation"]): void {
    this.state = { ...this.state, operation };
    this.stateListeners.forEach((listener) => listener(this.state));
  }
}

function output(token: string, text: string, exitCode = 0): string {
  return `\n__TRM_BEGIN_${token}__\n${text}\n__TRM_END_${token}__:${exitCode}\n`;
}

test("boot cancellation uses the workspace owner and refuses running guests or unrelated operations", async () => {
  const target = new FakeRuntime();
  const runner = new CommandRunner(target);
  let ownerCalls = 0, destroyed = 0, mutable = true;
  const runtime = Object.assign(target, {
    capabilities: { label: "Fixture", architecture: "x86_64", serialPorts: [0], interactivePorts: [0], snapshots: true, initScripts: true, cancelBoot: true } as RuntimeCapabilities,
    destroy: async () => { destroyed++; },
  }) as unknown as MachineRuntime;
  const bridge = createMachineBridge(runtime, runner, undefined, undefined, undefined,
    () => { if (!mutable) throw new Error("Not the writable workspace owner"); },
    async () => { ownerCalls++; target.update("idle"); });
  try {
    await assert.rejects(bridge.cancelBoot(), /only while/);
    target.update("booting"); target.updateOperation("restoring");
    await assert.rejects(bridge.cancelBoot(), /outside another operation/);
    target.updateOperation(null); mutable = false;
    await assert.rejects(bridge.cancelBoot(), /writable workspace owner/);
    mutable = true;
    assert.equal((await bridge.cancelBoot()).status, "idle");
    assert.equal(ownerCalls, 1); assert.equal(destroyed, 0, "workspace cleanup must own the managed teardown");
    runtime.capabilities.cancelBoot = false; target.update("loading");
    await assert.rejects(bridge.cancelBoot(), /does not support/);
  } finally { runner.dispose(); }
});

test("only live output completes a run, even with a matching replay and failing observer", async () => {
  const target = new FakeRuntime();
  target.replay = output("live", "stale") + "old transcript".repeat(100_000);
  const runner = new CommandRunner(target, { createId: () => "live" });
  runner.subscribe(() => {
    throw new Error("UI observer failure");
  });
  target.onSend = () => target.emit(output("live", "fresh\n", 7));
  const result = await runner.execute("echo fresh");
  assert.equal(result.output, "fresh\n");
  assert.equal(result.exitCode, 7);
  assert.equal(result.status, "exited");
  assert.equal(result.recovery, "not_needed");
  assert.equal(runner.isBusy(), false);
  assert.equal(target.outputListeners.size, 0);
  assert.equal(target.stateListeners.size, 1);
  assert.equal(runner.getState().runs.length, 1);
  runner.dispose();
});

test("the command lock prevents overlap and preserves a nonzero guest result", async () => {
  const target = new FakeRuntime();
  const runner = new CommandRunner(target, { createId: () => "locked" });
  const pending = runner.execute("false");
  await assert.rejects(runner.execute("echo overlapping"), /Another command/);
  assert.equal(target.sent.length, 1);
  target.emit(output("locked", "", 1));
  const result = await pending;
  assert.equal(result.exitCode, 1);
  assert.equal(runner.isBusy(), false);
  runner.dispose();
});

test("volume maintenance blocks public commands but permits the owning internal sync", async () => {
  const target = new FakeRuntime();
  const runner = new CommandRunner(target, { createId: () => "volumesync" });
  target.state = { ...target.state, volumeOperation: "syncing" };
  assert.equal(runner.getState().ready, false);
  await assert.rejects(runner.execute("echo competing"), /volume operation/);
  assert.equal(target.sent.length, 0);
  target.onSend = () => target.emit(output("volumesync", "", 0));
  const result = await runner.executeInternal("sync");
  assert.equal(result.exitCode, 0);
  assert.equal(runner.getState().runs.length, 0);
  assert.equal(runner.getState().ready, false);
  target.state = { ...target.state, volumeOperation: null };
  assert.equal(runner.getState().ready, true);
  runner.dispose();
});

test("a state change during subscription cleans up before any command is sent", async () => {
  const target = new FakeRuntime();
  const runner = new CommandRunner(target, { createId: () => "paused" });
  target.interruptNextSubscription = true;
  const result = await runner.execute("echo never sent");
  assert.equal(result.status, "interrupted");
  assert.equal(result.exitCode, null);
  assert.equal(result.recovery, "reset_required");
  assert.equal(target.sent.length, 0);
  assert.equal(target.outputListeners.size, 0);
  assert.equal(target.stateListeners.size, 1);
  runner.dispose();
});

test("a deadline holds the lock until recovery is acknowledged and keeps exit status unknown", async () => {
  const target = new FakeRuntime();
  let sequence = 0;
  const runner = new CommandRunner(target, {
    createId: () => `deadline${++sequence}`,
    recoveryDelayMs: 1,
    recoveryTimeoutMs: 200,
  });
  target.onSend = (text) => {
    if (text.includes("__TRM_READY_deadline1r__"))
      target.emit("\n__TRM_READY_deadline1r__\n");
    else if (text.includes("__TRM_BEGIN_deadline1__"))
      target.emit("\n__TRM_BEGIN_deadline1__\nworking");
    else if (text.includes("__TRM_BEGIN_deadline2__"))
      target.emit(output("deadline2", "next"));
  };
  const result = await runner.execute("sleep 20", { timeoutMs: 1000 });
  assert.equal(result.status, "timed_out");
  assert.equal(result.output, "working");
  assert.equal(result.exitCode, null);
  assert.equal(result.recovery, "recovered");
  assert.ok(target.sent.includes("\x03"));
  assert.equal(runner.getState().ready, true);
  assert.equal((await runner.execute("echo next")).output, "next");
  assert.equal(target.outputListeners.size, 0);
  runner.dispose();
});

test("streaming output is capped by UTF-8 bytes and recovers before releasing the lock", async () => {
  const target = new FakeRuntime();
  const runner = new CommandRunner(target, {
    createId: () => "bounded",
    recoveryDelayMs: 1,
    recoveryTimeoutMs: 200,
  });
  target.onSend = (text) => {
    if (text.includes("__TRM_READY_boundedr__"))
      target.emit("\n__TRM_READY_boundedr__\n");
    else if (text.includes("__TRM_BEGIN_bounded__"))
      target.emit("\n__TRM_BEGIN_bounded__\n" + "🤖".repeat(20_000));
  };
  const result = await runner.execute("produce output");
  assert.equal(result.status, "output_limit");
  assert.equal(
    new TextEncoder().encode(result.output).byteLength,
    MAX_OUTPUT_BYTES,
  );
  assert.equal(result.exitCode, null);
  assert.equal(result.recovery, "recovered");
  assert.equal(runner.isBusy(), false);
  runner.dispose();
});

test("failed recovery blocks future commands across pause/resume until a fresh boot lifecycle", async () => {
  const target = new FakeRuntime();
  let sequence = 0;
  const runner = new CommandRunner(target, {
    createId: () => `blocked${++sequence}`,
    recoveryDelayMs: 1,
    recoveryTimeoutMs: 20,
  });
  target.onSend = (text) => {
    if (text.includes("__TRM_BEGIN_blocked1__"))
      target.emit(
        "\n__TRM_BEGIN_blocked1__\n" + "x".repeat(MAX_OUTPUT_BYTES + 1),
      );
    else if (text.includes("__TRM_BEGIN_blocked2__"))
      target.emit(output("blocked2", "after reset"));
  };
  const result = await runner.execute("unresponsive command");
  assert.equal(result.recovery, "reset_required");
  assert.equal(result.exitCode, null);
  assert.match(result.message ?? "", /may still be running/);
  assert.equal(runner.getState().ready, false);
  await assert.rejects(runner.execute("next"), /Reset Linux/);
  target.update("paused");
  target.update("running");
  await assert.rejects(runner.execute("next"), /Reset Linux/);
  target.update("idle");
  target.update("loading");
  target.update("running");
  assert.equal((await runner.execute("next")).output, "after reset");
  assert.equal(target.outputListeners.size, 0);
  runner.dispose();
});

test("checkpoint operations make the command channel unavailable without sending input", async () => {
  const target = new FakeRuntime();
  const runner = new CommandRunner(target, { createId: () => "checkpoint" });
  let observedReady: boolean | undefined;
  runner.subscribe((state) => {
    observedReady = state.ready;
  });
  target.updateOperation("saving");
  assert.equal(runner.getState().ready, false);
  assert.equal(observedReady, false);
  await assert.rejects(
    runner.execute("echo during save"),
    /checkpoint operation/,
  );
  target.updateOperation("restoring");
  await assert.rejects(
    runner.execute("echo during restore"),
    /checkpoint operation/,
  );
  assert.equal(target.sent.length, 0);
  target.updateOperation(null);
  assert.equal(observedReady, true);
  target.onSend = () => target.emit(output("checkpoint", "after checkpoint"));
  assert.equal(
    (await runner.execute("echo after checkpoint")).output,
    "after checkpoint",
  );
  runner.dispose();
});

test("an unexpected checkpoint during execution interrupts tracking and requires reset", async () => {
  const target = new FakeRuntime();
  const runner = new CommandRunner(target, {
    createId: () => "checkpointRace",
  });
  target.onSend = () => {
    target.emit("\n__TRM_BEGIN_checkpointRace__\npartial output");
    target.updateOperation("saving");
  };
  const result = await runner.execute("slow command");
  assert.equal(result.status, "interrupted");
  assert.equal(result.output, "partial output");
  assert.equal(result.exitCode, null);
  assert.equal(result.recovery, "reset_required");
  target.updateOperation(null);
  await assert.rejects(runner.execute("next"), /Reset Linux/);
  assert.equal(target.outputListeners.size, 0);
  assert.equal(target.stateListeners.size, 1);
  runner.dispose();
});

test("startup holds the command gate until control is ready", async () => {
  const target = new FakeRuntime();
  target.state = { ...target.state, controlReady: false };
  const runner = new CommandRunner(target, { createId: () => "startup" });
  assert.equal(runner.getState().ready, false);
  assert.match(
    runner.getState().blockedReason ?? "",
    /did not recover after startup/,
  );
  await assert.rejects(
    runner.execute("too early"),
    /did not recover after startup/,
  );
  assert.equal(target.sent.length, 0);
  target.state = { ...target.state, controlReady: true };
  target.update("running");
  target.onSend = () => target.emit(output("startup", "ready"));
  assert.equal((await runner.execute("after startup")).output, "ready");
  runner.dispose();
});

test("host maintenance shares the user command lock and recovery without entering history", async () => {
  const target = new FakeRuntime();
  let sequence = 0;
  const runner = new CommandRunner(target, {
    createId: () => `maintenance${++sequence}`,
  });
  const maintenance = runner.executeInternal(
    "stty -F /dev/ttyS1 rows 30 cols 90",
  );
  assert.equal(runner.isBusy(), true);
  await assert.rejects(
    runner.execute("user command during resize"),
    /Another command/,
  );
  target.emit(output("maintenance1", "", 0));
  assert.equal((await maintenance).status, "exited");
  assert.equal(runner.getState().runs.length, 0);
  const command = runner.execute("user command");
  await assert.rejects(
    runner.executeInternal("resize during user command"),
    /Another command/,
  );
  target.emit(output("maintenance2", "visible"));
  assert.equal((await command).output, "visible");
  assert.equal(runner.getState().runs.length, 1);
  runner.dispose();
});

test("only a successful restore with an explicitly recovered shell clears uncertain tracking", async () => {
  const target = new FakeRuntime();
  const runner = new CommandRunner(target, { createId: () => "restored" });
  target.onSend = () => target.updateOperation("saving");
  const result = await runner.execute("interrupted");
  assert.equal(result.recovery, "reset_required");
  target.updateOperation(null);
  assert.equal(runner.getState().ready, false);
  target.updateOperation("restoring");
  target.state = { ...target.state, controlReady: false };
  target.updateOperation(null);
  assert.equal(runner.getState().ready, false);
  target.updateOperation("restoring");
  target.state = { ...target.state, controlReady: true };
  target.updateOperation(null);
  assert.equal(runner.getState().ready, true);
  target.onSend = () => target.emit(output("restored", "from checkpoint"));
  assert.equal(
    (await runner.execute("read restored state")).output,
    "from checkpoint",
  );
  runner.dispose();
});

class BridgeRuntime extends FakeRuntime implements MachineRuntime {
  capabilities: RuntimeCapabilities = { label: "Test Linux", architecture: "x86", serialPorts: [0], interactivePorts: [0], snapshots: true, initScripts: true };
  initScript = "";
  async boot() { this.update("running"); }
  async pause() { this.update("paused"); }
  async resume() { this.update("running"); }
  async reset() { this.replay = ""; this.update("idle"); this.update("running"); }
  async save() { return new ArrayBuffer(0); }
  async restore() { this.update("running"); }
  async destroy() { this.update("idle"); }
  setInitScript(script: string) { this.initScript = script; }
  getInitScript() { return this.initScript; }
  override emit(data: string) { this.replay += data; super.emit(data); }
}

test("installed page API preserves structured results, stable targets, and explicit output subscriptions", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true, writable: true });
  const targets = [new BridgeRuntime(), new BridgeRuntime()];
  const entries: BridgeMachine[] = targets.map((runtime, index) => {
    runtime.state = { ...runtime.state, status: "idle" };
    runtime.onSend = (frame) => {
      const token = frame.match(/__TRM_BEGIN_([a-zA-Z0-9]+)__/)?.[1];
      if (token) runtime.emit(output(token, `Linux machine-${index}\n`, index));
    };
    return { id: `machine-${index}`, name: `machine-${index}`, runtime, runner: new CommandRunner(runtime) };
  });
  let active = entries[0];
  const originalLog = console.log;
  const logs: unknown[][] = [];
  console.log = (...args) => { logs.push(args); };
  try {
    installAgentBridge({ active: () => active, list: () => entries, get: (id) => entries.find((entry) => entry.id === id) });
    const vm = window.terrarium.get(window.terrarium.list()[0].id);
    assert.equal((await vm.boot()).status, "running");
    const result = await vm.exec("uname -a");
    assert.equal(result.output, "Linux machine-0\n");
    assert.equal(result.exitCode, 0);
    assert.equal(result.status, "exited");
    assert.equal(logs.length, 0, "VM output is never implicitly mirrored");
    assert.equal(console.log(result.output, result.exitCode), undefined, "console.log return is unrelated to the exec result");
    assert.match(vm.readOutput(), /Linux machine-0/);
    const live: string[] = [];
    const stop = vm.subscribeOutput((event) => live.push(event.data));
    assert.deepEqual(live, []);
    active = entries[1];
    await window.terrarium.boot();
    assert.equal((await window.terrarium.exec("false")).exitCode, 1);
    assert.deepEqual(live, [], "Changing the active machine does not retarget a stable subscription");
    await vm.exec("uname -a");
    assert.match(live.join(""), /machine-0/);
    stop();
    const length = live.length;
    await vm.exec("uname -a");
    assert.equal(live.length, length);
    const stopMirror = window.terrarium.mirrorOutput();
    await window.terrarium.exec("uname -a");
    assert.match(String(logs.at(-1)?.[0]), /machine-1 \/ serial 0/);
    stopMirror(); stopMirror();
    const count = logs.length;
    await window.terrarium.exec("uname -a");
    assert.equal(logs.length, count);
    assert.equal((await vm.pause()).status, "paused");
    assert.equal((await vm.resume()).status, "running");
    assert.throws(() => window.terrarium.get("missing"), /No machine/);
    targets[0].update("booting");
    await assert.rejects(vm.exec("too early"), /Await vm.boot/);
  } finally {
    console.log = originalLog;
    for (const entry of entries) entry.runner.dispose();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
