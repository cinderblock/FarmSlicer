# Trademark clearance search: "FarmSlicer"

`plans/trademark-search.md`

> **Not legal advice.** This is a free, do-it-yourself knockout search done
> by an AI assistant from public databases on 2026-10-26. It can miss things:
> US state registrations, applications too new to be indexed, marks in other
> scripts or languages, and common-law use that never reached the web. A
> trademark attorney's clearance opinion is the step to take before relying
> on it for a filing or a large brand investment.

## Goal

Find out, for free, whether anything stands in the way of using (and later
registering) FARMSLICER for open-source slicing and print-farm software and
the support and cloud hosting sold around it. Asked by the maintainer
2026-10-26. Context: `plans/naming.md` (the name was kept) and the
"Decisions" section of `plans/monetization-and-licensing.md`.

## Decisions already made (don't re-ask)

- **No filing until there is revenue** (~$700 for two classes isn't worth it
  yet). Free steps to build common-law rights are wanted meanwhile.
- **Keep the name FarmSlicer** (`plans/naming.md`).
- Research only: no paid services, no accounts, no filings.

## Method

Searched 2026-10-26, roughly 3–5 PM PDT (22:00–00:00Z).

1. **USPTO** (tmsearch.uspto.gov, the official search system, which covers
   live and dead federal applications and registrations). Queried its search
   API from the page with Elasticsearch `query_string` queries, so wildcards
   worked across every class:
   - exact: `farmslicer`, `"farm slicer"` (word mark and pseudo-mark fields);
   - near: `farmslic*`, `farmslice*`, `"farm slice(s)"`, `"slicer farm"`,
     `slicerfarm*`, `"slice farm"`, `farm* AND slic*`;
   - sound/spelling variants: `formslic*`, `firmslic*`, `farmslyc*`,
     `pharmslic*`, `fermslic*`, `"form slicer"`, `"fleet slicer"`,
     `slicefleet*`;
   - the field: `*slicer*` in classes 9, 40, and 42 (all 42 hits reviewed),
     `*slic*` with goods mentioning printing/3D, `*farm*` with goods
     mentioning printing in classes 9, 40, and 42;
   - neighbours: `slic3r*`, `octofarm*`, `"print farm"`, `printfarm*`,
     `"farm print"`, `farmprint*`, `"farm manager"`, `simplyprint*`,
     `printago*`, `octoprint*`, `autofarm*`, `printerhive*`,
     `"fdm monster"`, `prusaslicer*`, `"bambu studio"`, `superslicer*`,
     `orcaslicer`, `3dprinteros`, `farm3d`.
   Status details for the relevant hits were confirmed on TSDR
   (tsdr.uspto.gov).
2. **EUIPO** (eSearch plus). Queried its search endpoint directly for the
   verbal element (CONTAINS): `farmslicer`, `farm slicer`, `farmslice`,
   `farm slice`, `slicer farm`, `slicerfarm`, `slic3r`, `orcaslicer`,
   `orca slicer`, `octofarm`, `print farm`, `printfarm`, and `slicer` (43
   hits, those in classes 9, 40, and 42 reviewed). Gotcha: changing the
   search term in the page's URL re-runs the *previous* term from the
   search box, so only the first URL search and the direct queries count.
3. **WIPO Global Brand Database** (77 million records from 89 offices,
   including national offices, Madrid, the EUIPO, and the USPTO): brand name
   `farmslicer` with the Embedded, Fuzzy, and Phonetic strategies, and
   `slic3r` Embedded. TMview (tmdn.org) couldn't be used: the browser
   extension isn't allowed on that site and its API refused scripted
   requests; the Global Brand Database covers the same offices.
4. **Common law** (unregistered use): web search for `"FarmSlicer"` and
   `"farm slicer" 3D printing software`; GitHub repository, user, org, and
   code search; npm, crates.io, PyPI, and Docker Hub (names and search);
   Apple App Store search API; YouTube, Mastodon (mastodon.social), and
   Bluesky handles; domain registrations by RDAP (registry data).

## Results

### No conflicting mark

- **USPTO: zero hits** for FARMSLICER, FARM SLICER, FARM SLICE(S),
  SLICER FARM, or any mark containing both FARM and SLIC in a related class.
  The two FARM + SLICE marks are for cheese (FARMSTYLE SLICES) and vacation
  rentals.
- **EUIPO: zero hits** for every FARMSLICER variant, SLIC3R, OCTOFARM, and
  PRINT FARM.
