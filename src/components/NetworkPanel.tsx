// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Box,
  Globe2,
  Info,
  LoaderCircle,
  Network,
  Plus,
  Settings2,
  ShieldCheck,
  Trash2,
  WifiOff,
} from "lucide-react";
import { workspace, type MachineSummary } from "../lib/machines";
import { MAX_SUBNETS, MAX_VPCS, ipv4Text, parseCidr, type VpcConfig } from "../lib/vpc-config";
import { NetworkToolsDialog, NewVpcDialog } from "./NetworkToolsDialog";
import type { NetworkMode } from "../lib/network";
import type { CloudControlPlane } from "../lib/cloud";
import { DeleteResourceDialog, type DeleteResourceRequest } from "./DeleteResourceDialog";
import { Modal } from "./Modal";

export function NetworkControls({
  machine,
  onChange,
  onConfigure,
  compact = false,
  readOnly = false,
}: {
  machine: MachineSummary;
  onChange: (id: string, mode: NetworkMode) => void;
  onConfigure: (id: string) => void;
  compact?: boolean;
  readOnly?: boolean;
}) {
  const supported =
    !readOnly && machine.capabilities.network !== "none" && !machine.network.quarantined;
  const { network } = machine;
  return (
    <div className={`network-controls ${compact ? "compact" : ""}`}>
      <div className="network-control-row">
        <div>
          <strong>
            {network.quarantined ? "Quarantine locked" : "VPC network"}
          </strong>
          <small>
            {supported
              ? `${network.vpcId} / ${network.subnetId} · this tab`
              : network.quarantined
                ? "Peer and outside traffic blocked by host"
                : readOnly ? "Workspace changes require write access" : "No network adapter in this profile"}
          </small>
        </div>
        <button
          className={`switch ${network.mode !== "isolated" ? "on" : ""}`}
          type="button"
          role="switch"
          aria-label={`${machine.name} VPC network`}
          aria-checked={network.mode !== "isolated"}
          disabled={!supported}
          onClick={() =>
            onChange(
              machine.id,
              network.mode === "isolated" ? "local" : "isolated",
            )
          }
        >
          <span />
        </button>
      </div>
      <div className="network-control-row">
        <div>
          <strong>
            {network.transport === "wisp" ? "Internet via relay" : "Web access"}
          </strong>
          <small>
            {network.transport === "wisp"
              ? "Outbound TCP · your Wisp relay"
              : "Outbound HTTP · browser CORS rules"}
          </small>
        </div>
        <button
          className={`switch ${network.mode === "world" ? "on" : ""}`}
          type="button"
          role="switch"
          aria-label={`${machine.name} outside access`}
          aria-checked={network.mode === "world"}
          disabled={!supported || network.mode === "isolated"}
          onClick={() =>
            onChange(machine.id, network.mode === "world" ? "local" : "world")
          }
        >
          <span />
        </button>
      </div>
      <button
        className="network-transport-button"
        disabled={network.quarantined || readOnly}
        onClick={() => onConfigure(machine.id)}
      >
        <Globe2 size={12} />
        <span>
          {network.transport === "wisp" ? "Wisp relay" : "Browser bridge"}
        </span>
        <span>
          {network.mode === "world" ? network.connectionState : "Configure"}
        </span>
      </button>
      <div className="network-address">
        <code title={network.dnsName ?? undefined}>{machine.config.ip}</code>
        <span>
          {network.mode === "isolated"
            ? network.quarantined
              ? "QUARANTINED"
              : "DISCONNECTED"
            : machine.state.status === "paused"
              ? "PAUSED"
              : network.attached && network.ready
                ? "LINK UP"
                : "LINK ON BOOT"}
        </span>
      </div>
      {machine.config.profile === "riscv64" && network.mode === "world" && (
        <p className="network-profile-note">
          {network.transport === "web" ? (
            <>
              Use <code>webget http://…</code> in this guest.
            </>
          ) : (
            "This guest requires numeric destination IPs."
          )}
        </p>
      )}
      {network.lastError && (
        <p className="network-error" role="status">
          {network.lastError}
        </p>
      )}
    </div>
  );
}

