import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { DesktopApiProvider } from "./api-context";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DesktopApiProvider>
      <App />
    </DesktopApiProvider>
  </React.StrictMode>,
);
