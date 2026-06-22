// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Roots view: list the user's sync roots, add a new one, pause/resume, scan, and
 * remove. A root is a folder Marrow keeps consistent across devices (SPEC §3/§7).
 * Per-root status comes straight from the Rust engine.
 */

import { type FormEvent, useCallback, useEffect, useState } from "react";

import { addRoot, listRoots, removeRoot, scanRoot, setRootPaused } from "../api/tauri";
import type { RootInfo, ScanSummary } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { formatBytes, formatCount } from "../lib/format";

export function Roots() {
  const [roots, setRoots] = useState<RootInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<ScanSummary | null>(null);

  const [newPath, setNewPath] = useState("");
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRoots(await listRoots());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function withRoot(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    try {
      await action();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    const path = newPath.trim();
    if (!path) return;
    const name = newName.trim() || path.split(/[/\\]/).filter(Boolean).pop() || path;
    setAdding(true);
    setError(null);
    try {
      await addRoot(path, name);
      setNewPath("");
      setNewName("");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  function onScan(id: string) {
    void withRoot(id, async () => {
      const summary = await scanRoot(id);
      setLastScan(summary);
    });
  }

  return (
    <>
      <div className="view-header">
        <div>
          <h1>Sync roots</h1>
          <p className="view-sub">Folders Marrow keeps in sync across your devices.</p>
        </div>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      <form className="card" onSubmit={onAdd} style={{ padding: "16px" }}>
        <div className="inline-form">
          <label className="field">
            <span className="field-label">Folder path</span>
            <input
              type="text"
              className="mono"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="/Users/you/code"
            />
          </label>
          <label className="field">
            <span className="field-label">Name (optional)</span>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="code"
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={adding || !newPath.trim()}>
            {adding ? <span className="spinner" /> : null} Add root
          </button>
        </div>
      </form>

      {lastScan && (
        <div className="banner banner-warn" role="status">
          Scanned {formatCount(lastScan.scanned)} entries:{" "}
          <strong>{formatCount(lastScan.included)}</strong> included,{" "}
          {formatCount(lastScan.ignored)} ignored, {formatBytes(lastScan.bytes)}.
        </div>
      )}

      {loading ? (
        <p className="row-meta">
          <span className="spinner" /> Loading roots…
        </p>
      ) : roots.length === 0 ? (
        <div className="empty">
          <h2>No sync roots yet</h2>
          <p>Add a folder above to start syncing it across your machines.</p>
        </div>
      ) : (
        <div className="card">
          {roots.map((root) => (
            <div className="row" key={root.id}>
              <div className="row-main">
                <div className="row-title">{root.name}</div>
                <div className="row-path">{root.path}</div>
                <div className="row-meta">{formatCount(root.fileCount)} files</div>
              </div>
              <StatusBadge state={root.paused ? "paused" : root.status} />
              <button
                type="button"
                className="btn btn-sm"
                disabled={busyId === root.id}
                onClick={() => onScan(root.id)}
              >
                Scan
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busyId === root.id}
                onClick={() => withRoot(root.id, () => setRootPaused(root.id, !root.paused))}
              >
                {root.paused ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={busyId === root.id}
                onClick={() => withRoot(root.id, () => removeRoot(root.id))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