export function NetworkPanel({
  cloud,
  writable = true,
  machines,
  vpcs,
  onSelect,
  onChange,
  onConfigure,
  onNewMachine,
  onError,
}: {
  cloud: CloudControlPlane;
  writable?: boolean;
  machines: MachineSummary[];
  vpcs: VpcConfig[];
  onSelect: (id: string) => void;
  onChange: (id: string, mode: NetworkMode) => void;
  onConfigure: (id: string) => void;
  onNewMachine: (vpcId: string, subnetId: string) => void;
  onError: (error: unknown) => void;
}) {
  const [newVpc, setNewVpc] = useState(false);
  const [newSubnetVpc, setNewSubnetVpc] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<DeleteResourceRequest | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  useEffect(() => cloud.subscribe(() => setRevision((value) => value + 1)), [cloud]);
  const deletionRevision = `${revision}:${writable}:${JSON.stringify(vpcs)}:${JSON.stringify(machines.map((entry) => [entry.id, entry.name, entry.network.vpcId, entry.network.subnetId, entry.state.status]))}`;
  const subnetVpc = vpcs.find((vpc) => vpc.id === newSubnetVpc);
  function reviewVpc(vpc: VpcConfig) {
    setDeletion({
      key: `vpc:${vpc.id}`, name: `${vpc.name} · ${vpc.cidr}`, kind: "VPC",
      description: "This removes the VPC definition. Delete its subnets and move or delete all assigned instances first. Running and stopped instance definitions both count as dependencies.",
      preview: () => cloud.deletions.preview({ type: "vpc", id: vpc.id }),
      remove: () => cloud.vpcs.delete(vpc.id).wait(),
    });
  }
  function reviewSubnet(vpc: VpcConfig, subnetId: string) {
    const subnet = vpc.subnets.find((entry) => entry.id === subnetId)!;
    setDeletion({
      key: `subnet:${vpc.id}:${subnet.id}`, name: `${vpc.name} / ${subnet.name} · ${subnet.cidr}`, kind: "subnet",
      description: "This removes the subnet definition and its gateway. Move or delete every assigned instance first, including stopped instances. The VPC and its other subnets remain available.",
      preview: () => cloud.deletions.preview({ type: "subnet", id: subnet.id, vpcId: vpc.id }),
      remove: () => cloud.subnets.delete(vpc.id, subnet.id).wait(),
    });
  }
  const [toolsId, setToolsId] = useState<string | null>(null);
  const toolsMachine = machines.find((entry) => entry.id === toolsId);
  const web = machines.filter((machine) => machine.network.mode === "world");
  const exampleSource = machines.find(
    (source) =>
      !source.network.quarantined &&
      machines.some(
        (peer) =>
          peer.id !== source.id &&
          !peer.network.quarantined &&
          peer.network.vpcId === source.network.vpcId,
      ),
  );
  const examplePeer =
    exampleSource &&
    machines.find(
      (peer) =>
        peer.id !== exampleSource.id &&
        !peer.network.quarantined &&
        peer.network.vpcId === exampleSource.network.vpcId,
    );
  return (
    <>
      <section className="page-heading workspace-heading">
        <div>
          <div className="eyebrow">
            <Network size={14} /> CONNECTIONS
          </div>
          <h1>
            A network <span>of your own.</span>
          </h1>
          <p>Separate VPCs. Routed subnets. An explicit way out.</p>
        </div>
        <button
          className="button primary"
          disabled={!writable || vpcs.length >= MAX_VPCS}
          onClick={() => setNewVpc(true)}
        >
          <Plus size={16} /> Create VPC
        </button>
      </section>
      {notice && <p className="cloud-notice" role="status">{notice}</p>}
      {!writable && <p className="cloud-notice" role="status">Workspace changes are temporarily unavailable. Check the workspace storage status; network details remain available.</p>}
      {!vpcs.length && <div className="empty-state glass"><Network size={30} /><h3>No VPCs in this workspace</h3><p>Create a VPC and a subnet before creating or placing a machine. Stored disks, objects, checkpoints, and evidence are kept.</p><button className="button secondary" disabled={!writable} onClick={() => setNewVpc(true)}><Plus size={14} />Create VPC</button></div>}
      <div className="vpc-topology-grid">
        {vpcs.map((vpc) => (
          <section
            key={vpc.id}
            className="vpc-card glass"
            aria-label={`VPC ${vpc.name}`}
          >
            <header>
              <div>
                <Network size={21} />
                <div>
                  <h2>{vpc.name}</h2>
                  <code>{vpc.cidr}</code>
                </div>
              </div>
              <button
                className="icon-button danger-hover"
                aria-label={`Delete VPC ${vpc.name}`}
                disabled={!writable}
                title="Review VPC deletion and dependencies"
                onClick={() => reviewVpc(vpc)}
              >
                <Trash2 size={15} />
              </button>
            </header>
            <p className="vpc-boundary">
              VPC boundary · local routes stay within this VPC
            </p>
            {vpc.subnets.map((subnet) => (
              <div className="subnet-group" key={subnet.id}>
                <div className="subnet-heading">
                  <div>
                    <strong>{subnet.name}</strong>
                    <code>{subnet.cidr}</code>
                  </div>
                  <div className="subnet-actions">
                    <button className="icon-button" disabled={!writable} aria-label={`Add machine to ${vpc.name}, ${subnet.name}`} onClick={() => onNewMachine(vpc.id, subnet.id)}><Plus size={16} /></button>
                    <button className="icon-button danger-hover" disabled={!writable} title="Review subnet deletion and dependencies" aria-label={`Delete subnet ${subnet.name} in ${vpc.name}`} onClick={() => reviewSubnet(vpc, subnet.id)}><Trash2 size={15} /></button>
                  </div>
                </div>
                <div className="subnet-machines">
                  {machines
                    .filter(
                      (machine) =>
                        machine.network.vpcId === vpc.id &&
                        machine.network.subnetId === subnet.id,
                    )
                    .map((machine) => (
                      <button
                        key={machine.id}
                        className={`subnet-machine ${machine.network.quarantined ? "quarantined" : machine.network.mode !== "isolated" ? "connected" : ""}`}
                        onClick={() => onSelect(machine.id)}
                      >
                        {machine.network.quarantined ? (
                          <ShieldCheck size={17} />
                        ) : (
                          <Box size={17} />
                        )}
                        <strong>{machine.name}</strong>
                        <code>{machine.config.ip}</code>
                        {machine.network.dnsName && <small className="machine-dns-name">{machine.network.dnsName}</small>}
                        <span>
                          {machine.network.quarantined
                            ? "Quarantine"
                            : machine.network.mode === "isolated"
                              ? "Disconnected"
                              : machine.network.mode === "world"
                                ? "VPC + outside"
                                : "VPC only"}
                        </span>
                      </button>
                    ))}
                  {!machines.some(
                    (machine) =>
                      machine.network.vpcId === vpc.id &&
                      machine.network.subnetId === subnet.id,
                  ) && (
                    <p className="empty-subnet">No machines in this subnet.</p>
                  )}
                </div>
              </div>
            ))}
            {!vpc.subnets.length && <p className="empty-subnet">This VPC has no subnets. Add one to place a machine, or delete the empty VPC.</p>}
            <div className="vpc-subnet-toolbar"><button className="button small secondary" disabled={!writable || vpc.subnets.length >= MAX_SUBNETS} onClick={() => setNewSubnetVpc(vpc.id)}><Plus size={14} />Add subnet</button><span>{vpc.subnets.length} / {MAX_SUBNETS} subnets</span></div>
            <footer>
              <Globe2 size={15} />
              <span>
                {
                  machines.filter(
                    (machine) =>
                      machine.network.vpcId === vpc.id &&
                      machine.network.mode === "world",
                  ).length
                }{" "}
                outside connections enabled
              </span>
              <small>Per-machine gateway</small>
            </footer>
          </section>
        ))}
      </div>
      <p className="network-boundary-note">
        <ShieldCheck size={15} /> VPCs do not peer. Each subnet has a gateway at
        its first host address. Outside access is{" "}
        {web.length
          ? `enabled for ${web.length} machine${web.length === 1 ? "" : "s"}`
          : "off"}
        ; it starts off again after refresh.
      </p>
      <div className="network-machine-grid">
        {machines.map((machine) => (
          <section className="network-machine-card glass" key={machine.id}>
            <header>
              <button onClick={() => onSelect(machine.id)}>
                <Box size={17} />
                <strong>{machine.name}</strong>
              </button>
              <span className={`machine-indicator ${machine.state.status}`} />
            </header>
            <NetworkControls
              machine={machine}
              onChange={onChange}
              onConfigure={onConfigure}
              readOnly={!writable}
            />
            <button
              className="network-tools-button button secondary"
              onClick={() => setToolsId(machine.id)}
            >
              <Settings2 size={14} /> Placement, rules & capture
            </button>
            <footer>
              <span>
                <ArrowUp size={12} />
                {machine.network.txPackets.toLocaleString()} sent
              </span>
              <span>
                <ArrowDown size={12} />
                {machine.network.rxPackets.toLocaleString()} received
              </span>
              <span>
                {machine.network.droppedPackets.toLocaleString()} dropped
              </span>
            </footer>
          </section>
        ))}
      </div>
      <div className="network-notes">
        <section className="technical-notes glass">
          <div className="card-label">
            TRY A LOCAL ROUTE <Network size={14} />
          </div>
          <p>
            Enable the VPC network on two machines in the same VPC. They can
            share a subnet or use different subnets. After booting, ping the
            other machine:
          </p>
          <pre className="inline-command">
            ping -c 3 {examplePeer?.config.ip ?? "PEER_IP"}
          </pre>
          <p>
            {exampleSource
              ? `Run this from ${exampleSource.name} after both VPC links are enabled.`
              : "Replace PEER_IP with another guest's address in the same VPC."}
          </p>
          <p>
            Real Ethernet frames pass through the in-page switch and router.
            Other VPCs, spoofed source addresses, and disabled links are blocked
            outside the guest.
          </p>
          <p>
            Private DNS resolves <code>{examplePeer?.network.dnsName ?? "machine-name.terrarium.internal"}</code>
            {" "}to its configured IPv4 address within the same VPC. Quarantined
            machines have no record. Use numeric addresses in the original
            RISC-V garden, whose image lacks normal resolver libraries.
          </p>
        </section>
        <section className="technical-notes glass">
          <div className="card-label">
            OUTSIDE CONNECTIONS <Info size={14} />
          </div>
          <p>
            The browser bridge accepts guest HTTP and fetches over HTTPS subject
            to CORS. Supply a secure Wisp relay for outbound TCP, including
            guest TLS when the selected image has a working TLS client. General
            UDP and incoming public ports are not included.
          </p>
          <p>
            <WifiOff size={13} /> Disconnecting outside access closes relay
            sockets and aborts web requests. Quarantine blocks both the private
            network and the world permanently for that clone.
          </p>
        </section>
      </div>
      {newVpc && (
        <NewVpcDialog
          onClose={() => setNewVpc(false)}
          onCreate={(config) => {
            try {
              workspace.addVpc(config);
              setNewVpc(false);
              setNotice("VPC created. Its subnets are available immediately.");
            } catch (error) { onError(error); throw error; }
          }}
        />
      )}
      {subnetVpc && <NewSubnetDialog cloud={cloud} vpc={subnetVpc} onClose={() => setNewSubnetVpc(null)} onCreated={() => { setNewSubnetVpc(null); setNotice("Subnet created. It is ready for instance placement."); }} />}
      {deletion && <DeleteResourceDialog key={deletion.key} request={deletion} revision={deletionRevision} onClose={() => setDeletion(null)} onDeleted={() => { setNotice(`${deletion.name} deleted. Other networks and stored resources were kept.`); setDeletion(null); }} blockerAction={(blocker) => {
        if (blocker.type === "instance" && machines.some((entry) => entry.id === blocker.id)) return { label: "Placement controls", run: () => { setDeletion(null); setToolsId(blocker.id); } };
        if (blocker.type === "subnet") return { label: "Review subnets", run: () => { setDeletion(null); } };
        return null;
      }} />}
      {toolsMachine && (
        <NetworkToolsDialog
          machine={toolsMachine}
          vpcs={vpcs}
          writable={writable}
          onClose={() => setToolsId(null)}
        />
      )}
    </>
  );
}


