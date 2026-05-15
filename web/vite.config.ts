import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { writeFileSync } from "fs";
import { resolve } from "path";

const buildVersion = Date.now().toString(36);

export default defineConfig({
  resolve: {
    alias: {
      // three.js r183+ deprecated Clock; R3F v9 still uses it.
      // Swap in a warning-free drop-in until R3F v10.
      "three/src/core/Clock.js": resolve(__dirname, "src/lib/Clock.js"),
    },
  },
  plugins: [
    react(),
    {
      name: "version-file",
      writeBundle() {
        writeFileSync(
          resolve(__dirname, "../dist/web/version.json"),
          JSON.stringify({ version: buildVersion }),
        );
      },
    },
  ],
  define: {
    __BUILD_VERSION__: JSON.stringify(buildVersion),
  },
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
