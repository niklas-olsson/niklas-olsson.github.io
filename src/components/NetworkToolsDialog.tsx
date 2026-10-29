// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { Download, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { workspace, type MachineSummary } from "../lib/machines";
import { downloadFile } from "../lib/snapshots";
import {
  firstAvailableIp,
  MAX_SUBNETS,
  type VpcConfig,
} from "../lib/vpc-config";
import {
  ALLOW_ALL_POLICY,
  DENY_ALL_POLICY,
  type NetworkPolicy,
  type PacketRule,
} from "../lib/network-policy";
import { Modal } from "./Modal";

export function NewVpcDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (config: VpcConfig) => void;
}) {
  const [name, setName] = useState("Canopy");
  const [cidr, setCidr] = useState("10.40.0.0/16");
  const [subnets, setSubnets] = useState([
    { id: crypto.randomUUID(), name: "Application", cidr: "10.40.1.0/24" },
    { id: crypto.randomUUID(), name: "Services", cidr: "10.40.2.0/24" },
  ]);
  const [error, setError] = useState("");
  return (
    <Modal
      title="Create a private VPC."
      subtitle="Subnets route to each other within this boundary. Other VPCs stay separate."
      onClose={onClose}
      className="network-tools-modal"
      notice={error ? { message: error, error: true } : null}
    >
      <form
        className="resource-form"
        onSubmit={(event) => {
          event.preventDefault();
          try {
            onCreate({ id: crypto.randomUUID(), name, cidr, subnets });
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        <label htmlFor="vpc-name">Name</label>
        <input
          id="vpc-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={64}
          autoFocus
          required
        />
        <label htmlFor="vpc-cidr">Private IPv4 range</label>
        <input
          id="vpc-cidr"
          value={cidr}
          onChange={(event) => setCidr(event.target.value)}
          spellCheck={false}
          required
        />
        <fieldset className="subnet-editor">
          <legend>Subnets · /24 ranges inside the VPC</legend>
          {subnets.map((subnet, index) => (
            <div className="subnet-edit-row" key={subnet.id}>
              <label>
                <span>Subnet name</span>
                <input
                  value={subnet.name}
                  onChange={(event) =>
                    setSubnets((old) =>
                      old.map((item, i) =>
                        i === index
                          ? { ...item, name: event.target.value }
                          : item,
                      ),
                    )
                  }
                  maxLength={64}
                  required
                />
              </label>
              <label>
                <span>CIDR</span>
                <input
                  value={subnet.cidr}
                  onChange={(event) =>
                    setSubnets((old) =>
                      old.map((item, i) =>
                        i === index
                          ? { ...item, cidr: event.target.value }
                          : item,
                      ),
                    )
                  }
                  spellCheck={false}
                  required
                />
              </label>
              <button
                type="button"
                className="icon-button danger-hover"
                aria-label={`Remove subnet ${subnet.name}`}
                onClick={() =>
                  setSubnets((old) =>
                    old.filter((item) => item.id !== subnet.id),
                  )
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <button
            className="button secondary"
            type="button"
            disabled={subnets.length >= MAX_SUBNETS}
            onClick={() =>
              setSubnets((old) => [
                ...old,
                {
                  id: crypto.randomUUID(),
                  name: `Subnet ${old.length + 1}`,
                  cidr: "",
                },
              ])
            }
          >
            <Plus size={14} /> Add subnet
          </button>
        </fieldset>
        <p className="small-print">
          Up to four VPCs, each with zero to four /24 subnets. Overlapping ranges
          in different VPCs are allowed. There is no peering or route to another
          VPC. Resource configuration persists; live traffic stays in this page.
        </p>
        <footer className="modal-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            Create VPC
          </button>
        </footer>
      </form>
    </Modal>
  );
}

export function NetworkToolsDialog({
  machine,
  vpcs,
  writable = true,
  onClose,
}: {
  machine: MachineSummary;
  vpcs: VpcConfig[];
  writable?: boolean;
  onClose: () => void;
}) {
  const [vpcId, setVpcId] = useState(machine.network.vpcId);
  const [subnetId, setSubnetId] = useState(machine.network.subnetId);
  const [ip, setIp] = useState(machine.network.ip);
  const [policy, setPolicy] = useState<NetworkPolicy>(
    structuredClone(machine.network.policy),
  );
  const [clearCapture, setClearCapture] = useState(false);
  const [notice, setNotice] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const port = workspace.get(machine.id).port;
  const frozen = machine.network.quarantined || !writable;
  const selectedVpc = vpcs.find((vpc) => vpc.id === vpcId);
  const selectedSubnet = selectedVpc?.subnets.find((subnet) => subnet.id === subnetId);
  const canMove =
    !frozen &&
    (!machine.lifecycle || machine.lifecycle === "ready") &&
    !machine.state.operation && !machine.state.acquiringEvidence && !machine.state.volumeOperation &&
    ["idle", "error"].includes(machine.state.status) &&
    !machine.network.attached &&
    !machine.runner.busy;
  const flows = port.getFlowLog(30).reverse();
  function perform(run: () => void, message: string) {
    try {
      run();
      setNotice({ message, error: false });
    } catch (error) {
      setNotice({
        message: error instanceof Error ? error.message : String(error),
        error: true,
      });
    }
  }
  function editRule(
    direction: "ingress" | "egress",
    index: number,
    patch: Partial<PacketRule>,
  ) {
    setPolicy((old) => ({
      ...old,
      [direction]: old[direction].map((rule, i) =>
        i === index ? { ...rule, ...patch } : rule,
      ),
    }));
  }
  function availableIp(vpc: VpcConfig, subnet: string): string {
    return firstAvailableIp(
      vpc,
      subnet,
      workspace
        .list()
        .filter(
          (entry) =>
            entry.id !== machine.id &&
            entry.config.vpcId === vpc.id &&
            !entry.investigation,
        )
        .map((entry) => entry.config.ip),
    );
  }
  return (
    <Modal
      title={`${machine.name}: network controls.`}
      subtitle="Placement, stateless packet rules, and bounded packet capture."
      onClose={onClose}
      className="network-tools-modal"
      notice={notice}
    >
      {machine.network.quarantined && (
        <p className="inspection-state">
          <ShieldCheck size={17} /> Quarantine is permanent for this clone.
          Network and rule changes are blocked.
        </p>
      )}
      <section className="resource-form">
        <h3>Network placement</h3>
        <div className="placement-grid">
          <label>
            VPC
            <select
              value={selectedVpc ? vpcId : ""}
              disabled={!canMove}
              onChange={(event) => {
                const selected = vpcs.find((item) => item.id === event.target.value);
                const subnet = selected?.subnets[0];
                if (!selected || !subnet) return;
                setVpcId(selected.id);
                setSubnetId(subnet.id);
                try { setIp(availableIp(selected, subnet.id)); }
                catch (error) { setIp(""); setNotice({ message: error instanceof Error ? error.message : String(error), error: true }); }
              }}
            >
              <option value="" disabled>Choose a VPC with a subnet</option>
              {vpcs.map((vpc) => (
                <option key={vpc.id} value={vpc.id} disabled={!vpc.subnets.length}>
                  {vpc.name}{!vpc.subnets.length ? " · no subnets" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Subnet
            <select
              value={selectedSubnet ? subnetId : ""}
              disabled={!canMove}
              onChange={(event) => {
                if (!selectedVpc) return;
                setSubnetId(event.target.value);
                try { setIp(availableIp(selectedVpc, event.target.value)); }
                catch (error) { setIp(""); setNotice({ message: error instanceof Error ? error.message : String(error), error: true }); }
              }}
            >
              <option value="" disabled>Choose a subnet</option>
              {vpcs
                .find((vpc) => vpc.id === vpcId)
                ?.subnets.map((subnet) => (
                  <option key={subnet.id} value={subnet.id}>
                    {subnet.name} · {subnet.cidr}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Guest IPv4
            <input
              value={ip}
              disabled={!canMove}
              spellCheck={false}
              onChange={(event) => setIp(event.target.value)}
            />
          </label>
        </div>
        <button
          className="button secondary"
          disabled={!canMove || !selectedSubnet || !ip}
          onClick={() =>
            perform(
              () =>
                workspace.configureAttachment(machine.id, {
                  vpcId,
                  subnetId,
                  ip,
                }),
              "Network placement saved for the next boot.",
            )
          }
        >
          Save placement
        </button>
        {!selectedSubnet && <p className="small-print" role="status">The selected placement is no longer available. Choose an existing VPC and subnet, or add a subnet in Connections.</p>}
        <p className="small-print">
          Stop the guest before moving it. A running or paused guest keeps its
          current attachment. Empty VPCs become available here after you add a subnet in Connections. Gateway: <code>{machine.network.gateway}</code>.
        </p>
      </section>
      <section className="packet-policy">
        <h3>Packet allow rules</h3>
        <p>
          These rules are stateless and apply at the host boundary. Unmatched IP
          packets are dropped. Return traffic needs its own matching rule. ARP
          stays confined to the subnet.
        </p>
        {(["ingress", "egress"] as const).map((direction) => (
          <fieldset
            className="policy-direction"
            key={direction}
            disabled={frozen}
          >
            <legend>
              {direction === "ingress"
                ? "Ingress · source CIDR"
                : "Egress · destination CIDR"}
            </legend>
            {policy[direction].map((rule, index) => (
              <div className="policy-rule" key={index}>
                <label>
                  Protocol
                  <select
                    value={rule.protocol}
                    onChange={(event) => {
                      const protocol = event.target
                        .value as PacketRule["protocol"];
                      editRule(direction, index, {
                        protocol,
                        ...(!["tcp", "udp"].includes(protocol)
                          ? { port: undefined }
                          : {}),
                      });
                    }}
                  >
                    <option value="any">Any IPv4</option>
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                    <option value="icmp">ICMP</option>
                  </select>
                </label>
                <label>
                  Peer CIDR
                  <input
                    value={rule.cidr}
                    onChange={(event) =>
                      editRule(direction, index, { cidr: event.target.value })
                    }
                    spellCheck={false}
                  />
                </label>
                <label>
                  Destination port
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    placeholder="Any"
                    disabled={frozen || !["tcp", "udp"].includes(rule.protocol)}
                    value={rule.port ?? ""}
                    onChange={(event) =>
                      editRule(direction, index, {
                        port: event.target.value
                          ? Number(event.target.value)
                          : undefined,
                      })
                    }
                  />
                </label>
                <button
                  className="icon-button danger-hover"
                  aria-label={`Remove ${direction} rule ${index + 1}`}
                  onClick={() =>
                    setPolicy((old) => ({
                      ...old,
                      [direction]: old[direction].filter((_, i) => i !== index),
                    }))
                  }
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {!policy[direction].length && (
              <p className="small-print">
                No allow rules. All {direction} IP traffic is denied.
              </p>
            )}
            <button
              className="button ghost"
              disabled={frozen || policy[direction].length >= 16}
              onClick={() =>
                setPolicy((old) => ({
                  ...old,
                  [direction]: [
                    ...old[direction],
                    { protocol: "any", cidr: machine.network.vpcCidr },
                  ],
                }))
              }
            >
              <Plus size={13} /> Add allow rule
            </button>
          </fieldset>
        ))}
        <div className="heading-actions">
          <button
            className="button primary"
            disabled={frozen}
            onClick={() =>
              perform(
                () => workspace.setPolicy(machine.id, policy),
                "Packet rules applied. They are enforced outside the guest.",
              )
            }
          >
            Apply rules
          </button>
          <button
            className="button secondary"
            disabled={frozen}
            onClick={() => setPolicy(structuredClone(ALLOW_ALL_POLICY))}
          >
            Allow all draft
          </button>
          <button
            className="button secondary"
            disabled={frozen}
            onClick={() => setPolicy(structuredClone(DENY_ALL_POLICY))}
          >
            Deny all draft
          </button>
        </div>
        <p className="small-print">
          Editing a draft does not change traffic until you apply it. Rules
          never override VPC separation, quarantine, or a disconnected link.
          IPv6, fragmented IP packets, and unsupported Ethernet protocols are
          not routed.
        </p>
      </section>
      <section className="packet-capture">
        <div className="section-toolbar">
          <div>
            <h3>Packet capture</h3>
            <p>
              {machine.network.capture.packets} frames ·{" "}
              {(machine.network.capture.bytes / 1024).toFixed(1)} KiB ·{" "}
              {machine.network.capture.evicted} evicted
            </p>
          </div>
          <div className="heading-actions">
            <button
              className={`button ${machine.network.capture.enabled ? "primary" : "secondary"}`}
              onClick={() => port.setCapture(!machine.network.capture.enabled)}
            >
              {machine.network.capture.enabled
                ? "Stop capture"
                : "Start capture"}
            </button>
            <button
              className="button secondary"
              disabled={!machine.network.capture.packets}
              onClick={() =>
                downloadFile(
                  `terrarium-${machine.name}-${Date.now()}.pcap`,
                  port.exportPcap().slice().buffer as ArrayBuffer,
                  "application/vnd.tcpdump.pcap",
                )
              }
            >
              <Download size={14} /> PCAP
            </button>
            <button
              className="icon-button"
              aria-label="Clear captured packets"
              disabled={!machine.network.capture.packets}
              onClick={() => setClearCapture(true)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>
        {clearCapture && <div className="capture-delete-confirmation" role="group" aria-label="Confirm captured packet deletion"><p>Clear all {machine.network.capture.packets.toLocaleString()} captured frames? Download the PCAP first if you need a copy. Capture settings and the flow log remain unchanged.</p><div className="heading-actions"><button className="button secondary" onClick={() => setClearCapture(false)}>Keep packets</button><button className="button danger" onClick={() => { port.clearCapture(); setClearCapture(false); setNotice({ message: "Captured packets cleared. Capture settings were kept.", error: false }); }}><Trash2 size={14} />Clear packets</button></div></div>}
        <p className="small-print">
          Capture is opt-in, in memory only. The newest 2,048 frames fit within
          4 MiB; each retains at most 2,048 bytes. Both allowed and dropped
          attempts can appear. The flow log below records verdicts, which
          ordinary PCAP does not.
        </p>
        <div className="flow-table-wrap">
          <table className="flow-table">
            <caption>Most recent packet decisions</caption>
            <thead>
              <tr>
                <th>Time / direction</th>
                <th>Packet</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {flows.map((flow, index) => (
                <tr key={`${flow.atMs}-${index}`}>
                  <td>
                    {new Date(flow.atMs).toLocaleTimeString()}
                    <small>{flow.direction}</small>
                  </td>
                  <td>
                    <strong>{flow.protocol.toUpperCase()}</strong>
                    <code>
                      {flow.source}
                      {flow.sourcePort ? `:${flow.sourcePort}` : ""} →{" "}
                      {flow.destination}
                      {flow.destinationPort ? `:${flow.destinationPort}` : ""}
                    </code>
                  </td>
                  <td>
                    <span
                      className={
                        flow.verdict === "drop" ? "flow-drop" : "flow-allow"
                      }
                    >
                      {flow.verdict}
                    </span>
                    <small>{flow.reason.replaceAll("_", " ")}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!flows.length && (
            <p className="small-print">No packet decisions recorded yet.</p>
          )}
        </div>
      </section>
    </Modal>
  );
}
