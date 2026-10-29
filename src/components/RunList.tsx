// SPDX-License-Identifier: Apache-2.0
import type { CSSProperties } from "react";
import { Code2, CheckCircle2, XCircle, ChevronDown } from "lucide-react";
import type { RunResult } from "../lib/agent-bridge";

export function RunList({
  runs,
  fontSize,
  compact = false,
}: {
  runs: RunResult[];
  fontSize: number;
  compact?: boolean;
}) {
  if (!runs.length)
    return (
      <div className="run-empty">
        <Code2 size={20} />
        <p>Real commands. Observable results.</p>
        <span>Your command history appears here after a run.</span>
      </div>
    );
  return (
    <div
      className={`run-list ${compact ? "compact" : ""}`}
      style={{ "--terminal-font-size": `${fontSize}px` } as CSSProperties}
    >
      {runs.map((run, index) => (
        <details
          className="run-entry"
          key={run.id}
          open={index === 0 || undefined}
        >
          <summary>
            <span
              className={`run-result-icon ${run.status === "exited" && run.exitCode === 0 ? "success" : "warning"}`}
            >
              {run.status === "exited" && run.exitCode === 0 ? (
                <CheckCircle2 size={16} />
              ) : (
                <XCircle size={16} />
              )}
            </span>
            <code>{run.command}</code>
            <span
              className={`pill ${run.status === "exited" && run.exitCode === 0 ? "success" : "warning"}`}
            >
              {run.status === "exited"
                ? `exit ${run.exitCode}`
                : run.status.replace(/_/g, " ")}
            </span>
            <ChevronDown size={14} />
          </summary>
          <div className="run-detail">
            <pre>{run.output || "(no output)"}</pre>
            <span>
              {(run.durationMs / 1000).toFixed(2)} s · shell output (stdout +
              stderr)
            </span>
            {run.message && <p className="run-message">{run.message}</p>}
          </div>
        </details>
      ))}
    </div>
  );
}
