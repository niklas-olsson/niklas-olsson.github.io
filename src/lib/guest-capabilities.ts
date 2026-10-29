// SPDX-License-Identifier: Apache-2.0

/** Guest reports are observations, not authenticated host facts or a Kubernetes certification. */
export const GUEST_CAPABILITY_COMMANDS = [
  "containerd", "runc", "k3s", "kubectl", "crictl", "ctr",
] as const;
export type GuestCapabilityCommand = typeof GUEST_CAPABILITY_COMMANDS[number];
export type GuestCgroupMode = "v2" | "hybrid" | "v1" | "none" | "unknown";
export type GuestOverlaySupport = "registered" | "module-present" | "not-observed";

export interface GuestCapabilityReport {
  schema: "terrarium.guest-capabilities/v1";
  source: "guest-reported";
  architecture: string;
  kernelRelease: string;
  memoryKiB: number | null;
  onlineCpus: number | null;
  cgroupMode: GuestCgroupMode;
  cgroupControllers: string[];
  namespaceEntries: string[];
  overlay: GuestOverlaySupport;
  commands: Record<GuestCapabilityCommand, boolean>;
  /** A prerequisite probe does not run containers, Kubernetes, CNI, or a durable restart. */
  kubernetesExecution: "not-verified";
}

export interface GuestPrerequisiteCheck {
  id: string;
  label: string;
  state: "observed" | "missing" | "unverified";
  detail: string;
}

const MAX_REPORT_BYTES = 16_384;
const textEncoder = new TextEncoder();

function markers(token: string): { begin: string; end: string } {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(token))
    throw new Error("A capability probe token must contain 1–64 letters, numbers, underscores or hyphens.");
  return {
    begin: `__TRM_CAPS_V1_${token}_BEGIN__`,
    end: `__TRM_CAPS_V1_${token}_END__`,
  };
}

/** Read-only POSIX shell probe; no installs, mounts, module loads or networking. */
export function buildGuestCapabilityProbe(token: string): string {
  const frame = markers(token);
  return [
    // Kernel messages still go to the serial console while these commands run.
    // Collect first so their output cannot split the slower observation steps.
    "_trm_report=$(",
    "printf 'architecture\\t%s\\n' \"$(uname -m 2>/dev/null)\"",
    "printf 'kernel\\t%s\\n' \"$(uname -r 2>/dev/null)\"",
    "printf 'memory_kib\\t%s\\n' \"$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo 2>/dev/null)\"",
    "printf 'cpus\\t%s\\n' \"$(if command -v nproc >/dev/null 2>&1; then nproc 2>/dev/null; else awk '/^processor[[:space:]]*:/ { n++ } END { if (n) print n }' /proc/cpuinfo 2>/dev/null; fi)\"",
    "_trm_cg=unknown; _trm_controllers=",
    "if [ -r /proc/mounts ]; then",
    "  _trm_cg=none",
    "  if grep -q ' cgroup ' /proc/mounts; then _trm_cg=v1; fi",
    "  if grep -q ' cgroup2 ' /proc/mounts; then",
    "    if [ \"$_trm_cg\" = v1 ]; then _trm_cg=hybrid; else _trm_cg=v2; fi",
    "  fi",
    "fi",
    "if [ -r /sys/fs/cgroup/cgroup.controllers ]; then _trm_controllers=$(cat /sys/fs/cgroup/cgroup.controllers); elif [ -r /sys/fs/cgroup/unified/cgroup.controllers ]; then _trm_controllers=$(cat /sys/fs/cgroup/unified/cgroup.controllers); fi",
    "printf 'cgroup_mode\\t%s\\n' \"$_trm_cg\"",
    "printf 'controllers\\t%s\\n' \"$_trm_controllers\"",
    "_trm_ns=; for _trm_path in /proc/self/ns/*; do if [ -e \"$_trm_path\" ]; then _trm_ns=\"${_trm_ns}${_trm_path##*/} \"; fi; done",
    "printf 'namespaces\\t%s\\n' \"$_trm_ns\"",
    "_trm_overlay=not-observed",
    "if grep -q '[[:space:]]overlay$' /proc/filesystems 2>/dev/null; then _trm_overlay=registered; elif command -v modinfo >/dev/null 2>&1 && modinfo overlay >/dev/null 2>&1; then _trm_overlay=module-present; fi",
    "printf 'overlay\\t%s\\n' \"$_trm_overlay\"",
    ...GUEST_CAPABILITY_COMMANDS.map((name) =>
      `if command -v ${name} >/dev/null 2>&1; then printf 'command_${name}\\t1\\n'; else printf 'command_${name}\\t0\\n'; fi`,
    ),
    "unset _trm_cg _trm_controllers _trm_ns _trm_path _trm_overlay",
    ")",
    `printf '\\n%s\\n%s\\n%s\\n' '${frame.begin}' \"$_trm_report\" '${frame.end}'`,
    "unset _trm_report",
  ].join("\n");
}

