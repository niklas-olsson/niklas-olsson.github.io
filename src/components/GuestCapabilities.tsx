// SPDX-License-Identifier: Apache-2.0
import { CheckCircle2, Info, Search, XCircle } from "lucide-react";
import { describeKubernetesPrerequisites, type GuestCapabilityReport } from "../lib/guest-capabilities";
import type { RuntimeStatus } from "../lib/runtime-types";

/** A guest observation is deliberately separate from an execution verification. */
export function GuestCapabilities({ report, error, status, onRuntimeSetup }: {
  report?: GuestCapabilityReport;
  error?: string;
  status: RuntimeStatus;
  onRuntimeSetup: () => void;
}) {
  const checks = report ? describeKubernetesPrerequisites(report) : [];
  const missing = checks.filter((check) => check.state === "missing").length;
  return <section className="runtime-card glass">
    <div className="card-label">GUEST PREREQUISITES <Search size={14} /></div>
    <p className="small-print">Kubernetes execution is unverified. This read-only probe reports facilities visible inside the guest.</p>
    {error ? <p className="error-text" role="status">Probe unavailable: {error}</p> : !report ? <p className="small-print">{["loading", "booting"].includes(status) ? "Waiting for the boot-time guest probe." : "Boot this machine to inspect its kernel, memory, cgroups, and installed tools."}</p> : <>
      <span className="pill subtle">{missing ? `${missing} prerequisite${missing === 1 ? "" : "s"} missing` : "Prerequisites observed; execution unverified"}</span>
      <details className="new-script-details">
        <summary>Inspect guest report</summary>
        <dl className="runtime-facts">
          <div><dt>Architecture</dt><dd>{report.architecture}</dd></div>
          <div><dt>Kernel</dt><dd>{report.kernelRelease}</dd></div>
          <div><dt>Reported RAM</dt><dd>{report.memoryKiB === null ? "Unavailable" : `${(report.memoryKiB / 1024).toFixed(1)} MiB`}</dd></div>
          <div><dt>Online CPUs</dt><dd>{report.onlineCpus ?? "Unavailable"}</dd></div>
          <div><dt>Cgroup mode</dt><dd>{report.cgroupMode}</dd></div>
          <div><dt>Controllers</dt><dd>{report.cgroupControllers.join(", ") || "None observed"}</dd></div>
          <div><dt>Namespace entries</dt><dd>{report.namespaceEntries.join(", ") || "None observed"}</dd></div>
          <div><dt>Tools on PATH</dt><dd>{Object.entries(report.commands).filter(([, found]) => found).map(([name]) => name).join(", ") || "None of the probed tools"}</dd></div>
        </dl>
        {checks.map((check) => <details key={check.id} className="new-script-details">
          <summary>{check.state === "observed" ? <CheckCircle2 size={13} /> : check.state === "missing" ? <XCircle size={13} /> : <Info size={13} />}{check.label} · {check.state}</summary>
          <p className="small-print">{check.detail}</p>
        </details>)}
        <p className="small-print">Reported by the guest after its boot script. Later guest changes can make this report stale. These observations do not authenticate a guest or establish that containers, pod networking, Services, or durable Kubernetes recovery work.</p>
      </details>
    </>}
    <button className="text-link" onClick={onRuntimeSetup}>Browser runtime setup</button>
  </section>;
}
