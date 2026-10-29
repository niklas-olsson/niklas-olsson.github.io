// SPDX-License-Identifier: Apache-2.0
import { MACHINE_STORAGE_KEY, VPC_STORAGE_KEY, parseMachineConfigs, type MachineConfig } from "./machine-config.ts";
import { DEFAULT_VPCS, validateVpcList, type VpcConfig } from "./vpc-config.ts";
import type { RuntimeStatus } from "./runtime-types.ts";
import { defaultX86MachineConfiguration, migratedMachineMac } from "./x86-machine-config.ts";
import { LEGACY_QEMU_BUNDLE_ID } from "./qemu-assets.ts";

export const WORKSPACE_STORAGE_KEY = "terrarium.workspace.v1";
export const WORKSPACE_LOCK = "terrarium-workspace-writer-v1";

export interface MachineActivity {
  id: string;
  status: Exclude<RuntimeStatus, "idle">;
  updatedAt: number;
}
export interface WorkspaceManifest {
  schema: "terrarium.workspace/v2";
  revision: number;
  updatedAt: number;
  activeId: string;
  vpcs: VpcConfig[];
  machines: MachineConfig[];
  activity: MachineActivity[];
}
export interface PersistenceState {
  mode: "opening" | "writable" | "read-only" | "error";
  error: string | null;
  revision: number;
  updatedAt: number | null;
}
export interface LoadedWorkspace {
  manifest: WorkspaceManifest;
  error: string | null;
  migrated: boolean;
}
type StorageLike = Pick<Storage, "getItem" | "setItem">;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function emptyManifest(): WorkspaceManifest {
  return { schema: "terrarium.workspace/v2", revision: 0, updatedAt: 0, activeId: "", vpcs: [], machines: [], activity: [] };
}

function migrateMachineDefinitions(machines: MachineConfig[]): MachineConfig[] {
  const migrated = machines.map(machine => machine.profile === "alpine-x86_64" && !machine.x86
    ? { ...machine, x86: defaultX86MachineConfiguration({ runtimeBundleId: LEGACY_QEMU_BUNDLE_ID, mac: migratedMachineMac(machine.id) }) } : machine);
  // Reopening a saved inventory must enforce the same NIC ownership rule as
  // add/configure. Validate after migration so a derived-identity collision
  // fails visibly while the original historical source remains untouched.
  const nics = new Set<string>();
  for (const machine of migrated) {
    if (!machine.x86) continue;
    if (nics.has(machine.x86.nic.mac))
      throw new Error("The saved x86_64 inventory has duplicate NIC identities. Its original data was kept.");
    nics.add(machine.x86.nic.mac);
  }
  return migrated;
}

/** Strict validation never replaces an invalid saved inventory with defaults. */
export function validateWorkspaceManifest(input: unknown): WorkspaceManifest {
  if (!input || typeof input !== "object") throw new Error("The saved workspace is not an object.");
  const data = input as Omit<Partial<WorkspaceManifest>, "schema"> & { schema?: string };
  if (!["terrarium.workspace/v1", "terrarium.workspace/v2"].includes(data.schema ?? "")) throw new Error("This workspace uses an unsupported format. Its saved data was kept.");
  if (Object.keys(data).sort().join(",") !== "activeId,activity,machines,revision,schema,updatedAt,vpcs")
    throw new Error("The saved workspace has unknown or missing fields. Its original data was kept.");
  if (!Number.isSafeInteger(data.revision) || data.revision! < 0 || typeof data.updatedAt !== "number" || !Number.isFinite(data.updatedAt) || data.updatedAt < 0)
    throw new Error("The saved workspace revision is invalid.");
  const vpcs = validateVpcList(data.vpcs as VpcConfig[]);
  if (!Array.isArray(data.machines)) throw new Error("The saved machine inventory is missing.");
  const machines = parseMachineConfigs(data.machines, vpcs);
  if (canonical(machines) !== canonical(data.machines))
    throw new Error("One or more saved machines are invalid. Nothing was replaced or silently skipped.");
  if (data.schema === "terrarium.workspace/v2" && machines.some(machine => machine.profile === "alpine-x86_64" && !machine.x86))
    throw new Error("The saved x86_64 machine configuration is missing. Nothing was replaced.");
  if (data.schema === "terrarium.workspace/v1" && machines.some(machine => machine.x86))
    throw new Error("A v1 workspace cannot silently adopt a new machine configuration.");
  if (typeof data.activeId !== "string" || (data.activeId !== "" && !machines.some((machine) => machine.id === data.activeId)))
    throw new Error("The saved selection refers to a missing machine.");
  if (!Array.isArray(data.activity)) throw new Error("The saved session record is invalid.");
  const ids = new Set<string>();
  for (const activity of data.activity) {
    if (!activity || typeof activity.id !== "string" || ids.has(activity.id) || !machines.some((machine) => machine.id === activity.id) ||
      !["loading", "booting", "running", "paused", "error"].includes(activity.status) || !Number.isFinite(activity.updatedAt) || activity.updatedAt < 0)
      throw new Error("The saved session refers to an invalid or missing machine.");
    ids.add(activity.id);
  }
  return structuredClone({ ...data, schema: "terrarium.workspace/v2", vpcs, machines: migrateMachineDefinitions(machines) } as WorkspaceManifest);
}

