import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
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
      // The licence files go out with the app (/THIRD-PARTY-NOTICES.txt,
      // /LICENSE.txt, /NOTICE.txt, /TRADEMARKS.txt), and every npm package that ends up in the
      // bundle must be in the notices (scripts/third-party-notices.mjs lists
      // web/package.json's production tree; this catches what that misses).
      name: "third-party-notices",
      apply: "build",
      generateBundle(_options, bundle) {
        const read = (name: string) => {
          const path = resolve(__dirname, "..", name);
          if (!existsSync(path)) this.error(`${name} is missing (the Docker web stage must copy it next to web/)`);
          return readFileSync(path, "utf8");
        };
        const notices = read("THIRD-PARTY-NOTICES.txt");
        const npmSection = notices.split(/^3\. JAVASCRIPT PACKAGES.*$/m)[1]?.split(/^4\. /m)[0] ?? "";
        const listed = new Set([...npmSection.matchAll(/^ {2}(\S+)@[^@\s]+$/gm)].map((m) => m[1]));
        if (listed.size === 0) this.error("THIRD-PARTY-NOTICES.txt has no JavaScript package list");
        const bundled = new Set<string>();
        for (const out of Object.values(bundle)) {
          if (out.type !== "chunk") continue;
          for (const [id, mod] of Object.entries(out.modules)) {
            if (mod.renderedLength === 0) continue;
            const path = id.replace(/\\/g, "/");
            const at = path.lastIndexOf("/node_modules/");
            if (at < 0) continue;
            const parts = path.slice(at + "/node_modules/".length).split("/");
            bundled.add(parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
          }
        }
        const missing = [...bundled].filter((name) => !listed.has(name)).sort();
        if (missing.length) {
          this.error(
            `npm packages in the bundle but not in THIRD-PARTY-NOTICES.txt: ${missing.join(", ")}. ` +
              "Run node scripts/third-party-notices.mjs (and add them to web/package.json's dependencies if they are only devDependencies).",
          );
        }
        this.emitFile({ type: "asset", fileName: "THIRD-PARTY-NOTICES.txt", source: notices });
        this.emitFile({ type: "asset", fileName: "LICENSE.txt", source: read("LICENSE") });
        this.emitFile({ type: "asset", fileName: "NOTICE.txt", source: read("NOTICE") });
        this.emitFile({ type: "asset", fileName: "TRADEMARKS.txt", source: read("TRADEMARKS.md") });
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
