// SPDX-License-Identifier: Apache-2.0

import { runtime } from "./linux-runtime.ts";
import type { MachineRuntime } from "./runtime-types.ts";
import { CommandRunner } from "./command-runner.ts";
import type { CloudControlPlane } from "./cloud.ts";
import {
  readRuntimeOutput,
  subscribeRuntimeOutput,
  type OutputReadOptions,
  type OutputSubscribeOptions,
  type OutputSubscriber,
} from "./output-stream.ts";

export const AGENT_BRIDGE_VERSION = "0.7.0";

export { CommandRunner } from "./command-runner.ts";
export type {
  RunResult,
  RunnerState,
  RunnerRuntime,
} from "./command-runner.ts";

/** The owner retains one runner per machine; selecting a tab never resets it. */
export interface BridgeMachine {
  id: string;
  name: string;
  runtime: MachineRuntime;
  runner: CommandRunner;
  setInitScript?: (script: string) => void;
  assertAvailable?: () => void;
  cancelBoot?: () => Promise<void>;
}

export interface MachineProvider {
  active(): BridgeMachine;
  list(): readonly BridgeMachine[];
  get(id: string): BridgeMachine | undefined;
}

export function createMachineBridge(
  target: MachineRuntime,
  runner: CommandRunner,
  onSetInitScript?: (script: string) => void,
  label: () => string = () => target.capabilities.label,
  assertAlive: () => void = () => {},
  assertMutable: () => void = assertAlive,
  onCancelBoot?: () => Promise<void>,
) {
  const status = () => { assertAlive(); return ({
    ...target.getSnapshot(),
    capabilities: target.capabilities,
    commandBusy: runner.isBusy(),
    commandReady: runner.getState().ready,
    commandBlockedReason: runner.getState().blockedReason,
  }); };
  return Object.freeze({
    version: AGENT_BRIDGE_VERSION,
    status,
    boot: async () => { assertMutable(); await target.boot(); return status(); },
    cancelBoot: async () => {
      assertMutable();
      if (!target.capabilities.cancelBoot)
        throw new Error("This runtime does not support cancelling a boot in progress.");
      const state = target.getSnapshot();
      if (!["loading", "booting"].includes(state.status) || state.operation || state.volumeOperation || state.acquiringEvidence)
        throw new Error("Cancel boot is available only while this machine is loading or starting, outside another operation.");
      if (onCancelBoot) await onCancelBoot(); else await target.destroy();
      return status();
    },
    exec: async (command: string, options?: { timeoutMs?: number }) => {
      assertMutable();
      if (target.getSnapshot().volumeOperation)
        throw new Error("Wait for this machine's volume operation to finish before starting another command.");
      if (target.getSnapshot().acquiringEvidence)
        throw new Error(
          "Wait for evidence acquisition to finish before starting another command.",
        );
      if (["loading", "booting"].includes(target.getSnapshot().status))
        throw new Error("Linux is still starting. Await vm.boot() before calling vm.exec().");
      return runner.execute(command, options);
    },
    pause: async () => {
      assertMutable();
      if (runner.isBusy())
        throw new Error(
          "Wait for the current command to finish before pausing.",
        );
      await target.pause();
      return status();
    },
    resume: async () => {
      assertMutable();
      if (runner.getState().blockedReason)
        throw new Error(runner.getState().blockedReason!);
      await target.resume();
      return status();
    },
    reset: async () => {
      assertMutable();
      if (runner.isBusy())
        throw new Error(
          "Wait for the current command to finish before resetting.",
        );
      await target.reset();
      return status();
    },
    getInitScript: () => { assertAlive(); return target.getInitScript(); },
    setInitScript: (script: string) => {
      assertMutable(); return onSetInitScript ? onSetInitScript(script) : target.setInitScript(script);
    },
    readOutput: (options?: OutputReadOptions) => { assertAlive(); return readRuntimeOutput(target, options); },
    subscribeOutput: (listener: OutputSubscriber, options?: OutputSubscribeOptions) => {
      assertAlive(); return subscribeRuntimeOutput(target, listener, options);
    },
    /** Explicit, per-machine console mirroring. Nothing is mirrored by default. */
    mirrorOutput: (options?: OutputSubscribeOptions) => {
      assertAlive(); return subscribeRuntimeOutput(target, (event) => {
        const prefix = `[${label()} / serial ${event.port}]`;
        if (event.type === "reset") console.log(`${prefix} transcript cleared`);
        else console.log(`${prefix}\n${event.data}`);
      }, options);
    },
  });
}

