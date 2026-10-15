# Extension design

## Responsibilities, one file each

| Module | Owns |
|---|---|
| `src/registry.ts` | reading `docs/help/registry.json` and the generated `index.json`/`page-meta.json`, the page id → file rule, the structural checks, the counts. No VS Code UI beyond `Uri`, `WorkspaceFolder` and the filesystem |
| `src/tree.ts` | the Content view: which nodes exist, what they show, what a click does |
| `src/diagnostics.ts` | which issues become Problems, and on which file |
| `src/extension.ts` | activation, the view and status bar, the commands, the file watcher |
| `src/ai/catalog.ts` | what can be downloaded: the pinned llama.cpp build with the checksums GitHub publishes, the models on offer, their licences. No network, no filesystem |
| `src/ai/install.ts` | the model folder, the resumable download and its checksum check, the unpack, and the manifest of what is installed |
| `src/ai/runtime.ts` | the local server process: started on demand on a loopback port, health-checked, stopped when idle — and the single `complete()` call everything else uses |
| `src/ai/history.ts` | the commits a draft is about: `git log` over the page's `code` globs since its last review, metadata and paths only. Never throws |
| `src/ai/prompts.ts` | loads `prompts/*.md` and fills them in: the house rules, the question, the draft, the area. The only text that may reach the model |
| `src/ai/citations.ts` | what an answer pointed at: the ids that resolve, the ids that do not, and the plain term search behind a low-confidence fallback |
| `src/ai/panel.ts` | the `Temco Knowledge` panel: chat about the open page, `Draft update` as a diff, `Ask the area`, and the model line. Decides nothing itself |
| `src/ai/commands.ts` | the list a person picks from: install, use, remove, open the folder, and the AI's status |
| `src/builds.ts` | the product repo's own builds, invoked as VS Code tasks and judged by the artifact they leave — never by an exit code, and never the form that deploys |
| `src/report.ts` | the staleness report: what needs attention, grouped by owner, as Markdown. Counts rather than lists for the pages that have merely never been reviewed |
| `src/scaffold.ts` | starting a registry in an open folder that has none: the smallest valid file, on a confirmation, with the seeding left to the repository's own generator |
| `src/home.ts` | the dashboard: the one page that is not about a folder — identity, how the application works, what we have now, how to start, and every feature with its state |
| `src/views.ts` | the other two sidebar sections: **Work** (what needs doing, and what changed) and **Library** (what it reads and produces) |
| `src/catalog/` | `schema.ts` (the tables) · `store.ts` (`node:sqlite`, in the extension's own storage — never in a repository) · `commands.ts` (the catalog status) |
| `src/feedback.ts` | feedback rows routed to their page's owner, against a proposed file shape, with the aging called out |

`registry.ts` is deliberately free of presentation: it is the part that would survive replacing the view, and
the part an AI feature will reuse to know what pages exist.

## The tree

```
Content                        (view container: Temco Knowledge)
├─ Gaps (12)                   only when something is wrong, across all open repos
├─ T3000Webview-EEZ-Studio     only when more than one folder is open
│  ├─ t3000                    title · audience · noindex
│  │  ├─ api-reference         chapter, with a page count
│  │  │  ├─ Data Points API     owner · ship · reviewed, plus its issues as children
│  │  │  └─ …
│  │  └─ …
│  └─ legacy
└─ …
```

- Counts live on the **parents**, because "which area needs attention" is the real question.
- A page with issues is collapsible and its children are the reasons.
- A page's tooltip carries what the generator knows and the registry does not: its last change, its headings,
  and — marked in the description and the icon — whether its `code` moved on since the last review. With
  `index.json`/`page-meta.json` absent, that block is simply missing and nothing else changes.
- Clicking a page opens the file; if the file does not exist, the click offers to create it.
- Areas and chapters are never empty: an area declared in `areas{}` with no pages still appears, which is
  itself information.

## The AI panel

```
Temco Knowledge                                     (panel: the AI, docked on the right)
├─ header        the page's title (· stale) and the model in use · offline
├─ transcript    your question, the answer as it streams, notes, errors
├─ Draft update  → opens a diff: the page on the left, the draft on the right
│                  Apply replaces the whole page — one Ctrl+Z takes it back
├─ Ask the area  → the question, with the id, title and headings of the pages around it
└─ Ask           → a question about the page on screen
```

- **It writes nothing by itself.** A draft lands in a diff and in the panel; putting it into the page is a
  button, and the change is an ordinary undoable edit.
- **What reaches the model is fixed.** The page's text and metadata, and for an area question the ids, titles
  and headings of its neighbours. No other file, no repository sweep, no credential.
- **Every draft names its prompt version**, so a draft can be traced to the instructions that produced it.
- **An answer's citations are checked.** A page it names becomes a chip that opens it and is dashed when the
  page is stale; a name that is not a page is reported rather than believed; and an area answer that named
  nothing is replaced by search results instead of a synthesis.
- **With nothing installed the panel still opens** and says what to download, so the extension never looks
  broken — the AI is optional the whole way down.

## The dashboard, and why this repository does not have one

`00-architecture.md` puts the dashboard on the **site**, not in the editor: a **generated static page** at
`/docs/_admin/` — coverage · stale by owner · docs-owed · unowned · unreviewed · broken links · feedback ·
health score — noindex, out of the PDF, the CHM and the offline zip, built by the product repository's own
pipeline (`13-implementation-plan.md` step 1.19). Its rows deep-link **into** the editor, and that hand-off is
this extension's half of it.

An earlier phase built an organisation read here instead — a repository list over the GitHub API and a sidebar
view — which answered the dashboard's own question more weakly (repository-level facts, none of the page-level
health) and in a second place. Both are deleted, along with the token setting they needed. The rule is the same
one this document already carries for checks: **the extension never computes an answer the product repository
already owns.**

