# App updates: graceful reloads, saved work, "What's new"

## Goal

When a new build is deployed, open browser tabs pick it up without losing
anyone's work, and people learn what changed:

1. A **What's new** dialog: opens once after sign-in when there are entries
   the browser hasn't seen; a sidebar link reopens it. Entries are short and
   user-facing: the big changes, plus one "Bug fixes" line, never every
   small fix.
2. **Graceful reloads**: a new build no longer reloads the page at once.
   The page reloads only when that loses nothing (the tab is hidden, the
   person is idle, or they navigate), and work in progress on the Slice page
   is saved before and restored after.
3. **A meaningful build version**: the git commit instead of a timestamp, so
   an error report's version says which code it came from.

## Environment / context

- Version check: `web/src/main.tsx` `useAutoRefresh` (before this work):
  polls `/version.json` every 30 s, `window.location.reload()` on change.
- `web/vite.config.ts` writes `dist/web/version.json` and defines
  `__BUILD_VERSION__` (was `Date.now().toString(36)`).
- `BUILD_VERSION` travels in error reports and feedback
  (`web/src/errorReporting.ts`; server caps it at 64 chars,
  `feedback::MAX_VERSION`).
- The Docker build context excludes `.git` and `*.md` (`.dockerignore`), so
  the commit comes in as a build argument (`GIT_SHA`, CI passes
  `github.sha`), and the changelog lives in a `.ts` file, not Markdown.
- Slice page state lives in `web/src/pages/Slice.tsx`; the plate lives in
  `components/ModelViewer.tsx`, which can be loaded with
  `initial={{ key, files, plates }}` (the re-slice path).
- IndexedDB database `farmslicer` (v1 had the `models` store,
  `web/src/localModels.ts`).
- Dialogs use `.modal-backdrop` / `.modal` (FeedbackDialog etc.).

## Decisions already made (don't re-ask)

