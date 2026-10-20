import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { isTauri, setApi } from "./lib/api";
import { createMockBackend } from "./lib/mockBackend";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "./index.css";

// Browser preview: `?demo` starts with sample connections over an in-memory shop database.
if (!isTauri() && new URLSearchParams(location.search).has("demo")) {
  setApi(createMockBackend({ latencyMs: 60, demo: true }));
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
