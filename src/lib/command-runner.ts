// SPDX-License-Identifier: Apache-2.0

import type { RuntimeSnapshot } from "./runtime-types.ts";
import {
  CommandFrameReader,
  commandFrame,
  hasRecoveryFrame,
  recoveryFrame,
} from "./command-protocol.ts";

export interface RunResult {
  id: string;
  command: string;
  output: string;
  /** Null when no complete, matching guest exit marker was observed. */
  exitCode: number | null;
  status: "exited" | "timed_out" | "output_limit" | "interrupted";
  startedAt: number;
  durationMs: number;
  recovery: "not_needed" | "recovered" | "reset_required";
  message?: string;
}

export interface RunnerState {
  busy: boolean;
  runs: RunResult[];
  ready: boolean;
  blockedReason: string | null;
}

type RunnerListener = (state: RunnerState) => void;

export interface RunnerRuntime {
  getSnapshot(): RuntimeSnapshot;
  send(text: string): void;
  onOutput(listener: (data: string) => void): () => void;
  subscribe(listener: (state: RuntimeSnapshot) => void): () => void;
}

interface RunnerSettings {
  recoveryDelayMs?: number;
  recoveryTimeoutMs?: number;
  createId?: () => string;
}

const RESET_REQUIRED =
  "The shell did not confirm recovery. The guest command may still be running. Reset Linux before executing another command.";
const STARTUP_RECOVERY_REQUIRED =
  "The system command channel did not recover after startup. Reset Linux before executing another command. Independent interactive shells remain available.";

/** One cooperative command at a time over the guest serial console. */
export class CommandRunner {
  private readonly target: RunnerRuntime;
  private readonly recoveryDelayMs: number;
  private readonly recoveryTimeoutMs: number;
  private readonly createId: () => string;
  private readonly unsubscribeReset: () => void;
  private busy = false;
  private runs: RunResult[] = [];
  private blockedReason: string | null = null;
  private listeners = new Set<RunnerListener>();

  constructor(target: RunnerRuntime, settings: RunnerSettings = {}) {
    this.target = target;
    this.recoveryDelayMs = settings.recoveryDelayMs ?? 100;
    this.recoveryTimeoutMs = settings.recoveryTimeoutMs ?? 2_000;
    this.createId =
      settings.createId ?? (() => crypto.randomUUID().replace(/-/g, ""));
    let restoring = false;
    this.unsubscribeReset = target.subscribe((state) => {
      if (state.operation === "restoring") restoring = true;
      const restored = restoring && !state.operation;
      if (restored) restoring = false;
      // A completed restore explicitly rechecks the command shell. Pausing or
      // resuming the existing guest is not evidence that a command stopped.
      if (
        (state.status === "idle" ||
          state.status === "loading" ||
          (restored &&
            state.status === "running" &&
            state.controlReady === true)) &&
        this.blockedReason
      ) {
        this.blockedReason = null;
      }
      this.publish();
    });
  }

  getState = (): RunnerState => {
    const state = this.target.getSnapshot();
    const blockedReason =
      this.blockedReason ??
      (state.status === "running" &&
      !state.operation &&
      state.controlReady === false
        ? STARTUP_RECOVERY_REQUIRED
        : null);
    return {
      busy: this.busy,
      runs: [...this.runs],
      ready:
        !this.busy &&
        !blockedReason &&
        state.status === "running" &&
        !state.operation &&
        !state.volumeOperation &&
        state.controlReady !== false,
      blockedReason,
    };
  };

  subscribe = (listener: RunnerListener): (() => void) => {
    this.listeners.add(listener);
    try {
      listener(this.getState());
    } catch {
      /* Observers cannot break command cleanup. */
    }
    return () => {
      this.listeners.delete(listener);
    };
  };

  isBusy = (): boolean => this.busy;

