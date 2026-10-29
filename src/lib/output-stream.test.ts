// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { OutputTextFilter, outputTail, readRuntimeOutput, subscribeRuntimeOutput, type OutputEvent } from "./output-stream.ts";
import type { OutputListener, RuntimeCapabilities, RuntimeListener, RuntimeSnapshot, SerialPort } from "./runtime-types.ts";

class OutputRuntime {
  capabilities: RuntimeCapabilities = { label: "test", architecture: "x86", serialPorts: [0, 1], interactivePorts: [1], snapshots: true, initScripts: true };
  state: RuntimeSnapshot = { status: "running", operation: null, message: "Ready", downloadProgress: 100, startedAt: 1, displayEpoch: 0 };
  stateListeners = new Set<RuntimeListener>();
  outputListeners = [new Set<OutputListener>(), new Set<OutputListener>()];
  transcripts = ["", ""];
  getSnapshot() { return this.state; }
  subscribe(listener: RuntimeListener) { this.stateListeners.add(listener); listener(this.state); return () => { this.stateListeners.delete(listener); }; }
  onOutput(listener: OutputListener, port: SerialPort = 0) { this.outputListeners[port].add(listener); if (this.transcripts[port]) listener(this.transcripts[port]); return () => { this.outputListeners[port].delete(listener); }; }
  emit(data: string, port: 0 | 1 = 0) { this.transcripts[port] += data; for (const listener of this.outputListeners[port]) listener(data); }
  reset() { this.transcripts = ["", ""]; this.state = { ...this.state, displayEpoch: (this.state.displayEpoch ?? 0) + 1 }; for (const listener of this.stateListeners) listener(this.state); }
}

test("one-shot reads select a real port, preserve raw serial text, and leave no listeners", () => {
  const source = new OutputRuntime();
  source.emit("\x1b[32mLinux\x1b[0m\r\n");
  source.emit("shell one\n", 1);
  assert.equal(readRuntimeOutput(source), "Linux\n");
  assert.equal(readRuntimeOutput(source, { format: "raw" }), "\x1b[32mLinux\x1b[0m\r\n");
  assert.equal(readRuntimeOutput(source, { port: 1 }), "shell one\n");
  assert.equal(source.outputListeners.flatMap((set) => [...set]).length, 0);
  assert.equal(source.stateListeners.size, 0);
  assert.throws(() => readRuntimeOutput(source, { port: 3 }), /not available/);
});

test("live-only is the default, replay is explicit, reset is observable, and stop fully detaches", () => {
  const source = new OutputRuntime();
  source.emit("old\r\n\x1b[");
  const events: Readonly<OutputEvent>[] = [];
  const stop = subscribeRuntimeOutput(source, (event) => events.push(event));
  assert.equal(events.length, 0);
  source.emit("31mnew\x1b[0m\r");
  source.emit("\nnext");
  assert.equal(events.map((event) => event.data).join(""), "new\nnext");
  assert.ok(events.every((event) => !event.replay));
  const replayed: Readonly<OutputEvent>[] = [];
  const detachReplay = subscribeRuntimeOutput(source, (event) => replayed.push(event), { replay: true });
  assert.equal(replayed[0].data, "old\nnew\nnext");
  assert.equal(replayed[0].replay, true);
  source.reset();
  assert.equal(events.at(-1)?.type, "reset");
  assert.equal(events.at(-1)?.epoch, 1);
  source.emit("fresh");
  assert.equal(events.at(-1)?.data, "fresh");
  stop(); stop(); detachReplay();
  const count = events.length;
  source.emit("after stop"); source.reset();
  assert.equal(events.length, count);
  assert.equal(source.outputListeners[0].size, 0);
  assert.equal(source.stateListeners.size, 0);
});

test("one observer cannot break other streams, and ports remain independent", () => {
  const source = new OutputRuntime();
  const events: Readonly<OutputEvent>[] = [];
  const stopBad = subscribeRuntimeOutput(source, () => { throw new Error("observer failed"); });
  const stopGood = subscribeRuntimeOutput(source, (event) => events.push(event), { port: 1, format: "raw" });
  source.emit("wrong port");
  source.emit("\x1b[31mright port\r\n", 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].data, "\x1b[31mright port\r\n");
  stopBad(); stopGood();
  assert.throws(() => subscribeRuntimeOutput(source, null as never), /listener/);
  assert.throws(() => subscribeRuntimeOutput(source, () => {}, { replay: "yes" as never }), /replay/);
  assert.throws(() => readRuntimeOutput(source, { format: "html" as never }), /format/);
  assert.equal(source.stateListeners.size, 0);
});

test("the plain-text filter handles split terminal strings and bounds do not split Unicode", () => {
  const filter = new OutputTextFilter();
  assert.equal(filter.push("before\x1b]8;;https://exam"), "before");
  assert.equal(filter.push("ple.invalid\x1b\\link\x1b]8;;\x07after"), "linkafter");
  assert.equal(filter.push("\x1bPprivate title\x1b"), "");
  assert.equal(filter.push("\\visible\u202e\x00\b\tend"), "visible\\u202e\tend");
  assert.equal(outputTail("prefix🤖x", 2), "x");
  assert.equal(outputTail("prefix🤖x", 3), "🤖x");
  assert.equal(new OutputTextFilter().push("__TRM_BEGIN_example__\n"), "__TRM_BEGIN_example__\n", "Do not guess which guest lines to erase");
});
