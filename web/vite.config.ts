import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { resolve } from "path";

/** Run git in the repo; "" when there is no git (the Docker build context has no .git). */
function git(args: string): string {
  try {
    return execSync(`git ${args}`, { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

// The build's version is the commit it was built from (GIT_SHA from CI's
// Docker build, else the checkout's HEAD), so a rebuild of the same commit
// doesn't make open tabs reload, and an error report's version names its
// code. Uncommitted changes, or no commit at all, add the build time.
const builtAt = new Date();
const commit = process.env.GIT_SHA || git("rev-parse HEAD");
const dirty = !process.env.GIT_SHA && commit !== "" && git("status --porcelain --untracked-files=no") !== "";
const stamp = builtAt.getTime().toString(36);
const buildVersion = commit ? `${commit.slice(0, 7)}${dirty ? `-dirty.${stamp}` : ""}` : `dev.${stamp}`;

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
          JSON.stringify({ version: buildVersion, commit, built: builtAt.toISOString() }),
        );
      },
    },
  ],
  define: {
    __BUILD_VERSION__: JSON.stringify(buildVersion),
    __BUILD_COMMIT__: JSON.stringify(commit),
    __BUILD_TIME__: JSON.stringify(builtAt.toISOString()),
  },
  server: {
    proxy: {
      "/api": "http://localhost:9337",
      "/wasm": "http://localhost:9337",
    },
    // Same cross-origin isolation the Rust server sends, so the multithreaded
    // WebAssembly engine (SharedArrayBuffer) also works under `vite dev`.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
