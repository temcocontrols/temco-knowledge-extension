# The plan

The step-level task list for this repository. `extension-design.md` summarises the five phases; this file is
what a session is pointed at — *"implement phase 2, step 3"* — and it is the **only** place progress is
marked. If a step here and the design package disagree about what to build, the design package wins and the
step is wrong.

Where the design lives: [`design/help-platform/`](design/help-platform/README.md) — 17 documents, moved here
from the product repository on 2026-10-12. **The paths inside them are product-repo paths**
(`docs/t3000/**`, `docs/help/registry.json`, `docs/docfx.json`, `scripts/docs-*.mjs`). The ones a step below
leans on: `05-content-and-registry.md`, `12-ai-features.md`, `13-implementation-plan.md`,
`15-online-editor.md`, `16-management-overview.md`.

## The platform's own design

This repository is not a per-repository reader: it is **the platform** — a standalone internal application over
many product repositories (`16-management-overview.md`: *“The platform is a standalone internal application… it
does not require T3000 to be installed”*, and *“build an extension, not a fork”*). The platform's own design is
[`platform-design.md`](platform-design.md): **sources** of many kinds (a git remote at a chosen branch, a local
folder, an archive), the **documents** a person creates and versions (`t3000_dev.chm`, `t3000_webview.pdf`), the
**builds and artifacts** that come out, the AI that reads the history, and the **SQLite catalog** that remembers
all of it. Its build order is **R1–R6** there, and that is where the next work is planned. This file still holds
the per-feature steps, and the design package still wins wherever content, registry or publishing rules are
concerned.

Two consequences worth stating, because they were wrong before: a **repository is not the unit of work** — a
document is, and a repository is only one kind of source — and a project is **not** defined by already carrying a
registry, since the catalog discovers documentation wherever it is and *suggests* the next step.

## How to read a step

Each step is **one sitting of work** with a stated acceptance test — not a phase, not a wish. A step that
needs a dependency this repository does not have yet says so and stops there rather than adding it quietly.
Ticking a step means its acceptance test passes, not that the code exists.

Three rules this plan keeps, taken from the design rather than invented here:

- **Nothing here duplicates the product repository's work.** Link checks, media audits, prose gates and the
  staleness *verdict* belong there; two answers to one question is the bug we are avoiding.
- **Two writes, and only on request.** The empty file for a page the registry already declares, and an empty
  registry where a folder you have open has none. No step may add a third writer without amending that rule
  first — and nothing under `_admin/` or `_edit/` is ever written, because those are generated.
- **The AI drafts; a named human approves.** No step gives the model publish rights, and what a glob or a
  generator can answer is never given to a model.

## Phase 1 — the Content view · done

| # | Step | State |
|---|---|---|
| 1.1 | `src/registry.ts` — read `docs/help/registry.json`, the page-id → file rule, the structural checks, the counts | done |
| 1.2 | `src/tree.ts` — areas → chapters → pages, counts on the parents, **Gaps**, a page's issues as its children | done |
| 1.3 | `src/diagnostics.ts` — every issue in the file that has to be fixed (`registry.json` for a missing file) | done |
| 1.4 | Status bar (`pages · issues · never reviewed`) + the *Temco Knowledge* output report + **Show Problems** | done |
| 1.5 | The six commands: `showStatus`, `validate`, `refresh`, `openRegistry`, `openPage`, `revealPage` | done |
| 1.6 | Refresh triggers: activation, a workspace-folder change, and the `docs/help/registry.json` watcher | done |
| 1.7 | The repository documentation: `.github/copilot-instructions.md`, `docs/`, `README.md` | done |

### Still open in phase 1

- **Nothing is committed yet.** HEAD is still `initial project skeleton`; everything above sits in the
  working tree. This is a `git` step for the owner, not a code step.

## Phase 2 — the AI · done

Every guardrail is now enforced somewhere specific rather than asked for in prose — the table is in
`extension-design.md` under *Guardrails, in code*.

