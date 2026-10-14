// The project page: create and edit a project.
//
// One layout, two modes. The popups this replaces asked one field at a time and could not show a source list at
// all; a page can hold everything at once and still be readable — name, version, owner, the sources it is made
// of, and the outputs it must produce.
//
// The page owns the draft and the extension does the writing: the page posts what the form holds, the extension
// puts it in the catalog. The only native dialog left is the folder/file picker, because an OS dialog is better
// than any text box we would build for it.
//
// "Project" is the word a person reads everywhere. The catalog's table is still called `documents` — renaming it
// means a schema migration, and a project is what that row is.

import * as vscode from 'vscode';
import { Catalog, CatalogUnavailable, DocumentDetail } from './catalog/store';
import { PROJECT_VIEW_TYPE, pageColumn } from './surface';

/** A source as the page collects it — `url` for a repository, `path` for a folder or archive. */
interface PageSource {
  kind: 'git' | 'folder' | 'archive';
  name: string;
  branch?: string;
  url?: string;
  path?: string;
}

interface PageMessage {
  type: 'ready' | 'pick' | 'submit' | 'cancel' | 'remove';
  kind?: 'folder' | 'archive';
  values?: { name: string; version: string; owner: string; audience: string };
  /** Sources added on this page, not in the catalog yet. */
  sources?: PageSource[];
  /** The slugs of the catalog's sources the page left ticked. */
  cited?: string[];
  outputs?: string[];
}