function invalid(reason: string): Error {
  return new Error(`Invalid guest capability report: ${reason}`);
}

function measuredInteger(value: string, name: string, maximum: number): number | null {
  if (!value) return null;
  if (!/^[1-9][0-9]*$/.test(value)) throw invalid(`${name} must be a positive integer or an empty observation.`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > maximum)
    throw invalid(`${name} is outside the supported observation range.`);
  return result;
}

function tokens(value: string, name: string): string[] {
  const result = value.trim() ? value.trim().split(/ +/) : [];
  if (result.length > 32 || result.some((entry) => !/^[a-z][a-z0-9_]{0,31}$/.test(entry)))
    throw invalid(`${name} contains unsupported entries.`);
  if (new Set(result).size !== result.length) throw invalid(`${name} contains duplicate entries.`);
  return result;
}

/** Parse one complete frame; bounded timestamped Linux console messages may interleave. */
export function parseGuestCapabilityReport(output: string, token: string): GuestCapabilityReport {
  const frame = markers(token);
  if (typeof output !== "string" || output.length > MAX_REPORT_BYTES || textEncoder.encode(output).byteLength > MAX_REPORT_BYTES)
    throw invalid("the output exceeds 16 KiB or is not text.");
  const lines = output.replace(/\r/g, "").split("\n");
  const begins = lines.flatMap((line, index) => line === frame.begin ? [index] : []);
  const ends = lines.flatMap((line, index) => line === frame.end ? [index] : []);
  if (begins.length !== 1 || ends.length !== 1 || ends[0] <= begins[0])
    throw invalid("one complete matching frame is required.");
  const required = ["architecture", "kernel", "memory_kib", "cpus", "cgroup_mode", "controllers", "namespaces", "overlay", ...GUEST_CAPABILITY_COMMANDS.map((name) => `command_${name}`)];
  const fields = new Map<string, string>();
  let kernelMessages = 0;
  for (const line of lines.slice(begins[0] + 1, ends[0])) {
    // A real guest produced "[  115.376595] random: crng init done" here.
    // This remains a guest-reported observation, never an authenticated claim.
    // Ignore only whole, short kernel-console records; all report fields stay
    // mandatory and strict. Partial-line corruption still rejects the report.
    if (line.length <= 512 && /^\[ *[0-9]{1,12}\.[0-9]{6}\] [\x20-\x7e]{1,480}$/.test(line)) {
      if (++kernelMessages > 16) throw invalid("too many interleaved kernel console messages.");
      continue;
    }
    const parts = line.split("\t");
    if (parts.length !== 2 || line.length > 512 || !required.includes(parts[0]))
      throw invalid("an unknown or malformed field was returned.");
    if (fields.has(parts[0])) throw invalid(`duplicate ${parts[0]} field.`);
    if (/[^\x20-\x7e]/.test(parts[1])) throw invalid("field values must be printable ASCII.");
    fields.set(parts[0], parts[1]);
  }
  if (fields.size !== required.length) throw invalid("required observations are missing.");
  const field = (name: string): string => fields.get(name)!;
  const architecture = field("architecture");
  const kernelRelease = field("kernel");
  if (!/^[A-Za-z0-9_.+-]{1,64}$/.test(architecture)) throw invalid("the architecture observation is missing or malformed.");
  if (!/^[A-Za-z0-9_.+~:-]{1,128}$/.test(kernelRelease)) throw invalid("the kernel observation is missing or malformed.");
  const cgroupMode = field("cgroup_mode") as GuestCgroupMode;
  if (!["v2", "hybrid", "v1", "none", "unknown"].includes(cgroupMode)) throw invalid("unknown cgroup mode.");
  const overlay = field("overlay") as GuestOverlaySupport;
  if (!["registered", "module-present", "not-observed"].includes(overlay)) throw invalid("unknown overlay observation.");
  const commands = {} as Record<GuestCapabilityCommand, boolean>;
  for (const name of GUEST_CAPABILITY_COMMANDS) {
    const value = field(`command_${name}`);
    if (value !== "0" && value !== "1") throw invalid(`the ${name} observation must be 0 or 1.`);
    commands[name] = value === "1";
  }
  return {
    schema: "terrarium.guest-capabilities/v1",
    source: "guest-reported",
    architecture,
    kernelRelease,
    memoryKiB: measuredInteger(field("memory_kib"), "memory", 2 ** 40),
    onlineCpus: measuredInteger(field("cpus"), "CPU count", 1_048_576),
    cgroupMode,
    cgroupControllers: tokens(field("controllers"), "cgroup controllers"),
    namespaceEntries: tokens(field("namespaces"), "namespace entries"),
    overlay,
    commands,
    kubernetesExecution: "not-verified",
  };
}