  private publish(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.getState());
      } catch {
        /* Keep the command lifecycle independent of UI observers. */
      }
    }
  }

  dispose(): void {
    if (this.busy)
      throw new Error(
        "Cannot dispose the command runner while a command is running.",
      );
    this.unsubscribeReset();
    this.listeners.clear();
  }

  execute = (
    command: string,
    options: { timeoutMs?: number } = {},
  ): Promise<RunResult> => this.executeTracked(command, options, true);

  /** Host maintenance uses the same serial lock without filling user history. */
  executeInternal = (
    command: string,
    options: { timeoutMs?: number } = {},
  ): Promise<RunResult> => this.executeTracked(command, options, false);

  private executeTracked = async (
    command: string,
    options: { timeoutMs?: number },
    record: boolean,
  ): Promise<RunResult> => {
    if (this.busy)
      throw new Error("Another command is running. Wait for it to finish.");
    if (this.blockedReason) throw new Error(this.blockedReason);
    if (this.target.getSnapshot().status !== "running")
      throw new Error("Boot or resume Linux before running a command.");
    if (this.target.getSnapshot().operation)
      throw new Error(
        "Wait for the checkpoint operation to finish before running a command.",
      );
    if (record && this.target.getSnapshot().volumeOperation)
      throw new Error("Wait for this machine's volume operation to finish before running a command.");
    if (this.target.getSnapshot().controlReady === false)
      throw new Error(STARTUP_RECOVERY_REQUIRED);
    const requestedTimeout =
      options && typeof options === "object" ? options.timeoutMs : undefined;
    const timeoutMs = Math.min(
      60_000,
      Math.max(
        1_000,
        typeof requestedTimeout === "number" &&
          Number.isFinite(requestedTimeout)
          ? requestedTimeout
          : 15_000,
      ),
    );
    const id = this.createId();
    const frame = commandFrame(command, id);
    const reader = new CommandFrameReader(id);
    const recoveryToken = `${id}r`;
    const startedAt = Date.now();
    this.busy = true;
    this.publish();

    return new Promise<RunResult>((resolve) => {
      let phase: "running" | "recovering" | "done" = "running";
      let acceptOutput = false;
      let recoveryBuffer = "";
      let failure: {
        status: "timed_out" | "output_limit";
        output: string;
      } | null = null;
      let unsubscribeOutput: (() => void) | undefined;
      let unsubscribeState: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let probeTimer: ReturnType<typeof setTimeout> | undefined;
      let recoveryTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (
        status: RunResult["status"],
        output: string,
        exitCode: number | null,
        recovery: RunResult["recovery"] = "not_needed",
        message?: string,
      ) => {
        if (phase === "done") return;
        phase = "done";
        clearTimeout(timer);
        clearTimeout(probeTimer);
        clearTimeout(recoveryTimer);
        unsubscribeOutput?.();
        unsubscribeState?.();
        if (recovery === "reset_required")
          this.blockedReason = message ?? RESET_REQUIRED;
        const result: RunResult = Object.freeze({
          id,
          command,
          output,
          exitCode,
          status,
          startedAt,
          durationMs: Date.now() - startedAt,
          recovery,
          ...(message ? { message } : {}),
        });
        if (record) this.runs = [result, ...this.runs].slice(0, 30);
        this.busy = false;
        this.publish();
        resolve(result);
      };

      const recover = (
        status: "timed_out" | "output_limit",
        output: string,
      ) => {
        if (phase !== "running") return;
        phase = "recovering";
        clearTimeout(timer);
        failure = { status, output };
        // A delay alone is not recovery. Require a new marker produced by the
        // shell after Ctrl-C, while holding the single-command lock.
        recoveryTimer = setTimeout(() => {
          finish(status, output, null, "reset_required", RESET_REQUIRED);
        }, this.recoveryTimeoutMs);
        probeTimer = setTimeout(() => {
          if (phase !== "recovering") return;
          try {
            this.target.send(recoveryFrame(recoveryToken));
          } catch {
            finish(status, output, null, "reset_required", RESET_REQUIRED);
          }
        }, this.recoveryDelayMs);
        try {
          this.target.send("\x03");
        } catch {
          finish(status, output, null, "reset_required", RESET_REQUIRED);
        }
      };

      unsubscribeOutput = this.target.onOutput((data) => {
        // The runtime immediately replays its terminal transcript on subscribe.
        // Do not mix that history with a new command or count it against limits.
        if (!acceptOutput || phase === "done") return;
        if (phase === "recovering") {
          recoveryBuffer = (recoveryBuffer + data).slice(-4_096);
          if (failure && hasRecoveryFrame(recoveryBuffer, recoveryToken)) {
            finish(failure.status, failure.output, null, "recovered");
          }
          return;
        }
        const current = reader.push(data);
        if (current.limited) {
          if (current.complete)
            finish("output_limit", current.output, current.exitCode);
          else recover("output_limit", current.output);
        } else if (current.complete) {
          finish("exited", current.output, current.exitCode);
        }
      });

      unsubscribeState = this.target.subscribe((state) => {
        if (phase === "done") return;
        if (state.operation) {
          const message =
            "A checkpoint operation interrupted command tracking. Reset Linux before executing another command.";
          finish(
            failure?.status ?? "interrupted",
            failure?.output ?? reader.getOutput(),
            null,
            "reset_required",
            message,
          );
          return;
        }
        if (state.status === "running" && state.controlReady !== false) return;
        if (state.status === "idle" || state.status === "loading") {
          finish(
            failure?.status ?? "interrupted",
            failure?.output ?? reader.getOutput(),
            null,
          );
        } else {
          const message =
            "The runtime changed before the command completed. Reset Linux before executing another command.";
          finish(
            failure?.status ?? "interrupted",
            failure?.output ?? reader.getOutput(),
            null,
            "reset_required",
            message,
          );
        }
      });

      // A synchronous subscription callback can finish before its unsubscribe
      // function is assigned. Close both subscriptions in that case as well.
      if ((phase as string) === "done") {
        unsubscribeOutput();
        unsubscribeState();
        return;
      }
      timer = setTimeout(
        () => recover("timed_out", reader.getOutput()),
        timeoutMs,
      );
      acceptOutput = true;
      try {
        this.target.send(frame);
      } catch {
        finish(
          "interrupted",
          reader.getOutput(),
          null,
          "reset_required",
          "Could not send the command reliably. Reset Linux before executing another command.",
        );
      }
    });
  };
}
