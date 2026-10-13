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
- **The organisation dashboard, read over the API.** *Documentation Dashboard* lists an organisation's
  repositories, reads each `docs/help/registry.json` and the last commit touching `docs/`, and writes repository,
  pages, owner, changed and state to the output channel — cached for an hour, with *Refresh* to pass the cache,
  and *Set a GitHub Token* storing a token in secret storage (never in a setting or a file). Unauthenticated it
  stops part-way and names GitHub's own limit; a remote scan reports the gaps the registry alone can show.
- **The Organisation view.** A second view in the same container, with two sources in one vocabulary: the folders
  you have open (measured here — no network, and the checks see the files themselves) and the organisation read
  from GitHub (cached; a floor, because a remote reader cannot see files). A repository that needs attention
  expands into the reasons to act on it, and each row's tooltip says which source it came from. A tree rather
  than `app-layout.md`'s table, since VS Code has no table view — the columns became the description and tooltip.

## 0.0.1

- Project initialised: extension manifest, TypeScript build, launch configuration.
- `Temco Knowledge: Show Status` — reports the open folders and whether each one carries
  `docs/help/registry.json`.
