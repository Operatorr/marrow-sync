// SPDX-License-Identifier: AGPL-3.0-only

/**
 * React 19 entry point. Mounts {@link App} into `#root` using the concurrent
 * `createRoot` API. StrictMode is on to surface accidental side-effects early. A
 * top-level {@link ErrorBoundary} catches a render-time throw and shows a
 * fallback instead of a blank webview (there is no browser chrome to recover
 * with in the Tauri shell).
 */

import { Component, type ErrorInfo, type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { Brand } from "./components/Brand";
import "./styles.css";

interface ErrorBoundaryState {
  hasError: boolean;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface the crash in the devtools console for diagnosis; the UI itself
    // only shows the calm fallback below.
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="onboarding">
          <Brand />
          <div className="banner banner-error" role="alert">
            Something went wrong — restart Marrow.
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
