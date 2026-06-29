import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Resolve @termany/core straight to its TS source — no build step for the shared
// package during dev. Vite compiles the TS on the fly.
const coreSrc = fileURLToPath(new URL("../../packages/core/src", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@termany/core": coreSrc,
    },
  },
  server: {
    port: 5173,
    // Never silently hop to another port. 5174 is the PTY server — if Vite stole
    // it (because 5173 was busy), the terminal backend would collide and die.
    // Failing loudly here makes a stale instance obvious instead of cryptic.
    strictPort: true,
  },
});