The phase the repository exists for. The model runs **locally** — no cloud, no keys, no documentation text
leaving the building — it is **draft-only**, and it is a setting rather than a hard-coded choice, so a
different model later changes nothing else.

| # | Step | Done when | State |
|---|---|---|---|
| 2.1 | Read the generated neighbours: `docs/help/index.json` (headings, git provenance, `stale`) and `page-meta.json` when present | a page shows its headings and last commit; with the files absent everything except provenance still works | **done** 2026-10-13 |
| 2.2 | **The catalog and the downloader** — a list of runtimes and models to choose from, downloaded on request into a folder of the user's choosing, resumable, checksum-verified where the catalog pins one, removable | a model downloads once, survives a restart, and no model file is ever inside a repository | **done** 2026-10-13 |
| 2.3 | **The runtime process** — the downloaded `llama-server` started on demand on a loopback port, health-checked before use, stopped when idle | the extension host never blocks; with nothing installed, every phase-1 feature is unaffected | **done** 2026-10-13 |
| 2.4 | **The panel** — the `Temco Knowledge` view: chat about the open page, `Draft update`, `Ask the area`, and which model is loaded | the panel reads the open document and `registry.ts`, and holds no logic of its own | **done** 2026-10-13 |
| 2.5 | **`Draft update`** — commit range from git (commits touching the page's `code[]` globs, since its last review), prompts as versioned files, the answer applied as a workspace edit | accepting is a diff, rejecting is `Ctrl+Z`, and the draft names its commit range and prompt version | **done** 2026-10-13 |
| 2.6 | **`Ask the area`** — candidates from the area and tags, an answer that cites pages; low confidence returns search results instead of a synthesis; `stale` pages excluded or explicitly warned | every answer cites a page that exists, and a stale page is never cited silently | **done** 2026-10-13 |
| 2.7 | **Guardrails as code** — degradable, traceable, no secrets or customer data in prompts (commit metadata, paths and page text only), cost bounded | with the model deleted, every phase-1 feature and every command still works | **done** 2026-10-13 |

**An answer's citations are checked, not believed.** `src/ai/citations.ts` splits what an answer names into
pages that exist and ids that do not: a known id becomes a chip that opens it (dashed and marked when the page
is stale), an unknown one is reported as a suspicion, and an area answer that named nothing gets the pages whose
words match the question instead of a synthesis. That search is deliberately plain — term overlap over the
title, the headings, the registry's keywords and tags — so it has no index to build and gives the same answer
every time, which is what a fallback needs to do when the model is the part that was unsure.

**The draft's range.** `src/ai/history.ts` reads `git log` for the page: the commits touching its `code` globs
since its last review, capped at 40, commit metadata and file paths only — never file contents. No page declares
a glob yet, so the range falls back to recent commits anywhere **and says so in its own label**; that label is
printed on the diff and in the transcript beside the prompt version. The wording now lives in `prompts/*.md`
(bump `PROMPT_VERSION` with it), so the instructions are reviewable text and they diff as text.

**The panel, and what it is allowed to see.** `src/ai/panel.ts` renders the transcript and forwards the
buttons; `src/ai/prompts.ts` holds the instructions, versioned as `PROMPT_VERSION`. A question carries the
page's text and metadata, plus — for *Ask the area* — the ids, titles and headings of the pages around it. A
draft comes back as a diff and is applied only by a button. The model never sees another file, and nothing is
committed on its behalf.

**The server, not a library.** `llama-server` is a program the user downloaded; the extension starts it with
`--host 127.0.0.1` — never the LAN — waits for `/health` to answer 200, and asks it questions over HTTP. It
starts when something needs it, never at activation, and stops after `ai.idleMinutes` of no use, on
`deactivate`, or if it never became ready. One call is exposed to the rest of the extension —
`complete(messages, onToken)` — so the provider behind it can change without the pipeline noticing.

As generated on 2026-10-12: 318 pages, every one with headings and provenance. **`code` globs are empty and
`stale` is `false` for all of them**, so the stale marker stays dark until the product repo fills the globs and
computes the verdict (`05-content-and-registry.md` §4). The extension reads that verdict; it never computes it.

**Nothing native ships.** A compiled inference engine is per-OS; a downloaded one is not — and that is what keeps
one `.vsix` valid on every platform and the package small. The pinned runtime is llama.cpp `b11577`, CPU builds
only, each with the sha256 GitHub itself publishes; the archive is unpacked with the platform's own `tar`; and
every model shows its licence before anything is fetched. Two follow-ups needing a machine that can reach the
file host: **pin the model checksums and sizes** (they ship as `sha256: ''`, which is refused unless
`ai.allowUnpinned` is on and then confirmed), and keep `RUNTIME_RELEASE` current.

**Settled 2026-10-13:** the local AI adds **no npm runtime dependency**. The runtime is a binary the user
chooses to download, so the rule about asking before adding a dependency is met by asking for the download
instead — and the extension still installs into an ordinary editor on any OS.

## Phase 3 — publishing · done

| # | Step | Done when | State |
|---|---|---|---|
| 3.1 | Invoke the product repository's **site build** as a task, streaming its output | the site build runs from here and its output is visible; no build logic is reimplemented | **done** 2026-10-13 |
| 3.2 | Invoke the **offline help build**; judge success by the artifact, never the exit code | the produced file exists, is newer than the run, and its path is reported | **done** 2026-10-13 |
| 3.3 | Report the artifacts — path, size, timestamp — and hand them over | nothing is uploaded, committed or published by this extension | **done** 2026-10-13 |

**Invoked, never reimplemented — and never a deploy.** `src/builds.ts` reads the repository's own `package.json`,
so the script is the repository's declared interface: it runs `docs:site` as a VS Code task (visible in the
terminal, cancellable) and `build:help:dry` for the help. Only `build:help:dry` is ever invoked — the plain
`build:help` copies the CHM into a T3000 installation, and building is not shipping. If a repository has only
the deploying form, the command refuses and says why instead of running it. Success is decided by a **file that
did not exist before and does now** — the CHM build's exit code has never been trustworthy — and the report
lists path, size and time for each artifact.

