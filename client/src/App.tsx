// SPDX-License-Identifier: AGPL-3.0-only

/**
 * App shell. Resolves auth state on mount, then routes between the onboarding
 * flow (not signed in / no device) and the main views (Roots, Status, Settings).
 *
 * Routing is intentionally a small piece of local state rather than a router
 * dependency — this is a four-view desktop app, not a website. When the UI runs
 * outside Tauri (e.g. `vite preview` or vitest) the commands surface a
 * `TauriUnavailableError`, which we render as a friendly "open the desktop app"
 * notice instead of crashing.
 */

import { useCallback, useEffect, useState } from "react";

import { authStatus, currentDevice, isTauri } from "./api/tauri";
import type { AuthStatus, DeviceInfo } from "./api/types";
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
  const [view, setView] = useState<View>("roots");

  const refresh = useCallback(async () => {
    if (!isTauri()) {
      setOutsideTauri(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [auth, device] = await Promise.all([authStatus(), currentDevice()]);
      setSession({ auth, device });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (outsideTauri) {
    return (
      <div className="onboarding">
        <div className="brand">
          <span className="brand-dot" />
          Marrow
        </div>
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
        <div className="brand">
          <span className="brand-dot" />
          Marrow
        </div>
        <p>
          <span className="spinner" /> Loading…
        </p>
      </div>
    );
  }

  const signedIn = session?.auth.signedIn ?? false;
  const hasDevice = Boolean(session?.device);

  if (!signedIn || !hasDevice) {
    return (
      <Onboarding auth={session?.auth ?? { signedIn: false, user: null }} onChange={refresh} />
    );
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          Marrow
        </div>
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
            onSignOut={refresh}
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
