// SPDX-License-Identifier: Apache-2.0
import { useState } from "react";
import { Globe2, Network, Save } from "lucide-react";
import { Modal } from "./Modal";
import type { ManagedMachine } from "../lib/machines";
import { validateRelayUrl, type NetworkTransport } from "../lib/network";

export function NetworkTransportDialog({
  machine,
  onSave,
  onClose,
}: {
  machine: ManagedMachine;
  onSave: (transport: NetworkTransport) => void;
  onClose: () => void;
}) {
  const current = machine.port.getSnapshot();
  const [kind, setKind] = useState<"web" | "wisp">(current.transport);
  const [relayUrl, setRelayUrl] = useState(current.relayUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      title={`Outside connection · ${machine.name}`}
      subtitle="Choose how this guest reaches the world."
      className="machine-form-modal"
      onClose={onClose}
      notice={error ? { message: error, error: true } : null}
    >
      <div className="machine-form">
        <fieldset className="profile-choices transport-choices">
          <legend>Transport</legend>
          <label
            className={`profile-choice ${kind === "web" ? "selected" : ""}`}
          >
            <input
              type="radio"
              name="transport"
              checked={kind === "web"}
              onChange={() => setKind("web")}
            />
            <Globe2 size={22} />
            <strong>Browser web bridge</strong>
            <p>
              Outbound HTTP through the browser. Works with HTTPS destinations
              that permit CORS. No relay account required.
            </p>
            <small>HTTP only · no guest TLS</small>
          </label>
          <label
            className={`profile-choice ${kind === "wisp" ? "selected" : ""}`}
          >
            <input
              type="radio"
              name="transport"
              checked={kind === "wisp"}
              onChange={() => setKind("wisp")}
            />
            <Network size={22} />
            <strong>Internet via Wisp</strong>
            <p>
              Outbound TCP through a compatible relay you supply. The relay
              resolves destination names.
            </p>
            <small>TCP · encrypted relay transport</small>
          </label>
        </fieldset>
        {kind === "wisp" && (
          <>
            <label htmlFor="relay-url">Secure Wisp relay endpoint</label>
            <input
              id="relay-url"
              value={relayUrl}
              onChange={(event) => {
                setRelayUrl(event.target.value);
                setError(null);
              }}
              type="url"
              placeholder="wss://your-relay.example/wisp/"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
            />
            <p className="script-explainer">
              Use your own or a trusted Wisp-compatible relay. It carries the
              guest’s outbound connections and sees their destinations. This
              address is saved in this browser. GitHub Pages does not host the
              relay.
            </p>
          </>
        )}
        {machine.config.profile === "riscv64" && (
          <p className="script-explainer">
            This small RISC-V image uses <code>webget http://…</code> with the
            Browser bridge. Its normal hostname lookup libraries are absent, so
            Wisp destinations need numeric IP addresses.
          </p>
        )}
        <p className="script-explainer">
          The supplied guest clients have limited protocol support. The Wisp
          connection is encrypted; it does not add TLS to guest tools. General
          UDP and public inbound ports are not provided.
        </p>
        <p className="script-explainer">
          The outside-access switch controls the connection separately. Applying
          a transport replaces any active connection. Outside access starts off
          after a page reload.
        </p>
      </div>
      <footer className="modal-footer">
        <button className="button secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          className="button primary"
          onClick={() => {
            try {
              onSave(
                kind === "web"
                  ? { kind: "web" }
                  : { kind: "wisp", relayUrl: validateRelayUrl(relayUrl) },
              );
              onClose();
            } catch (reason) {
              setError(
                reason instanceof Error ? reason.message : String(reason),
              );
            }
          }}
        >
          <Save size={15} />
          Apply transport
        </button>
      </footer>
    </Modal>
  );
}
