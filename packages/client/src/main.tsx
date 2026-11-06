import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyTheme } from "./theme";
import { setLinkPolicy } from "./md";
import "./styles.css";

setLinkPolicy();
void applyTheme();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
