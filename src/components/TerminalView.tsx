// SPDX-License-Identifier: Apache-2.0
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { runtime as defaultRuntime } from "../lib/linux-runtime";
import type { MachineRuntime, SerialPort } from "../lib/runtime-types";
import type { Preferences } from "../lib/preferences";

export interface TerminalHandle {
  focus: () => void;
  clear: () => void;
}
export interface TerminalViewProps {
  preferences: Preferences;
  blocked: boolean;
  onLeave: () => void;
  runtime?: MachineRuntime;
  port?: SerialPort;
  readOnly?: boolean;
  onError?: (error: Error) => void;
  onResize?: (port: SerialPort, columns: number, rows: number) => void;
}

function terminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const color = (name: string) => style.getPropertyValue(name).trim();
  return {
    background: "#00000000",
    foreground: color("--text"),
    cursor: color("--accent"),
    cursorAccent: color("--canvas"),
    selectionBackground: color("--selection"),
    black: color("--ansi-black"),
    brightBlack: color("--muted"),
    red: color("--danger"),
    brightRed: color("--danger"),
    green: color("--success"),
    brightGreen: color("--success"),
    yellow: color("--warning"),
    brightYellow: color("--warning"),
    blue: color("--info"),
    brightBlue: color("--info"),
    magenta: color("--magenta"),
    brightMagenta: color("--magenta"),
    cyan: color("--cyan"),
    brightCyan: color("--cyan"),
    white: color("--text"),
    brightWhite: color("--text"),
  };
}

export const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>(
  function TerminalView(
    {
      preferences,
      blocked,
      onLeave,
      runtime: target = defaultRuntime,
      port = 0,
      readOnly,
      onError,
      onResize,
    },
    ref,
  ) {
    const container = useRef<HTMLDivElement>(null);
    const terminal = useRef<Terminal | null>(null);
    const fit = useRef<FitAddon | null>(null);
    const blockedRef = useRef(blocked);
    const leaveRef = useRef(onLeave);
    const errorRef = useRef(onError);
    const resizeRef = useRef(onResize);
    const noninteractive =
      readOnly ?? !target.capabilities.interactivePorts.includes(port);
    const readOnlyRef = useRef(noninteractive);
    blockedRef.current = blocked;
    leaveRef.current = onLeave;
    errorRef.current = onError;
    resizeRef.current = onResize;
    readOnlyRef.current = noninteractive;

    useImperativeHandle(
      ref,
      () => ({
        focus: () => terminal.current?.focus(),
        clear: () => terminal.current?.clear(),
      }),
      [],
    );
    useEffect(() => {
      if (!container.current) return;
      const term = new Terminal({
        allowTransparency: true,
        fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
        fontSize: preferences.fontSize,
        lineHeight: 1.35,
        cursorBlink: !preferences.reduceMotion && !readOnlyRef.current,
        cursorStyle: "bar",
        theme: terminalTheme(),
        scrollback: 2500,
        screenReaderMode: true,
        allowProposedApi: false,
        disableStdin: readOnlyRef.current || blockedRef.current,
      });
      const addon = new FitAddon();
      term.loadAddon(addon);
      term.open(container.current);
      terminal.current = term;
      fit.current = addon;
      const dimensions = term.onResize(({ cols, rows }) =>
        resizeRef.current?.(port, cols, rows),
      );
      const resize = () => {
        if (container.current?.offsetWidth) addon.fit();
      };
      resize();
      resizeRef.current?.(port, term.cols, term.rows);
      const observer = new ResizeObserver(resize);
      observer.observe(container.current);
      let displayEpoch = target.getSnapshot().displayEpoch;
      const detachState = target.subscribe((state) => {
        if (state.displayEpoch !== displayEpoch) {
          displayEpoch = state.displayEpoch;
          term.reset();
        }
      });
      const detachOutput = target.onOutput(
        (output) => term.write(output),
        port,
      );
      const input = term.onData((data) => {
        if (readOnlyRef.current || blockedRef.current) return;
        if (
          target.getSnapshot().status !== "running" ||
          target.getSnapshot().operation
        )
          return;
        try {
          target.send(data, port);
        } catch (error) {
          errorRef.current?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      });
      term.attachCustomKeyEventHandler((event) => {
        if (event.key === "Escape" && event.ctrlKey && event.shiftKey) {
          leaveRef.current();
          return false;
        }
        return true;
      });
      return () => {
        detachState();
        detachOutput();
        input.dispose();
        dimensions.dispose();
        observer.disconnect();
        term.dispose();
        terminal.current = null;
        fit.current = null;
      };
      // A display may unmount freely. Its machine and shell stay alive.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target, port]);

    useEffect(() => {
      if (!terminal.current) return;
      terminal.current.options.theme = terminalTheme();
      terminal.current.options.fontSize = preferences.fontSize;
      fit.current?.fit();
    }, [preferences, target, port]);

    useEffect(() => {
      const media = matchMedia("(prefers-reduced-motion: reduce)");
      const update = () => {
        if (!terminal.current) return;
        terminal.current.options.disableStdin = blocked || noninteractive;
        terminal.current.options.cursorBlink =
          !preferences.reduceMotion && !media.matches && !noninteractive;
      };
      update();
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }, [blocked, noninteractive, preferences.reduceMotion, target, port]);

    return (
      <div
        ref={container}
        className="live-terminal"
        aria-label={`${noninteractive ? "Read-only system console" : `Independent Linux shell ${port || 1}`}. Press Control Shift Escape to leave the terminal.`}
      />
    );
  },
);
