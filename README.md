# Temco Knowledge Studio — extension

The platform that keeps Temco's product technical content (documentation and training) in step with the
code. It is delivered two ways from this one codebase:

- bundled inside **Temco Knowledge Studio**, our own desktop application (a branded build of VS Code), and
- installed into an ordinary VS Code for engineers who already have one.

**This repository holds no content.** There is no page, no image and no registry here — the extension
operates on the folder you open, which is a product repository.

## What is in it so far

Only the skeleton: activation, an output channel, and one command that reports whether the open folder is a
documented workspace (it looks for `docs/help/registry.json`).

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

1. Read the registry of the open workspace and show pages, owners and gaps in a side panel.
2. Run the checks (link, media, staleness) and report them as problems, not as text.
3. Local AI: download a model, load it in a worker, draft page updates from a commit range.
4. Publish: build the site and the offline help build, then hand the artifacts to whoever ships them.

## Rules this codebase keeps

- **No content, no secrets.** The extension is a tool; everything it works on lives in the product repos.
- **The AI drafts, a human approves.** Nothing is published from here without a named person accepting it.
- **No dependency on the desktop build.** If a feature only works inside our branded application, it is in
  the wrong repository.
