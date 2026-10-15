# Temco Knowledge Studio — extension

The platform that keeps Temco's product technical content (documentation and training) in step with the
code. It is delivered two ways from this one codebase:

- bundled inside **Temco Knowledge Studio**, our own desktop application (a branded build of VS Code), and
- installed into an ordinary VS Code for engineers who already have one.

**This repository holds no content.** There is no page, no image and no registry here — the extension
operates on the **project being worked on**, whose sources are product repositories, read wherever they live.

## What it does

Four surfaces from one extension — the same in our own application and in an ordinary VS Code:

- **Workspace** (activity bar, above the Library) — the pages of the project being worked on, as
  areas → chapters → pages, with the metadata a maintainer needs (owner, audience, whether the page ships,
  whether it was ever reviewed) and, from the source's own generated files, each page's last change, its
  headings, and whether the code it claims moved on since the last review. A **Gaps** node gathers every
  structural fault, problems land in the file that has to be fixed, and the status bar carries the totals.
- **Temco Knowledge** (right side) — the local AI: ask about the open page, *Draft update* (a diff you apply
  as one undoable edit), and *Ask the area* (an answer citing real pages, or search results when it cites
  none). The runtime and the models are downloaded on request, verified against their checksums, and run
  locally — nothing leaves the machine.
- **Documentation Owed** — the report of what needs attention, grouped by its owner.
- **Builds** — the open repository's own site and offline-help builds, invoked as tasks and judged by the
  artifact they leave behind, never by an exit code.

The **documentation dashboard is not one of them, deliberately.** Per `docs/design/help-platform/00-architecture.md`
it is a generated static page at `/docs/_admin/` in the docs site — coverage, stale by owner, docs-owed, unowned,
unreviewed, broken links, feedback, health score — built by the product repository's own pipeline, noindex, and
never shipped. This extension is the **hand-off target** its rows deep-link into; it neither generates nor
re-implements that page, and never writes under `_admin/`.

What it writes, and only when asked: the file for a registered page that has none, an empty registry in a folder
you have open that has none, a draft you apply (one `Ctrl+Z`), and the runtime and models you download (your own
folder, never a repository). Everything else is read, and nothing is published from here at all.

## Where to read more

| Document | Covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | the four folders, the flow, how it ships, the boundaries that must not blur |
| [`docs/registry-schema.md`](docs/registry-schema.md) | the registry we read, field by field, and where each check comes from |
| [`docs/extension-design.md`](docs/extension-design.md) | module responsibilities, the tree, the commands, the roadmap |
| [`docs/app-layout.md`](docs/app-layout.md) | the application window, the site's generated dashboard, and the seam between them |
| [`docs/plan.md`](docs/plan.md) | the numbered steps: what each one touches, its acceptance test, and what is blocked |
| [`docs/design/help-platform/`](docs/design/help-platform/README.md) | the platform design: 17 documents — content model, registry, search, the offline CHM, editing, AI, governance |

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
| 2 | **the AI** — the model list, the local runtime, the panel, drafts from a commit range, ask-the-area | done |
| 3 | publishing — the repository's own site and offline-help builds, judged by their artifacts | done |
| 4 | ~~the organisation read~~ — withdrawn: the dashboard is the product repository's generated page, and this is not a second one | 4.1–4.4 removed 2026-10-13; *Start a Registry* survives as the Content view's empty state |
| 5 | feedback and health — intake, the staleness report | done, bar two things that are not this repo's: the report's *schedule* (the product repo's CI) and the feedback file's shape (a proposal for the docs owner) |

Link checks, media audits and staleness verdicts are deliberately **not** on this list: they are the product
repository's gates, and a second implementation of them here would be a second answer to one question.

## Rules this codebase keeps

- **No product content, no secrets.** The only documentation here is this repository's own and the platform
  design in `docs/design/help-platform/`; a product's pages, images, registry and credentials stay in the
  product repositories. The extension works on whatever folder you open.
- **The AI drafts, a human approves.** A draft arrives as a diff and reaching the page takes a button and one
  `Ctrl+Z`; nothing is published from here at all.
- **Nothing native ships.** A compiled engine is per-OS, so the runtime and the models are downloaded on
  request into your own folder — which is what keeps one `.vsix` valid on every platform.
- **Nothing is fetched unasked.** Downloads are commands you ran; there is no
  telemetry and no background refresh, and a token lives in secret storage.
- **Building is not shipping.** Builds are invoked in the repository that owns them, and the form that deploys
  into a T3000 installation is never run.
- **No dependency on the desktop build.** If a feature only works inside our branded application, it is in
  the wrong repository.
