// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Status view: the overall sync state, a per-root breakdown, a manual sync
 * trigger, and the "why is this ignored?" explainer (SPEC §8) backed by the
 * `explain_ignore` command — a key trust feature for a tool touching source code.
 */

import { type FormEvent, useCallback, useEffect, useState } from "react";

import { explainIgnore, listRoots, syncStatus, triggerSync } from "../api/tauri";
import type { IgnoreDecision, RootInfo, SyncStatus } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { describeIgnore, formatCount, formatRelativeTime } from "../lib/format";

export function Status() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [roots, setRoots] = useState<RootInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const [s, r] = await Promise.all([syncStatus(), listRoots()]);
      setStatus(s);
      setRoots(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function onSyncAll() {
    setSyncing(true);
    setError(null);
    try {
      await triggerSync(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  }

  const rootName = (id: string) => roots.find((r) => r.id === id)?.name ?? id;

  return (
    <>
      <div className="view-header">
        <div>
          <h1>Status</h1>
          <p className="view-sub">
            {status ? (
              <>
                <StatusBadge state={status.state} /> · last sync{" "}
                {formatRelativeTime(status.lastSyncAt)}
              </>
            ) : (
              "Loading…"
            )}
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={onSyncAll} disabled={syncing}>
          {syncing ? <span className="spinner" /> : null} Sync now
        </button>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      <div className="stack">
        <div className="card">
          {(status?.roots ?? []).length === 0 ? (
            <div className="row">
              <div className="row-meta">No active roots.</div>
            </div>
          ) : (
            status?.roots.map((rs) => (
              <div className="row" key={rs.rootId}>
                <div className="row-main">
                  <div className="row-title">{rootName(rs.rootId)}</div>
                  <div className="row-meta">synced through seq {formatCount(rs.cursor)}</div>
                </div>
                <StatusBadge state={rs.status} />
              </div>
            ))
          )}
        </div>

        <IgnoreExplainer roots={roots} onExplain={explainIgnore} />
      </div>
    </>
  );
}

/** "Why is this ignored?" — resolves an ignore decision for a path in a root. */
function IgnoreExplainer({
  roots,
  onExplain,
}: {
  roots: RootInfo[];
  onExplain: (rootId: string, relPath: string) => Promise<IgnoreDecision>;
}) {
  const [rootId, setRootId] = useState("");
  const [relPath, setRelPath] = useState("");
  const [decision, setDecision] = useState<IgnoreDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!rootId && roots.length > 0) setRootId(roots[0]!.id);
  }, [roots, rootId]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const path = relPath.trim();
    if (!rootId || !path) return;
    setBusy(true);
    setError(null);
    setDecision(null);
    try {
      setDecision(await onExplain(rootId, path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: "16px" }}>
      <div className="field-label">Why is this ignored?</div>
      <p className="field-hint">
        Check whether a path syncs, and the exact rule responsible (SPEC §8).
      </p>
      <form onSubmit={onSubmit} className="inline-form" style={{ marginTop: "10px" }}>
        <label className="field" style={{ flex: "0 0 160px" }}>
          <span className="field-label">Root</span>
          <select
            value={rootId}
            onChange={(e) => setRootId(e.target.value)}
            style={{ width: "100%", padding: "8px 11px" }}
          >
            {roots.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Path (relative to root)</span>
          <input
            type="text"
            className="mono"
            value={relPath}
            onChange={(e) => setRelPath(e.target.value)}
            placeholder="dist/bundle.js"
          />
        </label>
        <button type="submit" className="btn" disabled={busy || !rootId || !relPath.trim()}>
          {busy ? <span className="spinner" /> : null} Explain
        </button>
      </form>

      {error && (
        <div className="banner banner-error" role="alert" style={{ marginTop: "12px" }}>
          {error}
        </div>
      )}

      {decision && (
        <div className={`explain-result ${decision.included ? "included" : "excluded"}`}>
          <div>
            <strong className="mono">{decision.path}</strong> —{" "}
            {decision.included ? "will sync" : "will not sync"}
          </div>
          <div className="row-meta" style={{ marginTop: "4px" }}>
            {describeIgnore(decision)}
          </div>
        </div>
      )}
    </div>
  );
}
