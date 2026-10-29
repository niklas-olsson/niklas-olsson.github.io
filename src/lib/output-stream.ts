// SPDX-License-Identifier: Apache-2.0
import type { MachineRuntime, SerialPort } from "./runtime-types.ts";

export type OutputFormat = "text" | "raw";

export interface OutputReadOptions {
  /** The system/agent console is port 0; x86 interactive shells use 1–3. */
  port?: SerialPort;
  /** Text removes terminal control sequences. Raw retains decoded serial text. */
  format?: OutputFormat;
}

export interface OutputSubscribeOptions extends OutputReadOptions {
  /** Historical replay is opt-in; the default follows only new output. */
  replay?: boolean;
}

export interface OutputEvent {
  type: "data" | "reset";
  data: string;
  port: SerialPort;
  replay: boolean;
  /** Changes when the guest transcript is discarded by reset or restore. */
  epoch: number;
}

export type OutputSubscriber = (event: Readonly<OutputEvent>) => void;
type OutputSource = Pick<MachineRuntime, "capabilities" | "getSnapshot" | "subscribe" | "onOutput">;

/** A text log, not a screen emulator. Cursor movement and backspace are omitted. */
export class OutputTextFilter {
  private state: "text" | "escape" | "csi" | "string" | "stringEscape" = "text";
  private carriageReturn = false;

  push(data: string): string {
    let result = "";
    for (const character of data) {
      const code = character.codePointAt(0)!;
      if (this.state === "string") {
        if (code === 7 || code === 0x9c) this.state = "text";
        else if (code === 27) this.state = "stringEscape";
        continue;
      }
      if (this.state === "stringEscape") {
        this.state = character === "\\" ? "text" : code === 27 ? "stringEscape" : "string";
        continue;
      }
      if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        else if (code === 27) this.state = "escape";
        continue;
      }
      if (this.state === "escape") {
        this.state = character === "[" ? "csi" : "]PX^_".includes(character) ? "string" : "text";
        continue;
      }
      if (code === 27) { this.state = "escape"; continue; }
      if (code === 0x9b) { this.state = "csi"; continue; }
      if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) { this.state = "string"; continue; }
      if (character === "\r") { result += "\n"; this.carriageReturn = true; continue; }
      if (character === "\n") {
        if (!this.carriageReturn) result += "\n";
        this.carriageReturn = false;
        continue;
      }
      this.carriageReturn = false;
      if (character === "\t") { result += character; continue; }
      if (code < 32 || (code >= 0x7f && code <= 0x9f)) continue;
      // Keep direction controls visible in a log of untrusted guest output.
      if (code === 0x061c || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
        result += `\\u${code.toString(16).padStart(4, "0")}`;
      } else result += character;
    }
    return result;
  }
}

function normalize(source: OutputSource, options: OutputSubscribeOptions) {
  if (!options || typeof options !== "object") throw new TypeError("Output options must be an object.");
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || !source.capabilities.serialPorts.includes(port))
    throw new RangeError("That serial port is not available on this machine.");
  const format = options.format ?? "text";
  if (format !== "text" && format !== "raw") throw new TypeError("Output format must be text or raw.");
  if (options.replay !== undefined && typeof options.replay !== "boolean")
    throw new TypeError("Output replay must be true or false.");
  return { port, format, replay: options.replay === true };
}

/** Read the runtime's bounded, current-epoch transcript without retaining a listener. */
export function readRuntimeOutput(source: OutputSource, options: OutputReadOptions = {}): string {
  const { port, format } = normalize(source, options);
  let result = "";
  // Both runtime adapters synchronously replay their retained transcript here.
  // JavaScript cannot interleave an asynchronous serial event before detach.
  const stop = source.onOutput((data) => { result += data; }, port);
  stop();
  return format === "raw" ? result : new OutputTextFilter().push(result);
}

/** Subscribe to one port. No guest starts, input is never sent, and stop is idempotent. */
export function subscribeRuntimeOutput(
  source: OutputSource,
  listener: OutputSubscriber,
  options: OutputSubscribeOptions = {},
): () => void {
  if (typeof listener !== "function") throw new TypeError("An output listener must be a function.");
  const { port, format, replay } = normalize(source, options);
  let epoch = source.getSnapshot().displayEpoch ?? 0;
  let filter = new OutputTextFilter();
  let subscribing = true;
  let stopped = false;
  let detachOutput: (() => void) | undefined;
  const notify = (event: OutputEvent) => {
    if (stopped) return;
    try { listener(Object.freeze(event)); } catch { /* Observers cannot interrupt serial delivery. */ }
  };
  const detachState = source.subscribe((state) => {
    const nextEpoch = state.displayEpoch ?? 0;
    if (nextEpoch === epoch) return;
    epoch = nextEpoch;
    filter = new OutputTextFilter();
    notify({ type: "reset", data: "", port, replay: false, epoch });
  });
  try {
    detachOutput = source.onOutput((data) => {
      if (stopped) return;
      // Parse even an excluded replay so a split ANSI sequence stays consistent.
      const text = format === "raw" ? data : filter.push(data);
      if (text && (!subscribing || replay))
        notify({ type: "data", data: text, port, replay: subscribing, epoch });
    }, port);
    subscribing = false;
  } catch (error) {
    stopped = true;
    detachState();
    throw error;
  }
  return () => {
    if (stopped) return;
    stopped = true;
    detachOutput?.();
    detachState();
  };
}

/** Bound a display's retained tail without splitting a UTF-16 surrogate pair. */
export function outputTail(text: string, limit = 128 * 1024): string {
  if (text.length <= limit) return text;
  let start = text.length - limit;
  if (text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start++;
  return text.slice(start);
}
