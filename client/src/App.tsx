// SPDX-License-Identifier: AGPL-3.0-only

/**
 * App shell. Resolves auth state on mount, then routes between the onboarding
 * flow (not signed in / no device) and the main views (Roots, Status, Settings).
 *
 * Routing is intentionally a small piece of local state rather than a router
 * dependency — this is a four-view desktop app, not a website. When the UI runs
 * outside Tauri (e.g. `vite preview` or vitest) the commands surface a
 * `TauriUnavailableError`, which we render as a friendly "open the desktop app"
 * notice instead of crashing. A backend failure resolving auth is surfaced as a
 * dedicated error view with Retry, never collapsed into the logged-out path.
 */

import { useCallback, useEffect, useState } from "react";

import { authStatus, currentDevice, isTauri } from "./api/tauri";
import type { AuthStatus, DeviceInfo } from "./api/types";
import { Brand } from "./components/Brand";
import { Onboarding } from "./views/Onboarding";
import { Roots } from "./views/Roots";
import { Settings } from "./views/Settings";
import { Status } from "./views/Status";

type View = "roots" | "status" | "settings";

interface Session {
  auth: AuthStatus;
  device: DeviceInfo | null;
}

export function App() {
  const [loading, setLoading] = useState(true);
  const [outsideTauri, setOutsideTauri] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("roots");

  // `alive` lets an in-flight refresh skip setState after the component unmounts
  // (the react-hooks lint rule is intentionally off, so we manage this by hand).
  const refresh = useCallback(async (alive: () => boolean = () => true) => {
    if (!isTauri()) {
      if (!alive()) return;
      setOutsideTauri(true);
      setLoading(false);
      return;
    }
    if (alive()) {
      setLoading(true);
      setError(null);
    }
    try {
      const [auth, device] = await Promise.all([authStatus(), currentDevice()]);
      if (!alive()) return;
      setSession({ auth, device });
    } catch (e) {
      if (!alive()) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void refresh(() => alive);
    return () => {
      alive = false;
    };
  }, [refresh]);

  if (outsideTauri) {
    return (
      <div className="onboarding">
        <Brand />
        <p>
          This UI runs inside the Marrow desktop app. Launch it with the Tauri shell to sign in and
          sync.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="onboarding">
        <Brand />
        <p>
          <span className="spinner" /> <span>Loading…</span>
        </p>
      </div>
    );
  }

  // A backend error with no usable session: show it explicitly with a retry,
  // rather than silently dropping the user into onboarding.
  if (error && !session) {
    return (
      <div className="onboarding">
        <Brand />
        <div className="banner banner-error" role="alert">
          Couldn’t reach the Marrow backend: {error}
        </div>
        <button type="button" className="btn btn-primary" onClick={() => void refresh()}>
          Retry
        </button>
      </div>
    );
  }

  const signedIn = session?.auth.signedIn ?? false;
  const hasDevice = Boolean(session?.device);

  if (!signedIn || !hasDevice) {
    return (
      <Onboarding
        auth={session?.auth ?? { signedIn: false, user: null }}
        onChange={() => void refresh()}
      />
    );
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <Brand />
        <NavItem label="Roots" active={view === "roots"} onClick={() => setView("roots")} />
        <NavItem label="Status" active={view === "status"} onClick={() => setView("status")} />
        <div className="nav-spacer" />
        <NavItem
          label="Settings"
          active={view === "settings"}
          onClick={() => setView("settings")}
        />
      </nav>
      <main className="main">
        {view === "roots" && <Roots />}
        {view === "status" && <Status />}
        {view === "settings" && (
          <Settings
            user={session?.auth.user ?? null}
            device={session?.device ?? null}
            onSignOut={() => void refresh()}
          />
        )}
      </main>
    </div>
  );
}

function NavItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="nav-item"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
