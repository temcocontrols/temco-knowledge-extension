# Temco Platform — target architecture and the hand-over of `temco-knowledge-extension`

| | |
|---|---|
| **Status** | final for this repository — the last document written here |
| **Date** | 2026-10-15 |
| **Supersedes** | `Temco-Platform-Architecture-Single-Doc.md` (a sketch kept in Downloads) |
| **Applies to** | `temco-knowledge-studio` (the VS Code fork) once it becomes `temco-platform` |
| **The one rule that outlives this repository** | nothing was ever published from it, nothing was ever written to a source, and nothing was ever committed on anyone's behalf. Carry that forward. |

## Contents

1. What this is
2. The product, and the technology it is built on
3. Target shape
4. One repository — and what happens to the two we have
5. Repository layout
6. Platform code and extension code: the boundary
7. What this repository already is
8. The migration
9. Contracts that must not change by accident
10. The rules carried over
11. The product's stance
12. Decisions recorded here
13. Deliberately not built, and not to build
14. Release and gates
15. Where the detail lives
16. Closing remark

---

## 1. What this is

`temco-knowledge-extension` is one half of a two-repository product. The other half is `temco-knowledge-studio`, a
fork of VS Code that carries the branding, the packaging and the build, and bundles this extension.

This document is the **hand-over**: the target shape of the single repository the product moves to, exactly what
this repository contributes to it, what must survive the move, and what this repository deliberately leaves
undone. It is the last document written here on purpose — after the move, `temco-knowledge-studio` (renamed) is
the only repository, and everything below is history that a reader can still act on.

## 2. The product, and the technology it is built on

**VS Code is the technology foundation. Temco Platform is the product.**

The product is a desktop application that carries documentation, an offline AI, projects, repository reads, SQL
tools, network tools, BACnet tools and device management over one shell — one installer, one update path, one
place a person opens.

Two consequences follow from "VS Code is the foundation", and both are load-bearing:

- **the platform shell owns application behaviour** — branding, startup, the welcome experience, the default
  layout, top-level menus, shared services;
- **the feature modules are built-in extensions** — the same model VS Code itself uses for Git, JSON, npm and
  TypeScript, and the model the code in this repository already follows.

## 3. Target shape

```text
Temco Platform  (the product)
│
├── VS Code core                    the foundation — rarely touched
│
├── Temco Platform shell            branding · startup · welcome · layout · menus · shared services
│
├── Temco Docs                      the registry, the pages, the checks, the editor surfaces
├── Temco AI                       the local model, the drafts, the answers
├── Temco Projects                  documents, sources, outputs, builds
├── Temco Repositories              the organisation, clones, pulls, history
├── Temco SQL Tools                 registers, queries, export
├── Temco Network Tools             devices on the wire
├── Temco BACnet Tools              objects, points, trends
├── Temco Device Manager            fleets, firmware, health
│
└── future Temco modules            anything else the products need
```

Everything above the line and below the shell is a module. The shell is the only part that **must** be platform
code; a module that only works inside the fork is a module in the wrong place.

## 4. One repository — and what happens to the two we have

The decision, in one line: **one repository for all Temco-owned functionality, and no separate repositories for
modules unless there is a business reason that cannot be argued away.**

What that means concretely for today's two repositories:

| Today | Becomes | Note |
|---|---|---|
| `temco-knowledge-studio` (VS Code fork: branding, packaging) | **`temco-platform`** — renamed, and the single repository | the fork's own build keeps producing the desktop application |
| `temco-knowledge-extension` (this repository) | **archived, read-only**, once its code is in `temco-platform/extensions/` | its history stays: every rule and every reason is in `docs/` and `docs/design/help-platform/` |
| `T3000Webview-EEZ-Studio` and the other product repositories | unchanged | **the platform holds no product content** — pages live in the product repositories, and that does not change because the tool merged |
| `docfx` | a pinned sibling, as now | the publishing engine is not vendored |

Two things to do in that order: move the code, then archive — never the other way round, and never with the two
copying each other. The tag or commit id of this repository's last state belongs in the platform's own history
notes, so a bisect can still find the original.

## 5. Repository layout

