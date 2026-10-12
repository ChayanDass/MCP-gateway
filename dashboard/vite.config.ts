import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Hot-reload dev server for the dashboard. Open http://localhost:5173 and every
// save updates the page without a reload. API calls go to the gateway in the
// cluster (the ingress on localhost:8080). changeOrigin sends Host: localhost,
// which is the host the ingress routes to the gateway.
const gateway = "http://localhost:8080";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: gateway, changeOrigin: true },
      "/mcp": { target: gateway, changeOrigin: true },
      "/healthz": { target: gateway, changeOrigin: true },
    },
  },
});