export type MachineBridge = ReturnType<typeof createMachineBridge>;

// Retain the original single-machine exports for existing consumers. The app
// installs its machine provider when it owns more than one runtime.
const defaultRunner = new CommandRunner(runtime);
const defaultMachine: BridgeMachine = {
  id: "local-01",
  name: "local-01",
  runtime,
  runner: defaultRunner,
};
const defaultProvider: MachineProvider = {
  active: () => defaultMachine,
  list: () => [defaultMachine],
  get: (id) => (id === defaultMachine.id ? defaultMachine : undefined),
};
export const subscribeRunner = defaultRunner.subscribe;
export const isRunnerBusy = defaultRunner.isBusy;
export const executeCommand = defaultRunner.execute;

export function installAgentBridge(
  provider: MachineProvider = defaultProvider,
  extensions: { cloud?: CloudControlPlane; workspace?: WorkspaceBridge } = {},
): void {
  const bridges = new WeakMap<MachineRuntime, MachineBridge>();
  const bridge = (machine: BridgeMachine): MachineBridge => {
    let value = bridges.get(machine.runtime);
    if (!value) {
      const assertAlive = () => {
        let current: BridgeMachine | undefined;
        try { current = provider.get(machine.id); } catch { /* Missing membership is revocation. */ }
        if (current?.runtime !== machine.runtime) throw new Error("This machine was deleted. Get a handle to an existing machine.");
      };
      value = createMachineBridge(
        machine.runtime,
        machine.runner,
        machine.setInitScript,
        () => machine.name,
        assertAlive,
        () => { assertAlive(); machine.assertAvailable?.(); },
        machine.cancelBoot,
      );
      bridges.set(machine.runtime, value);
    }
    return value;
  };
  const active = () => bridge(provider.active());
  window.terrarium = Object.freeze({
    version: AGENT_BRIDGE_VERSION,
    status: () => active().status(),
    boot: () => active().boot(),
    cancelBoot: () => active().cancelBoot(),
    exec: (command: string, options?: { timeoutMs?: number }) =>
      active().exec(command, options),
    pause: () => active().pause(),
    resume: () => active().resume(),
    reset: () => active().reset(),
    getInitScript: () => active().getInitScript(),
    setInitScript: (script: string) => active().setInitScript(script),
    readOutput: (options?: OutputReadOptions) => active().readOutput(options),
    subscribeOutput: (listener: OutputSubscriber, options?: OutputSubscribeOptions) =>
      active().subscribeOutput(listener, options),
    mirrorOutput: (options?: OutputSubscribeOptions) => active().mirrorOutput(options),
    ...(extensions.cloud ? { cloud: extensions.cloud } : {}),
    ...(extensions.workspace ? { workspace: Object.freeze(extensions.workspace) } : {}),
    list: () =>
      provider.list().map((machine) => ({
        id: machine.id,
        name: machine.name,
        ...bridge(machine).status(),
      })),
    get: (id: string): MachineBridge => {
      const machine = provider.get(id);
      if (!machine) throw new Error(`No machine has id "${id}".`);
      return bridge(machine);
    },
  });
}

export interface WorkspaceBridge {
  status(): unknown;
  prepareReload(): Promise<void>;
  takeControl(): Promise<void>;
  acknowledgeRecovery(id: string): void;
  exportManifest(): string;
}

declare global {
  interface Window {
    terrarium: MachineBridge & {
      cloud?: CloudControlPlane;
      workspace?: WorkspaceBridge;
      list(): ({ id: string; name: string } & ReturnType<
        MachineBridge["status"]
      >)[];
      get(id: string): MachineBridge;
    };
  }
}
