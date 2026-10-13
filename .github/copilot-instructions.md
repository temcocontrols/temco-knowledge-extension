# Working in this repository

Read this first — it is what makes an assistant useful here instead of guessing.

## What this repository is

`temco-knowledge-extension` is the **extension only**. It is one half of a two-repo product:

| Repo | What it holds |
|---|---|
| **`temco-knowledge-extension`** (here) | every feature: registry reading, checks, the AI, the model manager, publishing |
| `temco-knowledge-studio` | the application — a fork of VS Code that carries branding and packaging, and bundles this extension |

The application name is **Temco Knowledge Studio**. The published portal is **Temco Knowledge**. The extension
keeps this repo's own name, `temco-knowledge-extension`, because that is its identity for installs.

**The content lives elsewhere.** Documentation pages and `docs/help/registry.json` live in each product
repository (today: `T3000Webview-EEZ-Studio`). **The platform design is here**, in `docs/design/help-platform/`
— 16 documents, of which these matter most:

| Document | Why it matters to this repo |
|---|---|
| `05-content-and-registry.md` | the registry schema we consume |
| `12-ai-features.md` | what the AI is allowed to do |
| `15-online-editor.md` | the editor surfaces |
| `16-management-overview.md` | the whole picture, for management |

The paths those documents name (`docs/t3000/**`, `docs/help/*.json`, `docs/docfx.json`, `scripts/docs-*.mjs`)
belong to the **product** repository, which keeps the content and the publishing pipeline.

## Hard rules

1. **No product content, no secrets.** Never add a product's page, image, registry or any credential to this
   repo. The only documentation that lives here is this repository's own plus the platform design in
   `docs/design/help-platform/`. The extension operates on whatever folder is open.
2. **Read-only by default.** The only write allowed without an explicit user command is creating the empty
   file for a page that the registry already declares. Never edit `registry.json`, and never commit on the
   user's behalf.
3. **Never publish.** Building and shipping artifacts happens through commands in the product repo. This
   extension may invoke them, never reimplement them.
4. **Nothing native ships, and downloads are asked for.** A compiled inference engine is per-OS, so the
   runtime and the models are downloaded on request into the user's own folder — never bundled, never written
   into a repository, always a command the user ran.
4. **No dependency on the fork.** If a feature only works inside `temco-knowledge-studio`, it is in the wrong
   place. The extension must keep working when installed into ordinary VS Code — that is the whole reason it
   is an extension.
5. **Strict TypeScript, no surprises.** `tsc` must stay clean with the settings in `tsconfig.json`. Do not add
   a runtime dependency without asking; the extension's value is that it is portable and auditable.

## Where things are

```
src/registry.ts      reads docs/help/registry.json + the generated index.json/page-meta.json, runs the checks
src/tree.ts          the Content view (areas, chapters, pages, Gaps, issue children, provenance in tooltips)
src/diagnostics.ts   turns issues into Problems, in the file that has to be fixed
src/extension.ts     activation: view, status bar, commands, file watcher
src/ai/              catalog.ts (what can be downloaded), install.ts (download/verify/unpack), commands.ts (the list)
media/knowledge.svg  the activity-bar icon
docs/                this repository's docs; docs/design/help-platform/ is the platform design
```

Contributed surface lives in `package.json`: one view container (`temcoKnowledge`), one view
(`temcoKnowledge.pages`) and the commands — all named `temcoKnowledge.*`.

## Conventions

- **A diagnostic must land where the fix is.** A problem with an existing page is marked in that page; a
  registered page whose file is missing is marked on `registry.json`.
- **Counts are not problems.** `reviewed: null` and empty `tags`/`keywords` are normal in a large registry.
  Surfacing them as warnings buries the real faults, so they are counts in the tree and the status bar. The
  same holds for staleness: the generator's `stale` verdict is read from `index.json` and shown as a marker and
  a count — never recomputed here, never a problem.
- **Comments explain why, not what.** Keep them short and truthful; if a comment and the code disagree, the
  comment is wrong.
- **English only** in code, comments and user-visible strings.

## Commands

```powershell
npm install
npm run compile        # tsc -> out/
npm run watch          # during development
npm run package        # vsce package -> temco-knowledge-extension-x.y.z.vsix
```

Press **F5** for an Extension Development Host. Open a product repository (`T3000Webview-EEZ-Studio`) as the
folder — this repo alone has no registry, so the Content view will correctly show nothing.

## What is planned, in order

[`docs/plan.md`](docs/plan.md) is the step-level list and the only place progress is marked: phase 1 the
Content view (done), 2 the local AI, 3 publishing, 4 the portfolio dashboard, 5 feedback and health. Point a
session at a step — "implement phase 2, step 3" — and it finds the acceptance test and the blockers.

Details for each phase are in `docs/`.