export function loadWorkspaceManifest(storage: StorageLike): LoadedWorkspace {
  try {
    const saved = storage.getItem(WORKSPACE_STORAGE_KEY);
    if (saved !== null) {
      const input = JSON.parse(saved);
      return { manifest: validateWorkspaceManifest(input), error: null, migrated: input.schema === "terrarium.workspace/v1" };
    }
    // Migrate the previous pair of keys once; the new envelope is authoritative
    // even when its inventories are empty. Legacy keys never resurrect deletes.
    const rawVpcs = storage.getItem(VPC_STORAGE_KEY);
    const vpcs = rawVpcs === null ? structuredClone(DEFAULT_VPCS) : validateVpcList(JSON.parse(rawVpcs));
    const rawMachines = storage.getItem(MACHINE_STORAGE_KEY);
    const input = rawMachines === null ? null : JSON.parse(rawMachines);
    if (input !== null && !Array.isArray(input)) throw new Error("The old machine inventory is invalid.");
    // Pre-S2 keys never contained the versioned hardware/image contract. Do not
    // let a legacy migration become an alternative, unverified assignment path.
    if (Array.isArray(input) && input.some(value => value && typeof value === "object" && Object.hasOwn(value, "x86")))
      throw new Error("The old machine inventory contains an unsupported x86 configuration. Keep it for recovery; S2 hardware and images require a versioned workspace.");
    const machines = parseMachineConfigs(input, vpcs);
    if (Array.isArray(input) && (input.length !== machines.length || input.some((value, index) => value?.id !== machines[index]?.id)))
      throw new Error("The old machine inventory contains invalid entries. It was kept for recovery.");
    return { manifest: { ...emptyManifest(), vpcs, machines: migrateMachineDefinitions(machines), activeId: machines[0]?.id ?? "" }, error: null, migrated: true };
  } catch (error) {
    return { manifest: emptyManifest(), error: error instanceof Error ? error.message : String(error), migrated: false };
  }
}

/** One setItem commits networks, definitions, selection and activity together.
 * The lifetime Web Lock belongs to MachineWorkspace; this revision check also
 * refuses stale writers if saved data is changed by another version of the app.
 */
export function commitWorkspaceManifest(storage: StorageLike, current: WorkspaceManifest, update: Omit<WorkspaceManifest, "schema" | "revision" | "updatedAt">): WorkspaceManifest {
  const raw = storage.getItem(WORKSPACE_STORAGE_KEY);
  const stored = raw === null ? null : validateWorkspaceManifest(JSON.parse(raw));
  if ((stored?.revision ?? 0) !== current.revision)
    throw new Error("The saved workspace changed in another tab. Take control and reload its latest inventory before editing.");
  const next = validateWorkspaceManifest({ ...update, schema: "terrarium.workspace/v2", revision: current.revision + 1, updatedAt: Date.now() });
  try { storage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(next)); }
  catch { throw new Error("The workspace change was not saved. Browser storage is full or unavailable. Free storage or export data, then retry."); }
  return next;
}

export interface StorageHealth {
  persistent: boolean | null;
  usage: number | null;
  quota: number | null;
  canRequestPersistence: boolean;
}
export async function readStorageHealth(): Promise<StorageHealth> {
  const storage = globalThis.navigator?.storage;
  if (!storage) return { persistent: null, usage: null, quota: null, canRequestPersistence: false };
  const [persistence, estimate] = await Promise.allSettled([storage.persisted?.(), storage.estimate?.()]);
  return {
    persistent: persistence.status === "fulfilled" && typeof persistence.value === "boolean" ? persistence.value : null,
    usage: estimate.status === "fulfilled" ? estimate.value?.usage ?? null : null,
    quota: estimate.status === "fulfilled" ? estimate.value?.quota ?? null : null,
    canRequestPersistence: typeof storage.persist === "function",
  };
}