- **WIPO: zero hits** containing FARMSLICER. The only phonetic match is
  "FarmSlice Agro FruitMunch" (India, class 29, food). Fuzzy matches
  (71) are led by FARMALIDER (pharmacy, Chile/Spain), FARMLINER
  (machinery), and FARMspider (Korea, classes 9/42, Hancom Frontis); the
  most similar results are already far from FARMSLICER.
- **Common law: no other user found.** Web results for "FarmSlicer" are
  only farm machinery (Fendt "Slicer" mowers, bale and silage slicers);
  "farm slicer" in 3D printing returns articles about print-farm slicing
  (Printago, SimplyPrint), not a product. GitHub has only this project's
  repos (`cinderblock/FarmSlicer`, `cinderblock/farmslicer.com`); no
  `farmslicer` user or org. npm, crates.io, PyPI, Docker Hub: unused. No
  App Store app. YouTube `@farmslicer`, `farmslicer@mastodon.social`, and
  `farmslicer.bsky.social`: free (Instagram, X, and Reddit couldn't be
  checked without signing in).

### Every relevant hit

Status as of 2026-10-26. "Reg." = registration number, "SN" = US serial
number. Risk is to *using* FarmSlicer for slicing and print-farm software,
support, and hosting.

| Mark | Owner | Status | Classes | Goods / services (short) | Link | Risk |
| --- | --- | --- | --- | --- | --- | --- |
| ORCA SLICER | OrcaSlicer Pte. Ltd. (Singapore) | US: registered 2026-08-18, Reg. 8399129 (SN 99562552), first use Mar 2023, **"SLICER" disclaimed**. EU: registered, 019305347 | 9 | Downloadable software for preparing 3D models for printing and slicing, controlling, and operating 3D printers | [TSDR](https://tsdr.uspto.gov/#caseNumber=99562552&caseType=SERIAL_NO&searchType=statusSearch) | **Low** for the name (shares only the generic "slicer"), but it is the closest goods. Matters for how FarmSlicer *refers to* OrcaSlicer: see below |
| SLIC3R | Alessandro Ranellucci (Italy) | US: **dead**, Reg. 4406152 cancelled 2024-04-05 (no Section 8 declaration). No EU or WIPO record | 9 | Software converting a 3D model into printing instructions for a 3D printer | [TSDR](https://tsdr.uspto.gov/#caseNumber=85829870&caseType=SERIAL_NO&searchType=statusSearch) | None for FarmSlicer. **Some for the `slic3r.farm` domain** (common-law rights likely survive): see below |
| OMNISLICE | Kraetonics, LLC | US: registered 2024-09-10, Reg. 7498258 | 42 | SaaS for 3D printer slicing | SN 97562516 | Low: different lead word |
| SMARTSLICE | Teton Simulation Software | US: registered, Reg. 6917541 | 42 | Online software optimizing 3D print parameters | SN 97108662 | Low |
| PARALLEL SLICER | SprintRay, Inc. | US: registered 2022-07-26, Reg. 6805340 | 9 | 3D printer hardware/software, software for operating 3D printers | SN 90635246 | Low |
| SLICERWORKS | Roland DG Corporation | US: pending (Madrid); EU: IR accepted, W01911466 | 9 | Software for 3D printers | SN 79447413 | Low |
| SLICE3E8 | studio 3e8, Inc. | US: pending | 9 | Software for 3D printing and operating 3D printers | SN 99165765 | Low |
| PRINTAGO | Printago Inc | US: registered, Reg. 8009190 | 42 | SaaS for e-commerce of 3D printed products | SN 99019070 | Low: a neighbour in the print-farm market, unrelated name |
| 3DPRINTEROS | 3D Control Systems, Inc. | US: pending (earlier one dead) | 9, 35, 42 | Cloud software for managing 3D printers | SN 99764760 | Low: neighbour, unrelated name |
| BAMBU STUDIO | Bambulab Limited | US: live | 9, 42 | Slicing software | SN 98327002, 97307599 | None (name); a reminder that FarmSlicer talks to Bambu printers by name (nominative use) |
| THE PRINT FARM | Randy and Lindsay Houghton | US: pending, filed 2026-02-17 | 17 | Plastic filaments for 3D printing | SN 99655912 | Low: goods differ, and "print farm" is generic in this field |
| PRINTFARM-PRO | Versatile 3D LLC | US: abandoned | 7 | 3D printers | SN 88708660 | None |
| FARMPRINT | CSIRO (Australia) | US: registered, Reg. 7282305 | 9, 42 | Software benchmarking farms' environmental performance | SN 79346972 | Very low: agriculture, different structure |
| FARMspider | Hancom Frontis (Korea) | KR: registered | 9, 42 | Not checked (Korean-only record) | WIPO GBD | Very low: different second word, Korea only |
| FarmSlice Agro FruitMunch | FarmSlice Agro LLP (India) | IN: registered 2018-10-08, 3967252 | 29 | Food | WIPO GBD | None: unrelated goods |
| FARMSTYLE SLICES | Tillamook County Creamery Association | US: registered | 29 | Cheese | SN 99446501 | None |
| Other `*SLICER` marks in 9/42 | Roland (SLICER, effects pedals), Shimadzu (XSLICER), MIM Software (RESLICER), Brigham and Women's (3D SLICER, medical imaging), Deslicer AB, RaySlicer, PriceSlicer, TimeSlicer, CodeSlicer, LycheeSlicer (resin 3D printing software, US SN 90538558, EU 018407103), and others | mixed | 9, 42 | Mostly unrelated software; LycheeSlicer is 3D printing | tmsearch / eSearch | Low: they coexist with each other on the strength of their different lead words, which is the same position FarmSlicer is in |

No registration or application found for OCTOFARM, FDM MONSTER,
SIMPLYPRINT (one dead SMARTWORKS SIMPLYPRINT for print services),
AUTOFARM3D, PRINTERHIVE, OCTOPRINT, or PRUSASLICER at the USPTO.

### Domains (RDAP)

| Domain | Registered | Registrar |
| --- | --- | --- |
| slicer.farm | 2026-05-13 3:14 AM PDT (10:14Z) | Cloudflare |
| slic3r.farm | 2026-05-13 1:59 PM PDT (20:59Z) | Cloudflare |
| farmslicer.com | 2026-10-26 2:53 PM PDT (21:53Z) | Cloudflare |
| farmslicer.net / .org / .io / .app / .dev, farm-slicer.com, slicerfarm.com | no record (unregistered) | — |
| slic3r.org (the Slic3r project's) | 2011-10-03 | Gandi |

## Opinion: how clear the name looks

**Clear to use; registration is plausible but not certain.**

1. **Likelihood of confusion: low.** Nothing identical or close is
   registered, pending, or in use anywhere searched, in any class. The
   nearest marks share only the word "slicer", which the USPTO itself treats
   as descriptive for this software (OrcaSlicer had to disclaim it), so it
   gives no one rights over "-SLICER" names. A dozen `*SLICER` software
   marks coexist on that basis.
2. **The main registration risk is descriptiveness, not conflict.**
   "Slicer" is the generic name of the software category and "farm" is the
   industry's word for a group of printers ("print farm"). An examiner could
   read FARMSLICER as "slicer for print farms" and refuse it as merely
   descriptive (Lanham Act §2(e)(1)). Arguments the other way: "farm" alone
   most naturally means agriculture, so the combination is incongruous and
   needs a mental step to connect it to 3D printing (suggestive marks
   register); and the closed-up spelling is a coined single word. If it is
   refused, the fallbacks are the Supplemental Register (which still allows
   ® and blocks later confusingly similar filings) and acquired
   distinctiveness after five years of substantially exclusive use (§2(f)).
   Treat this as a real but manageable risk, and the main reason a lawyer's
   look before filing is worth it.
3. **Strength as a brand: modest.** A descriptive-leaning name is a weaker
   mark (narrower protection) and, as `plans/naming.md` found, harder to
   rank for. Consistent use and the distinctive "layer F" logo are what
   strengthen it.

### Slic3r and the `slic3r.farm` redirect

- The US SLIC3R registration (Ranellucci, 2013, software for 3D-printing
  instructions) **lapsed in April 2024** because no maintenance declaration
  was filed. Nobody else has registered it anywhere searched.
- That does **not** make the name free. The Slic3r project is still alive
  (slic3r.org, registered 2011), and unregistered (common-law) rights in the
  US, and passing-off rights elsewhere, last as long as the name is in use.
  A lapsed registration can also be refiled at any time.
- `slic3r.farm` is the **only real risk found in this search**. A domain
  built from another project's mark, used for a competing product in the
  same goods (slicing software), invites a confusion or "bad faith" claim
  (UDRP disputes don't require a registered mark). FarmSlicer is built on
  libslic3r, which helps explain the choice but also makes an affiliation
  look more plausible to users.
- **Using libslic3r doesn't change this** (the maintainer's point, 2026-10-26:
  "we use slic3r internally"). The AGPL licenses the code, not the name,
  and saying "built on libslic3r, which comes from Slic3r" in prose is
  ordinary nominative use. A domain is different: it uses the name as
  FarmSlicer's own address. UDRP panels let someone who builds on or
  services a product use its name in a domain only when the site offers
  that product, **says plainly what its relationship to the owner is**, and
  doesn't corner the name (the *Oki Data* test). A bare redirect to
  FarmSlicer says nothing, which is the weak spot.
- **How big the risk is**: low. Ranellucci let the registration lapse, and
  the realistic worst case is a UDRP complaint that takes the domain away
  (it costs the complainant, not the holder). It's not a risk to the
  FarmSlicer name itself.
- **Recommendation (revised 2026-10-26):** keeping it is reasonable if it
  serves the project. Don't make it the main address or print it in the
  README, app, or social profiles, and have it say what it is: a short page
  ("FarmSlicer is built on libslic3r, from the Slic3r project; it isn't
  affiliated with or endorsed by Slic3r", then a link to FarmSlicer) rather
  than a silent redirect. If it isn't doing anything useful, letting it
  lapse at renewal (2027-05-13) removes the question. `slicer.farm` is
  generic and carries no such risk.

### OrcaSlicer is now a registered mark

ORCA SLICER was registered in the US on 2026-08-18 (and in the EU) by
OrcaSlicer Pte. Ltd. FarmSlicer already uses the name the right way:
factually, to say where its engine and profiles come from (README, NOTICE).
Keep it that way: no "Orca" in product names, logos, domains, or anything
that suggests endorsement, and an "OrcaSlicer is a trademark of its owner;
FarmSlicer is not affiliated" line in the trademark policy below. The same
applies to Bambu Lab, Prusa, Klipper, OctoPrint, and Elegoo, which the UI
names as printer makes and protocols.

### Which classes

- **Class 9**: downloadable software (the self-hosted server and image,
  the installable web app). Needed.
- **Class 42**: SaaS and hosted platforms (the cloud hosting), technical
  support for software ("troubleshooting of computer software problems" is
  a class 42 service in the USPTO's ID Manual), software consulting.
  Needed; it covers both of the planned paid offerings.
- **Class 40** (custom 3D printing for others, "treatment of materials"):
  **not needed** for support and hosting. Only relevant if the company
  starts printing parts for customers under the FarmSlicer name.
- Possibly later: class 41 (training, if courses are sold), class 35 (only
  for retail or business services, not planned).

## Free steps that strengthen common-law rights now

US trademark rights come from use, not registration; these build and
document that use.

1. **Use the name consistently as a brand**: always "FarmSlicer" (one
   word, capital F and S), as an adjective for the product ("FarmSlicer
   server"), never as a generic verb or noun.
2. **Mark it with ™** where the brand appears prominently: the project
   site's header or first mention, the README's first mention, the app's
   sign-in card or About text. Once per page or screen is enough. **Never
   use ® before a federal registration issues** (it's unlawful in the US).
3. **Publish a trademark policy** (e.g. `TRADEMARKS.md` in the repo, linked
   from the site). The usual open-source shape: the code is AGPL and free
   to fork, but the name and logo are not licensed with it; forks and
   modified builds must use a different name; unmodified redistribution and
   factual references ("works with FarmSlicer") are fine; plus the
   third-party marks disclaimer above. This keeps the name distinctive
   while the code stays open, and is evidence of control over the mark.
4. **Keep dated evidence of first use** (no need to collect it now; know
   where it is):
   - first commit `e001a0d`, 2026-05-13 1:29 AM PDT (08:29Z), and the
     GitHub repo created 2026-05-13 3:22 AM PDT (10:22Z);
   - `slicer.farm` and `slic3r.farm` registered 2026-05-13, `farmslicer.com`
     2026-10-26 (RDAP, above);
   - the first GHCR image and the first deployment serving outside users
     (first use "in commerce" for a filing is the first sale, or first
     public offering of the software across state lines, so the first
     paid support or hosting customer is a date to write down);
   - Internet Archive snapshots of farmslicer.com and the GitHub repo
     (save a page now and after major releases: web.archive.org/save).
5. **Claim the remaining handles** while free: `farmslicer` on YouTube,
   Mastodon, and Bluesky (all free on 2026-10-26), plus whichever of
   Instagram, X, and Reddit are still available, and a GitHub org
   `farmslicer` (free) if the repo should ever move off the personal
   account. Optionally npm, crates.io, and Docker Hub names, if packages are
   ever published.
6. **Watch for conflicts for free**: re-run the USPTO search
   (`farmslicer`, `farm* AND slic*`) every few months, and set a web alert
   for "FarmSlicer".

## What to do later, when filing

1. **Who owns it**: file in the name of whichever entity sells the support
   and hosting (the C corp, if that's decided). The owner must be the one
   using the mark; an application in the wrong owner's name is void. If the
   maintainer files personally and the company sells, license it to the
   company in writing (or assign it).
2. **Re-search right before filing** (new applications appear daily), and
   consider a one-time attorney clearance opinion mainly on the
   descriptiveness question.
3. **What to file**: the word mark FARMSLICER in standard characters (the
   broadest protection); the "layer F" logo separately later if wanted. A
   logo or composite mark is easier to register if the word mark meets a
   descriptiveness refusal.
4. **Basis**: use in commerce (§1(a)) for class 9 if the software is
   publicly distributed by then, and class 42 once a paid service exists;
   otherwise intent-to-use (§1(b)), which reserves the priority date from
   filing but needs a Statement of Use (extra fee) later. Specimens: a
   download page with the mark for class 9; a web page offering the hosted
   or support service with the mark for class 42.
5. **Goods and services** (pick ID Manual entries to avoid the surcharge
   for free-form descriptions), along the lines of:
   - Class 9: "Downloadable computer software for slicing three-dimensional
     models into printer instructions and for managing, monitoring, and
     dispatching jobs to a plurality of three-dimensional printers."
   - Class 42: "Software as a service (SaaS) featuring software for slicing
     three-dimensional models and managing three-dimensional printers;
     platform as a service (PaaS); technical support services, namely,
     troubleshooting of computer software problems."
6. **Cost reference**: USPTO base application fee $350 per class (2025
   schedule; check the current one), so ~$700 for 9 + 42, plus fees for
   free-form text or an ITU Statement of Use if used. Expect 8–12 months to
   a first examination.
7. **Abroad**: within six months of the US filing, a Madrid Protocol
   application through the USPTO can extend it to the EU and others with
   the US priority date. Only worth it once there are customers there.
8. **Keep it alive**: Section 8 declaration between years 5 and 6 and
   renewals every 10 years. (Slic3r's US registration was lost by missing
   exactly this.)

## Things not to do

- Don't use ® until a registration issues.
- Don't promote `slic3r.farm`, or put "Slic3r", "Orca", "Bambu", or
  "Prusa" in FarmSlicer's product names, logos, or new domains.
- Don't treat this search as a legal opinion.
- When searching EUIPO eSearch again, don't change the term in the URL:
  it re-runs the previous search-box term (see Method).

## Open questions for the user

1. **`slic3r.farm`**: the maintainer asked why, since FarmSlicer uses
   libslic3r (answer above, in the Slic3r section). Keep it with a page that
   says what it is, or let it lapse at renewal (2027-05-13)?
   *Recommendation*: keep it only if it's useful, and then as a disclosure
   page, not a silent redirect. Changing what it serves is a Cloudflare
   change: it needs the maintainer's per-change OK, through the ops repo.
2. **Who owns the mark**: `TRADEMARKS.md` names Cameron Tacklind. If a
   company ends up selling the support and hosting, assign the mark to it
   (or license it in writing) and update the policy.

## Progress log

- [x] USPTO search (exact, near, phonetic, field, neighbours)
- [x] EUIPO search
- [x] WIPO Global Brand Database search (Embedded, Fuzzy, Phonetic)
- [ ] TMview: not reachable from the tools here (covered by WIPO GBD)
- [x] Common-law search (web, GitHub, package registries, app store,
  handles, domains)
- [x] Report written; `plans/naming.md` points here
- [x] ™ and trademark policy (2026-10-26, the maintainer asked to start
  claiming the name): `TRADEMARKS.md` (forks distributed or offered
  publicly get their own name; running a modified copy for your own people
  is fine), linked from the README and `NOTICE`, served at
  `/TRADEMARKS.txt` and linked under the sign-in cards; ™ on the README's
  first mention, the sidebar title, and the sign-in footer
- [ ] ™ on farmslicer.com (not in this repo)
- [ ] Claim the free handles (step 5 above): the maintainer's to do (sign-ins)
