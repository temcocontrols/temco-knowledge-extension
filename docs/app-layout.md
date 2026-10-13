# The application window

What the extension looks like inside **Temco Knowledge Studio** — the shell's panels are unmodified, and only
two of the five areas are ours.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Temco Knowledge Studio  -  T3000Webview-EEZ-Studio                                           │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│   │ CONTENT             │ data-points.md              Preview │ TEMCO KNOWLEDGE   (local AI) │
│   ├─────────────────────┼─────────────────────────────────────┼──────────────────────────────┤
│ ▣ │ ▾ t3000             │ 1  # Data Points API                │ You   summarise this page    │
│   │   ▾ api-reference   │ 2                                   │ AI    This page lists the API│
│   │     Data Points API │ 3  Read and write the data points   │       points; 14 months old. │
│   │     Database Mgmt   │ 4  of a controller. Each point has a│       Two points are missing.│
│   │   ▾ trends          │ 5  type, a unit and a scaling.      │                              │
│   │ ! Gaps              │ 6                                   │ [ Draft update ] [ Ask area ]│
│   │                     │ 7  Point . Type . Unit . Scaling    │ local  qwen2.5-3b  -  offline│
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│ PROBLEMS   OUTPUT   TERMINAL                                                                 │
│ !  data-points.md   Order 20 is used by more than one page in "api-reference".               │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│   335 pages - 12 issues - 341 never reviewed         Markdown  -  Ln 3, Col 1  -  UTF-8      │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Panel | What it is | Whose |
|---|---|---|
| **▣ Content** | the docs tree: areas → chapters → pages, counts on the right, **Gaps** at the bottom | ours — the only view that does not exist in ordinary VS Code |
| **Editor** | the page: plain Markdown, no front matter, Preview beside it | the shell's |
| **Temco Knowledge** | the AI: chat about the open page, `Draft update`, `Ask the area`, and which model is loaded | ours |
| **Problems** | structural faults only, each naming the file to fix | ours |
| **Status bar** | `pages · issues · never reviewed` | mixed |

Three properties of this layout are decisions, not accidents:

1. **The only new real estate is the Content view and the AI panel.** Search, source control, compare,
   terminals, Markdown preview and the problem list are the shell's, already there, nothing to build.
2. **The AI is a panel beside the page, not a separate application.** It reads the page you have open and the
   registry; `Draft update` writes a normal edit you review — so accepting is a diff, rejecting is `Ctrl+Z`.
3. **Both of our areas exist now.** The Content view is phase 1; the AI panel is phase 2, and the mock above
   is the panel as built — same place, same buttons, so the layout never had to move.

## Two worlds, and the seam between them

**The dashboard is not in this application.** `00-architecture.md` puts it on the **site**: a **generated
static page** at `/docs/_admin/` — coverage · stale by owner · docs-owed · unowned pages · broken links ·
feedback · help-id coverage — noindex, excluded from the PDF, the CHM and the offline zip, and produced by the
**product repository's** own pipeline (`13-implementation-plan.md` step 1.19 / 24). Nothing in this extension
generates it, and nothing here writes into `_admin/`: the design's rule is that those are *generated pages, not
documentation*.

What the extension does in that relationship is be the **hand-off target**. A dashboard row deep-links into the
editor (`vscode://file/…`), and this is where the page gets fixed:

```
┌── PRODUCT REPO ── the content lives here ──┐    ┌── THE EDITOR ── Temco Knowledge Studio / plain VS Code ──┐
│                                            │    │                                                          │
│  docs/t3000/**            the pages         │    │  ▣ Temco Knowledge            (activity bar, ours)       │
│  docs/help/registry.json  the structure     │    │   ┌──────────────────────────────────────────────────┐   │
│  scripts/docs-*.mjs       the generators    │    │   │ CONTENT                                          │   │
│                                            │    │   │  ▾ t3000                                         │   │
│ ┌─ READ SITE (ships) ────────────────────┐ │    │   │    ▾ api-reference                               │   │
│ │ /docs/          everything published   │ │    │   │      Data Points API   (wrong order)             │   │
│ │ /docs/feed/*.xml  changelog + releases │ │    │   │        └ why: Order 20 already used              │   │
│ │ /docs/T3000-Learn.pdf                  │ │    │   │    ▾ trends                                      │   │
│ │ /docs/T3000-Docs-<v>.zip               │ │    │   │  ! Gaps (12)                                     │   │
│ └────────────────────────────────────────┘ │    │   └──────────────────────────────────────────────────┘   │
│                                            │    │                                                          │
│ ┌─ AUTHORING SURFACE (never ships) ──────┐ │    │   ┌─ right side ──────────────────────────────────────┐   │
│ │ :8080   docfx preview — authoring only │ │    │   │ TEMCO KNOWLEDGE                        (the AI)    │   │
│ │                                        │ │    │   │ You  summarise this page                          │   │
│ │ /docs/_admin/   GENERATED DASHBOARD    │ │    │   │ AI   This page lists the API points; 14 months    │   │
│ │   coverage · stale by owner ·          │ │    │   │      old. Two points are missing.                 │   │
│ │   docs-owed · unowned · unreviewed ·   │ │    │   │ [ Draft update ] [ Ask the area ] [ Models… ]     │   │
│ │   broken links · feedback ·            │ │    │   └───────────────────────────────────────────────────┘   │
│ │   help-id coverage · health score      │ │    │   ┌─ bottom panel ────────────────────────────────────┐   │
│ │   noindex · out of PDF/CHM/zip         │ │    │   │ PROBLEMS  OUTPUT  TERMINAL                        │   │
│ │                                        │ │    │   │  ! data-points.md   Order 20 is used twice        │   │
│ │   each row  ──►  vscode://file/…  ─────┼─┼────┼──►  the page opens in the editor, ready to fix           │
│ │   each row  ──►  /docs/edit/<page-id>  │ │    │   └───────────────────────────────────────────────────┘   │
│ │                  (phase 3, hosted)     │ │    │                                                          │
│ └────────────────────────────────────────┘ │    │   status bar:  335 pages · 12 issues · 341 never reviewed │
│                                            │    │                                                          │
│                                            │    │   Build the Site · Build the Offline Help                │
│                                            │    │     └── invoke the *product repo's own* scripts          │
└────────────────────────────────────────────┘    └──────────────────────────────────────────────────────────┘
```

| | |
|---|---|
| **The dashboard** answers *"which pages need work across the organisation?"* — on the site, generated by the product repo, page-level health, never shipped | |
| **The Content view** answers *"which pages need work in the repository I have open?"* — in the editor, one repository, the reasons as children of the page that has them | |
| **The same pages, two distances.** Neither is a copy of the other, and neither recomputes what the other owns | |
| **This extension is where the work happens** — a dashboard row is a hand-off, not a destination | |

*Start a Registry* appears where it applies rather than in a title bar: as the Content view's empty state, for
the folder that has no `docs/help/registry.json` yet. It works on a folder **you have open** — a repository you
have not cloned is refused in words, because starting one there would be a commit made through the API on your
behalf. Filling the registry it creates is the repository's own generator's job (`npm run docs:registry`).

**Where the AI sits, and why that is a user action.** It belongs on the **right**, beside the page being worked
on. VS Code has no contribution point that places a container there — `contributes.viewsContainers` accepts
`activitybar` and `panel` only — so the view is contributed to the panel container and the **workbench docks it
on the right**: the secondary side bar accepts any view, remembers the position, and a fresh install needs one
drag. If it must open there by itself, the alternative is an editor-area webview panel opened beside the page
(`ViewColumn.Beside`), which is a tab rather than a dock. Recorded in `platform-design.md`, not hidden here.