```text
temco-platform
│
├── src
│   └── vs                          VS Code core — see below
│
├── src/temco                       the platform shell: our code in the product's own tree
│   ├── branding                    product identity, names, icons, about
│   ├── startup                     what happens on launch, and in what order
│   ├── welcome                     the welcome experience, ours, not VS Code's
│   ├── menus                       top-level menu contributions
│   ├── layout                      the default layout a first run opens with
│   └── services                    shared services the modules may use
│
├── extensions                      every Temco module, one folder each, each a real extension
│   ├── temco-docs
│   ├── temco-ai
│   ├── temco-projects
│   ├── temco-repositories
│   ├── temco-sql
│   ├── temco-nettools
│   ├── temco-device-manager
│   └── temco-bacnet
│
├── resources                       logos, images, branding assets
├── build                           build and packaging
├── cli                             command-line entry points
├── scripts                         maintenance tooling
├── test                            tests
└── remote                          the remote side, if the product ever has one
```

Inside `src/vs`:

| Path | What it is | How we treat it |
|---|---|---|
| `src/vs/editor` | Monaco and the editing engine | **do not modify**; if a change is needed, it is a module's job, not the core's |
| `src/vs/workbench` | the application shell: menus, activity bar, sidebar, views, panels, layout, welcome | **most platform customisation belongs here** |
| `src/vs/platform` | core services: storage, configuration, commands, files, telemetry | **only when necessary**, and always as a service a module consumes |

### Every module is still an extension

`extensions/temco-*` are **built-in extensions** in the fork's build, and **standard extensions** everywhere
else. Each keeps its own `package.json`, its own `tsconfig.json`, its own `node_modules` and its own `.vsix`
build, so:

- a module can be packaged and installed into ordinary VS Code, and run there — that is the test that keeps the
  boundary honest, and it is the reason a defect in a module cannot hide behind the shell;
- the platform can ship a fix to one module without rebuilding the core;
- a module's rules, its storage and its settings stay its own.

**A module must never assume the shell.** If a feature only works inside `temco-platform`, it is broken, not
integrated.

## 6. Platform code and extension code: the boundary

| Belongs in `src/temco` (the shell) | Belongs in `extensions/*` (a module) |
|---|---|
| product branding, names, icons, the About surface | everything that reads or writes a document, a registry or a page |
| the startup workflow and what it opens | the AI: the model, the prompts, the panels, the pages |
| the welcome experience | the organisation, the clones, the pulls, the history |
| the default layout of a first run | projects, sources, outputs, builds |
| top-level menus (`File · Edit · Doc · Project · AI · Tools · Help`) | SQL, network, BACnet, device views and commands |
| shared services both the shell and modules use | anything that can be a command, a view or a page |

The test for an awkward case: **could this ship as a `.vsix` and be useful in plain VS Code?** If yes, it is a
module. If it is only meaningful as part of the product's own identity or startup, it is the shell.

## 7. What this repository already is

This is the part a green-field document cannot tell you: the docs, AI, projects and repositories modules are
**built**, and they are what moves. Their shape is described in `docs/platform-design.md`; the numbers here are
what the code actually holds today.

### The surface a person uses

| | |
|---|---|
| **Commands** | 62, all named `temcoKnowledge.*`, each registered exactly once — `npm run compile` fails if an id is registered twice, because a duplicate throws in the middle of activation and everything below it silently never runs |
| **The Workspace view** | the project being worked on, as a tree: repository ▸ area ▸ chapter ▸ page, in VS Code's own tree widget, so left click opens a page or expands a folder, right click (or the keyboard's menu key) opens the row's menu, and the toolbar carries *New page · New chapter · Refresh* with the same list in its `…` for the row the tree last had focused |
| **The Library view** | projects · sources · **repositories** · catalog · needs attention · the AI, each row opening a page or a menu of its own |
| **Pages** (webviews, one tab group, never a split) | the dashboard, the projects list, a project's hub, create/edit a project, what needs doing, **the AI**, **the organisation's repositories**, and **New page** — the form that creates a page |
| **The AI panel** | a webview view in the secondary side bar: ask, *Draft update* (a diff a person applies), *Ask the area*, streaming answers, citations that open the page they name |
| **The Problems it raises** | structural faults, marked in the file that has to be fixed — a page's fault in the page, a registry's fault in `registry.json` |

### What it knows