export function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export class ProjectPage {
  private panel: vscode.WebviewPanel | undefined;
  private mode: 'new' | 'edit' = 'new';
  private slug = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly refresh: () => void
  ) {}

  /** A new project. It can be created with no sources at all — that is the point of it being a project. */
  openNew(): void {
    this.mode = 'new';
    this.slug = '';
    this.show('New project');
  }

  /** An existing project, filled in. */
  openEdit(slug: string): void {
    this.mode = 'edit';
    this.slug = slug;
    this.show('Project');
  }

  private show(title: string): void {
    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal(pageColumn());
      void this.seed();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      PROJECT_VIEW_TYPE,
      title,
      pageColumn(),
      { enableScripts: true, localResourceRoots: [] }
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'knowledge.svg');
    this.panel.webview.html = this.html(nonce());
    this.panel.webview.onDidReceiveMessage((message: PageMessage) => void this.receive(message));
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private async receive(message: PageMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
      case 'pick':
        break;
      case 'cancel':
        this.panel?.dispose();
        return;
      case 'remove':
        await this.remove();
        return;
      case 'submit':
        await this.submit(message);
        return;
    }

    if (message.type === 'ready') {
      await this.seed();
      return;
    }

    if (message.type === 'pick') {
      const kind = message.kind === 'archive' ? 'archive' : 'folder';
      const picked = await vscode.window.showOpenDialog({
        title: kind === 'folder' ? 'Which folder?' : 'Which file?',
        canSelectFolders: kind === 'folder',
        canSelectFiles: kind === 'archive',
        canSelectMany: false,
        openLabel: 'Use this',
      });
      if (!picked || picked.length === 0) {
        return;
      }
      const name = picked[0].path.split('/').filter(Boolean).pop() ?? picked[0].fsPath;
      await this.panel?.webview.postMessage({
        type: 'picked',
        kind,
        name,
        path: picked[0].fsPath,
      });
    }
  }

  /** Hands the page what to fill in — empty for a new document, its own values when editing. */
  private async seed(): Promise<void> {
    if (!this.panel) {
      return;
    }
    let document: DocumentDetail | undefined;
    let cited: string[] = [];
    const known: { slug: string; name: string; kind: string; branch?: string; pages?: number; line: string }[] = [];

    await this.withCatalog((catalog) => {
      if (this.mode === 'edit') {
        document = catalog.document(this.slug);
        cited = catalog.documentSourceSlugs(this.slug);
      }
      // What the catalog already knows, so a source is added once and cited by any number of projects.
      for (const source of catalog.sources()) {
        known.push({
          slug: source.slug,
          name: source.name,
          kind: source.kind,
          branch: source.branch,
          pages: source.pages,
          line: [
            `${source.name} — ${source.kind}`,
            source.branch,
            source.pages === undefined ? 'never read' : `${source.pages} pages`,
          ]
            .filter((part): part is string => Boolean(part))
            .join(' · '),
        });
      }
    });

    await this.panel.webview.postMessage({
      type: 'seed',
      mode: this.mode,
      document: document ?? { name: '', version: '1.0', owner: 'docs', audience: '', outputs: [], sources: [] },
      known,
      cited,
    });
  }

  private async submit(message: PageMessage): Promise<void> {
    const values = message.values;
    if (!values || values.name.trim().length === 0) {
      void vscode.window.showWarningMessage('Temco Knowledge: a project needs a name.');
      return;
    }

    const slug = this.mode === 'edit' && this.slug.length > 0 ? this.slug : slugOf(values.name);
    const added = message.sources ?? [];
    const cited = message.cited ?? [];
    const outputs = message.outputs ?? [];
    let citedCount = 0;

    const result = await this.withCatalog((catalog) => {
      catalog.createDocument({
        name: values.name.trim(),
        slug,
        version: values.version.trim() || undefined,
        audience: values.audience.trim() || undefined,
        owner: values.owner.trim() || undefined,
      });

      // One list for what the project cites: the ticks, plus whatever was added on this page — recorded first,
      // then cited, because a source has to exist before a project can point at it.
      const slugs = [...cited];
      for (const source of added) {
        const sourceSlug = slugOf(source.name);
        if (sourceSlug.length === 0) {
          continue;
        }
        catalog.addSource({
          kind: source.kind,
          name: source.name,
          slug: sourceSlug,
          remoteUrl: source.url,
          path: source.path,
          branch: source.branch,
        });
        slugs.push(sourceSlug);
      }
      // The whole list, not the additions: unticking a source on the page is how a project stops citing it.
      catalog.setDocumentSources(slug, slugs);
      catalog.setRecipe(slug, 'docfx', outputs);
      citedCount = new Set(slugs).size;
    });

    if (!result) {
      return;
    }

    this.refresh();
    this.panel?.dispose();
    void vscode.window.showInformationMessage(
      `${values.name.trim()} saved — cites ${citedCount} source${citedCount === 1 ? '' : 's'}, ${
        outputs.length === 0 ? 'no outputs chosen yet' : `outputs: ${outputs.join(', ')}`
      }.`
    );
  }

  private async remove(): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      'Remove this project from the Library? Its sources are kept; the project and its artifacts are not.',
      { modal: true },
      'Remove'
    );
    if (answer !== 'Remove') {
      return;
    }
    const ok = await this.withCatalog((catalog) => catalog.deleteDocument(this.slug));
    if (ok) {
      this.refresh();
      this.panel?.dispose();
    }
  }

  /** Opens the catalog, runs the work, closes it — and reports a refusal in words rather than a stack trace. */
  private async withCatalog(work: (catalog: Catalog) => void): Promise<boolean> {
    let catalog: Catalog | undefined;
    try {
      catalog = await Catalog.open(this.context);
      work(catalog);
      return true;
    } catch (error) {
      const message = error instanceof CatalogUnavailable ? error.message : String(error);
      void vscode.window.showErrorMessage(`Temco Knowledge: ${message}`);
      return false;
    } finally {
      catalog?.close();
    }
  }

  private html(script: string): string {
    const style = `
      :root { color-scheme: light dark; }
      body { margin: 0; padding: 1.6em 2em 3em; font-family: var(--vscode-font-family);
             font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
      h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 1em; }
      h2 { font-size: 1em; font-weight: 600; margin: 1.6em 0 .5em; }
      p { line-height: 1.55; margin: .3em 0; }
      label { display: block; color: var(--vscode-descriptionForeground); margin-bottom: .15em; }
      input[type=text] { width: 100%; max-width: 34em; min-width: 0; padding: .3em .5em; box-sizing: border-box;
                         color: var(--vscode-input-foreground); background: var(--vscode-input-background);
                         border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
      input:focus { outline: 1px solid var(--vscode-focusBorder); }
      /* min(14em, 100%), not a bare 14em: a track's minimum is a hard floor, so in a narrow column two of them
         push the right-hand field out of the pane and the page scrolls sideways. With min(), one column
         becomes one column at any width. */
      .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(14em, 100%), 1fr));
                gap: .9em 1.4em; max-width: 60em; }
      .fields > div { min-width: 0; }
      .row { display: flex; align-items: baseline; gap: .8em; padding: .25em 0;
             border-bottom: 1px solid var(--vscode-panel-border); }
      .row span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
      .row button { flex: 0 0 auto; }
      .row label.tick { display: flex; flex: 1 1 auto; min-width: 0; gap: .5em; align-items: baseline;
                        margin: 0; color: var(--vscode-foreground); cursor: pointer; }
      .row label.tick input { flex: 0 0 auto; margin: 0; }
      .add { display: flex; gap: .5em; flex-wrap: wrap; align-items: flex-end; margin: .6em 0 0; max-width: 60em; }
      .add > div { min-width: 0; }
      .outputs { display: flex; gap: 1.6em; flex-wrap: wrap; align-items: center; }
      .outputs label { display: inline-flex; gap: .4em; align-items: center; margin: 0;
                       color: var(--vscode-foreground); }
      button { padding: .3em .8em; border: none; border-radius: 2px; cursor: pointer;
               font-family: inherit; font-size: inherit;
               color: var(--vscode-button-secondaryForeground);
               background: var(--vscode-button-secondaryBackground); }
      button:hover { background: var(--vscode-button-secondaryHoverBackground); }
      button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
      button.primary:hover { background: var(--vscode-button-hoverBackground); }
      .actions { display: flex; gap: .6em; align-items: center; margin-top: 2em;
                 border-top: 1px solid var(--vscode-panel-border); padding-top: 1em; }
      .actions .spacer { flex: 1 1 auto; }
      .quiet { color: var(--vscode-descriptionForeground); max-width: 60em; }
      .req { color: var(--vscode-descriptionForeground); font-weight: 400; }
    `;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${script}';">
<style>${style}</style>
<title>Temco Knowledge</title>
</head>
<body>
  <h1 id="heading">New project</h1>

  <div class="fields">
    <div>
      <label for="name">Name <span class="req">— what you will see in the Library</span></label>
      <input id="name" type="text" placeholder="Product Help" autocomplete="off">
    </div>
    <div>
      <label for="version">Version</label>
      <input id="version" type="text" placeholder="1.0" autocomplete="off">
    </div>
    <div>
      <label for="owner">Owner</label>
      <input id="owner" type="text" placeholder="docs" autocomplete="off">
    </div>
    <div>
      <label for="audience">Audience</label>
      <input id="audience" type="text" placeholder="developers" autocomplete="off">
    </div>
  </div>

  <h2>Sources</h2>
  <p class="quiet">What the catalog knows is listed below — tick what this project is built from, and add a
    folder, a repository or an archive if the one you need is not there yet.</p>
  <p class="quiet" id="noSources">Nothing is recorded yet. A project can be created before its sources are
    settled.</p>
  <div id="sources"></div>
  <p class="quiet" id="cited"></p>

  <div class="add">
    <div style="flex:1 1 18em">
      <label for="repoUrl">Repository — owner/name or a full URL</label>
      <input id="repoUrl" type="text" placeholder="owner/name" autocomplete="off">
    </div>
    <div style="flex:0 1 12em">
      <label for="repoBranch">Branch</label>
      <input id="repoBranch" type="text" placeholder="main" autocomplete="off">
    </div>
    <button id="addRepo" type="button">Add repository</button>
    <button id="addFolder" type="button">Add folder…</button>
    <button id="addArchive" type="button">Add archive…</button>
  </div>

  <h2>Outputs</h2>
  <div class="outputs">
    <label><input id="out-chm" type="checkbox"> CHM</label>
    <label><input id="out-pdf" type="checkbox"> PDF</label>
    <label><input id="out-site" type="checkbox"> Site</label>
  </div>
  <p class="quiet">Choosing an output records the recipe. Building it comes next — this page does not run one.</p>

  <div class="actions">
    <button id="submit" class="primary" type="button">Create project</button>
    <button id="cancel" type="button">Cancel</button>
    <span class="spacer"></span>
    <button id="remove" type="button" hidden>Remove…</button>
  </div>

<script nonce="${script}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  // Two kinds of row, one list: what the catalog knows (a tick) and what this page added (removable).
  let known = [];
  const cited = new Set();
  let sources = [];

  function render() {
    const list = $('sources');
    list.replaceChildren();

    for (const source of known) {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.className = 'tick';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = cited.has(source.slug);
      box.addEventListener('change', () => {
        if (box.checked) { cited.add(source.slug); } else { cited.delete(source.slug); }
        summary();
      });
      const span = document.createElement('span');
      span.textContent = source.line;
      label.append(box, span);
      row.append(label);
      list.append(row);
    }

    sources.forEach((source, index) => {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('span');
      label.textContent = source.detail + ' — added here';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'remove';
      remove.addEventListener('click', () => { sources.splice(index, 1); render(); });
      row.append(label, remove);
      list.append(row);
    });

    $('noSources').hidden = known.length + sources.length > 0;
    summary();
  }

  /** What pressing Save will do, in one line, so the ticks are never a guess. */
  function summary() {
    const total = cited.size + sources.length;
    $('cited').textContent =
      total === 0
        ? 'This project will cite nothing yet.'
        : 'This project will cite ' + total + ' source' + (total === 1 ? '' : 's') + '.';
  }

  function label(kind, name, branch) {
    return name + ' — ' + kind + (branch ? ' · ' + branch : '');
  }

  // The slug rule, once more on this side: it is how a row in the catalog is found from a name.
  function slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'seed') {
      const document = message.document;
      $('name').value = document.name || '';
      $('version').value = document.version || '';
      $('owner').value = document.owner || '';
      $('audience').value = document.audience || '';
      for (const output of document.outputs || []) {
        const box = $('out-' + output);
        if (box) { box.checked = true; }
      }
      sources = (document.sources || []).map((source) => ({
        kind: source.kind, name: source.name, branch: source.branch,
        detail: label(source.kind, source.name, source.branch),
      }));
      // In edit mode the project's own sources are the ticks, and they are not "added here".
      known = message.known || [];
      cited.clear();
      for (const slug of message.cited || []) { cited.add(slug); }
      if (message.mode === 'edit') {
        const fromCatalog = new Set(known.map((source) => source.slug));
        sources = sources.filter((source) => !fromCatalog.has(slugify(source.name)));
      }
      const editing = message.mode === 'edit';
      $('heading').textContent = editing ? 'Project' : 'New project';
      $('submit').textContent = editing ? 'Save' : 'Create project';
      $('remove').hidden = !editing;
      render();
      return;
    }
    if (message.type === 'picked') {
      sources.push({ kind: message.kind, name: message.name, path: message.path,
                     detail: label(message.kind, message.name) });
      render();
    }
  });

  $('addRepo').addEventListener('click', () => {
    const url = $('repoUrl').value.trim();
    if (url.length < 3) { $('repoUrl').focus(); return; }
    const branch = $('repoBranch').value.trim();
    const name = url.replace(/\\.git$/, '').split('/').filter(Boolean).pop() || 'repository';
    sources.push({ kind: 'git', name, branch: branch || undefined, url, detail: label('git', name, branch) });
    $('repoUrl').value = '';
    $('repoBranch').value = '';
    render();
  });
  $('addFolder').addEventListener('click', () => vscode.postMessage({ type: 'pick', kind: 'folder' }));
  $('addArchive').addEventListener('click', () => vscode.postMessage({ type: 'pick', kind: 'archive' }));
  $('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $('remove').addEventListener('click', () => vscode.postMessage({ type: 'remove' }));
  $('submit').addEventListener('click', () => {
    const name = $('name').value.trim();
    if (name.length === 0) { $('name').focus(); return; }
    vscode.postMessage({
      type: 'submit',
      values: {
        name,
        version: $('version').value.trim(),
        owner: $('owner').value.trim(),
        audience: $('audience').value.trim(),
      },
      sources,
      cited: Array.from(cited),
      outputs: ['chm', 'pdf', 'site'].filter((kind) => $('out-' + kind).checked),
    });
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function nonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
