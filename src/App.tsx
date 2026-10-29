// SPDX-License-Identifier: Apache-2.0
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  Box,
  Braces,
  Check,
  CheckCircle2,
  ChevronRight,
  Code2,
  Copy,
  Cpu,
  Download,
  FileCode2,
  FileSearch,
  ShieldCheck,
  Globe2,
  HardDrive,
  Info,
  Layers3,
  LoaderCircle,
  Menu,
  Network,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  Terminal,
  SquareTerminal,
  Cloud,
  Trash2,
  Upload,
  WifiOff,
  X,
  XCircle,
} from "lucide-react";
import { workspace, PROFILES, type ManagedMachine } from "./lib/machines";
import {
  MAX_INIT_BYTES,
  validateInitScript,
  type MachineProfile,
} from "./lib/machine-config";
import { type RuntimeStatus } from "./lib/runtime-types";
import {
  loadPreferences,
  savePreferences,
  type Preferences,
} from "./lib/preferences";
import { installAgentBridge } from "./lib/agent-bridge";
import type { NetworkMode } from "./lib/network";
import {
  deleteSnapshot,
  downloadFile,
  listSnapshots,
  readSnapshot,
  storeSnapshot,
  subscribeSnapshotChanges,
  type SnapshotMeta,
} from "./lib/snapshots";
import { Appearance } from "./components/Appearance";
import { BrandMark } from "./components/Brand";
import { Modal } from "./components/Modal";
import { MachineConsole } from "./components/MachineConsole";
import { NetworkControls, NetworkPanel } from "./components/NetworkPanel";
import { BootScriptDialog } from "./components/BootScriptDialog";
import { FieldGuide } from "./components/FieldGuide";
import { NetworkTransportDialog } from "./components/NetworkTransportDialog";
import { RunList } from "./components/RunList";
import { InvestigationPanel } from "./components/InvestigationPanel";
import { RUNTIME_PROFILES } from "./lib/runtime-profiles";
import { assertCheckpointProfile, checkpointRuntimeVersion, isCheckpointRuntimeCompatible, inspectCheckpoint, MAX_CHECKPOINT_BYTES } from "./lib/checkpoint-format";
import { FleetConsole } from "./components/FleetConsole";
import { CloudPanel } from "./components/CloudPanel";
import { cloud } from "./lib/control-plane";
import { WorkspaceRecovery } from "./components/WorkspaceRecovery";
import { GuestCapabilities } from "./components/GuestCapabilities";
import { MachineHardwareSettings } from "./components/MachineHardwareSettings";
import { X86_MACHINE_PRESETS } from "./lib/x86-machine-config";

type Page = "playground" | "console" | "cloud" | "network" | "agents" | "snapshots" | "workspace" | "about";
type Icon = ComponentType<{
  size?: number;
  className?: string;
  strokeWidth?: number;
}>;
const NAV: { id: Page; title: string; icon: Icon }[] = [
  { id: "playground", title: "Playground", icon: Terminal },
  { id: "console", title: "Console", icon: SquareTerminal },
  { id: "cloud", title: "Cloud resources", icon: Cloud },
  { id: "network", title: "Connections", icon: Network },
  { id: "agents", title: "Agent workbench", icon: Braces },
  { id: "snapshots", title: "Snapshots & evidence", icon: Layers3 },
  { id: "workspace", title: "Workspace & storage", icon: HardDrive },
];
const STATUS_LABELS: Record<RuntimeStatus, string> = {
  idle: "Ready to boot",
  loading: "Downloading",
  booting: "Starting Linux",
  running: "Running locally",
  paused: "Paused",
  error: "Needs attention",
};
function Status({
  status,
  small = false,
}: {
  status: RuntimeStatus;
  small?: boolean;
}) {
  return (
    <span className={`status ${status} ${small ? "small" : ""}`}>
      <span className="status-dot" />
      {STATUS_LABELS[status]}
    </span>
  );
}

