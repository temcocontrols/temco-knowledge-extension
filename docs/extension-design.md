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
| `src/dashboard.ts` | the organisation read from the GitHub API: the repository list, each registry, the last commit touching `docs/`, cached for an hour |
| `src/dashboardView.ts` | the Organisation view: an open-folder row and an API row, both in the same words, and the reasons under the ones that need attention |

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
Temco Knowledge                                     (panel: the AI, bottom area)
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

## The organisation view

```
Temco Knowledge Studio — ORGANISATION
├─ Open folders                  (measured here: no network, and the checks see the files)
│  └─ T3000Webview-EEZ-Studio   318 pages · 2 days · current
├─ temcocontrols                 62 repositories      (read from GitHub, cached an hour)
│  ├─ T3000_Building_Automation_System  298 pages · 3 weeks · 12 gaps
│  │  └─ 12 gaps — open the repository to see them on the pages
│  └─ …
└─ Run “Documentation Dashboard” to read the organisation       (until it has been run)
```

- **Two sources, never mixed**, and every row says which it is: the folders you have open (exact — the same
  checks the Content view runs, including whether a registered page's file exists) and the organisation read
  over the API (a floor, because a remote reader cannot see files). Offline, the first still renders in full and
  the header says when GitHub was last read.
- **A tree, not a table.** VS Code has no table view and `app-layout.md` mocks one; rather than add a webview for
  columns, the columns became the row's description and tooltip. Recorded here because it is a deliberate
  divergence from the mock, not an oversight.
- **Problems first.** A repository that needs attention is collapsible, and its children are the reasons to act
  on — the same shape the Content view uses for a page.

## Commands

| Command | Does |
|---|---|
| `temcoKnowledge.showStatus` | refreshes, writes the full report to the *Temco Knowledge* output channel, offers **Show Problems** |
| `temcoKnowledge.validate` | same, and is what the status-bar item and the view title button call |
| `temcoKnowledge.refresh` | re-reads the registries |
| `temcoKnowledge.openRegistry` | opens `registry.json` for the folder the node belongs to |
| `temcoKnowledge.openPage` | opens the page, or offers to create the missing file |
| `temcoKnowledge.revealPage` | reveals the page in the explorer |
| `temcoKnowledge.models` | the list of runtimes and models: what is installed, what can be downloaded, which one is in use |
| `temcoKnowledge.removeModel` | deletes an installed runtime or model, and clears it from the settings when it was the one in use |
| `temcoKnowledge.openModelFolder` | opens the folder the downloads live in |
| `temcoKnowledge.aiStatus` | which runtime and model are in use, whether the server is running, and how to stop it or read its log |
| `temcoKnowledge.buildSite` | invokes the repository's own `docs:site` as a task and reports the files it produced |
| `temcoKnowledge.buildHelp` | invokes the non-deploying help build (`build:help:dry`) and reports the CHM it produced |
| `temcoKnowledge.dashboard` | reads the organisation from GitHub (cached an hour) and writes the table to the output channel |
| `temcoKnowledge.dashboardRefresh` | the same, past the cache |
| `temcoKnowledge.setGithubToken` | stores a token in secret storage, or clears the one stored |
| `temcoKnowledge.openRepository` | opens a row: the folder for a locally measured row, GitHub for one read over the API |

## What refreshes the view

- activation, and any workspace-folder change;
- a change to `**/docs/help/registry.json` (created, changed, deleted) — it changes the shape of the tree;
- a change to `**/docs/help/index.json` or `**/docs/help/page-meta.json` — they change the provenance the items
  display;
- an explicit refresh.

Everything else, including saving a page, does not refresh: the tree describes structure, not prose.

## Rules the code follows

- **One writer, on request, and never inside a repository.** The only write the extension makes to the folder
you opened is creating the empty file for a page the registry already declares. What it downloads — the
runtime, a model, the manifest that records them — goes to its own storage folder, or to the folder a setting
names.
- **A diagnostic lands where the fix is** — the page for a page problem, `registry.json` for a missing file
  or an unreadable registry.
- **Counts are not problems.** `reviewed: null` and empty tag lists are normal in a 335-page registry; as
  warnings they would bury the faults that matter.
- **No module knows about the fork.** Nothing references `temco-knowledge-studio`, by design.
- **Nothing is fetched unasked.** The only network calls are the runtime and model downloads the user starts
  from *Models and Runtime*, and the dashboard read the user starts from *Documentation Dashboard*: no telemetry,
  no update check, no background refresh. A token lives in secret storage, never in a file or a setting.
- **Nothing native ships.** A compiled engine is per-OS; a downloaded one is not, which is what keeps one
  `.vsix` valid on every platform — our application, plain VS Code, Windows or macOS.
- **Building is not shipping.** The build commands invoke the repository's own scripts and report what those
  scripts produced. The form that deploys into a T3000 installation is never run, and nothing is uploaded or
  committed.
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
| 2 | **the AI** — model download, worker, draft page updates from a commit range, ask-the-area | a local model, offline; drafts only, a human accepts |
| 3 | **publishing** — invoke the product repo's site build and offline help build, then hand over the artifacts | the extension orchestrates; it does not reimplement the pipeline |
| 4 | **the dashboard** — every repository in the organisation: pages, owner, last change, gaps | GitHub API, no clones, token in secret storage |
| 5 | **feedback and health** — intake, staleness routing, the `/_admin/` page | grows out of the same collector as the dashboard |

The step-level list — what each step touches, its acceptance test and what is blocked — is
[`plan.md`](plan.md). This table is the summary; `plan.md` is what work is pointed at.

Phase 2 is the reason this repo exists. Everything before it is what the AI needs in order to know what it is
talking about.