- "Seen" is remembered per browser in localStorage (user's call).
- The changelog is written by the agent from the commit history, simplified:
  big notes plus "Bug fixes" (user's call). New entries are added as
  user-facing work lands (CLAUDE.md says so).
- Shown to every signed-in account; entries older than the account are
  skipped, so a brand-new account isn't shown history.
- First visit with nothing recorded: show only the newest entry, not the
  whole history.
- The Slice page's draft is per tab (sessionStorage id → IndexedDB) and is
  restored whenever the page mounts in that tab, not only after an update
  (a manual refresh or leaving and coming back keeps the plate too). A new
  tab starts empty. `?from=<job>` wins over a draft made from another job.

## Design

### Version

`vite.config.ts`: commit = `GIT_SHA` env, else `git rev-parse HEAD`; dirty
tree adds `-dirty` + build time. `version.json` = `{ version, commit,
built }`; `__BUILD_VERSION__` = short sha (+ `-dirty.<time>`), plus
`__BUILD_COMMIT__`, `__BUILD_TIME__`. Same commit rebuilt → same version →
no needless reload.

### Reload policy (`web/src/appUpdate.ts`)

- Poll `/version.json` every 30 s and when the tab becomes visible.
- New version → `pending`. `decide()` (pure, unit-tested) reloads when
  nothing holds it, no dialog is open, and one of: the person navigated,
  the tab is hidden, or no input for `IDLE_RELOAD_MS`. Unsaved form edits
  (an `input`/`change` event outside a `[data-autosave]` region since the
  last navigation) block hidden/idle reloads but not navigation (navigating
  in the SPA drops the form anyway).
- Holds: `holdUpdate(reason)` → release function (`useUpdateHold(active,
  reason)`), e.g. while the Slice page is slicing.
- Savers: `beforeUpdate(fn)`; `reloadNow()` awaits them (bounded by a
  timeout) and then reloads.
- Otherwise a banner (`components/UpdateBanner.tsx`) offers "Reload now",
  warning when the page has unsaved edits.

### Slice draft (`web/src/sliceDraft.ts`)

Two records per tab id in the `drafts` store: `<id>:files` (Blobs; written
only when the model files change) and `<id>:state` (settings, plates,
last slice). Debounced save, flushed by the update saver and on `pagehide`.
Drafts untouched for 3 days are pruned on save.

### What's new

`web/src/data/changelog.ts` (entries newest first: `id` = date, `title`,
`highlights[]`, `fixes?`), `web/src/whatsNew.ts` (unseen entries, pure,
unit-tested), `components/WhatsNewDialog.tsx`, sidebar link in `Layout.tsx`.

## Plan / steps

1. [x] Plan doc.
2. [x] Version from git (vite config, Dockerfile ARG, CI build-arg).
3. [x] Shared IndexedDB module (v2: `models` + `drafts`).
4. [x] `appUpdate.ts` + banner, replace `useAutoRefresh`; tests.
5. [x] Slice draft save/restore + hold while slicing.
6. [x] Changelog data + What's new dialog + sidebar link; tests.
7. [x] Docs: CLAUDE.md (code map + "changelog line per user-facing
   change" convention), README (Updates).
8. [x] Checks: `bun run build`, `bun test` (all pass), lint (no new
   problems: 15 = HEAD's pre-existing ones); tried in a browser against a
   mock API (below).

## Findings / gotchas

- `toLocaleString` throws `TypeError: Invalid option` when `dateStyle` /
  `timeStyle` are combined with `timeZoneName`; spell the fields out.
- Navigation detection must not live in a component ref: a Layout that
  mounts again would take the next navigation for its first render.
  `appUpdate.notifyLocation` keeps the last `location.key` at module level.
- Only a change of path counts as navigation, not the query: the Slice
  page's slice history ("take its settings back") sets `?from=` in
  place, and reloading there would drop what the person asked for.
- The draft records the `?from=` job whose plate finished loading
  (`loadedFrom`), not `?from=` itself: a reload between the URL change and
  the job's plate arriving would otherwise restore the old plate as if it
  were that job's.
- A reload whose page still runs the old build (a cached or proxied stale
  index.html; reproduced by a mock announcing a version it doesn't serve)
  would reload again on every navigation. One reload per announced version
  (`farmslicer.reloadedFor` in sessionStorage); after that, the banner only.
- The "reloaded quietly" flag must be read on every load, not only when
  there are unseen entries, or a stale flag hides the next attended
  dialog.
- A changelog in `web/src/data/` would bust the server's Docker layer
  (the cargo stage copies that directory): it lives in `web/src/`.
- The T3 preview browser can't keep up with the Slice page's 3D view
  (HEAD's build too: evaluations time out); use Chrome for anything on
  `/slice`.
- How it was tried: `bun server.ts <dist>` (a mock of the API calls the
  pages make, `POST /__bump[?dist=]` switches the announced build) in
  `%LOCALAPPDATA%/Temp/fs-mock` (not in the repo). Verified: What's new
  first visit (newest only), full history, "Got it" remembered; banner on
  a new build; "Reload now" → new build, plate and settings restored,
  dialog with the unseen entries; navigation from a page that started on
  /slice loads the build (Chrome); hidden tab reloads quietly (dot, no
  dialog); stale build → no loop; manual F5 and leaving/returning to
  /slice restore the plate; a typed field turns the banner into the
  unsaved-changes warning and keeps the page.
- Not tried live: a hold during a real browser slice (no engine behind the
  mock); `decide` is unit-tested for it.

## Progress log

- [x] 2026-10-24: design written.
- [x] 2026-10-24: built, tested in a browser, docs updated, committed.

## Open questions for the user

- (none)

## Things not to do

- Don't reload while a browser slice runs: it kills the worker mid-slice
  and the job is left to time out.
- Don't put the changelog in a `.md` file: `.dockerignore` drops `*.md`.
- Don't count a typed search box as harmless: any field edit outside
  `[data-autosave]` keeps the page from reloading by itself. That errs
  on the safe side; narrowing it needs per-page knowledge of what's a
  filter.
