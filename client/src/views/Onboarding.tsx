// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Onboarding (SPEC §10): sign in with GitHub, then register this installation as
 * a device. Two sequential steps — the GitHub step opens the system browser via
 * the Rust `sign_in_with_github` command (tauri-plugin-opener); the device step
 * registers and stores the long-lived device token in the OS keychain.
 *
 * Opening the browser is not the same as completing sign-in: the OAuth callback
 * is still a TODO on the Rust side. So after the browser opens we show a pending
 * state with a manual "I've signed in — refresh" action that re-checks auth,
 * rather than assuming success.
 */

import { type FormEvent, useEffect, useRef, useState } from "react";

import { registerDevice, signInWithGithub } from "../api/tauri";
import type { AuthStatus } from "../api/types";
import { Brand } from "../components/Brand";
import { defaultDeviceName, detectPlatform } from "../lib/platform";

export function Onboarding({ auth, onChange }: { auth: AuthStatus; onChange: () => void }) {
  const platform = detectPlatform();
  const [deviceName, setDeviceName] = useState(() => defaultDeviceName(platform));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [awaitingBrowser, setAwaitingBrowser] = useState(false);

  // Guard setState against an unmount mid-await (react-hooks lint is off).
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  async function run(action: () => Promise<unknown>, onSuccess: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (!aliveRef.current) return;
      onSuccess();
    } catch (e) {
      if (!aliveRef.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  function onSignIn() {
    // Browser-open succeeding only means the OAuth flow *started*; switch to a
    // pending state and let the user confirm completion (or re-check) manually.
    void run(signInWithGithub, () => setAwaitingBrowser(true));
  }

  function onRegister(e: FormEvent) {
    e.preventDefault();
    const name = deviceName.trim();
    if (!name) return;
    void run(() => registerDevice(name, platform), onChange);
  }

  return (
    <div className="onboarding">
      <Brand />
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
            {awaitingBrowser ? (
              <>
                <p className="field-hint">
                  Finish signing in in your browser… once you’ve authorized with GitHub, come back
                  and refresh.
                </p>
                <div className="pending-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={onChange}
                    disabled={busy}
                    aria-busy={busy}
                  >
                    {busy ? <span className="spinner" /> : null}
                    <span>I’ve signed in — refresh</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={onSignIn}
                    disabled={busy}
                  >
                    Open browser again
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="field-hint">
                  We’ll open your browser to authorize with GitHub, then hand you back to the app.
                </p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={onSignIn}
                  disabled={busy}
                  aria-busy={busy}
                >
                  {busy ? <span className="spinner" /> : null}
                  <span>Sign in with GitHub</span>
                </button>
              </>
            )}
          </>
        ) : (
          <form onSubmit={onRegister}>
            <div className="field-label">Step 2 — Register this device</div>
            <p className="field-hint" id="device-name-hint">
              Signed in as <strong>{auth.user?.name ?? "you"}</strong>. Give this machine a name so
              you can recognize it later.
            </p>
            <label className="field" htmlFor="device-name">
              <span className="field-label">Device name</span>
              <input
                id="device-name"
                type="text"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="Alex's MacBook"
                aria-describedby="device-name-hint"
                autoFocus
              />
            </label>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !deviceName.trim()}
              aria-busy={busy}
            >
              {busy ? <span className="spinner" /> : null}
              <span>Register device</span>
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
