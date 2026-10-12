# Documentation for this repository

This folder describes **this repository**: the extension, how it is built, what it assumes, and where it is
going. It also carries the **platform design** in [`design/help-platform/`](design/help-platform/README.md) —
the documents that describe the platform this extension is part of.

The product documentation itself is not here: the pages and the registry live in the product repositories,
because that is where the content has to be.

| Document | Read it when |
|---|---|
| [`architecture.md`](architecture.md) | you need the whole picture: the four folders, the flow, how it ships |
| [`registry-schema.md`](registry-schema.md) | you touch anything that reads or writes registry data |
| [`extension-design.md`](extension-design.md) | you add a view, a command, a check or a diagnostic |
| [`app-layout.md`](app-layout.md) | you need the target UI: the application window and the dashboard |
| [`plan.md`](plan.md) | you are about to implement something: the numbered steps, their order, their acceptance tests |
| [`design/help-platform/`](design/help-platform/README.md) | you need the platform design itself: content model, registry, search, the offline CHM, editing, feedback, AI, governance |

## The three names, and why they are different

| Name | What it is |
|---|---|
| **Temco Knowledge Studio** | the application someone installs — our branded build of VS Code |
| **this extension** | the same features, installed into an ordinary VS Code for engineers who already have one |
| **Temco Knowledge** | the published portal: the documentation people read |

One brand for the tool, one for the artifact. The tool maintains content; the portal displays it. Keeping
them apart is what stops "put it in Temco Knowledge" from being ambiguous.

## Where the platform design lives

[`design/help-platform/`](design/help-platform/README.md) — 16 documents covering the content model, the
registry, search, the offline CHM, the editing and git flow, feedback, the AI features, the implementation
plan and the governance rules. `16-management-overview.md` is the one-page version.

**They describe the platform, and their paths belong to the product repository.** `docs/t3000/**`,
`docs/help/registry.json`, `docs/docfx.json`, `scripts/docs-*.mjs` and `dist/docs/` are the *product* repo's
paths, not this one's: the content and the publishing pipeline stay there by design.

They moved here from `T3000Webview-EEZ-Studio` on 2026-10-12 — the implementation lives in this repository,
so the design of it does too. The consequence, accepted deliberately: the product repo no longer registers or
publishes them, so the portal no longer serves the **Contributing** area that used to be built from
`docs/design/`.

Where the two disagree, the design package wins — and the disagreement is a bug worth fixing in one place or
the other.
