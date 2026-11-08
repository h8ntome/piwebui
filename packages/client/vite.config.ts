import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    proxy: {
      "/api": {
        target: process.env.PIWEB_BACKEND ?? "http://127.0.0.1:4319",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split the heavy libraries out of the single 550 KB bundle: the shell can boot and
        // paint while the markdown/highlight stack arrives as its own cached chunk (PERF-02).
        // highlight.js itself is loaded from lib/md.ts with a dynamic import on first use.
        manualChunks: {
          react: ["react", "react-dom"],
          markdown: ["marked", "dompurify"],
        },
      },
    },
  },
});
