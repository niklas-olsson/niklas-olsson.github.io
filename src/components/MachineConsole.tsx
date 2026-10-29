// SPDX-License-Identifier: Apache-2.0
import { lazy, Suspense, useId, useRef, useState } from "react";
import {
  ArrowRight,
  Columns2,
  Cpu,
  Expand,
  FileCode2,
  LoaderCircle,
  Minus,
  Network,
  Pause,
  Play,
  RotateCcw,
  SquareTerminal,
  Terminal,
  WifiOff,
} from "lucide-react";
import type { Preferences } from "../lib/preferences";
import type { ManagedMachine, MachineSummary } from "../lib/machines";
import { PROFILES } from "../lib/machines";
import { X86_MACHINE_PRESETS } from "../lib/x86-machine-config";
import { consoleDeviceLabel } from "../lib/runtime-profiles";
import type { SerialPort } from "../lib/runtime-types";
import { BrandMark, MachineArt } from "./Brand";
import { RunList } from "./RunList";

const TerminalView = lazy(() =>
  import("./TerminalView").then((module) => ({ default: module.TerminalView })),
);

export function MachineConsole({
  machine,
  summary,
  preferences,
  locked,
  expanded,
  onExpand,
  onBoot,
  onResume,
  onRun,
}: {
  machine: ManagedMachine;
  summary: MachineSummary;
  preferences: Preferences;
  locked: boolean;
  expanded: boolean;
  onExpand: () => void;
  onBoot: () => void;
  onResume: () => void;
  onRun: (text: string) => Promise<void>;
}) {
  const { state, runner, network } = summary;
  const ports = machine.runtime.capabilities.interactivePorts;
  const [view, setView] = useState<SerialPort | "runs">(ports[0] ?? 0);
  const [split, setSplit] = useState(false);
  const [secondPort, setSecondPort] = useState<SerialPort>(
    ports[1] ?? ports[0] ?? 0,
  );
  const [command, setCommand] = useState("");
  const tablist = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const profile = PROFILES[machine.config.profile];
  const memoryMiB = machine.config.x86 ? X86_MACHINE_PRESETS[machine.config.x86.presetId].memoryMiB : profile.memory;
  const ready = state.status === "running";
  const booting = state.status === "booting";
  const mainPort = typeof view === "number" ? view : (ports[0] ?? 0);
  const label = (port: SerialPort) =>
    port === 0 ? (ports.includes(0) ? "Console" : "System") : `Shell ${port}`;
  const select = (port: SerialPort | "runs") => {
    setView(port);
    if (port === secondPort)
      setSecondPort(ports.find((candidate) => candidate !== port) ?? 0);
  };
  const pane = (port: SerialPort, secondary = false) => {
    const session = state.sessions?.find((entry) => entry.port === port);
    const readOnly = !ports.includes(port);
    return (
      <section
        className="terminal-pane"
        key={`${machine.id}-${port}`}
        aria-label={`${machine.name} ${label(port)}`}
      >
        <header className="pane-header">
          <span>
            <span
              className={`session-dot ${session?.status ?? (ready ? "ready" : "starting")}`}
            />
            {label(port)}
            <small>
              {consoleDeviceLabel(machine.config.profile, port)}
            </small>
          </span>
          {secondary ? (
            <select
              aria-label="Session in second pane"
              value={port}
              onChange={(event) =>
                setSecondPort(Number(event.target.value) as SerialPort)
              }
            >
              {ports
                .filter((candidate) => candidate !== mainPort)
                .map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {label(candidate)}
                  </option>
                ))}
            </select>
          ) : (
            <span className="pane-meta">
              {readOnly
                ? "BOOT + AGENT OUTPUT"
                : session?.status === "unavailable"
                  ? "UNAVAILABLE"
                  : "INTERACTIVE SHELL"}
            </span>
          )}
        </header>
        <div className="terminal-wrap">
          <Suspense
            fallback={
              <div className="loading-screen">Preparing the terminal…</div>
            }
          >
            <TerminalView
              runtime={machine.runtime}
              port={port}
              preferences={preferences}
              onResize={machine.resizeTerminal}
              blocked={
                readOnly ||
                !ready ||
                Boolean(state.operation) ||
                (port === 0 && (locked || runner.busy)) ||
                session?.status === "unavailable"
              }
              onLeave={() =>
                tablist.current
                  ?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
                  ?.focus()
              }
            />
          </Suspense>
          {session?.status === "unavailable" && (
            <div className="session-unavailable">
              This serial shell did not become ready. The system console
              contains the boot details.
            </div>
          )}
        </div>
      </section>
    );
  };

  return (
    <section className="console-card glass machine-console">
      <header className="console-header">
        <div className="console-title">
          <span className="console-icon">
            <Terminal size={16} />
          </span>
          <strong>{machine.name}</strong>
          <span className="pill subtle">{profile.architecture}</span>
        </div>
        <div className="console-actions">
          {ports.length > 1 && (
            <button
              className={`icon-button ${split ? "selected" : ""}`}
              aria-label={split ? "Use one terminal pane" : "Split terminals"}
              aria-pressed={split}
              onClick={() => {
                setSplit(!split);
                if (view === "runs" || mainPort === 0) setView(ports[0]);
              }}
              title="Split terminals"
            >
              <Columns2 size={16} />
            </button>
          )}
          <button
            className="icon-button"
            onClick={onExpand}
            aria-label={expanded ? "Exit expanded console" : "Expand console"}
          >
            {expanded ? <Minus size={16} /> : <Expand size={16} />}
          </button>
        </div>
      </header>
      <div
        className="console-tabs session-tabs"
        ref={tablist}
        role="tablist"
        aria-label={`${machine.name} terminal sessions`}
        onKeyDown={(event) => {
          if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key))
            return;
          const tabs = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              '[role="tab"]',
            ),
          );
          const current = tabs.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : (current +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    tabs.length) %
                  tabs.length;
          event.preventDefault();
          tabs[next]?.click();
          tabs[next]?.focus();
        }}
      >
        {ports.map((port) => (
          <button
            key={port}
            role="tab"
            id={`${panelId}-tab-${port}`}
            aria-controls={panelId}
            tabIndex={view === port ? 0 : -1}
            aria-selected={view === port}
            className={view === port ? "active" : ""}
            onClick={() => select(port)}
          >
            <SquareTerminal size={14} />
            {label(port)}
          </button>
        ))}
        {!ports.includes(0) && (
          <button
            role="tab"
            id={`${panelId}-tab-0`}
            aria-controls={panelId}
            tabIndex={view === 0 ? 0 : -1}
            aria-selected={view === 0}
            className={view === 0 ? "active" : ""}
            onClick={() => select(0)}
          >
            <Cpu size={14} />
            System
          </button>
        )}
        <button
          role="tab"
          id={`${panelId}-tab-runs`}
          aria-controls={panelId}
          tabIndex={view === "runs" ? 0 : -1}
          aria-selected={view === "runs"}
          className={view === "runs" ? "active" : ""}
          onClick={() => select("runs")}
        >
          <FileCode2 size={14} />
          Runs{runner.runs.length > 0 && <span>{runner.runs.length}</span>}
        </button>
      </div>
      <div
        className="console-body"
        role="tabpanel"
        id={panelId}
        aria-labelledby={`${panelId}-tab-${view}`}
        aria-label={view === "runs" ? "Command results" : label(mainPort)}
      >
        {view === "runs" ? (
          <RunList runs={runner.runs} fontSize={preferences.fontSize} compact />
        ) : state.status === "idle" || state.status === "error" ? (
          <div className="boot-screen">
            <div className="boot-art">
              <MachineArt />
              <span className="art-caption">
                <span />
                YOUR MACHINE. YOUR EXPERIMENT.
              </span>
            </div>
            <div className="boot-copy">
              <span className="eyebrow">
                {profile.architecture.toUpperCase()}
              </span>
              <h2>
                {state.status === "error"
                  ? "Let’s try that again."
                  : "A world of your own."}
              </h2>
              <p>
                {state.status === "error"
                  ? state.message
                  : `${memoryMiB} MiB of memory. A real Linux kernel. ${machine.config.initScript.trim() ? "Your boot script is ready to run." : "Start a shell and see what happens."}`}
              </p>
              <button
                className="button primary boot-button"
                disabled={locked}
                onClick={onBoot}
              >
                {state.status === "error" ? (
                  <RotateCcw size={16} />
                ) : (
                  <Play size={16} fill="currentColor" />
                )}
                Boot {machine.name}
                <ArrowRight size={16} />
              </button>
              <small>
                Verified guest assets download{" "}
                {`from upstream hosts (${profile.download})`}
                .<br />
                Guest network starts{" "}
                {network.mode === "isolated"
                  ? "disconnected"
                  : network.mode === "local"
                    ? "on the private LAN"
                    : "with web access enabled"}
                .
              </small>
            </div>
          </div>
        ) : state.status === "loading" ? (
          <div className="loading-screen">
            <BrandMark className="loading-mark" />
            <span className="eyebrow">
              PREPARING {machine.name.toUpperCase()}
            </span>
            <h2>Bringing Linux to your browser.</h2>
            <p>{state.message}</p>
            <div className="progress-track">
              <span style={{ width: `${state.downloadProgress ?? 8}%` }} />
            </div>
            <span className="loading-percentage">
              {state.downloadProgress === null
                ? "Preparing the runtime"
                : `${state.downloadProgress}% downloaded`}
            </span>
          </div>
        ) : (
          <div
            className={`terminal-deck ${split && ports.length > 1 && mainPort !== 0 ? "split" : ""}`}
          >
            {pane(booting ? 0 : mainPort)}
            {split &&
              !booting &&
              ports.length > 1 &&
              mainPort !== 0 &&
              pane(
                secondPort === mainPort
                  ? ports.find((port) => port !== mainPort)!
                  : secondPort,
                true,
              )}
            {state.status === "paused" && (
              <div className="pause-overlay">
                <span className="empty-icon">
                  <Pause size={24} />
                </span>
                <h3>{machine.name} is paused.</h3>
                <p>Its memory and shell sessions are still here.</p>
                <button
                  className="button primary"
                  disabled={locked}
                  onClick={onResume}
                >
                  <Play size={15} />
                  Resume machine
                </button>
              </div>
            )}
            {booting && (
              <div className="boot-status">
                <LoaderCircle className="spin" size={14} />
                {state.init?.status === "running"
                  ? "Running boot script…"
                  : "Preparing Linux and its shells…"}
              </div>
            )}
          </div>
        )}
      </div>
      <form
        className="command-bar"
        onSubmit={(event) => {
          event.preventDefault();
          if (!command.trim()) return;
          setView("runs");
          void onRun(command);
        }}
      >
        <span className="command-prompt">❯</span>
        <input
          aria-label={`Run a command in ${machine.name}`}
          placeholder={
            ready
              ? "Run a bounded task in the agent channel…"
              : "Boot this machine to run a command"
          }
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          disabled={!ready || locked || !runner.ready}
          autoComplete="off"
          spellCheck={false}
        />
        <button
          aria-label="Run command"
          disabled={!ready || locked || !runner.ready || !command.trim()}
          type="submit"
        >
          {runner.busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : (
            <ArrowRight size={17} />
          )}
        </button>
      </form>
      <footer className="console-footer">
        <span>
          <Cpu size={12} />
          {memoryMiB} MiB
        </span>
        <span>
          {network.mode === "isolated" ? (
            <WifiOff size={12} />
          ) : (
            <Network size={12} />
          )}
          {network.mode === "isolated"
            ? "Network off"
            : network.mode === "local"
              ? "Private LAN"
              : network.transport === "wisp"
                ? "LAN + relay"
                : "LAN + web"}
        </span>
        <span className="terminal-key-hint">Ctrl ⇧ Esc leaves terminal</span>
      </footer>
    </section>
  );
}
