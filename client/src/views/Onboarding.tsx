// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Onboarding (SPEC §10): sign in with GitHub, then register this installation as
 * a device. Two sequential steps — the GitHub step opens the system browser via
 * the Rust `sign_in_with_github` command (tauri-plugin-opener); the device step
 * registers and stores the long-lived device token in the OS keychain.
 */

import { type FormEvent, useState } from "react";

import { registerDevice, signInWithGithub } from "../api/tauri";
import type { AuthStatus } from "../api/types";
import { defaultDeviceName, detectPlatform } from "../lib/platform";

export function Onboarding({ auth, onChange }: { auth: AuthStatus; onChange: () => void }) {
  const platform = detectPlatform();
  const [deviceName, setDeviceName] = useState(() => defaultDeviceName(platform));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function onSignIn() {
    void run(signInWithGithub);
  }

  function onRegister(e: FormEvent) {
    e.preventDefault();
    const name = deviceName.trim();
    if (!name) return;
    void run(() => registerDevice(name, platform));
  }

  return (
    <div className="onboarding">
      <div className="brand">
        <span className="brand-dot" />
        Marrow
      </div>
      <p>Sync your code folders across every machine, with developer-native ignore rules.</p>

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      <div className="card">
        {!auth.signedIn ? (
          <>
            <div className="field-label">Step 1 — Sign in</div>
            <p className="field-hint">
              We&rsquo;ll open your browser to authorize with GitHub, then hand you back to the app.
            </p>
            <button type="button" className="btn btn-primary" onClick={onSignIn} disabled={busy}>
              {busy ? <span className="spinner" /> : null} Sign in with GitHub
            </button>
          </>
        ) : (
          <form onSubmit={onRegister}>
            <div className="field-label">Step 2 — Register this device</div>
            <p className="field-hint">
              Signed in as <strong>{auth.user?.name ?? auth.user?.email ?? "you"}</strong>. Give
              this machine a name so you can revoke it later.
            </p>
            <label className="field">
              <span className="field-label">Device name</span>
              <input
                type="text"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="Alex&rsquo;s MacBook"
                autoFocus
              />
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy || !deviceName.trim()}>
              {busy ? <span className="spinner" /> : null} Register device
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
