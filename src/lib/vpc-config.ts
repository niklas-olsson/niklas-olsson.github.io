// SPDX-License-Identifier: Apache-2.0

export interface SubnetConfig {
  id: string;
  name: string;
  cidr: string;
}
export interface VpcConfig {
  id: string;
  name: string;
  cidr: string;
  subnets: SubnetConfig[];
}
export interface NetworkAttachment {
  vpcId: string;
  subnetId: string;
  ip: string;
}
export interface ResolvedAttachment extends NetworkAttachment {
  vpcCidr: string;
  subnetCidr: string;
  gateway: string;
}
export interface Ipv4Cidr {
  cidr: string;
  network: number;
  mask: number;
  prefix: number;
  broadcast: number;
}

export const DEFAULT_VPC_ID = "default";
export const DEFAULT_SUBNET_ID = "default";
export const MAX_VPCS = 4;
export const MAX_SUBNETS = 4;
export const DEFAULT_VPCS: VpcConfig[] = [
  {
    id: DEFAULT_VPC_ID,
    name: "Garden",
    cidr: "192.168.76.0/24",
    subnets: [
      {
        id: DEFAULT_SUBNET_ID,
        name: "Default subnet",
        cidr: "192.168.76.0/24",
      },
    ],
  },
];

export function ipv4Number(value: string): number {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value)
  )
    throw new Error("Use a canonical IPv4 address.");
  const parts = value.split(".").map(Number);
  if (parts.some((part) => part > 255))
    throw new Error("An IPv4 octet cannot exceed 255.");
  return (
    ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  );
}

export function ipv4Text(value: number): string {
  return [
    value >>> 24,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

export function parseCidr(value: string): Ipv4Cidr {
  if (typeof value !== "string" || !/^[^/]+\/(0|[1-9]\d?)$/.test(value))
    throw new Error("Use an IPv4 CIDR, such as 10.40.0.0/16.");
  const [address, bits] = value.split("/");
  const prefix = Number(bits);
  if (prefix > 32) throw new Error("IPv4 prefixes range from /0 to /32.");
  const ip = ipv4Number(address);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  if (network !== ip)
    throw new Error(
      "Use the network address for this CIDR; host bits must be zero.",
    );
  return {
    cidr: `${address}/${prefix}`,
    network,
    mask,
    prefix,
    broadcast: (network | ~mask) >>> 0,
  };
}

export function containsIp(
  cidr: string | Ipv4Cidr,
  ip: string | number,
): boolean {
  const block = typeof cidr === "string" ? parseCidr(cidr) : cidr;
  const address = typeof ip === "string" ? ipv4Number(ip) : ip;
  return (address & block.mask) >>> 0 === block.network;
}

function id(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,48}$/.test(value))
    throw new Error(
      "Resource IDs use 1–48 letters, numbers, underscores, or hyphens.",
    );
  return value;
}
function name(value: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 64 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error("Use a resource name of 1–64 printable characters.");
  return value.trim();
}
function isPrivate(block: Ipv4Cidr): boolean {
  return ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].some(
    (range) =>
      containsIp(range, block.network) && containsIp(range, block.broadcast),
  );
}

export function validateVpcConfig(input: VpcConfig): VpcConfig {
  if (!input || typeof input !== "object")
    throw new Error("A VPC configuration is required.");
  const block = parseCidr(input.cidr);
  if (block.prefix > 24 || !isPrivate(block))
    throw new Error(
      "VPCs use a private IPv4 CIDR between its private range prefix and /24.",
    );
  if (
    !Array.isArray(input.subnets) ||
    input.subnets.length > MAX_SUBNETS
  )
    throw new Error("A VPC holds up to four /24 subnets.");
  const subnets: SubnetConfig[] = [];
  for (const candidate of input.subnets) {
    if (!candidate || typeof candidate !== "object")
      throw new Error("Invalid subnet.");
    const subnet = parseCidr(candidate.cidr);
    if (
      subnet.prefix !== 24 ||
      !containsIp(block, subnet.network) ||
      !containsIp(block, subnet.broadcast)
    )
      throw new Error("Each subnet must be a /24 within its VPC.");
    const validated = {
      id: id(candidate.id),
      name: name(candidate.name),
      cidr: subnet.cidr,
    };
    if (
      subnets.some(
        (other) => other.id === validated.id || other.cidr === validated.cidr,
      )
    )
      throw new Error("Subnet IDs and CIDRs must be unique within a VPC.");
    subnets.push(validated);
  }
  return {
    id: id(input.id),
    name: name(input.name),
    cidr: block.cidr,
    subnets,
  };
}

export function validateVpcList(input: VpcConfig[]): VpcConfig[] {
  if (!Array.isArray(input) || input.length > MAX_VPCS)
    throw new Error("A workspace holds up to four VPCs.");
  const vpcs: VpcConfig[] = [];
  for (const candidate of input) {
    const value = validateVpcConfig(candidate);
    if (vpcs.some((other) => other.id === value.id))
      throw new Error("VPC IDs must be unique.");
    vpcs.push(value);
  }
  return vpcs;
}

/** Saved resource configuration never grants packet forwarding. */
export function parseVpcConfigs(input: unknown): VpcConfig[] {
  try {
    return validateVpcList(input as VpcConfig[]);
  } catch {
    return structuredClone(DEFAULT_VPCS);
  }
}

export function resolveAttachment(
  vpcs: VpcConfig[],
  attachment: NetworkAttachment,
): ResolvedAttachment {
  const vpc = vpcs.find((item) => item.id === attachment.vpcId);
  const subnet = vpc?.subnets.find((item) => item.id === attachment.subnetId);
  if (!vpc || !subnet) throw new Error("Select an existing VPC and subnet.");
  const block = parseCidr(subnet.cidr);
  const address = ipv4Number(attachment.ip);
  if (
    !containsIp(block, address) ||
    address <= block.network + 1 ||
    address >= block.broadcast
  )
    throw new Error(
      "Choose a host address inside the selected subnet, excluding its network, gateway, and broadcast addresses.",
    );
  return {
    ...attachment,
    vpcCidr: vpc.cidr,
    subnetCidr: subnet.cidr,
    gateway: ipv4Text(block.network + 1),
  };
}

export function firstAvailableIp(
  vpc: VpcConfig,
  subnetId: string,
  used: string[],
): string {
  const subnet = vpc.subnets.find((item) => item.id === subnetId);
  if (!subnet) throw new Error("Select an existing subnet.");
  const block = parseCidr(subnet.cidr);
  for (let host = 10; host < 255; host++) {
    const candidate = ipv4Text(block.network + host);
    if (!used.includes(candidate)) return candidate;
  }
  throw new Error("This subnet has no available application-assigned address.");
}
