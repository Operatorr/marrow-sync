// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the Tauri invoke wrappers. We mock `@tauri-apps/api/core` so the
 * wrappers can be exercised in jsdom without a real Tauri bridge, and we assert
 * both the command name + argument mapping and the graceful degradation when the
 * bridge is absent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => invokeMock(cmd, args),
}));

import {
  addRoot,
  authStatus,
  currentDevice,
  explainIgnore,
  getSettings,
  isTauri,
  listRoots,
  registerDevice,
  removeRoot,
  scanRoot,
  setRootPaused,
  setSettings,
  signInWithGithub,
  signOut,
  syncStatus,
  TauriUnavailableError,
  triggerSync,
} from "./tauri";
import type { SyncStatus } from "./types";

/** Pretend the Tauri IPC bridge is present (or not) for a block of tests. */
function setBridge(present: boolean) {
  if (present) {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  } else {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  }
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  setBridge(false);
});

describe("isTauri", () => {
  it("reflects presence of the IPC bridge", () => {
    setBridge(false);
    expect(isTauri()).toBe(false);
    setBridge(true);
    expect(isTauri()).toBe(true);
  });
});

describe("wrappers without a bridge", () => {
  it("reject with TauriUnavailableError naming the command", async () => {
    setBridge(false);
    await expect(authStatus()).rejects.toBeInstanceOf(TauriUnavailableError);
    await expect(authStatus()).rejects.toThrow(/auth_status/);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("wrappers with a bridge", () => {
  beforeEach(() => setBridge(true));

  it("auth_status passes no args and returns the payload", async () => {
    const payload = { signedIn: true, user: null };
    invokeMock.mockResolvedValueOnce(payload);
    await expect(authStatus()).resolves.toEqual(payload);
    expect(invokeMock).toHaveBeenCalledWith("auth_status", undefined);
  });

  it("sign_in_with_github passes no args", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await signInWithGithub();
    expect(invokeMock).toHaveBeenCalledWith("sign_in_with_github", undefined);
  });

  it("sign_out passes no args", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await signOut();
    expect(invokeMock).toHaveBeenCalledWith("sign_out", undefined);
  });

  it("list_roots passes no args and returns the payload", async () => {
    const roots = [
      { id: "r1", name: "code", path: "/code", paused: false, fileCount: 3, status: "idle" },
    ];
    invokeMock.mockResolvedValueOnce(roots);
    await expect(listRoots()).resolves.toEqual(roots);
    expect(invokeMock).toHaveBeenCalledWith("list_roots", undefined);
  });

  it("remove_root maps the id arg", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await removeRoot("r1");
    expect(invokeMock).toHaveBeenCalledWith("remove_root", { id: "r1" });
  });

  it("scan_root maps the id arg and returns the summary", async () => {
    const summary = { rootId: "r1", scanned: 10, included: 8, ignored: 2, bytes: 1024 };
    invokeMock.mockResolvedValueOnce(summary);
    await expect(scanRoot("r1")).resolves.toEqual(summary);
    expect(invokeMock).toHaveBeenCalledWith("scan_root", { id: "r1" });
  });

  it("current_device passes no args and can return null", async () => {
    invokeMock.mockResolvedValueOnce(null);
    await expect(currentDevice()).resolves.toBeNull();
    expect(invokeMock).toHaveBeenCalledWith("current_device", undefined);
  });

  it("get_settings passes no args and returns the payload", async () => {
    const settings = { serverUrl: "https://x", autoSync: true };
    invokeMock.mockResolvedValueOnce(settings);
    await expect(getSettings()).resolves.toEqual(settings);
    expect(invokeMock).toHaveBeenCalledWith("get_settings", undefined);
  });

  it("normalizes a bare-string rejection (Rust CommandError) to an Error", async () => {
    invokeMock.mockRejectedValueOnce("sync not yet implemented");
    const rejection = await triggerSync(null).then(
      () => null,
      (e: unknown) => e,
    );
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("sync not yet implemented");
  });

  it("register_device maps name + platform args", async () => {
    invokeMock.mockResolvedValueOnce({ id: "d1", name: "Mac", platform: "macos" });
    await registerDevice("Mac", "macos");
    expect(invokeMock).toHaveBeenCalledWith("register_device", {
      name: "Mac",
      platform: "macos",
    });
  });

  it("add_root maps path + name args", async () => {
    invokeMock.mockResolvedValueOnce({
      id: "r1",
      name: "code",
      path: "/code",
      paused: false,
      fileCount: 0,
      status: "idle",
    });
    await addRoot("/code", "code");
    expect(invokeMock).toHaveBeenCalledWith("add_root", { path: "/code", name: "code" });
  });

  it("set_root_paused maps id + paused", async () => {
    invokeMock.mockResolvedValueOnce({
      id: "r1",
      name: "code",
      path: "/code",
      paused: true,
      fileCount: 0,
      status: "idle",
    });
    await setRootPaused("r1", true);
    expect(invokeMock).toHaveBeenCalledWith("set_root_paused", { id: "r1", paused: true });
  });

  it("explain_ignore maps rootId + relPath (camelCase boundary)", async () => {
    const decision = {
      path: "dist/app.js",
      included: false,
      reason: { kind: "gitignore", file: ".gitignore", pattern: "dist/", line: 2 },
    };
    invokeMock.mockResolvedValueOnce(decision);
    await expect(explainIgnore("r1", "dist/app.js")).resolves.toEqual(decision);
    expect(invokeMock).toHaveBeenCalledWith("explain_ignore", {
      rootId: "r1",
      relPath: "dist/app.js",
    });
  });

  it("sync_status returns the per-root wire shape (status + cursor, SPEC §7)", async () => {
    // The Rust `RootSyncState` serializes `{ rootId, status, cursor }`. Asserting
    // the exact wire shape here guards the boundary contract: the TS type and the
    // Status view must read `status`/`cursor`, not the prior `state`/`pending`.
    const payload: SyncStatus = {
      state: "idle",
      lastSyncAt: 1_700_000_000_000,
      roots: [{ rootId: "r1", status: "syncing", cursor: 42 }],
    };
    invokeMock.mockResolvedValueOnce(payload);
    const got = await syncStatus();
    expect(invokeMock).toHaveBeenCalledWith("sync_status", undefined);
    expect(got.roots[0]).toEqual({ rootId: "r1", status: "syncing", cursor: 42 });
    // Field names line up with no manual mapping.
    expect(got.roots[0]!.status).toBe("syncing");
    expect(got.roots[0]!.cursor).toBe(42);
  });

  it("trigger_sync passes a null rootId for a full sync", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await triggerSync(null);
    expect(invokeMock).toHaveBeenCalledWith("trigger_sync", { rootId: null });
  });

  it("set_settings wraps the settings object", async () => {
    const settings = { serverUrl: "https://x", autoSync: false };
    invokeMock.mockResolvedValueOnce(settings);
    await expect(setSettings(settings)).resolves.toEqual(settings);
    expect(invokeMock).toHaveBeenCalledWith("set_settings", { settings });
  });
});
