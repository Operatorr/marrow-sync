// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Status view: the overall sync state, a per-root breakdown, a manual sync
 * trigger, and the "why is this ignored?" explainer (SPEC §8) backed by the
 * `explain_ignore` command — a key trust feature for a tool touching source code.
 *
 * The view polls `sync_status` on an interval so progress is visible while a sync
 * runs. `trigger_sync` may reject ("sync not yet implemented") and a per-root
 * cursor may legitimately be 0 until a sync has actually run — both are handled
 * gracefully here.
 */

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { explainIgnore, listRoots, syncStatus, triggerSync } from "../api/tauri";
import type { IgnoreDecision, RootInfo, SyncStatus } from "../api/types";
import { StatusBadge } from "../components/StatusBadge";
import { describeIgnore, formatCount, formatRelativeTime } from "../lib/format";

/** How often (ms) to re-poll sync status while the view is mounted. */
const POLL_MS = 4000;

export function Status() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [roots, setRoots] = useState<RootInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  // Guards: skip setState after unmount, and don't let polled reloads overlap.
  const aliveRef = useRef(true);
  const inFlightRef = useRef(false);

  const reload = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const [s, r] = await Promise.all([syncStatus(), listRoots()]);
      if (!aliveRef.current) return;
      setStatus(s);
      setRoots(r);
      setError(null);
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void reload();
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
    };
  }, [reload]);

  async function onSyncAll() {
    setSyncing(true);
    setError(null);
    try {
      await triggerSync(null);
      await reload();
    } catch (e) {
      // The backend may report "sync not yet implemented" — surface it plainly.
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setSyncing(false);
    }
  }

  // O(1) name lookup by id rather than a `find` per row.
  const rootNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of roots) map.set(r.id, r.name);
    return map;
  }, [roots]);
  const rootName = (id: string) => rootNames.get(id) ?? id;

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
          {syncing ? <span className="spinner" /> : null}
          <span>Sync now</span>
        </button>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      <div className="stack">
        <div className="card">
          {status === null ? (
            <div className="row">
              <div className="row-meta">
                <span className="spinner" /> <span>Loading status…</span>
              </div>
            </div>
          ) : status.roots.length === 0 ? (
            <div className="row">
              <div className="row-meta">No active roots.</div>
            </div>
          ) : (
            status.roots.map((rs) => (
              <div className="row" key={rs.rootId}>
                <div className="row-main">
                  <div className="row-title">{rootName(rs.rootId)}</div>
                  <div className="row-meta">
                    {rs.cursor > 0 ? (
                      <>synced through seq {formatCount(rs.cursor)}</>
                    ) : (
                      <>not yet synced (—)</>
                    )}
                  </div>
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

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Keep the selected root valid: default to the first, and reset if the current
  // selection was removed from the list.
  useEffect(() => {
    const exists = roots.some((r) => r.id === rootId);
    if (!exists) setRootId(roots[0]?.id ?? "");
  }, [roots, rootId]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const path = relPath.trim();
    if (!rootId || !path) return;
    setBusy(true);
    setError(null);
    setDecision(null);
    try {
      const result = await onExplain(rootId, path);
      if (!aliveRef.current) return;
      setDecision(result);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  return (
    <div className="card card-pad">
      <div className="field-label">Why is this ignored?</div>
      <p className="field-hint">
        Check whether a path syncs, and the exact rule responsible (SPEC §8).
      </p>
      <form onSubmit={onSubmit} className="inline-form" style={{ marginTop: "10px" }}>
        <label className="field" htmlFor="explain-root" style={{ flex: "0 0 160px" }}>
          <span className="field-label">Root</span>
          <select
            id="explain-root"
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
        <label className="field" htmlFor="explain-path">
          <span className="field-label">Path (relative to root)</span>
          <input
            id="explain-path"
            type="text"
            className="mono"
            value={relPath}
            onChange={(e) => setRelPath(e.target.value)}
            placeholder="dist/bundle.js"
          />
        </label>
        <button type="submit" className="btn" disabled={busy || !rootId || !relPath.trim()}>
          {busy ? <span className="spinner" /> : null}
          <span>Explain</span>
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
