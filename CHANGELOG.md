# Change Log

## Unreleased

- **the Content view**: the registry reader and the structural checks, areas → chapters → pages with counts
  on the parents, **Gaps**, a page's issues as its children, problems landing in the file that has to be
  fixed, the status bar (`pages · issues · never reviewed`), the output report, and the six `temcoKnowledge.*`
  commands.
- Repository documentation: `.github/copilot-instructions.md`, `README.md`, and `docs/` — architecture,
  registry schema, extension design, application layout, and the plan.
- **The platform design moved here** from `T3000Webview-EEZ-Studio`: `docs/design/help-platform/` — 19 files
  (the 16 design documents, its README and its TOC). The product repository no longer registers or publishes
  them, so its **Contributing** area is gone from the published site: its area definition, its 17 registry
  entries, the `design/**` content glob, the navbar node and the generator that produced them were removed.
- The tree and the report show what the generator knows: a page's last change and headings in its tooltip, a
  `stale` marker on the page when the generator says its code moved on, and a stale count on the repository and
  area tooltips. Read from `docs/help/index.json` / `page-meta.json`; absent, everything else works unchanged.
- **The local AI's first slice: the model list.** *Models and Runtime* offers the llama.cpp build for this
  machine and a choice of models, downloads the one picked into the user's own folder (resumable, checked
  against the catalog's sha256), unpacks it with the platform's `tar`, records it in a manifest, and can remove
  it again. Nothing native ships with the extension, and every download is a command the user ran.

## 0.0.1

- Project initialised: extension manifest, TypeScript build, launch configuration.
- `Temco Knowledge: Show Status` — reports the open folders and whether each one carries
  `docs/help/registry.json`.
