// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Roots view: list the user's sync roots, add a new one, pause/resume, scan, and
 * remove. A root is a folder Marrow keeps consistent across devices (SPEC §3/§7).
 * Per-root status comes straight from the Rust engine.
 */

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { addRoot, listRoots, removeRoot, scanRoot, setRootPaused } from "../api/tauri";
import type { RootInfo, ScanSummary } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { formatBytes, formatCount } from "../lib/format";

/** True for a POSIX absolute path (`/…`) or a Windows drive path (`C:\…`/`C:/…`). */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
}

export function Roots() {
  const [roots, setRoots] = useState<RootInfo[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lastScan, setLastScan] = useState<ScanSummary | null>(null);

  const [newPath, setNewPath] = useState("");
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  // Guard setState against an unmount mid-await (react-hooks lint is off).
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const next = await listRoots();
      if (!aliveRef.current) return;
      setRoots(next);
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      // Only the very first load shows the full-screen loading state.
      if (aliveRef.current) setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function withRoot(id: string, action: () => Promise<unknown>) {
    setBusyId(id);
    setError(null);
    // Drop any stale scan banner before a non-scan action (pause/remove) so it
    // doesn't linger as if it described the new state.
    setLastScan(null);
    try {
      await action();
      await reload();
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setBusyId(null);
    }
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    const path = newPath.trim();
    if (!path) return;
    // TODO: replace this manual path field with a native folder picker (Tauri
    // dialog plugin) once wired up on the Rust side.
    if (!isAbsolutePath(path)) {
      setError("Enter an absolute folder path, e.g. /Users/you/code or C:\\Users\\you\\code.");
      return;
    }
    const name = newName.trim() || path.split(/[/\\]/).filter(Boolean).pop() || path;
    setAdding(true);
    setError(null);
    setLastScan(null);
    try {
      await addRoot(path, name);
      if (!aliveRef.current) return;
      setNewPath("");
      setNewName("");
      await reload();
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setAdding(false);
    }
  }

  function onScan(id: string) {
    setBusyId(id);
    setError(null);
    void (async () => {
      try {
        const summary = await scanRoot(id);
        if (!aliveRef.current) return;
        setLastScan(summary);
        await reload();
      } catch (e) {
        if (!aliveRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (aliveRef.current) setBusyId(null);
      }
    })();
  }

  function onTogglePause(root: RootInfo) {
    void withRoot(root.id, async () => {
      const updated = await setRootPaused(root.id, !root.paused);
      // Use the returned RootInfo for an immediate update; reload still follows.
      if (aliveRef.current) {
        setRoots((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
      }
    });
  }

  function onRemove(root: RootInfo) {
    if (!window.confirm(`Remove "${root.name}"? This stops syncing the folder.`)) return;
    void withRoot(root.id, () => removeRoot(root.id));
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

      <form className="card card-pad" onSubmit={onAdd}>
        <div className="inline-form">
          <label className="field" htmlFor="root-path">
            <span className="field-label">Folder path</span>
            <input
              id="root-path"
              type="text"
              className="mono"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="/Users/you/code"
            />
          </label>
          <label className="field" htmlFor="root-name">
            <span className="field-label">Name (optional)</span>
            <input
              id="root-name"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="code"
            />
          </label>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={adding || !newPath.trim()}
            aria-busy={adding}
          >
            {adding ? <span className="spinner" /> : null}
            <span>Add root</span>
          </button>
        </div>
      </form>

      {lastScan && (
        <div className="banner banner-success" role="status">
          Scanned {formatCount(lastScan.scanned)} entries:{" "}
          <strong>{formatCount(lastScan.included)}</strong> included,{" "}
          {formatCount(lastScan.ignored)} ignored, {formatBytes(lastScan.bytes)}.
        </div>
      )}

      {initialLoading ? (
        <p className="row-meta">
          <span className="spinner" /> <span>Loading roots…</span>
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
                onClick={() => onTogglePause(root)}
              >
                {root.paused ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={busyId === root.id}
                onClick={() => onRemove(root)}
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
