// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultDeviceName, detectPlatform } from "./platform";

/** Stub `navigator.userAgent`/`platform` for one detection call. */
function stubNavigator(userAgent: string, platform = "") {
  vi.stubGlobal("navigator", { userAgent, platform } as Navigator);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectPlatform", () => {
  it("detects macOS from a real Macintosh user agent", () => {
    stubNavigator(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
      "MacIntel",
    );
    expect(detectPlatform()).toBe("macos");
  });

  it("is not fooled by 'Darwin' containing the 'win' substring", () => {
    // The old loose `includes("win")` check matched "Darwin" and mislabelled it
    // Windows. Token matching must NOT classify a Darwin UA as Windows.
    stubNavigator("Darwin/24.0.0", "");
    expect(detectPlatform()).not.toBe("windows");
  });

  it("detects Windows", () => {
    stubNavigator("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32");
    expect(detectPlatform()).toBe("windows");
  });

  it("detects Linux", () => {
    stubNavigator("Mozilla/5.0 (X11; Linux x86_64)", "Linux x86_64");
    expect(detectPlatform()).toBe("linux");
  });

  it("falls back to linux for unknown platforms", () => {
    stubNavigator("SomeRandomAgent/1.0", "FreeBSD");
    expect(detectPlatform()).toBe("linux");
  });
});

describe("defaultDeviceName", () => {
  it("renders a friendly per-platform name", () => {
    expect(defaultDeviceName("macos")).toBe("Marrow on macOS");
    expect(defaultDeviceName("windows")).toBe("Marrow on Windows");
    expect(defaultDeviceName("linux")).toBe("Marrow on Linux");
  });
});
