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
│ PROBLEMS   OUTPUT   TERMINAL   TEMCO KNOWLEDGE                                               │
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

## The dashboard (phase 4)

A second view, for the whole organisation rather than one repository. It needs no clones: the GitHub API
reports which repos carry a registry, how big it is, who owns it and when it last changed.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ Temco Knowledge Studio  -  Dashboard                                                         │
├──────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                              │
│  temcocontrols        62 repositories   -   14 documented   -   9 stale   -   3 with gaps    │
│                                                                                              │
│  REPOSITORY                      PAGES   OWNER     CHANGED        STATE                      │
│  T3000Webview-EEZ-Studio           335   docs      2 days         current                    │
│  T3000_Building_Automation_System  298   docs      3 weeks        12 gaps                    │
│  T3000Firmware                      96   fw-team   5 months       stale, no owner            │
│  BACnet-Stack                       54   docs      8 months       stale                      │
│  T3-Devices                         41   -         1 year         stale, unowned             │
│  Modbus-Tools                       18   docs      1 month        current                    │
│  ...                                                                                         │
│                                                                                              │
│  48 repositories have no docs/help/registry.json yet       [ Start one ]                     │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Where each column comes from:

| Column | Source |
|---|---|
| the repository list | `GET /orgs/temcocontrols/repos` |
| `PAGES`, `OWNER`, gaps | `GET /repos/{owner}/{repo}/contents/docs/help/registry.json` |
| `CHANGED` | `GET /repos/{owner}/{repo}/commits?path=docs&per_page=1` |
| `STATE` | computed here: stale, unowned, gaps |

Roughly three calls per repo, cached for an hour — well inside the authenticated rate limit. The token lives
in VS Code's secret storage, and with a multi-root workspace open the same table is produced from local
folders with no network at all.

The dashboard is **not** the portal (that is for readers), **not** a per-page tool (the Content view is), and
**not** a CI dashboard (it reports documentation state, not build state).
