import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { writeFileSync } from "fs";
import { resolve } from "path";

const buildVersion = Date.now().toString(36);

export default defineConfig({
  plugins: [
    react(),
    {
      // three.js r183+ deprecated Clock; R3F v9 still uses it.
      // The pre-built bundle inlines Clock, so resolve.alias can't intercept it.
      // Strip the deprecation warn() from the bundled code until R3F v10.
      name: "fix-three-clock-deprecation",
      transform(code, id) {
        if (!id.includes("three")) return;
        const target =
          "warn( 'Clock: This module has been deprecated. Please use THREE.Timer instead.' ); // @deprecated, r183";
        if (!code.includes(target)) return;
        return code.replace(target, "");
      },
    },
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