Worth knowing, because it is the reason this is a deliberate command rather than a button: the help build
inherently writes into the product layout (`T3000_Building_Automation_System\HelpDocs\T3000_Help.chm`), which
is a different repository again; the search for the artifact looks there by the folder's *name*, never by hard
typing another repository's path.

## Phase 4 — the dashboard · withdrawn 2026-10-13

**This phase rested on a misreading, and it is removed.** `00-architecture.md` defines the dashboard as a
**generated static page** at `/docs/_admin/` — coverage · stale by owner · docs-owed · unowned pages · broken
links · feedback · help-id coverage — noindex, excluded from the PDF, the CHM and the offline zip, and built by
the **product repository's** own pipeline (`13-implementation-plan.md` step 1.19 / 24). It is an authoring
surface *on the site*, and its rows deep-link **into** the editor (`vscode://file/…`, `00-architecture.md`).

What was built here instead — an organisation read over the GitHub API, and a sidebar view of it — answered the
same question more weakly: repository-level facts from the API, with none of the page-level health the real
dashboard carries, and a second organisation-wide answer to a question the design answers in exactly one place.
That is the duplicate this plan's first rule exists to prevent, so the two modules, the view, its four commands
and its two settings are deleted rather than kept and renamed.

**4.5 survives, rehomed.** *Start a Registry* was never about the dashboard: it acts on a folder you have open,
and it is the Content view's empty state — which is where a folder with no registry actually starts, since the
view has nothing else to show. Everything else in this phase is product-repository work.

**The seam, and why the extension is not the dashboard.** The dashboard asks *which pages need work across the
organisation?* — a question about the site, answered on the site, by the site's own generator. The Content view
asks *which pages need work in the repository I have open?* — the same vocabulary, one repository, with the
reasons marked in the file that has to be fixed. The extension's half of that hand-off is the deep link: the
dashboard's row opens the page here, and `app-layout.md` draws the two worlds and the seam between them.

## Phase 5 — feedback and health · done, with one contract to confirm