function NewSubnetDialog({ cloud, vpc, onClose, onCreated }: {
  cloud: CloudControlPlane; vpc: VpcConfig; onClose: () => void; onCreated: () => void;
}) {
  const [name, setName] = useState(`Subnet ${vpc.subnets.length + 1}`);
  const [cidr, setCidr] = useState(() => {
    const block = parseCidr(vpc.cidr);
    const used = new Set(vpc.subnets.map((subnet) => subnet.cidr));
    for (let address = block.network; address <= block.broadcast; address += 256) {
      const candidate = `${ipv4Text(address)}/24`;
      if (!used.has(candidate)) return candidate;
    }
    return "";
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <Modal title="Add a subnet" subtitle={vpc.name} onClose={() => { if (!busy) onClose(); }} notice={error ? { message: error, error: true } : null}>
    <form className="resource-form" onSubmit={(event) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true); setError("");
      void (async () => {
        try { await cloud.subnets.create(vpc.id, { name, cidr }).wait(); onCreated(); }
        catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
        finally { setBusy(false); }
      })();
    }}>
      <label htmlFor="new-subnet-name">Subnet name</label><input id="new-subnet-name" value={name} disabled={busy} maxLength={64} required autoFocus onChange={(event) => setName(event.target.value)} />
      <label htmlFor="new-subnet-cidr">Private IPv4 CIDR</label><input id="new-subnet-cidr" value={cidr} disabled={busy} required spellCheck={false} placeholder="10.40.1.0/24" onChange={(event) => setCidr(event.target.value)} />
      <p className="small-print">Choose an unused /24 range inside <code>{vpc.cidr}</code>. Its first host address is the subnet gateway. VPCs may remain empty until you need a subnet.</p>
      <footer className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !name.trim() || !cidr.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}Add subnet</button></footer>
    </form>
  </Modal>;
}