/** Limited prerequisites only. These checks never promote a guest to Kubernetes ready. */
export function describeKubernetesPrerequisites(report: GuestCapabilityReport): GuestPrerequisiteCheck[] {
  const expectedNamespaces = ["ipc", "mnt", "net", "pid", "uts"];
  const absentNamespaces = expectedNamespaces.filter((name) => !report.namespaceEntries.includes(name));
  const expectedControllers = ["cpu", "memory", "pids"];
  const absentControllers = expectedControllers.filter((name) => !report.cgroupControllers.includes(name));
  const kernel = /^(\d+)\.(\d+)/.exec(report.kernelRelease);
  const modernKernel = kernel && (Number(kernel[1]) > 5 || Number(kernel[1]) === 5 && Number(kernel[2]) >= 8);
  return [
    { id: "architecture", label: "64-bit Kubernetes target", state: ["x86_64", "aarch64"].includes(report.architecture) ? "observed" : "missing", detail: `Guest reports ${report.architecture}; this path targets x86_64 and aarch64.` },
    { id: "kernel", label: "Modern kernel baseline", state: modernKernel ? "observed" : "missing", detail: `Guest reports Linux ${report.kernelRelease}; the cgroup v2 baseline is Linux 5.8 or later. Required kernel configuration remains a separate check.` },
    { id: "cgroups", label: "Unified cgroup v2", state: report.cgroupMode === "v2" && absentControllers.length === 0 ? "observed" : report.cgroupMode === "unknown" ? "unverified" : "missing", detail: `Mode: ${report.cgroupMode}. Visible controllers: ${report.cgroupControllers.join(", ") || "none"}. This does not test controller delegation.` },
    { id: "namespaces", label: "Namespace entries", state: absentNamespaces.length ? "missing" : "observed", detail: absentNamespaces.length ? `Not observed: ${absentNamespaces.join(", ")}.` : "IPC, mount, network, PID and UTS entries are visible. Namespace creation has not been tested." },
    { id: "overlay", label: "Overlay filesystem", state: report.overlay === "registered" ? "observed" : "unverified", detail: report.overlay === "registered" ? "The guest kernel lists overlayfs. A container mount has not been tested." : report.overlay === "module-present" ? "An overlay module is present; it has not been loaded or tested." : "Overlayfs was not observed; this probe does not install or load modules." },
    { id: "k3s", label: "K3s executable", state: report.commands.k3s ? "observed" : "missing", detail: report.commands.k3s ? "k3s is on PATH. Its version, services and bundled runtime have not been tested." : "No k3s executable was found on PATH." },
    { id: "execution", label: "Actual Kubernetes execution", state: "unverified", detail: "Container execution, a Ready node, pod DNS/Services, CNI behavior and persistent restart require separate end-to-end tests." },
  ];
}
