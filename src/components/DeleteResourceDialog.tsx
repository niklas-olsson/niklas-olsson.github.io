// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { Modal } from "./Modal";

export interface DeletionBlocker {
  type: string;
  id: string;
  name: string;
  message: string;
}

export interface DeletionPreview {
  exists: boolean;
  allowed: boolean;
  blockers: readonly DeletionBlocker[];
  preserves: readonly string[];
}

/** Callbacks belong to the exact selected resource, never a later active selection. */
export interface DeleteResourceRequest {
  key: string;
  name: string;
  kind: string;
  description: string;
  preview: () => Promise<DeletionPreview>;
  remove: () => Promise<unknown>;
}

export function DeleteResourceDialog({
  request,
  revision = "",
  onClose,
  onDeleted,
  blockerAction,
}: {
  request: DeleteResourceRequest;
  revision?: string | number;
  onClose: () => void;
  onDeleted: () => void;
  blockerAction?: (blocker: DeletionBlocker) => { label: string; run: () => void } | null;
}) {
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [checking, setChecking] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const sequence = useRef(0);
  const deleteLock = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current += 1; };
  }, []);

  useEffect(() => {
    if (deleteLock.current) return;
    const current = ++sequence.current;
    let active = true;
    setChecking(true);
    void request.preview().then((value) => {
      if (active && current === sequence.current) setPreview(value);
    }).catch((reason) => {
      if (active && current === sequence.current) {
        setPreview(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => {
      if (active && current === sequence.current) setChecking(false);
    });
    return () => { active = false; };
  }, [request, revision, retry]);

  async function confirmDeletion() {
    if (deleteLock.current || checking || !preview?.exists || !preview.allowed) return;
    deleteLock.current = true;
    sequence.current += 1;
    setDeleting(true);
    setError("");
    try {
      // Recheck after confirmation. The backend also enforces dependency gates
      // when applying the deletion, including changes made through the API.
      const latest = await request.preview();
      if (mounted.current) setPreview(latest);
      if (!latest.exists || !latest.allowed) return;
      await request.remove();
      if (mounted.current) onDeleted();
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      deleteLock.current = false;
      if (mounted.current) {
        setDeleting(false);
        setRetry((value) => value + 1);
      }
    }
  }

  return <Modal
    title={`Delete ${request.kind}?`}
    subtitle={request.name}
    className="delete-resource-modal"
    onClose={() => { if (!deleteLock.current) onClose(); }}
    notice={error ? { message: error, error: true } : null}
  >
    <p className="delete-resource-description">{request.description}</p>
    {checking && !deleting && <p className="delete-resource-status" role="status"><LoaderCircle size={16} className="spin" />Checking current dependencies…</p>}
    {preview && !preview.exists && <p className="delete-resource-status" role="status"><CheckCircle2 size={16} />This resource has already been removed. Nothing else will be deleted.</p>}
    {preview?.exists && preview.blockers.length > 0 && <section className="delete-resource-blockers" aria-label="Deletion dependencies">
      <h3><AlertTriangle size={16} />Resolve these dependencies first</h3>
      <ul>{preview.blockers.map((blocker, index) => {
        const action = blockerAction?.(blocker);
        return <li key={`${blocker.type}:${blocker.id}:${index}`}><div><strong>{blocker.name}</strong><p>{blocker.message}</p></div>{action && <button className="button small secondary" disabled={deleting} onClick={action.run}>{action.label}</button>}</li>;
      })}</ul>
    </section>}
    {preview?.exists && preview.preserves.length > 0 && <section className="delete-resource-preserves"><h3>What remains</h3><ul>{preview.preserves.map((item, index) => <li key={index}>{item}</li>)}</ul></section>}
    {preview?.exists && preview.allowed && <p className="small-print">This deletion cannot be undone from this workspace. Export any data you need before continuing.</p>}
    <footer className="modal-footer">
      <button className="button secondary" disabled={deleting} onClick={onClose}>{preview && !preview.exists ? "Close" : "Cancel"}</button>
      {(!preview || !preview.allowed) && preview?.exists !== false && <button className="button secondary" disabled={checking || deleting} onClick={() => { setError(""); setRetry((value) => value + 1); }}><RefreshCw size={14} />Check again</button>}
      {preview?.exists !== false && <button className="button danger" disabled={checking || deleting || !preview?.allowed} onClick={() => { void confirmDeletion(); }}>{deleting ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}{deleting ? "Deleting…" : `Delete ${request.kind}`}</button>}
    </footer>
  </Modal>;
}
