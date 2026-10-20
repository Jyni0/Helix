/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
  repository?: string | { url: string };
};
const git = (cmd: string) => {
  try {
    return execSync(`git ${cmd}`, { cwd: fileURLToPath(new URL(".", import.meta.url)), stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
};
// owner/name on GitHub: package.json "repository", else the origin remote.
const repoUrl = (typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url) || git("remote get-url origin");
const repo = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?\/?$/.exec(repoUrl)?.[1] ?? "";

const host = process.env.TAURI_DEV_HOST;

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // What "Check for Updates" compares against the latest GitHub release.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_SHA__: JSON.stringify(git("rev-parse HEAD")),
    __REPO__: JSON.stringify(repo),
  },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  clearScreen: false,
  server: {
    port: 1450,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1451 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 3000,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/tests/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
