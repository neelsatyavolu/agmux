// Must be first: rename xanom-* → agmux-* keys before any store loads state.
import "./lib/storageMigrateBootstrap";

import React from "react";
import ReactDOM from "react-dom/client";
import { StartupGate } from "./components/StartupGate";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ThemeProvider } from "./components/ThemeProvider";
import "./index.css";

// Prevent browser from navigating to dropped files outside valid drop zones
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <StartupGate />
      </ThemeProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
