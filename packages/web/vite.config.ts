import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Em desenvolvimento (npm run dev -w @lt/web) a API continua no servidor do lt (127.0.0.1:4000).
const api = `http://127.0.0.1:${process.env.LT_PORT ?? 4000}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": api, "/metrics": api },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 1200 },
});