| | |
|---|---|
| **The catalog** | `node:sqlite`, 12 tables, schema version 1, at `<globalStorageUri>/catalog/catalog.db` — **in the extension's own storage, never in a repository, never committed**. Documents, sources, pages, artifacts, builds, scans and events; the platform's memory |
| **A read** | a source read **local** (its folder), **over the API** (its registry through the contents API at a chosen branch, with a token from secret storage or the `gh` CLI), or from the **working area** (a clone) |
| **The working area** | `temcoKnowledge.workspaceFolder`, default `~/TemcoKnowledge`, laid out `<project>/<source>/` for a clone and `<project>/work/` for what we make. **Clone single-branch with full history, pull `--ff-only`, remove the copy alone.** Never automatic, never written to the origin, never pushed |
| **The AI** | a local llama.cpp runtime and model, downloaded on request into the user's own folder, run on loopback, stopped when idle. Six prompts in `prompts/*.md` (`system · ask · draft · area · newpage · analyse`), versioned by `PROMPT_VERSION` (`ai-v4`), reviewable as text because they are text |
| **The checks** | structural faults from the registry itself; counts (never reviewed, unshipped) as counts, never as problems; and the generator's own `stale` verdict read from `index.json`, **never recomputed here** |
| **The builds** | the product repository's own scripts, invoked as tasks and judged by the artifact they leave behind: `docs:registry`, `docs:verify`, `docs:media:check`, `docs:owed`, `docs:site`, `build:help:dry` — and **never** the form that deploys |

### Settings it contributes

`temcoKnowledge.ai.modelFolder` · `ai.allowUnpinned` · `ai.runtime` · `ai.model` · `ai.idleMinutes` ·
`start.open` · `organisation` · `workspaceFolder`.

### The file map

```text
src/extension.ts       activation: the views, the status bar, the commands, the refresh, the watchers
src/registry.ts        the registry model: areas ▸ chapters ▸ pages, the checks, the path rules
src/tree.ts            the Workspace tree's rows, icons, colours, tooltips and empty-state notes
src/views.ts           the Library: projects · sources · repositories · catalog · needs attention · the AI
src/diagnostics.ts     issues into Problems, in the file that has to be fixed
src/pageOps.ts         operating on a page: create · rename the title · move · retire · the drag controller
                       — and `writePage()`, the one write that makes a page
src/rowOps.ts          where a row is: reveal in the OS · a terminal · copy a path
src/registryEdit.ts    one named value of registry.json, rendered the way its own generator renders it
src/read.ts            reading a source (local · api) and recording what it found
src/repository.ts      the organisation's list · a source's code files · one file's text
src/workarea.ts        where the local copies live: clone · pull · open · remove, and the folder we own
src/builds.ts          the product repository's own scripts, invoked and reported
src/report.ts          the staleness report, and src/feedback.ts the feedback rows
src/scaffold.ts        a registry in a folder that has none · src/selected.ts which project is being worked on
src/surface.ts         the one-tab-group rule — `ViewColumn` is named only here
src/home.ts            the dashboard · projectsPage · projectHub · projectPage · needsPage · aiPage
src/repositoriesPage.ts  the organisation, and Start · Fetch · Pull on a repository
src/newPagePage.ts     the form that creates a page, drafts it, and asks what the source is missing
src/format.ts          the Markdown toolbar (editor menus) · src/project*.ts the project surfaces
src/catalog/           schema.ts (the tables) · store.ts (node:sqlite) · commands.ts (the catalog status)
src/ai/                catalog · install · runtime · prompts · history · citations · panel · commands · machine
media/                 knowledge.svg (the activity-bar icon); ai-panel.js/.css (the AI panel)
prompts/               the instruction text the model receives — the six prompts named above
docs/                  this repository's docs; docs/design/help-platform/ is the platform design (17 documents)
scripts/               check-commands.mjs — the guard that a command id is never registered twice
```

## 8. The migration

The move is mechanical first and architectural second. Four waves, each ending in a working product:

| Wave | What moves | Where it lands | The gate |
|---|---|---|---|
| **0 · lift** | the whole extension as it stands | `extensions/temco-docs` (one module, all of it) | the fork builds; the extension activates in ordinary VS Code from a `.vsix`; `npm run compile` clean; 62 commands |
| **1 · split** | the AI (`src/ai/*`, the panel, `aiPage`, the AI commands, `prompts/`) | `extensions/temco-ai`, talking to the docs module through **commands the docs module already declares** | both modules activate; the AI panel still answers about the open page |
| **2 · split** | the organisation, clones and history (`repository.ts`, `workarea.ts`, `repositoriesPage.ts`) | `extensions/temco-repositories` | Fetch · Pull · Open · Remove still work, and the docs module still reads a cloned source from disk |
| **3 · shell** | branding, welcome, layout, menus, the About surface | `src/temco/*` in the fork | the product opens as Temco, and every module still runs in plain VS Code |

Notes that will save a week:

