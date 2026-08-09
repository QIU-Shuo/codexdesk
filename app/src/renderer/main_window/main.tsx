import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { startThemeSync } from "./theme";
// Before `index.css`: the `@font-face` rules must be registered by the time
// the first rule that references `--font-sans` is applied. See fonts.css.
import "./fonts.css";
import "./index.css";
// After `index.css`: the file surface's rules override the base ones by order
// rather than by specificity. See fileview.css.
import "./fileview.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

// The main process only asks for `titleBarStyle: "hiddenInset"` on macOS
// (main/index.ts), so only there does the sidebar need to leave room for the
// traffic lights. Elsewhere the standard frame still occupies that space.
if (navigator.userAgent.includes("Mac OS X")) {
  document.documentElement.classList.add("mac-chrome");
}

// Before `render`: resolving the theme in an effect would paint one frame of
// the dark canvas on a light-themed machine. See `theme.ts`.
startThemeSync();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
