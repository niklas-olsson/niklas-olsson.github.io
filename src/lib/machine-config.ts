// SPDX-License-Identifier: Apache-2.0
import { validateRelayUrl } from "./network-transport.ts";
import { validateVolumeAttachments, type VolumeAttachment } from "./volume-types.ts";
import { validateX86MachineConfiguration, type X86MachineConfiguration } from "./x86-machine-config.ts";
import {
  getRuntimeProfile,
  isRuntimeProfileId,
  type RuntimeProfileId,
} from "./runtime-profiles.ts";
import {
  DEFAULT_VPCS,
  DEFAULT_VPC_ID,
  DEFAULT_SUBNET_ID,
  firstAvailableIp,
  parseVpcConfigs,
  resolveAttachment,
  type VpcConfig,
} from "./vpc-config.ts";
import {
  ALLOW_ALL_POLICY,
  DENY_ALL_POLICY,
  validateNetworkPolicy,
  type NetworkPolicy,
} from "./network-policy.ts";
export type MachineProfile = RuntimeProfileId;
export type SavedNetworkMode = "isolated" | "local";

export interface MachineConfig {
  x86?: X86MachineConfiguration;
  id: string;
  name: string;
  profile: MachineProfile;
  ip: string;
  vpcId: string;
  subnetId: string;
  policy: NetworkPolicy;
  initScript: string;
  network: SavedNetworkMode;
  networkTransport: "web" | "wisp";
  relayUrl: string;
  volumes: VolumeAttachment[];
}

export const MAX_INIT_BYTES = 8_192;
export const MACHINE_STORAGE_KEY = "terrarium.machines.v1";
export const VPC_STORAGE_KEY = "terrarium.vpcs.v1";
export const MACHINE_IPS = [
  "192.168.76.10",
  "192.168.76.11",
  "192.168.76.12",
  "192.168.76.13",
] as const;
export const DEFAULT_MACHINE: MachineConfig = {
  id: "local-01",
  name: "local-01",
  profile: "x86",
  ip: MACHINE_IPS[0],
  vpcId: DEFAULT_VPC_ID,
  subnetId: DEFAULT_SUBNET_ID,
  policy: structuredClone(ALLOW_ALL_POLICY),
  initScript: "",
  network: "isolated",
  networkTransport: "web",
  relayUrl: "",
  volumes: [],
};

export function validateMachineName(name: string): string {
  const value = name.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(value)) {
    throw new Error(
      "Use a name of 1–32 lowercase letters, numbers, or internal hyphens.",
    );
  }
  return value;
}

export function validateInitScript(script: string): string {
  if (typeof script !== "string")
    throw new Error("The boot script must be text.");
  if (new TextEncoder().encode(script).byteLength > MAX_INIT_BYTES)
    throw new Error("Keep boot scripts within 8 KiB of UTF-8 text.");
  if (script.includes("\0"))
    throw new Error("Boot scripts cannot contain null bytes.");
  return script.replace(/\r\n?/g, "\n");
}

/** Saved data is configuration only. A stored World choice never grants network access. */
export function parseMachineConfigs(
  value: unknown,
  vpcs: VpcConfig[] = DEFAULT_VPCS,
): MachineConfig[] {
  const fallback = (): MachineConfig[] => {
    const vpc = vpcs.find((entry) => entry.subnets.length > 0);
    if (!vpc) return [];
    return [{
      ...structuredClone(DEFAULT_MACHINE),
      vpcId: vpc.id,
      subnetId: vpc.subnets[0].id,
      ip: firstAvailableIp(vpc, vpc.subnets[0].id, []),
    }];
  };
  if (!Array.isArray(value)) return fallback();
  // An intentionally emptied inventory must not recreate the starter machine.
  if (value.length === 0) return [];
  const configs: MachineConfig[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const data: Record<string, unknown> = {};
    for (const key of [
      "id",
      "name",
      "profile",
      "ip",
      "vpcId",
      "subnetId",
      "policy",
      "initScript",
      "network",
      "networkTransport",
      "relayUrl",
      "volumes",
      "x86",
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (descriptor && "value" in descriptor) data[key] = descriptor.value;
    }
    if (typeof data.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(data.id))
      continue;
    if (typeof data.name !== "string" || typeof data.initScript !== "string")
      continue;
    if (!isRuntimeProfileId(data.profile)) continue;
    if (typeof data.ip !== "string") continue;
    try {
      const attachment = resolveAttachment(vpcs, {
        vpcId: typeof data.vpcId === "string" ? data.vpcId : DEFAULT_VPC_ID,
        subnetId:
          typeof data.subnetId === "string" ? data.subnetId : DEFAULT_SUBNET_ID,
        ip: data.ip,
      });
      const name = validateMachineName(data.name);
      const initScript = validateInitScript(data.initScript);
      const volumes = validateVolumeAttachments(data.volumes ?? []);
      const x86 = data.x86 === undefined ? undefined : validateX86MachineConfiguration(data.x86);
      if (x86 && data.profile !== "alpine-x86_64") continue;
      if (!getRuntimeProfile(data.profile).capabilities.volumes && volumes.length) continue;
      if (
        configs.some(
          (entry) =>
            entry.id === data.id ||
            entry.name === name ||
            (entry.vpcId === attachment.vpcId && entry.ip === data.ip),
        )
      )
        continue;
      let networkTransport: "web" | "wisp" = "web";
      let relayUrl = "";
      let policy = structuredClone(ALLOW_ALL_POLICY);
      if (data.policy !== undefined) {
        try {
          policy = validateNetworkPolicy(data.policy as NetworkPolicy);
        } catch {
          policy = structuredClone(DENY_ALL_POLICY);
        }
      }
      if (
        data.networkTransport === "wisp" &&
        typeof data.relayUrl === "string"
      ) {
        try {
          relayUrl = validateRelayUrl(data.relayUrl);
          networkTransport = "wisp";
        } catch {
          /* Invalid transport configuration returns to the browser bridge. */
        }
      }
      configs.push({
        id: data.id,
        name,
        profile: data.profile,
        ip: data.ip as string,
        vpcId: attachment.vpcId,
        subnetId: attachment.subnetId,
        policy,
        initScript,
        network:
          data.network === "local" || data.network === "world"
            ? "local"
            : "isolated",
        networkTransport,
        relayUrl,
        volumes,
        ...(x86 ? { x86 } : {}),
      });
    } catch {
      /* An invalid saved entry must not prevent the workspace from opening. */
    }
  }
  return configs.length ? configs : fallback();
}

export function loadMachineConfigs(
  vpcs: VpcConfig[] = DEFAULT_VPCS,
): MachineConfig[] {
  try {
    return parseMachineConfigs(
      JSON.parse(localStorage.getItem(MACHINE_STORAGE_KEY) ?? "null"),
      vpcs,
    );
  } catch {
    return parseMachineConfigs(null, vpcs);
  }
}

export function loadVpcConfigs(): VpcConfig[] {
  try {
    return parseVpcConfigs(
      JSON.parse(localStorage.getItem(VPC_STORAGE_KEY) ?? "null"),
    );
  } catch {
    return structuredClone(DEFAULT_VPCS);
  }
}

export function saveVpcConfigs(vpcs: VpcConfig[]): boolean {
  try {
    localStorage.setItem(VPC_STORAGE_KEY, JSON.stringify(vpcs));
    return true;
  } catch {
    return false;
  }
}

export function saveMachineConfigs(configs: MachineConfig[]): boolean {
  try {
    localStorage.setItem(MACHINE_STORAGE_KEY, JSON.stringify(configs));
    return true;
  } catch {
    return false;
  }
}
