# Extension design

## Responsibilities, one file each

| Module | Owns |
|---|---|
| `src/registry.ts` | reading `docs/help/registry.json`, the page id → file rule, the structural checks, the counts. No VS Code UI beyond `Uri`, `WorkspaceFolder` and the filesystem |
| `src/tree.ts` | the Content view: which nodes exist, what they show, what a click does |
| `src/diagnostics.ts` | which issues become Problems, and on which file |
| `src/extension.ts` | activation, the view and status bar, the commands, the file watcher |

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
- Clicking a page opens the file; if the file does not exist, the click offers to create it.
- Areas and chapters are never empty: an area declared in `areas{}` with no pages still appears, which is
  itself information.

## Commands

| Command | Does |
|---|---|
| `temcoKnowledge.showStatus` | refreshes, writes the full report to the *Temco Knowledge* output channel, offers **Show Problems** |
| `temcoKnowledge.validate` | same, and is what the status-bar item and the view title button call |
| `temcoKnowledge.refresh` | re-reads the registries |
| `temcoKnowledge.openRegistry` | opens `registry.json` for the folder the node belongs to |
| `temcoKnowledge.openPage` | opens the page, or offers to create the missing file |
| `temcoKnowledge.revealPage` | reveals the page in the explorer |

## What refreshes the view

- activation, and any workspace-folder change;
- a change to `**/docs/help/registry.json` (created, changed, deleted) — the one file whose edits change the
  shape of the tree;
- an explicit refresh.

Everything else, including saving a page, does not refresh: the tree describes structure, not prose.

## Rules the code follows

- **One writer, and only on request.** The only write in the whole extension is creating an empty file for a
  page the registry already declares.
- **A diagnostic lands where the fix is** — the page for a page problem, `registry.json` for a missing file
  or an unreadable registry.
- **Counts are not problems.** `reviewed: null` and empty tag lists are normal in a 335-page registry; as
  warnings they would bury the faults that matter.
- **No module knows about the fork.** Nothing references `temco-knowledge-studio`, by design.
- **Nothing is fetched.** The extension makes no network call today; when the dashboard arrives it will be an
  explicit, opt-in feature with its own settings.

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
