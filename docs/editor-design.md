# The editor

The design for **R6 — editing and publishing**: the toolbar, creating a document, images, drafts, and where the
review happens. It is written the same week its first step was built, so it separates what exists from what is
proposed, and it puts the one decision that is not mine in front of the person who has to make it.

The content rules are not here. Registry schema, link forms, media rules, review flow and publishing belong to
`design/help-platform/`, which stays the source of truth; this document only says how the desktop application
implements them.

---

## 1. The surface: VS Code's editor, with our toolbar on it

`15-online-editor.md` designs the editor for the **website**: Monaco, bundled and self-hosted, with an API behind
it, served at `/docs/edit/<page-id>` on a host that has a clone. That editor is not this application's editor and
building it twice would be the bug.

| | the website's editor | this application |
|---|---|---|
| the core | Monaco, bundled by us, ~2 MB, custom build, `<textarea>` fallback | **VS Code is Monaco plus a shell** — nothing to bundle |
| what it adds | toolbar, preview pane, gate markers, upload, publish, PR | toolbar, a link to a real page, the outline, the gates' markers — of which the markers already exist (`src/diagnostics.ts`) |
| what it never does | never WYSIWYG: pages are hard-wrapped, and a rich round-trip reflows every line | the same rule, and the same reason |
| publishing | `POST /api/docs/publish` → a real PR | **never.** This application builds and reports; shipping stays a separate act |

So the desktop equivalent of "Monaco + our toolbar + completion + markers" is **VS Code, with the toolbar built**
— which is what `src/format.ts` now is. An editor page of our own, hosting Monaco in a webview, was considered and
is refused for the reason `15-online-editor.md` §9 gives for the website: the integration is the part that matters,
and the editor is the part that already exists.

### What exists — the toolbar, built 2026-10-14

Sixteen commands, all `temcoKnowledge.format.*`, in `src/format.ts`. Each one edits the buffer in front: the page a
person is typing in, undone with `Ctrl+Z`. None of them writes a file, opens a tab, or touches the registry.

| Where a person meets it | What is there |
|---|---|
| the editor's title bar, Markdown files only | **Bold** · *Italic* · *Link to a page* · **Format** |
| the editor's context menu, and the tab's | the submenu **Temco Knowledge** — all sixteen, grouped |
| the palette | every action, by name; **Format** lists them all in one picker |

