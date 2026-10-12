# Temco Knowledge Studio — extension

The platform that keeps Temco's product technical content (documentation and training) in step with the
code. It is delivered two ways from this one codebase:

- bundled inside **Temco Knowledge Studio**, our own desktop application (a branded build of VS Code), and
- installed into an ordinary VS Code for engineers who already have one.

**This repository holds no content.** There is no page, no image and no registry here — the extension
operates on the folder you open, which is a product repository.

## What is in it so far

A **Content** view in the activity bar, built from the registry of every open repository:

- areas → chapters → pages, with the metadata a maintainer actually needs (owner, audience, whether the
  page ships, whether it was ever reviewed);
- a **Gaps** node that gathers every page with a structural problem, so triage is one click instead of a
  search;
- structural problems surfaced as **problems**, in the file that has to be fixed: two pages sharing a
  title, two pages fighting over one position, a page whose id disagrees with its own area and chapter, or
  a registered page whose file does not exist;
- totals in the status bar, and commands to validate, refresh, open the registry, open a page, create the
  file for a registered page that has none, or reveal a page in the explorer.

It only reads. Nothing is written unless you ask for it, and nothing is published from here at all.

## Where to read more

| Document | Covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | the four folders, the flow, how it ships, the boundaries that must not blur |
| [`docs/registry-schema.md`](docs/registry-schema.md) | the registry we read, field by field, and where each check comes from |
| [`docs/extension-design.md`](docs/extension-design.md) | module responsibilities, the tree, the commands, the roadmap |
| [`docs/app-layout.md`](docs/app-layout.md) | the application window and the organisation dashboard |
| [`docs/plan.md`](docs/plan.md) | the numbered steps: what each one touches, its acceptance test, and what is blocked |
| [`docs/design/help-platform/`](docs/design/help-platform/README.md) | the platform design: 16 documents — content model, registry, search, the offline CHM, editing, AI, governance |

The platform design moved here from the product repo on 2026-10-12, because the design of a thing belongs
with the thing. Its paths (`docs/t3000/**`, `docs/help/registry.json`, `scripts/docs-*.mjs`) are paths in the
**product** repository, which is where the content and the publishing pipeline stay.

## Run it

```powershell
npm install
npm run compile
```

Press **F5** (or use the "Run Extension" launch configuration). A second VS Code window opens — the
Extension Development Host — with the extension loaded. In that window, run
**Temco Knowledge: Show Status** from the command palette and watch the *Temco Knowledge* output channel.

During development, run the `npm: watch` task so TypeScript recompiles on save.

## Package it

```powershell
npm run package
code --install-extension temco-knowledge-extension-0.0.1.vsix
```

## Planned, in order

The step-level task list is [`docs/plan.md`](docs/plan.md): that is where progress is marked, and where
*"implement phase 2, step 3"* points.

| Phase | Adds | State |
|---|---|---|
| 1 | the Content view — registry, checks, gaps, status bar | done |
| 2 | **the AI** — model download, worker, draft page updates from a commit range, ask-the-area | next |
| 3 | publishing — invoke the product repo's site build and offline help build, hand over the artifacts | planned |
| 4 | the dashboard — every repository in the organisation: pages, owner, last change, gaps | planned |
| 5 | feedback and health — intake, staleness routing, the `/_admin/` view | planned |

Link checks, media audits and staleness verdicts are deliberately **not** on this list: they are the product
repository's gates, and a second implementation of them here would be a second answer to one question.

## Rules this codebase keeps

- **No content, no secrets.** The extension is a tool; everything it works on lives in the product repos.
- **The AI drafts, a human approves.** Nothing is published from here without a named person accepting it.
- **No dependency on the desktop build.** If a feature only works inside our branded application, it is in
  the wrong repository.
