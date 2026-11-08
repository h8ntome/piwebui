import { createRoot } from "react-dom/client";
import { App } from "./App";
import { setLinkPolicy } from "./lib/md";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/ui.css";
import "./styles/sidebar.css";
import "./styles/layout.css";
import "./styles/transcript.css";

setLinkPolicy();
document.documentElement.dataset.platform = navigator.platform?.toLowerCase().startsWith("mac") ? "darwin" : "linux";

createRoot(document.getElementById("root")!).render(
  <App />,
);