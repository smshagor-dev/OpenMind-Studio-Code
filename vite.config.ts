/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react()],

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
  },
});
