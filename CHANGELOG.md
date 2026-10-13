# Change Log

## Unreleased

- **the Content view**: the registry reader and the structural checks, areas → chapters → pages with counts
  on the parents, **Gaps**, a page's issues as its children, problems landing in the file that has to be
  fixed, the status bar (`pages · issues · never reviewed`), the output report, and the six `temcoKnowledge.*`
  commands.
- Repository documentation: `.github/copilot-instructions.md`, `README.md`, and `docs/` — architecture,
  registry schema, extension design, application layout, and the plan.
- **The platform design moved here** from `T3000Webview-EEZ-Studio`: `docs/design/help-platform/` — 19 files
  (the 16 design documents, its README and its TOC). The product repository no longer registers or publishes
  them, so its **Contributing** area is gone from the published site: its area definition, its 17 registry
  entries, the `design/**` content glob, the navbar node and the generator that produced them were removed.
- The tree and the report show what the generator knows: a page's last change and headings in its tooltip, a
  `stale` marker on the page when the generator says its code moved on, and a stale count on the repository and
  area tooltips. Read from `docs/help/index.json` / `page-meta.json`; absent, everything else works unchanged.
- **The local AI's first slice: the model list.** *Models and Runtime* offers the llama.cpp build for this
  machine and a choice of models, downloads the one picked into the user's own folder (resumable, checked
  against the catalog's sha256), unpacks it with the platform's `tar`, records it in a manifest, and can remove
  it again. Nothing native ships with the extension, and every download is a command the user ran.
- **The local AI's second slice: the runtime process.** The downloaded `llama-server` is started on demand on
  a loopback port (`--host 127.0.0.1`, never the LAN), waited for with a `/health` check, and stopped when idle
  (`temcoKnowledge.ai.idleMinutes`), when its model is removed, or when the window closes. *AI Status* names the
  runtime and model in use and can stop the server or open its log.
- **The AI panel.** A *Temco Knowledge* panel: ask about the open page, `Draft update` (the draft opens as a
  diff; *Apply* replaces the page and one Ctrl+Z takes it back), and `Ask the area` (the pages around the one
  on screen, by id, title and headings). Answers stream as they arrive, every draft names its prompt version,
  and with nothing installed the panel still opens and says what to download. What reaches the model is the
  page and its metadata — never another file.
- **`Draft update` reads the change it is about.** `src/ai/history.ts` logs the commits touching the page's
  `code` globs since its last review (capped at 40; commit metadata and file paths, never file contents), and
  the range is printed beside the prompt version on the diff and in the transcript. No page declares a glob yet,
  so the range falls back to recent commits anywhere and says so. The prompt wording moved into `prompts/*.md`,
  where it is reviewable text — `PROMPT_VERSION` bumps with it.
- **Citations are checked, not believed.** An answer that names a page turns it into a chip that opens it —
  dashed when the page is stale — and a name that is not a page is reported as a suspicion. An *Ask the area*
  answer that named no page at all is replaced by search results over titles, headings, keywords and tags,
  rather than a synthesis nothing supports.
- **Guardrails made explicit.** Answers are bounded (1024 tokens; drafts 2048), a page too large for one draft
  is refused instead of half-drafted, a missing prompt file is a named error, and the panel's model line carries
  the prompt version. `extension-design.md` now maps every guardrail from `12-ai-features.md` §5 to the place
  that enforces it.
- **Publishing, invoked rather than reimplemented.** *Build the Site* and *Build the Offline Help* run the open
  repository's own scripts as VS Code tasks — `docs:site`, and only ever the non-deploying `build:help:dry` — and
  then report the artifacts as path, size and time. Success is a file that did not exist before and does now,
  because the CHM build's exit code cannot be trusted. The deploying help build is refused with a reason rather
  than run, since it copies the CHM into a T3000 installation.
- **The home page, and it opens by itself.** Activating the extension now shows *Temco Knowledge* — the
  platform's entry point: documents, sources, the folders this editor has open, what the platform noticed and
  has not shown yet, and where its memory is kept. It opens as a page in the editor area, every action is a
  `command:` link (no scripts, nothing loaded from anywhere), and `temcoKnowledge.home.openOnStart` turns it
  off. Nothing on it is specific to a product: the lists come from the catalog, and the folders are whatever
  is open. Its queries are exercised against a real database, including a document with no sources and no
  build still appearing in the list.
- **The catalog exists (R1).** The platform's memory: a `catalog.db` in the extension's own storage with the
  tables the design names — sources, documents, doc_sources, recipes, builds, artifacts, commits, commit_pages,
  pages, scans, events — and a `node:sqlite` store that needs no dependency, since the engine ships with the
  extension host. Where that built-in is missing, the store says so in words at the point of use instead of
  failing activation, and a database written by a newer schema is refused rather than half-read. *The Catalog*
  reports the file, the schema version and a row count per table. Verified by applying the schema to a real
  database: 12 tables, idempotent, inserts and the document↔source join exercised.
- **Phase 4 withdrawn: the dashboard is not ours.** An organisation read over the GitHub API and an Organisation
  view were built here, then removed on re-reading the design. `00-architecture.md` puts the dashboard on the
  **site** — a generated static page at `/docs/_admin/` carrying coverage, stale by owner, docs-owed, unowned,
  unreviewed, broken links, feedback and the health score, noindex and never shipped, built by the product
  repository's own pipeline (`13-implementation-plan.md` step 1.19) — and its rows deep-link *into* the editor.
  What was here answered that same question more weakly (repository-level facts from the API, none of the
  page-level health) and in a second place, which is the duplicate the plan's first rule exists to prevent.
  `src/dashboard.ts`, `src/dashboardView.ts`, the view, its four commands and its two settings are deleted, and
  nothing under `_admin/` or `_edit/` is written at all. *Start a Registry* survives as the Content view's empty
  state, which is where a folder with no registry actually starts.
- **Documentation Owed.** A report of what needs attention, grouped by owner: stale pages and faulty ones, with
  the reasons in the words of the fix, and counts — not lists — for the pages that have merely never been
  reviewed. It opens as an untitled Markdown document, so producing a report writes nothing. The *cadence* stays
  in the product repo's CI (`11-review-and-cicd.md` §2): an editor extension has no scheduler.
- **The last two steps.** *Start a Registry* creates the smallest valid `docs/help/registry.json` in an open
  folder that has none, after a confirmation, and refuses a repository that is not open — starting one there would
  be a commit made through the API. *Feedback by Owner* reads each repository's `docs/help/feedback.json`, routes
  every row to its page's owner and calls out the ones waiting over 30 days (the file shape is a proposal awaiting
  the docs owner's word). The `/_admin/` page writer that joined them was withdrawn: see phase 4 above.
- **Where the commands live.** *Feedback by Owner* is a button on the Content view's title beside *Validate*,
  *Open Registry*, *Refresh*, *Models and Runtime* and *Documentation Owed*, and *Start a Registry* is the row
  the Content view shows when a folder has no registry — instead of a sentence telling you to go and find one.
- **The AI view was landing in the Explorer.** It was contributed to a container named `panel`, which is not a
  container — VS Code said so on every activation and put the view in the Explorer instead. It now lives in a
  contributed panel container (`temcoKnowledgePanel`) — docked on the right by the workbench, since VS Code has
  no contribution point that places a container there — where
  `app-layout.md` draws it.

## 0.0.1

- Project initialised: extension manifest, TypeScript build, launch configuration.
- `Temco Knowledge: Show Status` — reports the open folders and whether each one carries
  `docs/help/registry.json`.
