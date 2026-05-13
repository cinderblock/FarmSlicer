import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:9337",
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