| # | Step | Done when | State |
|---|---|---|---|
| 5.1 | Feedback intake and routing: each row reaches the page's owner; aging is visible | a row older than 30 days appears without anyone searching for it | **done** against a proposed contract — see below |
| 5.2 | The staleness report, grouped by owner | it is produced on a schedule and needs no interpretation to act on | **done here**, minus the schedule — see below |
| 5.3 | ~~The `/_admin/` view — the same data, rendered for the portal~~ | **withdrawn 2026-10-13** — the design's rule is *“nothing under `_admin/` or `_edit/` is in `docfx.json` content: they are generated pages, not documentation”*, and the product repo already generates that folder. `src/admin.ts` and its command are deleted; see phase 4 | — |

**5.1 reads a shape that is proposed, not agreed.** `09-feedback-subscriptions-notifications.md` was written against
an endpoint on the T3000 server plus database tables, and `16-management-overview.md` supersedes that hosting model,
so where a row comes from was never settled. `src/feedback.ts` therefore reads the smallest shape that carries what
routing needs — `docs/help/feedback.json`, `{ version, rows: [{ page, kind, note, at, state, by }] }` per repository
— routes each row to its page's owner, and calls out the ones waiting over 30 days in their own section. **The shape
is the extension's proposal for the docs owner to accept or replace**; with no such file anywhere, the command says
exactly that instead of reporting “no feedback”.

**5.3 is withdrawn for the same reason phase 4 is, and it is worth stating plainly.** The `_admin/` folder is
**generated by the product repository's own pipeline** — `docs-registry.mjs` writes its `index.md` — so an
extension writing a Markdown page beside it was a second writer on a generated surface. The rule I had written
to guard it (“never overwrite `index.md`”) was the symptom: the honest version of that rule is **never write
under `_admin/` or `_edit/` at all**. What the site's dashboard needs from this repository is the deep link it
already gets, not a page.

**5.2, and the half of it that does not belong here.** `src/report.ts` produces the report on the *Documentation
Owed* command: the pages that need attention, grouped by owner, with the reasons in the words of the fix, and
counts — not lists — for the pages that have merely never been reviewed. It opens as an untitled Markdown
document, so producing a report writes nothing anywhere. **The cadence is not here**: an editor extension has no
scheduler, and `11-review-and-cicd.md` §2 already places the weekly job in the product repo's CI. What this
delivers is the report that job would send — which is the part a maintainer actually reads.

## Decisions that gate steps

| Decision | Gates | Who |
|---|---|---|
| The local-AI runtime dependency | **resolved 2026-10-13** — a downloaded binary, not an npm dependency: nothing native ships | — |
| Which model, and where its weights live | **resolved 2026-10-13** — the user chooses from the catalog; the folder is `temcoKnowledge.ai.modelFolder` | — |
| Pin the model checksums and sizes | 2.2's follow-up; needs a machine that can reach the file host | the repository owner |
| May this extension ever write into a product repository beyond a declared-but-missing page file? | **resolved 2026-10-13** — an empty registry where a folder you have open has none, on a modal confirmation. Never under `_admin/` or `_edit/`, and never anything a generator writes | — |
| Does the extension render the `/_admin/` dashboard? | **resolved 2026-10-13** — no. The dashboard is a generated page the product repo builds; this extension is its deep-link target, not a second renderer | — |
| May the extension invoke a product repository's build scripts? | **resolved 2026-10-13** — yes, as VS Code tasks discovered from that repository's own `package.json`; never reimplemented | — |
| Does it ever deploy the CHM into a T3000 installation? | **resolved 2026-10-13** — never: only the non-deploying `build:help:dry` is invoked, and shipping stays a separate act | — |
| Where a feedback row comes from | **proposed 2026-10-13** — `docs/help/feedback.json` per repository, in the shape `src/feedback.ts` reads; the docs owner accepts or replaces it | the docs owner |
| May the extension create a registry in a product repo? | **resolved 2026-10-13** — only in a folder you have open, only empty, on a modal confirmation | — |
