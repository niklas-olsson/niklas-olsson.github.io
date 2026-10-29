// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { Check, Pause, Play, SquareTerminal, Trash2 } from "lucide-react";
import type { BridgeMachine } from "../lib/agent-bridge";
import type { SerialPort } from "../lib/runtime-types";
import { outputTail, subscribeRuntimeOutput } from "../lib/output-stream";

const VIEW_LIMIT = 128 * 1024;

function MachineOutput({ machine }: { machine: BridgeMachine }) {
  const runtime = machine.runtime;
  const [port, setPort] = useState<SerialPort>(0);
  const [live, setLive] = useState(true);
  const [followTail, setFollowTail] = useState(true);
  const [state, setState] = useState(() => runtime.getSnapshot());
  const [view, setView] = useState({ text: "", truncated: false });
  const [error, setError] = useState("");
  const pending = useRef({ text: "", truncated: false });
  const flush = useRef<() => void>(() => {});
  const output = useRef<HTMLPreElement>(null);

  useEffect(() => runtime.subscribe(setState), [runtime]);
  useEffect(() => {
    if (!live) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    pending.current = { text: "", truncated: false };
    setError("");
    const publish = () => {
      clearTimeout(timer);
      timer = undefined;
      setView({ ...pending.current });
    };
    flush.current = publish;
    let stop: (() => void) | undefined;
    try {
      stop = subscribeRuntimeOutput(runtime, (event) => {
        if (event.type === "reset") pending.current = { text: "", truncated: false };
        else {
          const text = pending.current.text + event.data;
          pending.current = {
            text: outputTail(text, VIEW_LIMIT),
            truncated: pending.current.truncated || text.length > VIEW_LIMIT,
          };
        }
        // Keep a fleet of noisy guests from rendering on every serial chunk.
        timer ??= setTimeout(publish, 100);
      }, { port, replay: true, format: "text" });
      publish();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "This output stream is unavailable.");
    }
    return () => { clearTimeout(timer); stop?.(); flush.current = () => {}; };
  }, [runtime, port, live]);

  useEffect(() => {
    if (followTail && output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [view.text, followTail]);

  return (
    <section className="fleet-output-panel glass" aria-label={`${machine.name} serial output`}>
      <header className="fleet-output-header">
        <div><SquareTerminal size={16} /><strong>{machine.name}</strong><span className={`status-label ${state.status}`}>{state.status}</span></div>
        <select
          aria-label={`${machine.name} serial port`}
          value={port}
          onChange={(event) => { setPort(Number(event.target.value) as SerialPort); setLive(true); setFollowTail(true); }}
        >
          {runtime.capabilities.serialPorts.map((value) => (
            <option key={value} value={value}>
              {value === 0 ? (runtime.capabilities.interactivePorts.includes(0) ? "Console · serial 0" : "System + agents · serial 0") : `Shell ${value} · serial ${value}`}
            </option>
          ))}
        </select>
      </header>
      <div className="fleet-output-tools">
        <button className="button small" onClick={() => { flush.current(); setLive(!live); }} aria-pressed={!live}>
          {live ? <Pause size={13} /> : <Play size={13} />}{live ? "Pause view" : "Resume view"}
        </button>
        <label className="fleet-follow"><input type="checkbox" checked={followTail} onChange={(event) => setFollowTail(event.target.checked)} />Follow tail</label>
        <button className="button small ghost" onClick={() => { pending.current = { text: "", truncated: false }; setView({ ...pending.current }); }}>
          <Trash2 size={13} />Clear view
        </button>
        <span className="small-print">{live ? "Live" : "View paused; VM continues"}</span>
      </div>
      {error && <p className="notice error" role="alert">{error}</p>}
      {view.truncated && <p className="small-print fleet-truncated">Earlier display text was trimmed. This pane retains the latest 128 Ki characters.</p>}
      <pre
        className="fleet-output-text"
        ref={output}
        tabIndex={0}
        aria-label={`${machine.name} ${port === 0 ? "system" : `shell ${port}`} output; read-only`}
        onScroll={(event) => {
          const element = event.currentTarget;
          const atEnd = element.scrollHeight - element.clientHeight - element.scrollTop < 24;
          if (atEnd !== followTail) setFollowTail(atEnd);
        }}
      >{view.text || (state.status === "idle" ? "Boot this machine to receive output." : "Waiting for output on this serial port…")}</pre>
    </section>
  );
}

/** Only selected panels subscribe. Each can be paused or closed independently. */
export function FleetConsole({ machines, activeId }: { machines: readonly BridgeMachine[]; activeId: string }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set([activeId]));
  const visible = machines.filter((machine) => selected.has(machine.id));
  return (
    <section className="fleet-console">
      <header className="fleet-heading">
        <div><h2>Machine output</h2><p>Follow boot messages, agent commands, and independent shells across the machines you choose.</p></div>
        <span className="pill subtle">{visible.length} selected</span>
      </header>
      <fieldset className="fleet-picker glass">
        <legend>Choose machines to follow</legend>
        <div className="fleet-picker-actions">
          <button className="button small" onClick={() => setSelected(new Set([activeId]))}>Active machine</button>
          <button className="button small" onClick={() => setSelected(new Set(machines.map((machine) => machine.id)))}>Select all</button>
          <button className="button small ghost" onClick={() => setSelected(new Set())}>Stop all views</button>
        </div>
        <div className="fleet-machine-choices">
          {machines.map((machine) => (
            <label key={machine.id} className={`fleet-machine-choice${selected.has(machine.id) ? " selected" : ""}`}>
              <input type="checkbox" checked={selected.has(machine.id)} onChange={(event) => {
                setSelected((previous) => {
                  const next = new Set(previous);
                  if (event.target.checked) next.add(machine.id); else next.delete(machine.id);
                  return next;
                });
              }} />
              <span>{machine.name}</span>{selected.has(machine.id) && <Check size={13} aria-hidden="true" />}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="small-print fleet-explanation">These are read-only text logs. Terminal cursor controls are omitted; system logs include kernel messages and the command protocol. Command results with exit codes remain in each machine’s Runs tab. Pausing a view stops its output subscription and leaves the guest running.</p>
      {visible.length ? <div className="fleet-output-grid">{visible.map((machine) => <MachineOutput key={machine.id} machine={machine} />)}</div> : <div className="empty-state glass"><SquareTerminal size={28} /><h3>No output streams selected</h3><p>Choose one or more machines above. Every selected machine gets its own output pane.</p></div>}
    </section>
  );
}
