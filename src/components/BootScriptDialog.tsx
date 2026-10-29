// SPDX-License-Identifier: Apache-2.0
import { useRef, useState } from "react";
import { CheckCircle2, Download, FileCode2, Save, Upload } from "lucide-react";
import { Modal } from "./Modal";
import type { ManagedMachine } from "../lib/machines";
import { downloadFile } from "../lib/snapshots";
import { MAX_INIT_BYTES, validateInitScript } from "../lib/machine-config";

const EXAMPLE =
  '#!/bin/sh\nset -eu\n\nmkdir -p /root/workspace\nprintf "A little world, ready to explore.\\n" > /root/workspace/hello.txt\n\necho "Boot script finished on $(uname -m)"\n';

export function BootScriptDialog({
  machine,
  onSave,
  onClose,
}: {
  machine: ManagedMachine;
  onSave: (script: string) => void;
  onClose: () => void;
}) {
  const [script, setScript] = useState(machine.config.initScript);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const bytes = new TextEncoder().encode(script).byteLength;
  const latest = machine.runtime.getSnapshot().init;
  async function importScript(file?: File) {
    if (!file) return;
    try {
      if (file.size > MAX_INIT_BYTES)
        throw new Error("Keep boot scripts within 8 KiB of UTF-8 text.");
      setScript(validateInitScript(await file.text()));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return (
    <Modal
      title={`Boot script · ${machine.name}`}
      subtitle="Prepare this machine every time it starts fresh."
      className="script-modal"
      onClose={onClose}
      notice={error ? { message: error, error: true } : null}
    >
      <div className="script-toolbar">
        <span>
          <FileCode2 size={15} />
          /bin/sh · guest root
        </span>
        <div>
          <button
            className="button ghost"
            onClick={() => input.current?.click()}
          >
            <Upload size={14} />
            Import .sh
          </button>
          <button
            className="button ghost"
            disabled={!script}
            onClick={() =>
              downloadFile(
                `${machine.name}-init.sh`,
                script,
                "text/x-shellscript",
              )
            }
          >
            <Download size={14} />
            Export
          </button>
        </div>
      </div>
      <label className="visually-hidden" htmlFor="boot-script">
        Boot script
      </label>
      <textarea
        id="boot-script"
        className="script-editor"
        value={script}
        onChange={(event) => {
          setScript(event.target.value);
          setError(null);
        }}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder={"#!/bin/sh\n# Commands to run on a fresh boot"}
        autoFocus
      />
      <div className="script-meta">
        <span className={bytes > MAX_INIT_BYTES ? "danger-text" : ""}>
          {bytes.toLocaleString()} / {MAX_INIT_BYTES.toLocaleString()} bytes
        </span>
        <button
          disabled={Boolean(script.trim())}
          onClick={() => setScript(EXAMPLE)}
        >
          Insert a small example
        </button>
      </div>
      <p className="script-explainer">
        Runs once on Boot and Reset, after Linux starts. The script has up to 60
        seconds and runs before interactive shells are released. Saving applies
        to the next fresh boot. Restoring a snapshot preserves its existing
        state and skips the script.
      </p>
      {latest && latest.status !== "idle" && (
        <details className="script-result">
          <summary>
            <CheckCircle2 size={14} />
            Last boot: {latest.status}
            {latest.exitCode !== null ? ` · exit ${latest.exitCode}` : ""}
          </summary>
          <pre>{latest.output || latest.message || "(no output)"}</pre>
        </details>
      )}
      <input
        ref={input}
        className="visually-hidden"
        type="file"
        accept=".sh,.txt,text/plain,text/x-shellscript"
        onChange={(event) => {
          void importScript(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <footer className="modal-footer">
        <button className="button secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={bytes > MAX_INIT_BYTES}
          onClick={() => {
            try {
              onSave(validateInitScript(script));
              onClose();
            } catch (reason) {
              setError(
                reason instanceof Error ? reason.message : String(reason),
              );
            }
          }}
        >
          <Save size={15} />
          Save boot script
        </button>
      </footer>
    </Modal>
  );
}
