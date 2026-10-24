// What this build is (vite.config.ts defines them). Outside Vite (bun test)
// the constants don't exist, hence the typeof checks.

declare const __BUILD_VERSION__: string;
declare const __BUILD_COMMIT__: string;
declare const __BUILD_TIME__: string;

/** The commit's short hash (`-dirty.<time>` for uncommitted changes, `dev.<time>` without git). */
export const BUILD_VERSION: string = typeof __BUILD_VERSION__ === "string" ? __BUILD_VERSION__ : "test";
/** The full commit hash, "" when the build didn't know it. */
export const BUILD_COMMIT: string = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : "";
/** When it was built (ISO 8601). */
export const BUILD_TIME: string = typeof __BUILD_TIME__ === "string" ? __BUILD_TIME__ : "";