- **Wave 0 is deliberately a lift, not a rewrite.** The extension has no runtime dependencies, so it drops into
  `extensions/` as it is. Prove the platform builds and the modules still work before splitting anything.
- **The split is by command surface, not by folder tidiness.** The catalog, the registry and the writes stay with
  the docs module — the other modules *use* them, and a shared "platform" module that owns the catalog would make
  the docs module's rules someone else's business.
- **Every split is a chance to break storage.** The catalog lives under the extension id's `globalStorageUri`; a
  module with a new id gets a new empty folder. Read §9 before any id changes.
- **One tab-group rule, six prompts, one write.** `src/surface.ts`, `prompts/*.md` and `pageOps.writePage()` are
  the three places where "how this behaves" lives. Move them first, or move them last, but do not leave two
  versions of them alive at once.

## 9. Contracts that must not change by accident

These are user-visible, or they hold state. Changing any one of them without a migration loses something real:

| Contract | Today | If it changes |
|---|---|---|
| extension id | `temcocontrols.temco-knowledge-extension` | **the catalog folder changes and every project, source and scan is gone** from the user's point of view |
| catalog path | `<globalStorageUri>/catalog/catalog.db` | same as above — migrate the file, or keep the id |
| settings ids | `temcoKnowledge.*` (eight of them) | a person's model choice, organisation and working-area path silently reset |
| working-area path | `temcoKnowledge.workspaceFolder`, default `~/TemcoKnowledge` | clones are orphaned on disk (harmless, but confusing) |
| command ids | `temcoKnowledge.*`, 62 of them | keybindings, menus and any user's scripts that call them stop working |
| view ids | `temcoKnowledge.pages`, `temcoKnowledge.library`, `temcoKnowledge.ai`, `temcoKnowledgePanel` | layout settings and the AI panel's placement reset |
| the catalog schema | version 1, 12 tables | a migration is needed, and the schema file says which version it is |
| prompt files | `prompts/*.md`, `PROMPT_VERSION = 'ai-v4'` | drafts stop being traceable to the instructions behind them |

**The rule:** rename ids only in a release that migrates state, and never in the same release as the move.

## 10. The rules carried over

These are the constitution of this repository. They are not implementation details; they are why the product can
be trusted with a customer's repositories.

1. **Read-only by default.** Reading is what it does. It writes in exactly five cases, each its own command, each
   a modal confirmation naming the path or the value before it happens:
   (a) the empty file for a page the registry already declares; (b) an empty `docs/help/registry.json` in a folder
   that has none; (c) **a new page file**, from a kind's heading skeleton or carrying a draft the person read;
   (d) **one curated value** in an existing registry — a title, an order, a chapter, a retirement — rendered the
   way the repository's own generator renders it; (e) **the working area** — our own folder, where a source is
   cloned and pulled and where what we make is written.
2. **Nothing is ever written to a source, and nothing is ever pushed.** A clone is a copy we own; the origin is
   read, never touched.
3. **No page's file is ever renamed or moved, and no page is ever deleted.** The page id *is* its path, and a
   retired page keeps its file so its redirect keeps working. Retirement is the act; deletion is not offered.
4. **Never publish, never deploy.** The extension invokes the product repository's own build scripts and reports
   the artifacts they leave behind. It never runs the form that deploys, and it never reimplements the pipeline.
5. **Nothing native ships.** A compiled runtime is per-OS: the runtime and the models are downloaded on request
   into the user's own folder, never bundled, and the engine runs on loopback only.
6. **The platform holds no product content and no secrets.** No page, image, registry or credential from a
   product belongs in the platform's repository.
7. **An extension must never depend on the fork.** A module that only works inside `temco-platform` is in the
   wrong place.
8. **Nothing is computed twice.** Staleness, owed pages and structural faults are the product repositories' own
   verdicts, read and reported — never recomputed here.
9. **Strict TypeScript, no surprises.** `tsc` clean, no runtime dependency without asking, and the compile gate
   also refuses a command id registered twice.
10. **Never commit on anyone's behalf.**

## 11. The product's stance

A VS Code fork arrives with opinions switched on. Decide these deliberately, in the shell, before the first
release:

