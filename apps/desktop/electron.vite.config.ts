import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode, command }) => {
  // Self-host fork guard: production builds must declare their own
  // backend URLs via apps/desktop/.env.production.local (gitignored).
  // Upstream's runtime-config-loader handles the runtime case; this
  // guard is a belt-and-braces check at build time so a release artifact
  // can't ship without explicit self-host endpoints configured.
  if (command === "build" && mode === "production") {
    const env = loadEnv(mode, __dirname, "VITE_");
    const required = ["VITE_API_URL", "VITE_WS_URL", "VITE_APP_URL"];
    const missing = required.filter((k) => !(env[k] ?? "").trim());
    if (missing.length > 0) {
      throw new Error(
        [
          `desktop build refused: missing ${missing.join(", ")}.`,
          ``,
          `This is a self-hosting fork. Provide overrides in`,
          `apps/desktop/.env.production.local (gitignored):`,
          ``,
          `  VITE_API_URL=https://api.example.com`,
          `  VITE_WS_URL=wss://api.example.com/ws`,
          `  VITE_APP_URL=https://app.example.com`,
        ].join("\n"),
      );
    }
  }

  return {
    main: {
      plugins: [externalizeDepsPlugin()],
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
    },
    renderer: {
      server: {
        // Allow parallel worktrees to run `pnpm dev:desktop` side-by-side
        // (e.g. Multica Canary alongside a primary checkout) by overriding
        // the renderer port via env. Falls back to 5173 for the common case.
        port: Number(process.env.DESKTOP_RENDERER_PORT) || 5173,
        strictPort: true,
      },
      plugins: [react(), tailwindcss()],
      resolve: {
        alias: {
          "@": resolve("src/renderer/src"),
        },
        dedupe: ["react", "react-dom"],
      },
    },
  };
});
