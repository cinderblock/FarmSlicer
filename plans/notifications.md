# Notifications: Web Push when prints fail (and more)

`plans/notifications.md`

## Goal

When a print fails, the people it matters to hear about it on their phone or
computer, even with FarmSlicer closed: the person who sent it, whoever made
the job, and (if they want) the printer's operators. Asked by the maintainer
on 2026-10-26, together with making FarmSlicer an installable app (PWA).

## Environment / context

- Production is HTTPS (`farm.example.com` behind the ops Caddy), which Web Push
  needs (secure context). Pushes go *out* from the server to the browser's
  push service (FCM, Mozilla autopush, Apple), so no proxy change is needed.
- iOS/iPadOS (16.4+) only delivers Web Push to an app added to the home
  screen, and only asks for permission from a tap.
- Every event already goes through `events::emit` (src/events.rs), which
  feeds webhooks; notifications are a second consumer there.
- OpenSSL is already linked (vendored, for webauthn-rs) and gives EC P-256
  keys, ECDH, ECDSA and AES-128-GCM; HKDF is two HMAC-SHA256 calls with
  `webhooks::hmac_sha256`. No new crypto crate.

## Decisions already made (don't re-ask)

- **Who hears about a print** (maintainer, 2026-10-26): its sender *and*
  whoever made the job ("both even"), and the operators of the printer's
  pools ("print managers"), each person choosing per event.
- **Defaults** are mine to choose ("I trust your judgment; we can fix issues
  later"): failed/stopped on for own prints and operated printers; approval
  requests on for those who can approve; finished off.
- **Install (PWA) and notifications are separate pieces of work**; the PWA part
  (manifest, icons, a non-caching service worker) was delegated to a
  sub-agent in the same tree. The service worker must never cache pages:
  `web/src/appUpdate.ts` needs index.html fresh from the network.
- **No configured secrets**: the VAPID key pair is made on first use and kept
  in the `settings` table (`vapid_key`, PKCS#8 PEM), like everything else.

## Design

- Storage (`src/db/notifications.rs`): `push_subscriptions` (id, user_id,
  endpoint UNIQUE, p256dh, auth, user agent label, created/last_success),
  and `users.notify_prefs` (JSON, NULL = defaults).
- Preferences: per event (`print.failed`, `print.finished`,
  `print.approval_requested`) a set of relations (`mine`: sent it or made the
  job; `operated`: a printer of one of your pools; `managed`: a group you
  manage; `all`: admins, every print).
- Who gets a push (`notifications::recipients`, pure parts unit-tested): only
  accounts that have a subscription; per account, its relations to the print
  and its preferences. Approval requests go only to people who can approve
  (`prints_api::can_approve_print`).
- Delivery (`src/notifications.rs`): RFC 8291 `aes128gcm` encryption, RFC 8292
  VAPID (ES256 JWT, `vapid t=..., k=...`), TTL, Urgency high for failures;
  404/410 delete the subscription. Fire-and-forget task per push (no retry
  queue: a stale "print failed" an hour later is noise). RFC 8291's example
  is a unit test.
- Payload: `{title, body, url, tag}`; the service worker shows it and opens
  `url` when tapped (`tag` = the print, so a later push replaces an earlier one).
- API: `GET /api/notifications/key`, `GET/PUT /api/me/notifications` (prefs,
  this account's devices), `POST /api/me/notifications/subscriptions`,
  `DELETE /api/me/notifications/subscriptions/{id}`, `POST
  /api/me/notifications/test`.
- UI: Account page, "Notifications" section: turn on for this device, the
  event × relation checkboxes, the device list, a test button.

## Progress log

- [x] Questions answered (2026-10-26)
- [x] PWA: manifest, icons, `sw.js`, registration (sub-agent, `4a1a910`)
- [x] Server: storage, crypto + tests, recipients, events hook, API
- [x] Service worker push, notificationclick, pushsubscriptionchange
- [x] Account page UI, changelog, README/CLAUDE.md
- [x] Unit tests (9, incl. RFC 8291's example and RFC 5869) + full unit
      suite (178) + every e2e suite (21, incl. `tests/notifications-e2e.mjs`)
      on buildhost, 2026-10-26
- [x] UI checked in Chrome against a stub server (desktop and 360 px)
- [x] Commit
- [ ] Deploy (CI image, ops pin): the maintainer's call
- [ ] First real notification on a real phone after deploy (Android Chrome,
      and iOS from the Home Screen); nobody has granted the permission
      prompt and received a push from FCM/Apple yet

## Findings / gotchas

- The e2e's fake push service decrypts with Node's crypto and verifies
  the VAPID JWT, so encryption and signing were checked by a second
  implementation, not only against our own code.
- Against the real FCM (from buildhost): a made-up endpoint token is
  answered as gone and the device is forgotten, so the TLS client, the
  request shape and the 404/410 handling work against Google. A real
  subscription needs a person to click Allow on the permission prompt,
  which browser automation can't do.
- `FARMSLICER_NO_AUTH`'s `dev` user isn't in `users`, so its subscriptions
  would break the foreign key: subscribing answers 409 there.
- A tap on a notification must not reload an open window (it could be
  slicing in the browser): sw.js posts `farmslicer.open` and the app
  routes itself (`Layout` + `serviceWorker.ts` `onOpenRequest`).
- The app's icon is still Vite's default logo (`favicon.svg`); installed
  apps make that visible. Replace the SVG and re-render the PNGs (CLAUDE.md).

## Open questions for the user

1. Replace the placeholder (Vite) logo before people install the app?
2. Deploy now? (Push, then the ops digest pin, per usual.)

## Things not to do

- Don't give the service worker a fetch handler or a cache (see above).
- Don't route pushes through Caddy/Cloudflare or add infra: none needed.