export default function App() {
  const [page, setPage] = useState<Page>("playground");
  const [work, setWork] = useState(workspace.getSnapshot);
  const [preferences, setPreferences] = useState<Preferences>(loadPreferences);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(
    () => matchMedia("(max-width: 700px)").matches,
  );
  const [expanded, setExpanded] = useState(false);
  const [actions, setActions] = useState<Record<string, string>>({});
  const actionTasks = useRef(new Set<string>());
  const cancellationTasks = useRef(new Map<string, Promise<void>>());
  const cancelledStarts = useRef(new Set<string>());
  const [cancellingBoots, setCancellingBoots] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const [agentCommand, setAgentCommand] = useState(
    'uname -srm && printf "hello from the guest\\n"',
  );
  const [timeout, setTimeoutValue] = useState(15_000);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [snapshotTitle, setSnapshotTitle] = useState("");
  const [inspectionTarget, setInspectionTarget] = useState<SnapshotMeta | null>(
    null,
  );
  const [snapshotTarget, setSnapshotTarget] = useState<ManagedMachine | null>(
    null,
  );
  const [scriptMachine, setScriptMachine] = useState<ManagedMachine | null>(
    null,
  );
  const [networkMachine, setNetworkMachine] = useState<ManagedMachine | null>(
    null,
  );
  const [newMachine, setNewMachine] = useState(false);
  const [newName, setNewName] = useState("local-02");
  const [newProfile, setNewProfile] = useState<MachineProfile>("x86");
  const [newScript, setNewScript] = useState("");
  const [newVpcId, setNewVpcId] = useState(work.vpcs[0]?.id ?? "");
  const [newSubnetId, setNewSubnetId] = useState(work.vpcs[0]?.subnets[0]?.id ?? "");
  const [editMachine, setEditMachine] = useState<ManagedMachine | null>(null);
  const [editName, setEditName] = useState("");
  const [hardwareSettingsBusy, setHardwareSettingsBusy] = useState(false);
  const [confirm, setConfirm] = useState<{
    title: string;
    body: string;
    label: string;
    machine: ManagedMachine | null;
    run: () => Promise<void>;
  } | null>(null);
  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const preferenceWarningShown = useRef(false);
  const summary =
    work.machines.find((entry) => entry.id === work.activeId) ??
    work.machines[0];
  const machine = summary ? workspace.list().find((entry) => entry.id === summary.id) ?? null : null;
  const state = summary?.state;
  const runner = summary?.runner;
  const runtime = machine?.runtime;
  const action = machine ? actions[machine.id] ?? null : null;
  const ready = state?.status === "running";
  const hasMachine = ready || state?.status === "paused";
  const isBooting = state?.status === "loading" || state?.status === "booting";
  const writable = work.persistence.mode === "writable" && !work.preparingReload;
  const locked =
    !writable || (summary?.lifecycle !== undefined && summary.lifecycle !== "ready") || runner?.busy ||
    action !== null ||
    Boolean(state?.operation) ||
    Boolean(state?.acquiringEvidence) || Boolean(state?.volumeOperation);
  const canCancelBoot = Boolean(
    machine && runtime?.capabilities.cancelBoot && isBooting && writable &&
    summary?.lifecycle === "ready" && !runner?.busy && !state?.operation &&
    !state?.acquiringEvidence && !state?.volumeOperation && !cancellingBoots.has(machine.id),
  );
  const profile = machine ? PROFILES[machine.config.profile] : null;
  const configuredMemoryMiB = machine?.config.x86 ? X86_MACHINE_PRESETS[machine.config.x86.presetId].memoryMiB : profile?.memory;
  const runningCount = work.machines.filter(
    (entry) => entry.state.status === "running",
  ).length;
  const lanCount = work.machines.filter(
    (entry) => entry.network.mode !== "isolated",
  ).length;
  const webCount = work.machines.filter(
    (entry) => entry.network.mode === "world",
  ).length;

  useEffect(() => workspace.subscribe(setWork), []);
  useEffect(() => {
    installAgentBridge(workspace, { cloud, workspace: {
      status: () => ({ ...workspace.getSnapshot().persistence, recovery: workspace.getSnapshot().recovery }),
      prepareReload: workspace.prepareReload, takeControl: workspace.takeControl,
      acknowledgeRecovery: workspace.acknowledgeRecovery, exportManifest: workspace.exportManifest,
    } });
  }, []);
  useEffect(() => {
    const query = matchMedia("(max-width: 700px)");
    const change = () => {
      setMobileViewport(query.matches);
      if (!query.matches) setMobileMenu(false);
    };
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!mobileMenu) return;
    sidebar.current?.querySelector("button")?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenu(false);
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      menuButton.current?.focus();
    };
  }, [mobileMenu]);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.ctrlKey) setExpanded(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = preferences.theme;
    root.dataset.reduceMotion = String(preferences.reduceMotion);
    root.style.setProperty("--surface-opacity", String(preferences.opacity));
    root.style.setProperty(
      "--material-blur",
      preferences.blur ? "18px" : "0px",
    );
    root.style.setProperty("--terminal-font-size", `${preferences.fontSize}px`);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute(
        "content",
        getComputedStyle(root).getPropertyValue("--canvas").trim(),
      );
    if (!savePreferences(preferences) && !preferenceWarningShown.current) {
      preferenceWarningShown.current = true;
      setNotice({
        message:
          "Appearance changed for this tab. Your browser did not allow settings to be saved.",
        error: false,
      });
    }
  }, [preferences]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(
      () => setNotice(null),
      notice.error ? 12_000 : 6_000,
    );
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (page !== "snapshots") return;
    let active = true;
    let request = 0;
    const update = () => { const current = ++request; void listSnapshots().then((items) => { if (active && current === request) setSnapshots(items); }).catch((error) => { if (active && current === request) showError(error); }); };
    update();
    const unsubscribe = subscribeSnapshotChanges(update);
    return () => { active = false; unsubscribe(); };
  }, [page]);
  useEffect(() => {
    const exists = (entry: ManagedMachine | null) => !entry || work.machines.some((item) => item.id === entry.id);
    if (!exists(editMachine)) setEditMachine(null);
    if (!exists(scriptMachine)) setScriptMachine(null);
    if (!exists(networkMachine)) setNetworkMachine(null);
    if (!exists(snapshotTarget)) setSnapshotTarget(null);
    if (confirm?.machine && !exists(confirm.machine) && !actions[confirm.machine.id]) {
      setConfirm(null);
      setNotice({ message: "That machine was already deleted. Its dialog has been closed.", error: false });
    }
  }, [work.machines, editMachine, scriptMachine, networkMachine, snapshotTarget, confirm, actions]);

  function showError(error: unknown) {
    setNotice({
      message: error instanceof Error ? error.message : String(error),
      error: true,
    });
  }
  function navigate(next: Page) {
    setPage(next);
    setMobileMenu(false);
    setExpanded(false);
  }
  function selectMachine(id: string) {
    workspace.select(id);
    navigate("playground");
  }
  async function perform(
    label: string,
    target: ManagedMachine | null,
    task: () => Promise<void>,
  ) {
    const key = target?.id ?? "workspace-resource";
    if (actionTasks.current.has(key)) return;
    if (target && (target.runner.isBusy() || target.lifecycle !== "ready" || target.runtime.getSnapshot().operation || target.runtime.getSnapshot().acquiringEvidence || target.runtime.getSnapshot().volumeOperation)) {
      showError(new Error(`Wait for ${target.name}'s current command or resource operation to finish, then retry.`));
      return;
    }
    actionTasks.current.add(key);
    setActions((old) => ({ ...old, [key]: label }));
    try {
      workspace.assertWritable();
      await task();
    } catch (error) {
      const expectedCancellation = label === "boot" && target && cancelledStarts.current.has(target.id) &&
        error instanceof Error && /stopped|cancelled|interrupted/i.test(error.message);
      if (!expectedCancellation) showError(error);
    } finally {
      actionTasks.current.delete(key);
      setActions((old) => {
        const next = { ...old };
        delete next[key];
        return next;
      });
    }
  }
  async function boot(target = machine) {
    if (!target) return;
    cancelledStarts.current.delete(target.id);
    await perform("boot", target, target.runtime.boot);
  }
  function cancelBoot(id: string): Promise<void> {
    const previous = cancellationTasks.current.get(id);
    if (previous) return previous;
    const task = Promise.resolve().then(async () => {
      workspace.assertWritable();
      const target = workspace.get(id);
      const current = target.runtime.getSnapshot();
      if (!target.runtime.capabilities.cancelBoot || !["loading", "booting"].includes(current.status))
        throw new Error("This machine no longer has a cancellable boot in progress.");
      cancelledStarts.current.add(id);
      await workspace.stop(id);
      setNotice({ message: `Boot cancelled for ${target.name}. The saved machine definition and stored data disks are kept.`, error: false });
    }).finally(() => {
      cancellationTasks.current.delete(id);
      setCancellingBoots(new Set(cancellationTasks.current.keys()));
    });
    cancellationTasks.current.set(id, task);
    setCancellingBoots(new Set(cancellationTasks.current.keys()));
    return task;
  }
  async function runCommand(command: string) {
    if (locked || !machine) return;
    try {
      const result = await machine.runner.execute(command, {
        timeoutMs: timeout,
      });
      if (result.status !== "exited")
        setNotice({
          message: `${machine.name}: ${result.message || `Command ${result.status.replace(/_/g, " ")}. Completion could not be confirmed.`}`,
          error: true,
        });
    } catch (error) {
      showError(error);
    }
  }
  function setNetwork(id: string, mode: NetworkMode) {
    try {
      workspace.setNetwork(id, mode);
    } catch (error) {
      showError(error);
    }
  }
  function requestReset() {
    const target = machine;
    if (!target) return;
    setConfirm({
      title: `Reset ${target.name}?`,
      body: "This discards the machine’s RAM, temporary root files, and processes, then boots a clean guest and runs its saved boot script. Attached data volumes are synced and preserved. Resume a paused guest with writable volumes before resetting it.",
      label: "Reset machine",
      machine: target,
      run: target.runtime.reset,
    });
  }
  function requestRemove(target = machine) {
    if (!target) return;
    setConfirm({
      title: `Delete ${target.name}?`,
      body: "This syncs writable data disks, stops the guest, and deletes its saved definition and boot script. Guest RAM and temporary root files are lost. Attached disks, independent snapshots, and evidence archives are kept. Resume a paused guest with writable disks first. The last machine can also be deleted.",
      label: "Delete machine",
      machine: target,
      run: () => workspace.remove(target.id),
    });
  }
  function openNewMachine(
    vpcId = work.vpcs.find((vpc) => vpc.subnets.length > 0)?.id ?? "",
    subnetId = work.vpcs.find((item) => item.id === vpcId)?.subnets[0]?.id ?? "",
  ) {
    if (!vpcId || !subnetId) {
      navigate("network");
      setNotice({ message: "Create a VPC and a subnet in Connections before creating a machine.", error: false });
      return;
    }
    let number = work.machines.length + 1;
    while (
      work.machines.some(
        (entry) => entry.name === `local-${String(number).padStart(2, "0")}`,
      )
    )
      number++;
    setNewName(`local-${String(number).padStart(2, "0")}`);
    setNewProfile("alpine-riscv64");
    setNewVpcId(vpcId);
    setNewSubnetId(subnetId);
    setNewScript("");
    setNewMachine(true);
    setNotice(null);
  }
  function createMachine(start: boolean) {
    try {
      const entry = workspace.add(
        newName,
        newProfile,
        validateInitScript(newScript),
        { vpcId: newVpcId, subnetId: newSubnetId },
      );
      setNewMachine(false);
      navigate("playground");
      if (start) void boot(entry);
    } catch (error) {
      showError(error);
    }
  }
  function openSnapshot() {
    if (!machine) return;
    setSnapshotTitle(`${machine.name} · ${new Date().toLocaleDateString()}`);
    setSnapshotTarget(machine);
  }
  async function saveSnapshotToBrowser() {
    if (!snapshotTarget) return;
    const target = snapshotTarget;
    await perform("snapshot", target, async () => {
      const meta = await storeSnapshot(
        snapshotTitle,
        await target.runtime.save(),
      );
      setSnapshots(await listSnapshots());
      setSnapshotTarget(null);
      setNotice({
        message: `“${meta.title}” saved in this browser.`,
        error: false,
      });
    });
  }
  async function exportCurrentSnapshot() {
    const target = snapshotTarget ?? machine;
    if (!target) return;
    await perform("snapshot", target, async () => {
      if (!checkpointRuntimeVersion(target.config.profile)) throw new Error("This machine profile does not have a checkpoint format.");
      const bytes = await target.runtime.save();
      const inspection = await inspectCheckpoint(bytes);
      downloadFile(
        `terrarium-${target.name}-${inspection.runtimeVersion.replace("@", "-")}-${Date.now()}.bin`,
        bytes,
      );
      setNotice({
        message:
          "Machine snapshot downloaded. Keep it with this runtime version.",
        error: false,
      });
    });
  }
  function restoreStored(meta: SnapshotMeta) {
    const target = machine;
    if (!target) return;
    setConfirm({
      title: `Restore into ${target.name}?`,
      body: `“${meta.title}” replaces this machine’s CPU, memory, and guest files, then resumes guest execution with this machine’s current network setting: ${target.port.getSnapshot().mode}. Its boot script will not run. For an untrusted checkpoint, choose Inspect and create a quarantined clone.`,
      label: "Restore and resume",
      machine: target,
      run: async () => {
        if (!isCheckpointRuntimeCompatible(target.config.profile, meta.runtime))
          throw new Error(
            "This snapshot requires a runtime that is not supported by the selected machine profile. Its original bytes remain available for export.",
          );
        const bytes = await readSnapshot(meta.id);
        await assertCheckpointProfile(bytes, target.config.profile);
        await target.runtime.restore(bytes);
        navigate("playground");
        setNotice({
          message: `Snapshot restored into ${target.name}.`,
          error: false,
        });
      },
    });
  }
  async function importSnapshot(file?: File) {
    if (!file) return;
    try { workspace.assertWritable(); } catch (error) { showError(error); return; }
    if (file.size > MAX_CHECKPOINT_BYTES) {
      showError(
        new Error(`Choose a compatible checkpoint within its runtime's size limit, up to about ${Math.round(MAX_CHECKPOINT_BYTES / 1048576)} MiB.`),
      );
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      await inspectCheckpoint(buffer);
      const meta = await storeSnapshot(
        file.name.replace(/\.bin$/i, ""),
        buffer,
      );
      setSnapshots(await listSnapshots());
      setInspectionTarget(meta);
      setNotice({
        message: "Checkpoint imported and hashed. No guest was started.",
        error: false,
      });
    } catch (error) {
      showError(error);
    }
  }

  const bridgeExample = `const machines = window.terrarium.list();\nconst vm = window.terrarium.get(machines[0].id);\nawait vm.boot();\nconst result = await vm.exec('uname -a');\nresult`;
  async function copyBridgeExample() {
    try {
      await navigator.clipboard.writeText(bridgeExample);
      setNotice({ message: "Machine API example copied.", error: false });
    } catch {
      showError(
        new Error(
          "Clipboard access was blocked. Select and copy the example manually.",
        ),
      );
    }
  }

  return (
    <div className={`app-shell ${expanded ? "console-expanded" : ""}`}>
      <a href="#main" className="skip-link">
        Skip to playground
      </a>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="background-grid" />
      {mobileMenu && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <aside
        id="main-navigation"
        ref={sidebar}
        inert={mobileViewport && !mobileMenu}
        aria-hidden={mobileViewport && !mobileMenu ? true : undefined}
        className={`sidebar glass ${mobileMenu ? "open" : ""}`}
      >
        <button
          className="brand"
          onClick={() => navigate("playground")}
          aria-label="Terrarium home"
        >
          <BrandMark className="brand-mark" />
          <span>
            terrarium<span className="brand-period">.</span>
            <small>A SYSTEMS PLAYGROUND</small>
          </span>
        </button>
        <div className="sidebar-section-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {NAV.map(({ id, title, icon: NavIcon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? "active" : ""}`}
              aria-current={page === id ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              <NavIcon size={17} />
              <span>{title}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-rule" />
        <div className="sidebar-section-label machine-section-label">
          MACHINES
          <span className="machine-section-actions">
            <span className="micro-label">
              {work.machines.length}
            </span>
            <button
              className="icon-button"
              aria-label="Add machine"
              onClick={() => openNewMachine()}
            >
              <Plus size={15} />
            </button>
          </span>
        </div>
        <p className="machine-budget">{work.machines.filter((entry) => !["idle", "error"].includes(entry.state.status)).reduce((total, entry) => total + (entry.config.x86 ? X86_MACHINE_PRESETS[entry.config.x86.presetId].memoryMiB : RUNTIME_PROFILES[entry.config.profile].memoryMiB), 0)} MiB guest RAM in started machines</p>
        <div className="machine-list">
          {work.machines.map((entry) => (
            <button
              key={entry.id}
              className={`machine-nav ${entry.id === machine?.id ? "selected" : ""}`}
              aria-label={`Select ${entry.name}, ${STATUS_LABELS[entry.state.status]}`}
              aria-current={entry.id === machine?.id ? "true" : undefined}
              onClick={() => selectMachine(entry.id)}
            >
              <span className="machine-nav-icon">
                <Box size={17} />
              </span>
              <span>
                <strong>{entry.name}</strong>
                <small>
                  {PROFILES[entry.config.profile].architecture}
                </small>
              </span>
              <span className={`machine-indicator ${entry.state.status}`} />
            </button>
          ))}
        </div>
        <button
          className="add-machine-inline"
          onClick={() => openNewMachine()}
        >
          <Plus size={14} />
          New machine
        </button>
        <div className="sidebar-rule compact-rule" />
        <div className="sidebar-section-label">CONNECTIONS</div>
        <button
          className={`sidebar-network ${page === "network" ? "selected" : ""}`}
          onClick={() => navigate("network")}
        >
          <Network size={17} />
          <span>
            <strong>
              {work.vpcs.length} VPC{work.vpcs.length === 1 ? "" : "s"}
            </strong>
            <small>
              {lanCount} LAN port{lanCount === 1 ? "" : "s"} enabled
            </small>
          </span>
          <ChevronRight size={13} />
        </button>
        <button
          className="sidebar-network world"
          onClick={() => navigate("network")}
        >
          {webCount ? <Globe2 size={16} /> : <WifiOff size={16} />}
          <span>
            <strong>World</strong>
            <small>
              {webCount
                ? `${webCount} outside connection${webCount === 1 ? "" : "s"} enabled`
                : "Outside access off"}
            </small>
          </span>
        </button>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setAppearanceOpen(true)}>
            <Settings2 size={17} />
            <span>Appearance</span>
            <span className="theme-dot" />
          </button>
          <button
            className={`nav-item ${page === "about" ? "active" : ""}`}
            onClick={() => navigate("about")}
            aria-current={page === "about" ? "page" : undefined}
          >
            <BookOpen size={17} />
            <span>Field guide</span>
          </button>
          <div className="sidebar-version">
            <span>v0.8.0-dev.s1</span>
            <span>{runningCount} RUNNING LOCALLY</span>
          </div>
        </div>
      </aside>
      <div className="workspace" inert={mobileViewport && mobileMenu}>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              ref={menuButton}
              className="icon-button mobile-menu-button"
              aria-label="Open navigation"
              aria-expanded={mobileMenu}
              aria-controls="main-navigation"
              onClick={() => setMobileMenu(!mobileMenu)}
            >
              <Menu size={19} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>
              {page === "about"
                ? "Field guide"
                : NAV.find((entry) => entry.id === page)?.title}
            </strong>
          </div>
          <div className="topbar-actions">
            <span className="browser-badge">
              <span />
              IN YOUR BROWSER
            </span>
            <span className="vertical-rule" />
            <button
              className="icon-button"
              aria-label="Change appearance"
              onClick={() => setAppearanceOpen(true)}
            >
              <Settings2 size={17} />
            </button>
            <button
              className="avatar-button"
              title="About this local workspace"
              onClick={() => navigate("about")}
            >
              <BrandMark />
            </button>
          </div>
        </header>
        <main id="main" tabIndex={-1}>
          {work.persistence.mode !== "writable" && (
            <div className="command-warning" role="status">
              <Info size={17} />
              <p>
                {work.persistence.mode === "opening" ? "Opening the saved workspace and checking tab ownership…" : work.persistence.error}
              </p>
              <button className="button secondary" onClick={() => navigate("workspace")}>Workspace & storage</button>
            </div>
          )}
          {work.recovery.length > 0 && page !== "workspace" && <div className="command-warning" role="status"><Info size={17} /><p>{work.recovery.length} machine{work.recovery.length === 1 ? " was" : "s were"} active when the previous page ended. Definitions and committed disks were kept; guest memory was not restored.</p><button className="button secondary" onClick={() => navigate("workspace")}>Review recovery</button></div>}
          {runner?.blockedReason && machine && (
            <div className="command-warning" role="alert">
              <Info size={17} />
              <p>{runner.blockedReason}</p>
              <button
                className="button secondary"
                disabled={locked}
                onClick={requestReset}
              >
                Reset {machine.name}
              </button>
            </div>
          )}
          {!machine && (page === "playground" || page === "agents") && <section className="empty-state glass empty-workspace"><Box size={34} /><h1>Room for a new world.</h1><p>This workspace has no machines. Your stored disks, snapshots, and objects remain available in their resource views.</p><button className="button primary" disabled={!writable} onClick={() => openNewMachine()}><Plus size={16} />Create a machine</button><button className="button secondary" onClick={() => navigate("cloud")}>Open cloud resources</button></section>}
          {page === "playground" && machine && summary && state && runner && runtime && profile && (
            <>
              <section className="page-heading workspace-heading">
                <div>
                  <div className="eyebrow">
                    <Box size={14} />
                    YOUR LITTLE WORLD
                  </div>
                  <h1 className="machine-heading">
                    {machine.name}
                    <button
                      className="icon-button"
                      aria-label={`Edit ${machine.name}`}
                      onClick={() => {
                        setEditName(machine.name);
                        setEditMachine(machine);
                        setNotice(null);
                      }}
                    >
                      <Settings2 size={16} />
                    </button>
                  </h1>
                  <p>
                    {profile.title} · {profile.architecture} · {configuredMemoryMiB}{" "}
                    MiB
                  </p>
                </div>
                <div className="heading-actions">
                  <button
                    className="button secondary"
                    onClick={() => setScriptMachine(machine)}
                  >
                    <FileCode2 size={15} />
                    Boot script
                    {machine.config.initScript.trim() && (
                      <span className="button-dot" />
                    )}
                  </button>
                  <button
                    className="button secondary"
                    disabled={
                      !hasMachine || locked || !runtime?.capabilities.snapshots
                    }
                    onClick={openSnapshot}
                    title={
                      !runtime.capabilities.snapshots
                        ? "VM checkpoints require a compatible profile without external volumes or evidence"
                        : "Save this machine"
                    }
                  >
                    <Save size={15} />
                    Snapshot
                  </button>
                  {isBooting && runtime.capabilities.cancelBoot && <button className="button secondary" disabled={!canCancelBoot} onClick={() => void cancelBoot(machine.id).catch(showError)}>{cancellingBoots.has(machine.id) ? <LoaderCircle size={15} className="spin" /> : <X size={15} />}Cancel boot</button>}
                  <button className="button ghost danger-hover" disabled={locked || isBooting || cancellingBoots.has(machine.id)} onClick={() => requestRemove()}><Trash2 size={15} />Delete</button>
                </div>
              </section>
              {machine.investigation && (
                <div className="quarantine-banner glass">
                  <ShieldCheck size={19} />
                  <div>
                    <strong>Quarantined checkpoint clone</strong>
                    <p>
                      {state.status === "paused"
                        ? "Paused. Resume explicitly to execute guest code. "
                        : "Guest execution is allowed. "}
                      Peer and outside traffic are permanently disconnected.
                    </p>
                  </div>
                  <button
                    className="button secondary"
                    onClick={() => navigate("snapshots")}
                  >
                    Open evidence bench
                  </button>
                </div>
              )}
              {machine.evidence && (
                <div className="quarantine-banner glass">
                  <FileSearch size={19} />
                  <div>
                    <strong>Clean analyst · read-only evidence</strong>
                    <p>
                      {machine.evidence.title} is mounted at{" "}
                      <code>/mnt/evidence</code>. This temporary guest cannot
                      save checkpoints.
                    </p>
                  </div>
                </div>
              )}
              <div className="playground-grid machine-playground">
                <MachineConsole
                  key={machine.id}
                  machine={machine}
                  summary={summary}
                  preferences={preferences}
                  locked={locked}
                  expanded={expanded}
                  onExpand={() => setExpanded(!expanded)}
                  onBoot={() => void boot()}
                  onResume={() =>
                    void perform("resume", machine, runtime.resume)
                  }
                  onRun={runCommand}
                />
                <aside className="inspector">
                  <section className="runtime-card glass">
                    <div className="card-label">
                      MACHINE DETAILS
                      <Cpu size={14} />
                    </div>
                    <div className="runtime-profile">
                      <span>
                        <Box size={22} />
                      </span>
                      <div>
                        <h3>{profile.title}</h3>
                        <p>
                          {RUNTIME_PROFILES[machine.config.profile].userland}
                        </p>
                      </div>
                    </div>
                    <dl className="runtime-facts">
                      <div>
                        <dt>Status</dt>
                        <dd>
                          <Status status={state.status} small />
                        </dd>
                      </div>
                      <div>
                        <dt>Architecture</dt>
                        <dd>{profile.architecture}</dd>
                      </div>
                      <div>
                        <dt>Guest RAM</dt>
                        <dd>{configuredMemoryMiB} MiB</dd>
                      </div>
                      <div>
                        <dt>Shells</dt>
                        <dd>
                          {runtime.capabilities.interactivePorts.length}{" "}
                          independent
                        </dd>
                      </div>
                      <div>
                        <dt>Boot script</dt>
                        <dd>
                          {state.init?.status === "failed"
                            ? "Failed"
                            : state.init?.status === "running"
                              ? "Running"
                              : machine.config.initScript.trim()
                                ? state.init?.status === "succeeded"
                                  ? "Completed"
                                  : "Configured"
                                : "Empty"}
                        </dd>
                      </div>
                    </dl>
                    {RUNTIME_PROFILES[machine.config.profile].runtimeKind === "qemu" && <p className="small-print">This experimental runtime reserves 2,300 MiB of shared Wasm memory per instance, including its guest RAM. Root changes are lost on stop, reset or refresh unless preserved in a VM checkpoint.</p>}
                    <div className="runtime-actions">
                      <button
                        className="button secondary"
                        disabled={!hasMachine || locked}
                        onClick={() =>
                          void perform(
                            state.status === "paused" ? "resume" : "pause",
                            machine,
                            state.status === "paused"
                              ? runtime.resume
                              : runtime.pause,
                          )
                        }
                      >
                        {state.status === "paused" ? (
                          <Play size={14} />
                        ) : (
                          <Pause size={14} />
                        )}
                        {state.status === "paused" ? "Resume" : "Pause"}
                      </button>
                      <button
                        className="button ghost"
                        disabled={
                          (!hasMachine && state.status !== "error") || locked
                        }
                        onClick={requestReset}
                      >
                        <RotateCcw size={14} />
                        Reset
                      </button>
                    </div>
                  </section>
                  {RUNTIME_PROFILES[machine.config.profile].runtimeKind === "qemu" && <GuestCapabilities report={state.guestCapabilities} error={state.guestCapabilityError} status={state.status} onRuntimeSetup={() => navigate("workspace")} />}
                  <section className="runtime-card network-inspector glass">
                    <div className="card-label">
                      CONNECTIONS
                      <Network size={14} />
                    </div>
                    <NetworkControls
                      machine={summary}
                      readOnly={!writable}
                      onChange={setNetwork}
                      onConfigure={(id) => setNetworkMachine(workspace.get(id))}
                      compact
                    />
                    <button
                      className="text-link"
                      onClick={() => navigate("network")}
                    >
                      Open network map
                      <ArrowRight size={13} />
                    </button>
                  </section>
                  <section className="boot-script-card glass">
                    <div className="card-label">
                      ON A FRESH BOOT
                      <FileCode2 size={14} />
                    </div>
                    <button onClick={() => setScriptMachine(machine)}>
                      <strong>
                        {machine.config.initScript.trim()
                          ? "Your init script is saved."
                          : "Give this world a beginning."}
                      </strong>
                      <p>
                        {machine.config.initScript.trim()
                          ? `${machine.config.initScript.split("\n").length} lines · ${new TextEncoder().encode(machine.config.initScript).byteLength} bytes`
                          : "Create files, configure a service, prepare an experiment."}
                      </p>
                      <span>
                        {state.init?.status === "failed"
                          ? "Inspect script failure"
                          : "Edit boot script"}
                        <ArrowRight size={13} />
                      </span>
                    </button>
                  </section>
                </aside>
              </div>
              {state.init?.status === "failed" && (
                <div className="command-warning" role="alert">
                  <Info size={17} />
                  <p>
                    Boot script:{" "}
                    {state.init.message ||
                      `exit ${state.init.exitCode ?? "unknown"}`}
                    . The guest is available for inspection.
                  </p>
                  <button
                    className="button secondary"
                    onClick={() => setScriptMachine(machine)}
                  >
                    View output
                  </button>
                </div>
              )}
              {summary.terminalResizeError && (
                <p className="network-error" role="status">
                  Terminal sizing: {summary.terminalResizeError}
                </p>
              )}
              <div className="workspace-hint">
                <span>
                  <Terminal size={14} />
                  {!machine.runtime.capabilities.interactivePorts.includes(0)
                    ? "Shells keep their own working directory and processes. The agent channel stays separate."
                    : "This console and agent tasks share one channel. Wait for a task to finish before typing."}
                </span>
                <span>
                  {work.machines.length} machine
                  {work.machines.length === 1 ? "" : "s"} · {runningCount}{" "}
                  running
                </span>
              </div>
            </>
          )}
          {page === "console" && <FleetConsole machines={workspace.list()} activeId={work.activeId} />}
          {page === "cloud" && <CloudPanel cloud={cloud} work={work} onSelect={selectMachine} onNewMachine={() => openNewMachine()} onConnections={() => navigate("network")} onCancelBoot={cancelBoot} cancellingBoots={cancellingBoots} />}
          {page === "network" && (
            <NetworkPanel
              cloud={cloud}
              writable={writable}
              machines={work.machines}
              vpcs={work.vpcs}
              onNewMachine={openNewMachine}
              onError={showError}
              onSelect={selectMachine}
              onChange={setNetwork}
              onConfigure={(id) => setNetworkMachine(workspace.get(id))}
            />
          )}
          {page === "agents" && machine && summary && state && runner && runtime && (
            <>
              <section className="page-heading workspace-heading">
                <div>
                  <div className="eyebrow">
                    <Braces size={14} />
                    THE AGENT WORKBENCH
                  </div>
                  <h1>
                    Less guesswork. <span>More evidence.</span>
                  </h1>
                  <p>
                    Send a bounded task to <strong>{machine.name}</strong>, then
                    inspect what happened.
                  </p>
                </div>
                <Status status={state.status} />
              </section>
              <div className="agent-grid">
                <section className="agent-editor glass">
                  <div className="card-label">
                    COMMAND WORKPAD
                    <Code2 size={15} />
                  </div>
                  <div className="agent-target">
                    <label htmlFor="agent-target">Target machine</label>
                    <select
                      id="agent-target"
                      value={machine.id}
                      onChange={(event) => workspace.select(event.target.value)}
                    >
                      {work.machines.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name} ·{" "}
                          {PROFILES[entry.config.profile].architecture}
                        </option>
                      ))}
                    </select>
                  </div>
                  <label htmlFor="agent-command">
                    What should the guest do?
                  </label>
                  <textarea
                    id="agent-command"
                    spellCheck={false}
                    value={agentCommand}
                    onChange={(event) => setAgentCommand(event.target.value)}
                    rows={7}
                  />
                  <div className="editor-footer">
                    <label htmlFor="timeout">
                      Time limit
                      <select
                        id="timeout"
                        value={timeout}
                        onChange={(event) =>
                          setTimeoutValue(Number(event.target.value))
                        }
                      >
                        <option value={5000}>5 seconds</option>
                        <option value={15000}>15 seconds</option>
                        <option value={60000}>60 seconds</option>
                      </select>
                    </label>
                    {!hasMachine ? (
                      <button
                        className="button primary"
                        disabled={locked || isBooting}
                        onClick={() => void boot()}
                      >
                        {isBooting ? (
                          <LoaderCircle size={15} className="spin" />
                        ) : (
                          <Play size={15} />
                        )}
                        Boot first
                      </button>
                    ) : state.status === "paused" ? (
                      <button
                        className="button primary"
                        disabled={locked}
                        onClick={() =>
                          void perform("resume", machine, runtime.resume)
                        }
                      >
                        <Play size={15} />
                        Resume {machine.name}
                      </button>
                    ) : (
                      <button
                        className="button primary"
                        disabled={
                          !ready ||
                          locked ||
                          !runner.ready ||
                          !agentCommand.trim()
                        }
                        onClick={() => void runCommand(agentCommand)}
                      >
                        {runner.busy ? (
                          <LoaderCircle size={15} className="spin" />
                        ) : (
                          <Play size={15} />
                        )}
                        Run in {machine.name}
                      </button>
                    )}
                  </div>
                  <p className="editor-note">
                    <Info size={14} />
                    You or a browser agent provide the commands. No model is
                    connected.
                  </p>
                </section>
                <section className="bridge-card glass">
                  <div className="card-label">
                    A PAGE API FOR YOUR MACHINES
                    <Braces size={15} />
                  </div>
                  <h3>
                    Meet <code>window.terrarium</code>
                  </h3>
                  <p>
                    List the guests, choose one by ID, and use the same command
                    path as this workpad.
                  </p>
                  <div className="code-example">
                    <button
                      className="icon-button"
                      aria-label="Copy browser API example"
                      onClick={() => void copyBridgeExample()}
                    >
                      <Copy size={14} />
                    </button>
                    <pre>{bridgeExample}</pre>
                  </div>
                  <div className="bridge-limits">
                    <span>
                      <Check size={13} />
                      One task per machine at a time
                    </span>
                    <span>
                      <Check size={13} />
                      Actual output and exit status
                    </span>
                    <span>
                      <Check size={13} />
                      Timeout and recovery reporting
                    </span>
                  </div>
                  <p className="small-print">
                    The short <code>terrarium.exec()</code> call targets the
                    selected machine. Run this JavaScript in the browser's developer console for the Terrarium page. The workpad and guest terminals accept Linux shell commands.
                  </p>
                  <p className="small-print">
                    <code>result</code> shows the returned object; <code>result.output</code> shows its text. A final <code>console.log(...)</code> evaluates to <code>undefined</code>. Use <code>vm.readOutput()</code> for the serial transcript, or <code>const stop = vm.mirrorOutput()</code> for live browser-console output. Call <code>stop()</code> to unsubscribe. The Console page follows multiple machines.
                  </p>
                </section>
              </div>
              <section className="runs-card glass">
                <header>
                  <div>
                    <span className="eyebrow">
                      {machine.name.toUpperCase()}
                    </span>
                    <h2>Run history</h2>
                  </div>
                  <button
                    className="button ghost"
                    disabled={!runner.runs.length}
                    onClick={() =>
                      downloadFile(
                        `${machine.name}-run-history.json`,
                        JSON.stringify(
                          {
                            version: 2,
                            machine: {
                              id: machine.id,
                              name: machine.name,
                              profile: machine.config.profile,
                            },
                            runs: runner.runs,
                          },
                          null,
                          2,
                        ),
                        "application/json",
                      )
                    }
                  >
                    <Download size={14} />
                    Export JSON
                  </button>
                </header>
                <RunList runs={runner.runs} fontSize={preferences.fontSize} />
              </section>
            </>
          )}
          {page === "snapshots" && (
            <>
              <section className="page-heading workspace-heading">
                <div>
                  <div className="eyebrow">
                    <Layers3 size={14} />
                    CHECKPOINTS & EVIDENCE
                  </div>
                  <h1>
                    A point to return to. <span>Or investigate.</span>
                  </h1>
                  <p>
                    {machine ? <>Save or restore the selected machine: <strong>{machine.name}</strong>.</> : "Your saved checkpoints and evidence remain available without a running machine."}
                  </p>
                </div>
                <div className="heading-actions">
                  <button
                    className="button secondary"
                    disabled={!writable || snapshots.length >= 3}
                    onClick={() => importInput.current?.click()}
                  >
                    <Upload size={15} />
                    Import
                  </button>
                  <button
                    className="button primary"
                    disabled={
                      !hasMachine || locked || !runtime?.capabilities.snapshots
                    }
                    onClick={openSnapshot}
                  >
                    <Plus size={16} />
                    New snapshot
                  </button>
                </div>
              </section>
              {!runtime?.capabilities.snapshots && (
                <div className="command-warning">
                  <Info size={17} />
                  <p>
                    VM checkpoints require a compatible profile without external data
                    volumes or evidence attached. Disk snapshots are available
                    in Cloud resources. You can
                    inspect saved checkpoints and create a quarantine clone from
                    any selected profile.
                  </p>
                </div>
              )}
              <div className="snapshot-explainer glass">
                <span>
                  <HardDrive size={21} />
                </span>
                <p>
                  <strong>CPU, memory, and guest files. Together.</strong>{" "}
                  Snapshots stay in this browser until removed or cleared.
                  Download a copy for safekeeping. Restoring into a machine
                  replaces its current state.
                </p>
                <span className="pill subtle">
                  {snapshots.length} / 3 SAVED
                </span>
              </div>
              {!snapshots.length ? (
                <section className="snapshots-empty glass">
                  <div className="empty-state">
                    <span className="empty-icon">
                      <Layers3 size={26} />
                    </span>
                    <h3>No worlds on the shelf. Yet.</h3>
                    <p>
                      Boot a machine with checkpoint support and save a point worth returning to.
                    </p>
                    <button
                      className="button secondary"
                      onClick={() => navigate("playground")}
                    >
                      Go to playground
                      <ArrowRight size={15} />
                    </button>
                  </div>
                </section>
              ) : (
                <div className="snapshot-grid">
                  {snapshots.map((meta) => (
                    <article className="snapshot-card glass" key={meta.id}>
                      <span className="snapshot-icon">
                        <Layers3 size={26} />
                      </span>
                      <span className="eyebrow">MACHINE SNAPSHOT</span>
                      <h2>{meta.title}</h2>
                      <p>
                        {new Date(meta.createdAt).toLocaleString()}
                        <br />
                        {(meta.size / 1048576).toFixed(1)} MiB · {meta.runtime}
                      </p>
                      {meta.sha256 && (
                        <code className="snapshot-digest" title={meta.sha256}>
                          SHA-256 {meta.sha256.slice(0, 16)}…
                        </code>
                      )}
                      <footer>
                        <button
                          className="button primary"
                          onClick={() => setInspectionTarget(meta)}
                        >
                          <FileSearch size={14} /> Inspect
                        </button>
                        <button
                          className="button secondary"
                          disabled={
                            locked ||
                            isBooting ||
                            !runtime?.capabilities.snapshots ||
                            !machine || !isCheckpointRuntimeCompatible(machine.config.profile, meta.runtime)
                          }
                          title={!machine || !isCheckpointRuntimeCompatible(machine.config.profile, meta.runtime) ? "Select a machine with this checkpoint's supported runtime profile, or inspect it to create a quarantined clone." : "Restore into the selected compatible machine"}
                          onClick={() => restoreStored(meta)}
                        >
                          <RotateCcw size={14} />
                          Restore
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`Download ${meta.title}`}
                          onClick={() =>
                            void readSnapshot(meta.id)
                              .then((buffer) =>
                                downloadFile(
                                  `terrarium-${meta.runtime.replace("@", "-")}-${meta.id}.bin`,
                                  buffer,
                                ),
                              )
                              .catch(showError)
                          }
                        >
                          <ArrowDownToLine size={17} />
                        </button>
                        <button
                          className="icon-button danger-hover"
                          aria-label={`Delete ${meta.title}`}
                          disabled={!writable || Boolean(actions["workspace-resource"])}
                          onClick={() =>
                            setConfirm({
                              title: `Remove “${meta.title}”?`,
                              body: "This permanently deletes this saved snapshot from this browser. Download a copy first if you want to keep it.",
                              label: "Delete snapshot",
                              machine: null,
                              run: async () => {
                                await deleteSnapshot(meta.id, { ifSha256: meta.sha256 });
                                setSnapshots(await listSnapshots());
                                if (inspectionTarget?.id === meta.id) setInspectionTarget(null);
                              },
                            })
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      </footer>
                    </article>
                  ))}
                </div>
              )}
              <InvestigationPanel
                work={work}
                machine={machine}
                inspect={inspectionTarget}
                onCloseInspection={() => setInspectionTarget(null)}
                onOpenMachine={selectMachine}
                onError={showError}
              />
              <div className="snapshot-note">
                <Info size={15} />
                <p>
                  Checkpoints are specific to their runtime and guest profile.
                  Earlier formats need their matching Terrarium version.
                  Boot scripts, appearance, and run history are
                  separate from saved VM state.
                </p>
              </div>
            </>
          )}
          {page === "about" && <FieldGuide />}
          {page === "workspace" && <WorkspaceRecovery work={work} onOpenMachine={selectMachine} onSnapshots={() => navigate("snapshots")} />}
        </main>
        <footer className="workspace-footer">
          <span>
            <span className="footer-status-dot" />A small world, running on your
            terms.
          </span>
          <span>
            LOCAL FIRST<span>·</span>EXPERIMENTAL BY NATURE
          </span>
        </footer>
      </div>
      <input
        ref={importInput}
        className="visually-hidden"
        type="file"
        accept=".bin,.v86,application/octet-stream"
        aria-label="Import a machine snapshot"
        onChange={(event) => {
          void importSnapshot(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {appearanceOpen && (
        <Appearance
          notice={notice}
          value={preferences}
          onChange={setPreferences}
          onClose={() => setAppearanceOpen(false)}
        />
      )}
      {scriptMachine && (
        <BootScriptDialog
          machine={scriptMachine}
          onSave={(script) => {
            workspace.configure(scriptMachine.id, { initScript: script });
            setNotice({
              message: `Boot script saved for ${scriptMachine.name}. It runs on the next fresh boot.`,
              error: false,
            });
          }}
          onClose={() => setScriptMachine(null)}
        />
      )}
      {networkMachine && (
        <NetworkTransportDialog
          machine={networkMachine}
          onClose={() => setNetworkMachine(null)}
          onSave={(transport) =>
            workspace.configureNetworkTransport(networkMachine.id, transport)
          }
        />
      )}
      {newMachine && (
        <Modal
          title="Make room for another world."
          subtitle="Each machine gets its own kernel, memory, and filesystem."
          onClose={() => setNewMachine(false)}
          notice={notice}
          className="machine-form-modal"
        >
          <div className="machine-form">
            <label htmlFor="machine-name">Machine name</label>
            <input
              id="machine-name"
              autoFocus
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              maxLength={32}
              spellCheck={false}
              autoComplete="off"
            />
            <fieldset className="profile-choices">
              <legend>Machine profile</legend>
              {(Object.keys(PROFILES) as MachineProfile[]).map((id) => (
                <label
                  key={id}
                  className={`profile-choice ${newProfile === id ? "selected" : ""}`}
                >
                  <input
                    type="radio"
                    name="profile"
                    value={id}
                    checked={newProfile === id}
                    onChange={() => setNewProfile(id)}
                  />
                  <Cpu size={22} />
                  <strong>{PROFILES[id].title}</strong>
                  <span className="pill subtle">
                    {PROFILES[id].architecture}
                  </span>
                  <p>{PROFILES[id].description}</p>
                  <small>
                    {RUNTIME_PROFILES[id].memoryMiB} MiB · Linux{" "}
                    {RUNTIME_PROFILES[id].kernel}
                  </small>
                </label>
              ))}
            </fieldset>
            <p className="small-print" aria-live="polite">{RUNTIME_PROFILES[newProfile].limitations.join(" ")}</p>
            <div className="network-placement-fields">
              <label htmlFor="new-machine-vpc">VPC</label>
              <select
                id="new-machine-vpc"
                value={work.vpcs.some((vpc) => vpc.id === newVpcId && vpc.subnets.length) ? newVpcId : ""}
                onChange={(event) => {
                  setNewVpcId(event.target.value);
                  setNewSubnetId(
                    work.vpcs.find((item) => item.id === event.target.value)?.subnets[0]?.id ?? "",
                  );
                }}
              >
                <option value="" disabled>Choose a VPC with a subnet</option>
                {work.vpcs.filter((vpc) => vpc.subnets.length > 0).map((vpc) => (
                  <option key={vpc.id} value={vpc.id}>
                    {vpc.name} · {vpc.cidr}
                  </option>
                ))}
              </select>
              <label htmlFor="new-machine-subnet">Subnet</label>
              <select
                id="new-machine-subnet"
                value={work.vpcs.find((vpc) => vpc.id === newVpcId)?.subnets.some((subnet) => subnet.id === newSubnetId) ? newSubnetId : ""}
                onChange={(event) => setNewSubnetId(event.target.value)}
              >
                <option value="" disabled>Choose an existing subnet</option>
                {work.vpcs
                  .find((vpc) => vpc.id === newVpcId)
                  ?.subnets.map((subnet) => (
                    <option key={subnet.id} value={subnet.id}>
                      {subnet.name} · {subnet.cidr}
                    </option>
                  ))}
              </select>
            </div>
            {!work.vpcs.find((vpc) => vpc.id === newVpcId)?.subnets.some((subnet) => subnet.id === newSubnetId) && <p className="error-text" role="status">The selected network is no longer available. Choose an existing subnet, or create one in Connections.</p>}
            <details className="new-script-details">
              <summary>
                <FileCode2 size={15} />
                Add a boot script
                <Plus size={14} />
              </summary>
              <textarea
                className="script-editor compact"
                value={newScript}
                onChange={(event) => setNewScript(event.target.value)}
                aria-label="New machine boot script"
                spellCheck={false}
                placeholder={
                  "#!/bin/sh\n# Prepare your machine on its first boot"
                }
              />
              <p>
                {new TextEncoder()
                  .encode(newScript)
                  .byteLength.toLocaleString()}{" "}
                / {MAX_INIT_BYTES.toLocaleString()} bytes. You can add or import
                a script later.
              </p>
            </details>
            <p className="machine-form-note">
              <WifiOff size={14} />
              New machines start with the guest network disconnected.
            </p>
          </div>
          <footer className="modal-footer">
            <button
              className="button secondary"
              disabled={!writable || !work.vpcs.find((vpc) => vpc.id === newVpcId)?.subnets.some((subnet) => subnet.id === newSubnetId)}
              onClick={() => createMachine(false)}
            >
              Create machine
            </button>
            <button
              className="button primary"
              disabled={!writable || !work.vpcs.find((vpc) => vpc.id === newVpcId)?.subnets.some((subnet) => subnet.id === newSubnetId)}
              onClick={() => createMachine(true)}
            >
              <Play size={15} />
              Create & boot
            </button>
          </footer>
        </Modal>
      )}
      {editMachine && (
        <Modal
          title={`Machine settings · ${editMachine.name}`}
          className={editMachine.config.profile === "alpine-x86_64" ? "machine-form-modal" : ""}
          onClose={() => { if (!hardwareSettingsBusy) setEditMachine(null); }}
          notice={notice}
        >
          {editMachine.config.profile === "alpine-x86_64" ? <MachineHardwareSettings
            key={editMachine.id}
            machine={editMachine}
            name={editName}
            onNameChange={setEditName}
            writable={writable}
            revision={JSON.stringify([work.persistence.mode, work.preparingReload, work.machines.map((entry) => [entry.id, entry.name, entry.state.status, entry.lifecycle, entry.config.x86])])}
            deleteDisabled={!writable || editMachine.lifecycle !== "ready" || editMachine.runner.isBusy() || Boolean(editMachine.runtime.getSnapshot().operation) || Boolean(editMachine.runtime.getSnapshot().volumeOperation) || ["loading", "booting"].includes(editMachine.runtime.getSnapshot().status)}
            onBusyChange={setHardwareSettingsBusy}
            onSaved={() => setEditMachine(null)}
            onDelete={() => { setEditMachine(null); requestRemove(editMachine); }}
          /> : <>
          <div className="machine-form">
            <label htmlFor="edit-machine-name">Name</label>
            <input
              id="edit-machine-name"
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
              maxLength={32}
              spellCheck={false}
              autoFocus
            />
            <p className="script-explainer">
              The profile and memory are fixed for this machine. Create another
              machine to use a different architecture.
            </p>
          </div>
          <footer className="modal-footer">
            <button
              className="button ghost danger-hover"
              disabled={locked || isBooting}
              onClick={() => {
                setEditMachine(null);
                requestRemove(editMachine);
              }}
            >
              <Trash2 size={15} />
              Delete
            </button>
            <button
              className="button primary"
              onClick={() => {
                try {
                  workspace.configure(editMachine.id, { name: editName });
                  setEditMachine(null);
                } catch (error) {
                  showError(error);
                }
              }}
            >
              <Save size={15} />
              Save name
            </button>
          </footer>
          </>}
        </Modal>
      )}
      {snapshotTarget && (
        <Modal
          notice={notice}
          title={`Save ${snapshotTarget.name}.`}
          subtitle="Preserve CPU, memory, and temporary root files."
          onClose={() => {
            if (!actions[snapshotTarget.id]) setSnapshotTarget(null);
          }}
        >
          <div className="snapshot-form">
            <label htmlFor="snapshot-name">Snapshot name</label>
            <input
              id="snapshot-name"
              maxLength={80}
              value={snapshotTitle}
              onChange={(event) => setSnapshotTitle(event.target.value)}
              placeholder="A point to return to"
              autoFocus
            />
            <p>
              Saving a running guest briefly pauses it, then resumes it. An
              already paused guest stays paused. Checkpoints can take tens to
              hundreds of megabytes. Download a copy to keep it outside browser
              storage.
            </p>
          </div>
          <footer className="modal-footer">
            <button
              className="button secondary"
              disabled={Boolean(actions[snapshotTarget.id])}
              onClick={() => void exportCurrentSnapshot()}
            >
              <Download size={15} />
              Download instead
            </button>
            <button
              className="button primary"
              disabled={
                Boolean(actions[snapshotTarget.id]) || !snapshotTitle.trim()
              }
              onClick={() => void saveSnapshotToBrowser()}
            >
              {actions[snapshotTarget.id] ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Save size={15} />
              )}
              Save in browser
            </button>
          </footer>
        </Modal>
      )}
      {confirm && (
        <Modal
          notice={notice}
          title={confirm.title}
          onClose={() => {
            if (!actions[confirm.machine?.id ?? "workspace-resource"]) setConfirm(null);
          }}
          className="confirm-modal"
        >
          <p className="confirm-copy">{confirm.body}</p>
          <footer className="modal-footer">
            <button
              className="button secondary"
              disabled={Boolean(actions[confirm.machine?.id ?? "workspace-resource"])}
              onClick={() => setConfirm(null)}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={Boolean(actions[confirm.machine?.id ?? "workspace-resource"])}
              onClick={() =>
                void perform("change", confirm.machine, async () => {
                  await confirm.run();
                  setConfirm(null);
                })
              }
            >
              {actions[confirm.machine?.id ?? "workspace-resource"] ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <ArrowRight size={15} />
              )}
              {confirm.label}
            </button>
          </footer>
        </Modal>
      )}
      {notice && (
        <div
          className={`toast ${notice.error ? "error" : ""}`}
          role={notice.error ? "alert" : "status"}
        >
          {notice.error ? <XCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{notice.message}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