| | Recommendation | Why |
|---|---|---|
| **Telemetry** | off, with an explicit setting to turn it on | the modules read a customer's repositories; a product that phones home about that is a different product |
| **Update checks** | ours, and only to our own endpoint | the foundation's default points at Microsoft's |
| **Marketplace calls** | off unless a person installs something | a documentation tool has no reason to call the gallery on startup |
| **The welcome page** | ours | it is the product's front door, and the shell owns it |
| **Crash reporting** | off unless asked | same reason as telemetry |
| **The AI** | local, on loopback, downloaded on request | nothing about a customer's code leaves the machine. The models are the one thing worth a download dialog |
| **The network** | only where a person asked: reading a repository over the API, or fetching a local copy | both need a token, both are reads, and neither happens by itself |

## 12. Decisions recorded here

| Decision | Taken |
|---|---|
| One repository | **yes** — `temco-platform`; the fork is renamed, this repository is archived |
| Split into modules now, or lift first? | **lift first** (wave 0), split only where a module has an interface worth having |
| Version the ids with the move? | **no** — keep the extension id, the storage folder, the settings ids and the command ids, and migrate state in a release of its own if a rename is ever wanted |
| Where the modules live | `extensions/temco-*`, each a standard extension that also builds as a `.vsix` |
| Where the shell lives | `src/temco/*`, and `src/vs/*` is touched only where the product's behaviour requires it |
| What the platform's default branch is | one branch, one release line; a module's fix ships as a platform release, not as a side channel |
| Who owns a module | the team that owns the documentation the module serves — this product has no separate platform team |

## 13. Deliberately not built, and not to build

- **Publishing or deploying** anything, from any surface.
- **Renaming or deleting a page's file** — the id is the path; retirement replaces deletion.
- **A second index.** The catalog is the record. A JSON copy beside the clones would be two answers to one
  question, and the wrong one would win eventually.
- **Recomputing a product repository's verdicts** — staleness, owed pages, broken links belong to that
  repository's own generator.
- **A page for everything.** The Markdown toolbar lives in the editor's own menus; a menu belongs on the thing it
  acts on; and an empty state is a sentence a view draws itself, not a welcome screen that guesses.
- **An organisation dashboard of our own**: the site's generated dashboard answers that question, and the
  platform hands off to it rather than re-implementing it.

## 14. Release and gates

What a release of the platform must run, in this order:

1. `npm run compile` in every module (for the docs module, `tsc` **and** `scripts/check-commands.mjs`).
2. The module's own behaviour check, which for the pages is a syntax check of the *generated* script: a page's
   script lives inside a template literal, so the compiler cannot see a mistake in it.
3. The platform build, with the modules picked up as built-ins.
4. A manual pass in the running product: the Workspace view, a page, the AI panel, one write with its
   confirmation, one clone, one build.
5. The `.vsix` of each module, installed into ordinary VS Code, activated once — **that is the boundary test**,
   and a release that skips it is the release that quietly grows a dependency on the fork.

Versioning: the platform and each module carry their own version; a module's version changes when its surface
changes; the platform's version changes when anything in it ships. One changelog, in the platform, with a section
per module — the modules' own `CHANGELOG.md` files are the detail.

## 15. Where the detail lives

| | |
|---|---|
| `docs/platform-design.md` | the platform's own design: sources → documents → artifacts, the catalog, the AI over history, the surfaces, the decisions, the build order |
| `docs/design/help-platform/` | the 17 documents of the help platform — content and registry, the DocFX engine, search, offline builds, editing and git, feedback, releases, review, AI, governance, the online editor, and the management overview. `05-content-and-registry.md` and `12-ai-features.md` govern most of what this repository does |
| `docs/architecture.md` | how this repository is put together, module by module |
| `docs/extension-design.md` | every command, what it does, and where it surfaces |
| `docs/editor-design.md` | the editor surfaces, and the decision about how far the extension may go into a product repository |
| `docs/registry-schema.md` | `registry.json`, field by field |
| `docs/app-layout.md` | the application's own layout |
| `docs/plan.md` | what was planned here, and where progress was marked |

## 16. Closing remark

This repository was built to do three things: **read** a product's documentation repository and say what is wrong
with it, **write** a page only when a person asked for exactly that file and saw the confirmation, and **keep its
own memory** — the catalog — on the machine it runs on, never in a repository, never committed.

It did not publish, did not deploy, did not write to a source, and did not commit on anyone's behalf. Everything
the platform needs from it is in `extensions/`, in `prompts/`, and in the rules in §10 — and the rules are the
part worth carrying over in full, because they are the reason a customer can point this product at a repository
and go home.

After the move, this repository is archived read-only. Keep this document in the platform, under
`docs/design/`, so that the next person who asks "why is it done this way?" finds the answer rather than the
guess.
