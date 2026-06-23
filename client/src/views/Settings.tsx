// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Settings view: the server URL the RPC client targets (SPEC §5), the auto-sync
 * toggle, the current device (the unit of auth — SPEC §10), and sign-out.
 */

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { getSettings, setSettings, signOut } from "../api/tauri";
import type { DeviceInfo, Settings as SettingsShape, UserInfo } from "../api/types";
import { platformLabel } from "../lib/format";
import { normalizeServerUrl } from "../lib/serverUrl";

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
  const [urlError, setUrlError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

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
      const s = await getSettings();
      if (!aliveRef.current) return;
      setSettingsState(s);
      setServerUrl(s.serverUrl);
      setAutoSync(s.autoSync);
    } catch (e) {
      if (!aliveRef.current) return;
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

    // Validate the URL before sending the device token anywhere (same rule as
    // api/client.ts so the form and the RPC client never disagree).
    let cleaned: string;
    try {
      cleaned = normalizeServerUrl(serverUrl);
    } catch (err) {
      setUrlError(err instanceof Error ? err.message : String(err));
      return;
    }
    setUrlError(null);

    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // Spread existing settings so a field added in the future isn't dropped.
      const next = await setSettings({ ...settings, serverUrl: cleaned, autoSync });
      if (!aliveRef.current) return;
      setSettingsState(next);
      setServerUrl(next.serverUrl);
      setAutoSync(next.autoSync);
      setSaved(true);
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setSaving(false);
    }
  }

  function handleSignOut() {
    void (async () => {
      setError(null);
      setSigningOut(true);
      try {
        await signOut();
        if (!aliveRef.current) return;
        onSignOut();
      } catch (e) {
        if (!aliveRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (aliveRef.current) setSigningOut(false);
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
        <div className="banner banner-success" role="status">
          Settings saved.
        </div>
      )}

      <form className="card card-pad-lg" onSubmit={onSave}>
        <label className="field" htmlFor="server-url">
          <span className="field-label">Server URL</span>
          <input
            id="server-url"
            type="url"
            className="mono"
            value={serverUrl}
            aria-invalid={urlError ? true : undefined}
            aria-describedby={urlError ? "server-url-error" : undefined}
            onChange={(e) => {
              setServerUrl(e.target.value);
              setSaved(false);
              setUrlError(null);
            }}
            placeholder="https://api.marrow.dev"
          />
          {urlError ? (
            <p className="field-error" id="server-url-error" role="alert">
              {urlError}
            </p>
          ) : (
            <p className="field-hint">
              The Marrow server this client talks to. Self-hosters point this at their own Worker.
            </p>
          )}
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

        <button
          type="submit"
          className="btn btn-primary"
          disabled={!dirty || saving}
          aria-busy={saving}
        >
          {saving ? <span className="spinner" /> : null}
          <span>Save changes</span>
        </button>
      </form>

      <div className="card card-pad-lg">
        <div className="field-label">Account &amp; device</div>
        <div className="row" style={{ padding: "10px 0" }}>
          <div className="row-main">
            <div className="row-title">{user?.name ?? "Signed in"}</div>
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
        <p className="field-hint" style={{ marginTop: "10px" }}>
          Signing out clears this device’s token on this machine. Managing or revoking devices from
          here is coming soon.
        </p>
        <button
          type="button"
          className="btn btn-danger"
          style={{ marginTop: "14px" }}
          onClick={handleSignOut}
          disabled={signingOut}
          aria-busy={signingOut}
        >
          {signingOut ? <span className="spinner" /> : null}
          <span>Sign out</span>
        </button>
      </div>
    </>
  );
}
