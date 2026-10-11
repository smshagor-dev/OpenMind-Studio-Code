/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: [
      // y-monaco imports Monaco by its pre-0.50 path; monaco-editor's package exports now map every "*.js" subpath under
      // esm/vs, so that path no longer resolves. Point it at the same entry the app imports (one Monaco instance).
      { find: /^monaco-editor\/esm\/vs\/editor\/editor\.api(\.js)?$/, replacement: "monaco-editor" },
    ],
  },

  // Vite runs from this directory (repo root); the Tauri window loads
  // `../dist` per src-tauri/tauri.conf.json's frontendDist.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },

  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // Through Vite (not Node) so the Monaco alias above applies to it in tests too.
    server: { deps: { inline: ["y-monaco"] } },
  },
});
