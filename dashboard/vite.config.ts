import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, /api and /mcp are proxied to a gateway port-forward on :8080.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/mcp": "http://localhost:8080",
    },
  },
});