## Commands

| Command | Does |
|---|---|
| `temcoKnowledge.showStatus` | refreshes, writes the full report to the *Temco Knowledge* output channel, offers **Show Problems** |
| `temcoKnowledge.validate` | same, and is what the status-bar item and the view title button call |
| `temcoKnowledge.refresh` | re-reads the registries |
| `temcoKnowledge.openRegistry` | opens `registry.json` for the folder the node belongs to |
| `temcoKnowledge.openPage` | opens the page, or offers to create the missing file |
| `temcoKnowledge.reveal` | shows the page's file — or a chapter's, an area's or a source's folder — in the operating system's file manager (`revealFileInOS`, not the VS Code view of a similar name) |
| `temcoKnowledge.openTerminal` | opens an integrated terminal at the folder that row stands for |
| `temcoKnowledge.copyPath` · `copyRelativePath` | the row's path on the clipboard, absolute or relative to the open folder |
| `temcoKnowledge.newPage` · `newChapter` | a page (kind, title, file name) or a chapter — a folder with its first page, since an empty chapter does not exist |
| `temcoKnowledge.newPage.article` · `.task` · `.reference` · `.troubleshooting` · `.releaseNote` | the same as `newPage` with the kind already named, so the *New Page of a Kind* submenu is one click per kind |
| `temcoKnowledge.renamePage` | the title as a registry value, and the page's first `#` with it — never the file name |
| `temcoKnowledge.movePageUp` · `movePageDown` | a two-number swap of `order` in `registry.json` |
| `temcoKnowledge.retirePage` | `deprecated` and `superseded_by`; the file stays, so old links keep redirecting |
| `temcoKnowledge.models` | the list of runtimes and models: what is installed, what can be downloaded, which one is in use |
| `temcoKnowledge.removeModel` | deletes an installed runtime or model, and clears it from the settings when it was the one in use |
| `temcoKnowledge.openModelFolder` | opens the folder the downloads live in |
| `temcoKnowledge.aiStatus` | which runtime and model are in use, whether the server is running, and how to stop it or read its log |
| `temcoKnowledge.buildSite` | invokes the repository's own `docs:site` as a task and reports the files it produced |
| `temcoKnowledge.buildHelp` | invokes the non-deploying help build (`build:help:dry`) and reports the CHM it produced |
| `temcoKnowledge.stalenessReport` | opens the report of what is owed as an untitled Markdown document — nothing is written |
| `temcoKnowledge.startRegistry` | creates the smallest valid `docs/help/registry.json` in an open folder that has none, after a confirmation — and is also the Content view's empty state |
| `temcoKnowledge.feedback` | reads each repository's `docs/help/feedback.json`, routes the rows to their owners, and calls out the aging |

