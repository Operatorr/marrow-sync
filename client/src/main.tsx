// SPDX-License-Identifier: AGPL-3.0-only

/**
 * React 19 entry point. Mounts {@link App} into `#root` using the concurrent
 * `createRoot` API. StrictMode is on to surface accidental side-effects early.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
