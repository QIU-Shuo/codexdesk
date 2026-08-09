import type { CodexDeskApi } from "../../preload/index";

declare global {
  interface Window {
    codexDesk: CodexDeskApi;
  }
}

export {};
