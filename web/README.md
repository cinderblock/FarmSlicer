# FarmSlicer web app

The browser side of FarmSlicer: React + TypeScript + Three.js, built with
Vite and Bun into `../dist/web`, which the server serves. The repository's
[README](../README.md) describes the app; [CLAUDE.md](../CLAUDE.md) maps
the code.

```sh
bun install
bun run dev      # Vite on :5173, proxying /api and /wasm to a server on :9337
bun run build    # → ../dist/web
bun test         # unit tests (test/, src/*.test.ts)
bun run lint
```

- `src/engine/`: the browser slicing engine (the WebAssembly build of
  libslic3r in `public/wasm/`, made by `../wasm/build.sh`).
- `public/`: served as-is: the service worker (`sw.js`), the manifest and
  the icons (rendered from `icons/` by `icons/render.sh`).
