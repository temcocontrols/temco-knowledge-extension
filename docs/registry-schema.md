# The registry we read

`docs/help/registry.json` in each product repository is the single description of that product's
documentation set. This extension is a **reader** of it. The schema is owned by the generator in the product
repo (`scripts/docs-registry.mjs`) — if a field ever needs to change, it changes there first and this reader
follows.

## Shape

```json
{
  "version": 1,
  "areas": {
    "t3000": { "title": "t3000", "audience": "user", "noindex": false }
  },
  "pages": {
    "t3000/api-reference/data-points": {
      "title": "Data Points API",
      "area": "t3000",
      "chapter": "api-reference",
      "order": 20,
      "audience": "user",
      "ship": true,
      "owner": "docs",
      "tags": [],
      "keywords": [],
      "help_ids": [],
      "code": [],
      "reviewed": null
    }
  }
}
```

## Fields, and what they decide

| Field | Where | Meaning |
|---|---|---|
| `areas` | registry | the top level of the site: one entry per product area, with its default audience and whether it is excluded from the published site |
| `pages` | registry | every page, keyed by **page id** |
| `title` | page | the page's name, used for search, navigation and the tree |
| `area`, `chapter` | page | where the page sits; both must agree with the page id |
| `order` | page | position inside its chapter. Pages are ordered by it, then by title |
| `audience` | page | `user`, `developer` or `contributing`; falls back to the area's audience |
| `ship` | page | `false` keeps the page out of the shipped help build |
| `owner` | page | who is answerable for the page's accuracy |
| `tags`, `keywords`, `help_ids`, `code` | page | search facets, context-help ids, and the code globs a change should make the page stale. Empty is normal |
| `reviewed` | page | ISO date of the last human review, or `null`. `null` is a **count**, not a warning |

## Page id → file

The page id is the path under `docs/`, without the extension:

| Page id | File that must exist |
|---|---|
| `t3000/api-reference/data-points` | `docs/t3000/api-reference/data-points.md` |

That single rule is what makes a page "missing" checkable, and it is why this extension never guesses at
paths: the id is the path.

## Generated neighbours

The product repo also emits, and this extension may read:

- `docs/help/index.json` — headings and git provenance per page (last commit, date).
- `docs/help/page-meta.json` — the metadata bar values rendered on each published page.

Neither is required: if they are absent, everything except provenance-related features still works.

## Structural checks

Run on every refresh, cheap enough to run on 335 pages without thinking about it:

| Check | Severity | Reported on |
|---|---|---|
| the page has no title | error | the page |
| `area` is not declared in `areas{}` | error | the page |
| the id disagrees with `area`/`chapter` | error | the page |
| registered, but the file does not exist | error | `registry.json` |
| no `order` | warning | the page |
| two pages share one title | warning | both pages |
| two pages share one `order` inside a chapter | warning | both pages |
| the registry declares no pages | warning | `registry.json` |
| the registry is not valid JSON | error | `registry.json` |

**Deliberately not checked here:** prose quality, links, images and staleness. Those belong to the product
repo's own gates (`npm run docs:verify`, the media audit, `docs-owed`) and to the AI phase, where a commit
range can be read. Duplicating them in the extension would create two answers to one question.
