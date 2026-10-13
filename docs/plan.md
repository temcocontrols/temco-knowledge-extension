# The plan

The step-level task list for this repository. `extension-design.md` summarises the five phases; this file is
what a session is pointed at — *"implement phase 2, step 3"* — and it is the **only** place progress is
marked. If a step here and the design package disagree about what to build, the design package wins and the
step is wrong.

Where the design lives: [`design/help-platform/`](design/help-platform/README.md) — 16 documents, moved here
from the product repository on 2026-10-12. **The paths inside them are product-repo paths**
(`docs/t3000/**`, `docs/help/registry.json`, `docs/docfx.json`, `scripts/docs-*.mjs`). The ones a step below
leans on: `05-content-and-registry.md`, `12-ai-features.md`, `13-implementation-plan.md`,
`15-online-editor.md`, `16-management-overview.md`.

## How to read a step

Each step is **one sitting of work** with a stated acceptance test — not a phase, not a wish. A step that
needs a dependency this repository does not have yet says so and stops there rather than adding it quietly.
Ticking a step means its acceptance test passes, not that the code exists.

Three rules this plan keeps, taken from the design rather than invented here:

- **Nothing here duplicates the product repository's work.** Link checks, media audits, prose gates and the
  staleness *verdict* belong there; two answers to one question is the bug we are avoiding.
- **Only one write, and only on request.** Creating the empty file for a page the registry already declares.
  No step may add a second writer without amending that rule first.
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

## Phase 2 — the AI · in progress

The phase the repository exists for. The model runs **locally** — no cloud, no keys, no documentation text
leaving the building — it is **draft-only**, and it is a setting rather than a hard-coded choice, so a
different model later changes nothing else.

| # | Step | Done when | State |
|---|---|---|---|
| 2.1 | Read the generated neighbours: `docs/help/index.json` (headings, git provenance, `stale`) and `page-meta.json` when present | a page shows its headings and last commit; with the files absent everything except provenance still works | **done** 2026-10-13 |
| 2.2 | **The catalog and the downloader** — a list of runtimes and models to choose from, downloaded on request into a folder of the user's choosing, resumable, checksum-verified where the catalog pins one, removable | a model downloads once, survives a restart, and no model file is ever inside a repository | **done** 2026-10-13 |
| 2.3 | **The runtime process** — the downloaded `llama-server` started on demand on a loopback port, health-checked before use, stopped when idle | the extension host never blocks; with nothing installed, every phase-1 feature is unaffected | **done** 2026-10-13 |
| 2.4 | **The panel** — the `Temco Knowledge` view: chat about the open page, `Draft update`, `Ask the area`, and which model is loaded | the panel reads the open document and `registry.ts`, and holds no logic of its own | **done** 2026-10-13 |
| 2.5 | **`Draft update`** — commit range from git (commits touching `docs/**` and the page's `code[]` globs), a versioned prompt file, the answer applied as a workspace edit | accepting is a diff, rejecting is `Ctrl+Z`, and the draft names its commit range and prompt version | next |
| 2.6 | **`Ask the area`** — candidates from the area and tags, an answer that cites pages; low confidence returns search results instead of a synthesis; `stale` pages excluded or explicitly warned | every answer cites a page that exists, and a stale page is never cited silently | planned |
| 2.7 | **Guardrails as code** — degradable, traceable, no secrets or customer data in prompts (commit metadata, paths and page text only), cost bounded | with the model deleted, every phase-1 feature and every command still works | planned |

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

## Phase 3 — publishing

| # | Step | Done when |
|---|---|---|
| 3.1 | Invoke the product repository's **site build** as a task, streaming its output | the site build runs from here and its output is visible; no build logic is reimplemented |
| 3.2 | Invoke the **offline help build**; judge success by the artifact, never the exit code | the produced file exists, is newer than the run, and its path is reported |
| 3.3 | Report the artifacts — path, size, timestamp — and hand them over | nothing is uploaded, committed or published by this extension |

## Phase 4 — the dashboard

| # | Step | Done when |
|---|---|---|
| 4.1 | The collector: the organisation's repositories, each one's `docs/help/registry.json`, and the last commit touching `docs/` | ~3 calls per repository, cached for an hour |
| 4.2 | The token in VS Code secret storage, opt-in | public repositories work without a token; a private one needs it and never writes it to disk |
| 4.3 | The table: repository · pages · owner · changed · state (stale / unowned / gaps) | the state column is computed here from data the API already returned |
| 4.4 | Multi-root mode: the same table from the open folders, with no network at all | the table renders offline and says so |
| 4.5 | *Start one* for a repository that carries no registry | **gated** — this writes into a *product* repository, so it is an explicit command with a confirmation, and it needs the owner's agreement before it is built |

## Phase 5 — feedback and health

| # | Step | Done when |
|---|---|---|
| 5.1 | Feedback intake and routing: each row reaches the page's owner; aging is visible | a row older than 30 days appears without anyone searching for it |
| 5.2 | The staleness report, grouped by owner | it is produced on a schedule and needs no interpretation to act on |
| 5.3 | The `/_admin/` view — the same data, rendered for the portal | one collector, two renderings; the dashboard never becomes a second source of truth |

## Decisions that gate steps

| Decision | Gates | Who |
|---|---|---|
| The local-AI runtime dependency | **resolved 2026-10-13** — a downloaded binary, not an npm dependency: nothing native ships | — |
| Which model, and where its weights live | **resolved 2026-10-13** — the user chooses from the catalog; the folder is `temcoKnowledge.ai.modelFolder` | — |
| Pin the model checksums and sizes | 2.2's follow-up; needs a machine that can reach the file host | the repository owner |
| May this extension ever write into a product repository beyond a declared-but-missing page file? | 4.5 | the repository owner |
| The GitHub token: a new PAT, or the one the `gh` CLI already holds | 4.2 | the repository owner |
