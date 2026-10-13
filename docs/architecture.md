# Architecture

## The four folders

```
C:\QN\temcocontrols\
│
├─ T3000Webview-EEZ-Studio        the product repo — the content lives here
│   ├─ docs/t3000/**              the pages, one folder per chapter
│   ├─ docs/help/registry.json    the structure: areas, pages, owners, order
│   ├─ docs/help/index.json       generated: headings + git provenance
│   ├─ docs/toc.yml  **/toc.yml   generated navigation
│   ├─ docs/templates/t3000/      the site template: brand, page-meta bar
│   ├─ dist/docs/                 generated site — the engine output
│   └─ scripts/docs-*.mjs         the build side: registry, gates, changelog, media
│
├─ temco-knowledge-extension      the extension — every feature lives here
│   ├─ src/registry.ts            reads the registry, runs the structural checks
│   ├─ src/tree.ts                the Content view: areas, chapters, pages, gaps
│   ├─ src/diagnostics.ts         problems, in the file that has to be fixed
│   ├─ src/extension.ts           view, status bar, commands, file watcher
│   ├─ media/knowledge.svg        the view icon
│   └─ docs/design/help-platform/ the platform design (16 documents), moved here 2026-10-12
│
├─ temco-knowledge-studio         the application — the fork of VS Code
│   ├─ product.json               branding: name, icon, protocol, gallery
│   ├─ extensions/                the .vsix is placed here when the app is built
│   └─ packaging/                 fork + extension → one installer
│
└─ docfx                          the publishing engine — upstream, pinned
                                  never modified; a version bump only
```

## The flow

```
   open a product repo in the editor
        │
        ▼
   read     docs/help/registry.json   →  areas · chapters · pages · owners · order
        │
        ▼
   show     Content view              →  pages, chapters, issues, never reviewed
        │                                Gaps → only the pages with a real fault
        ▼
   check    file exists · id agrees with area/chapter · title unique · order unique
        │
        ▼
   fetch    phase 2 · the runtime and a model are downloaded on request, into the user's own folder
        │
        ▼
   serve    phase 2 · the local server starts on demand, on loopback only, and stops when it is idle
        │
        ▼
   draft    phase 2 · the local AI reads a commit range and proposes page edits
        │
        ▼
   approve  phase 2 · a named human accepts; nothing else ever writes
        │
        ▼
   publish  phase 3 · docfx build      →  site  →  portal
                       help build       →  CHM   →  ships with the installer
```

## How it ships

```
   our application   →  TemcoKnowledgeStudio-Setup.exe
                        ├─ our branded build of VS Code  ("Temco Knowledge Studio")
                        └─ + the extension, preinstalled

   plain VS Code     →  VS Code from Microsoft
                        └─ + temco-knowledge-extension-0.1.0.vsix  (Install from VSIX)

   same extension · same view · same checks · same AI — only the packaging differs

   what a customer installation gets

   T3000
     └─ T3000_Help.chm      the only artifact from this platform
                            no extension, no editor, no AI, no registry
```

## The published portal (target)

```
   /                          hub home: what is inside, what changed recently
   /t3000/                    product area — the pages exactly as they are today
   /t3000/api-reference/…     chapter → page
   /_admin/                   health: owners, gaps, staleness
   /firmware/                 a second product later, from the same generator
```

## The three boundaries that must not blur

1. **Content never moves.** Pages stay at `docs/t3000/**` in the product repo, which is why the application,
   the MCP tools and the F1 help keep working untouched. This extension only reads them. One deliberate
   exception, made on 2026-10-12: the platform **design** moved from the product repo's `docs/design/` to
   `docs/design/help-platform/` here, because the design of a thing belongs with the thing. The product repo
   keeps the content and the pipeline; it no longer registers or publishes the design pages.
2. **The application is packaging, not features.** `temco-knowledge-studio` holds branding and the build. The
   extension must never depend on something only the fork provides, or it stops working in plain VS Code.
3. **One artifact crosses into a customer installation.** The CHM. No editor, no registry, no AI runtime.

## Decisions already made, so they are not re-litigated

- The publishing engine is **pinned, never patched** unless a real need appears; the fork of it, if it ever
  happens, lives as commits in our own repo, not as loose patch files.
- One repository for the extension, one for the application fork. No submodules in either direction — the
  application consumes the extension as a packaged `.vsix`, pinned to a version.
- The AI drafts and a named human approves. Nothing publishes itself.
