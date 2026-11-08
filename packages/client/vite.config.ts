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
  build: { outDir: "dist", sourcemap: false },
});