| Group | Actions |
|---|---|
| Inline | Bold `**…**` · Italic `*…*` · Inline code `` `…` `` |
| Blocks | Heading level (`##`–`####`) · bullet · numbered · task · block quote · code block with a language · table · horizontal rule · callout |
| Insert | Link · **Link to a page** |
| Navigate | Go to a heading (this page's outline) |

Three things it does on purpose, each of which has an obvious wrong answer:

- **Every button is a toggle.** Bold over `**bold**` removes the marks; the bullet list over a list takes the
  bullets off; the same heading level again removes it. That is what a button does in every other editor.
- **A block gets a blank line before it when the line above is prose.** Not decoration: `text` followed by `---` is
  a level-2 heading in Markdown, and a table glued to a paragraph is a paragraph.
- **A callout, a fence and an alert marker start their own line** — mid-line they would glue to the text after the
  cursor, and `> [!NOTE]` is an alert only at the start of a line.

**No keybindings are contributed, deliberately.** `Ctrl+B` hides the side bar everywhere else, and this extension
has to keep working in an ordinary VS Code. Everything here is a command, so a chord is one personal binding away.

**A page that is not a file on disk says so.** A page read from a source, or a diff, has a scheme that is not
`file`, and every action refuses it in words rather than appearing to work.

---

## 2. Creating a document

Nothing is built here yet. Two facts decide how it should work, and both come from the design package.

**A page is a pair, not a file.** The registry *is* the structure (`05-content-and-registry.md` §2), and a `.md`
that no `pages` entry names is an error the generator reports as `unregistered page`. So "create a document" is
always a file **and** a registry entry.

**Some of those fields are not the author's to set.** `15-online-editor.md` §5.4 splits them: `title`, `order`,
`owner`, `tags`, `keywords`, `reviewer`, `code` are a page owner's; `chapter`, `ship`, `area` and `category` are
**structure**, marked *needs the docs owner*. A create form that quietly writes `chapter` is a governance change
wearing a UI.

### The kinds worth offering

| Kind | What it writes | Why it is a kind |
|---|---|---|
| **Article** | a page file in an existing area and chapter, plus its entry | the ordinary case, and the one a creation flow is judged on |
| **New chapter** | the file, the entry, and a folder | a chapter is a TOC parent; creating one is a structural act |
| **Task / how-to** | the same, with a numbered-step skeleton | the commonest documentation shape, and the one whose headings a template gets right |
| **Reference** | the same, with a tables-first skeleton | the shape an API or a register actually has |
| **Troubleshooting** | the same, with *Symptom · Cause · Fix* | matches the area the product already has (`troubleshooting`) |
| **Release note** | a page in the `releases` chapter, dated, with *What's new · Fixed · Known issues* | dated, and the reason `version` exists in the registry |
| **Loose page** | a Markdown file under `docs/` registered in `exclude` | a working note that must exist and must not ship (`docs/todo/` in the product repo is this) |

Each template is a **skeleton the registry's own rules require** — the headings, the front-matter-free top, the
hard-wrapped prose that the gates expect — and nothing else. A template that invents prose is a template someone
has to delete.

### The flow

```
  Create a page ────────────────────────────────────────────────────────────────
  1  Kind        ( ) article  ( ) task  ( ) reference  ( ) troubleshooting  ( ) release note  ( ) loose
  2  Where       area [ t3000 ▾ ]   chapter [ features ▾ ]   order [ 40 ]     ← structure: flagged
  3  Title       Trend Logs                →  the id and the file path, shown, not guessed
                   id    t3000/features/trend-logs
                   file  docs/t3000/features/trend-logs.md          (new)
  4  Owner       [ trendlog ▾ ]   audience [ user ▾ ]
  ──────────────────────────────────────────────────────────────────────────────
  It will write, after asking for each path by name:
      docs/t3000/features/trend-logs.md          (the skeleton above)
      docs/help/registry.json                    (one `pages` entry — or registry.d/, if the file is split)
```

Two rules the flow keeps: **the id and the path are shown before anything is written**, and **the structure fields
are named as structure** so nobody discovers later that they changed a chapter. The write is two modal
confirmations naming two paths — never a silent one — and nothing is ever committed.

---

## 3. Images

An image is the one action in the toolbar that is missing, and the reason is not the code: the file has to be
written into the page's own `media/` folder before `![alt](media/…)` points at anything.

The rules are already written down, in the design package, so they are not ours to invent:

| Rule | Source |
|---|---|
| the file goes into the **page's own `media/`**, with a slugified name (`02-run-screen.png`) | `15-online-editor.md` §3 |
| accepted: PNG, JPG, WebP, GIF, SVG — diagrams as SVG, sanitised on the way in | `15-online-editor.md` §3 |
| images ≤ 2 MB · a page ≤ 1 MB · content-type sniffed, never trusted from the name | `15-online-editor.md` §5.2 |
| **the destination is derived, never supplied** | `15-online-editor.md` §5.1 |
| screenshots are captured properly or not at all — no editing, no resizing | `15-online-editor.md` §9 |

**What an extension can and cannot take.** A file the user **picked** (`showOpenDialog`) and a file **dropped** on
the page are both reachable; VS Code's API does not expose the **clipboard image**, so "screenshot → `Ctrl+V` → it
lands in `media/`" is a browser-editor feature and stays on the website. That limit is worth saying out loud
because `15-online-editor.md` §3 puts paste first, and its assumption is the browser.

---

## 4. Drafts, review and publishing

**Not built, and the largest piece of R6.** The design is already fixed and is not ours to change:

| | where it belongs |
|---|---|
| editing a **local** source | in place — the page file is the page, which the Workspace view already does |
| editing a **git** source | on a draft branch in a materialised clone — which is the `fetch` read mode R2 still owes |
| review | `docs:blocking`, `registry --check`, the link check and the media check, run by the repository's own scripts |
| publishing | never from this application: the gates, the commit and the PR are the product repository's |
| a page's fields in the editor | restricted by §5.4: structure needs the docs owner |

So the honest order is: **images and create-a-page first, because both need only a decision**; drafts after, because
they need the `fetch` mode and a review flow that lives in the product repository.

---

## 5. The decision this waits on

Today the extension may write into a product repository exactly twice, each its own command, each a modal naming
the path: the empty file for a page the registry already declares, and an empty `registry.json` in a folder that
has none. Nothing under `_admin/` or `_edit/` is ever written, and an existing registry is never edited.

| An image into the page's `media/` | A new page's `.md` file | An entry in `registry.json` / `registry.d/*.json` |
|---|---|---|
| the third writer. The path is derived from the page, the name is slugified, the type is sniffed, and the file is binary | the same class as the one writer we already have, one kind of file instead of empty | **the largest step**, and the one that contradicts "an existing registry is never edited" |

**Recommendation, in this order.** Accept the image writer and the page-file writer together: they are one decision —
*this application may put a page and its picture into a repository, at paths it derived, after asking* — and each
one is useless alone, since a page whose picture cannot be added is not authored here, and a picture without a page
is nothing. Take the registry entry as a **second** decision, and start it in the *split* form
(`registry.d/<area>-<chapter>.json`), where the diff touches one small file that a reviewer can read, rather than
the single 500-page `registry.json` that `05-content-and-registry.md` warns about. If that second decision is
refused, create-a-page still works honestly: the file is written, and the registry entry is shown, ready to paste,
in the file that has to have it.

---

## 6. Acceptance, per step

| # | Step | The test that ends it |
|---|---|---|
| 1 | the toolbar | **done 2026-10-14** — a Markdown file shows the four buttons; every button toggles; `---` after prose is not a heading; the page picker inserts a link the gate resolves; a page read from a source is refused in words |
| 2 | insert an image | a dropped PNG lands in the page's `media/` under a slugified name and is referenced relatively; a 3 MB PNG and a `.exe` renamed `.png` are both refused, in words, with the limit |
| 3 | create a page | an article is created from the kind's skeleton, in a chapter that exists, and the repository's own `docs:registry` then reports no `unregistered page` — with two confirmations naming two paths, and nothing committed |
| 4 | drafts | a page is corrected, the gates run, the diff is reviewed, and the result is a commit a person made — not one this application made |