Where they surface: the **Workspace view's title bar** carries *New page*, *New chapter* and *Refresh* inline,
and its `…` holds the page acts (open · reveal · terminal · copy a path · rename the title · move up · move down ·
retire · the *New Page of a Kind* submenu · the registry) plus Home and Validate — the same list the row's own
right-click menu shows, which is the Library's shape and the Explorer's. A row's **left click** opens a page or
expands a folder; a **right click** (or the keyboard's menu key) opens the menu; the hover carries nothing.
Everything else is in the palette, where it costs no room — and `startRegistry` is a row in the view's empty
state, so the view and the button that fixes it are never apart. There is no organisation-wide surface here by
design: that question belongs to the site's generated dashboard, which this extension hands off to rather than
re-implements.

## What refreshes the view

- activation, and any workspace-folder change;
- a change to `**/docs/help/registry.json` (created, changed, deleted) — it changes the shape of the tree;
- a change to `**/docs/help/index.json` or `**/docs/help/page-meta.json` — they change the provenance the items
  display;
- an explicit refresh.

Everything else, including saving a page, does not refresh: the tree describes structure, not prose.

## Rules the code follows

- **Two writes, each asked for.** Reading is what the extension does; it writes in exactly two places, and only
  on a command that names what it will create: the empty file for a page the registry already declares, and an
  empty registry where a folder you have open has none. Both are files the registry's own generator already
  expects, and neither is ever an existing file. **Nothing under `_admin/` or `_edit/` is written at all** — the
  design's rule is that those are generated pages, not documentation. What it downloads — the runtime, a model,
  the manifest that records them — goes to its own storage folder, or to the folder a setting names, and never
  into a repository.
- **A diagnostic lands where the fix is** — the page for a page problem, `registry.json` for a missing file
  or an unreadable registry.
- **Counts are not problems.** `reviewed: null` and empty tag lists are normal in a 335-page registry; as
  warnings they would bury the faults that matter.
- **No module knows about the fork.** Nothing references `temco-knowledge-studio`, by design.
- **Nothing is fetched unasked.** The only network calls are the runtime and model downloads the user starts
  from *Models and Runtime*: no telemetry, no update check, no background refresh, no organisation scan. No
  credential is stored at all.
- **Nothing native ships.** A compiled engine is per-OS; a downloaded one is not, which is what keeps one
  `.vsix` valid on every platform — our application, plain VS Code, Windows or macOS.
- **Building is not shipping.** The build commands invoke the repository's own scripts and report what those
  scripts produced. The form that deploys into a T3000 installation is never run, and nothing is uploaded or
  committed.
- **A generated page is never overwritten.** Which now means: nothing under `_admin/` or `_edit/` is written at
  all. The dashboard is the product repository's generated page; this extension is the deep-link target it
  hands off to.
- **An empty state is actionable.** A view that only explains itself is a dead end, and the folder with no
  registry is exactly where a new product repository starts. The Content view's empty state is a row that runs
  *Start a Registry* rather than a sentence telling the reader to go and find one.
- **A process, only while it is wanted.** The local server starts when something asks the AI for an answer,
  never at activation; it listens on loopback only; and it is stopped when idle, when its model is removed,
  and when the window closes. The extension holds no model in its own process, so nothing to load or unload
  blockingly.

## Guardrails, in code

`12-ai-features.md` §5 lists them; this is where each one actually lives, so it can be checked rather than
trusted.

| Guardrail | Where it is enforced |
|---|---|
| No shipped page is edited by a model | A draft opens in a diff; the page changes only when **Apply draft** is pressed, and then as one undoable `WorkspaceEdit` |
| No secrets, no customer data | The only thing a prompt can take is a `PageContext` — page text, path, registry metadata — plus ids, titles and headings for an area question. No parameter exists that could carry another file, a token or a sweep of the repository |
| Traceable | `PROMPT_VERSION` is printed on every draft and in the panel's model line, and a draft also names its commit range (`src/ai/history.ts`) |
| Degradable | The panel opens with nothing installed and says what to download; the server never starts without a runtime and a model; a missing prompt file is a named error, not a stack trace; a page too large for one draft is refused rather than half-drafted |
| Deterministic first | Staleness is read from `index.json`, never recomputed; the low-confidence fallback is plain term overlap; citations are resolved against the registry |
| Cost bounded | 6 turns of history, 40 area candidates, 40 commits, 100k characters of page text, 1024 tokens per answer and 2048 per draft, `--ctx-size 8192` |
| Offline | The runtime is a local process on `127.0.0.1`; the only other network calls are the downloads the user starts |

## Roadmap

| Phase | Adds | Notes |
|---|---|---|
| 1 | **the Content view** — registry, checks, gaps, status bar | done |
| 2 | **the AI** — model download, worker, draft page updates from a commit range, ask-the-area | done — a local model, offline; drafts only, a human accepts |
| 3 | **publishing** — invoke the product repo's site build and offline help build, then hand over the artifacts | done — the extension orchestrates; it does not reimplement the pipeline |
| 4 | ~~the dashboard~~ — withdrawn: the dashboard is the product repository's generated page at `/docs/_admin/` | 4.1–4.4 removed 2026-10-13; *Start a Registry* survived as the Content view's empty state |
| 5 | **feedback and health** — intake, and the report of what is owed | done — the report's cadence stays in the product repo's CI, and the feedback file's shape is a proposal for the docs owner |

The step-level list — what each step touches, its acceptance test and what is blocked — is
[`plan.md`](plan.md). This table is the summary; `plan.md` is what work is pointed at.

Phase 2 is the reason this repo exists. Everything before it is what the AI needs in order to know what it is
talking about.
