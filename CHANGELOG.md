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
- As of this entry the work above is in the working tree and uncommitted.

## 0.0.1

- Project initialised: extension manifest, TypeScript build, launch configuration.
- `Temco Knowledge: Show Status` — reports the open folders and whether each one carries
  `docs/help/registry.json`.
