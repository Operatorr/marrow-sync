// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Settings view: the server URL the RPC client targets (SPEC §5), the auto-sync
 * toggle, the current device (the unit of auth — SPEC §10), and sign-out.
 */

import { type FormEvent, useCallback, useEffect, useState } from "react";

import { getSettings, setSettings, signOut } from "../api/tauri";
import type { DeviceInfo, Settings as SettingsShape, UserInfo } from "../api/types";
import { platformLabel } from "../lib/format";

export function Settings({
  user,
  device,
  onSignOut,
}: {
  user: UserInfo | null;
  device: DeviceInfo | null;
  onSignOut: () => void;
}) {
  const [settings, setSettingsState] = useState<SettingsShape | null>(null);
  const [serverUrl, setServerUrl] = useState("");
  const [autoSync, setAutoSync] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const s = await getSettings();
      setSettingsState(s);
      setServerUrl(s.serverUrl);
      setAutoSync(s.autoSync);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const dirty =
    settings !== null && (serverUrl !== settings.serverUrl || autoSync !== settings.autoSync);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const next = await setSettings({ serverUrl: serverUrl.trim(), autoSync });
      setSettingsState(next);
      setServerUrl(next.serverUrl);
      setAutoSync(next.autoSync);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function handleSignOut() {
    void (async () => {
      setError(null);
      try {
        await signOut();
        onSignOut();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }

  return (
    <>
      <div className="view-header">
        <div>
          <h1>Settings</h1>
          <p className="view-sub">Server connection, sync behavior, and this device.</p>
        </div>
      </div>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}
      {saved && !dirty && (
        <div className="banner banner-warn" role="status">
          Settings saved.
        </div>
      )}

      <form className="card" onSubmit={onSave} style={{ padding: "18px" }}>
        <label className="field">
          <span className="field-label">Server URL</span>
          <input
            type="url"
            className="mono"
            value={serverUrl}
            onChange={(e) => {
              setServerUrl(e.target.value);
              setSaved(false);
            }}
            placeholder="https://api.marrow.dev"
          />
          <p className="field-hint">
            The Marrow server this client talks to. Self-hosters point this at their own Worker.
          </p>
        </label>

        <label className="field toggle">
          <input
            type="checkbox"
            checked={autoSync}
            onChange={(e) => {
              setAutoSync(e.target.checked);
              setSaved(false);
            }}
          />
          <span>
            <span className="field-label" style={{ marginBottom: 0 }}>
              Automatic sync
            </span>
            <span className="field-hint">Sync on file changes and on an interval.</span>
          </span>
        </label>

        <button type="submit" className="btn btn-primary" disabled={!dirty || saving}>
          {saving ? <span className="spinner" /> : null} Save changes
        </button>
      </form>

      <div className="card" style={{ padding: "18px" }}>
        <div className="field-label">Account &amp; device</div>
        <div className="row" style={{ padding: "10px 0" }}>
          <div className="row-main">
            <div className="row-title">{user?.name ?? user?.email ?? "Signed in"}</div>
            {user?.email && <div className="row-meta">{user.email}</div>}
          </div>
        </div>
        {device && (
          <div className="row" style={{ padding: "10px 0", borderTop: "1px solid var(--border)" }}>
            <div className="row-main">
              <div className="row-title">{device.name}</div>
              <div className="row-meta">
                {platformLabel(device.platform)} · <span className="mono">{device.id}</span>
              </div>
            </div>
          </div>
        )}
        <button
          type="button"
          className="btn btn-danger"
          style={{ marginTop: "14px" }}
          onClick={handleSignOut}
        >
          Sign out
        </button>
      </div>
    </>
  );
}
