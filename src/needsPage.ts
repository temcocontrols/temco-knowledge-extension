// The page behind the Library's *Needs attention* row: everything that wants a person, in one place.
//
// This is the merge of the old **Work** view, and it exists because of what that view got wrong: it was a second
// copy of the tree's own *Gaps* list plus a counter, in a third place, behind an icon that meant five different
// things at once. So the sidebar keeps one expandable row — a count and the first few items — and this page has
// the room to say *why* each thing is listed and *where* the fix is.
//
// One rule is load-bearing here: **nothing on this page is computed twice.** Structural faults come from the
// checks `registry.ts` runs on the working tree; staleness is the *generator's* verdict, read from `index.json`
// and never recomputed; and "documentation owed" is the product repository's own `docs:owed` check, which this
// page only runs. Its output is the verdict — this page does not parse it, and says so.

import * as vscode from 'vscode';
import { OFFERED_SCRIPTS, scriptsIn } from './builds';
import { DocsRoot, collectPages, countStale } from './registry';
import { NEEDS_VIEW_TYPE, pageColumn } from './surface';

/** What the last run of one of the repository's own scripts left behind. */
interface ScriptRun {
  folder: string;
  script: string;
  exit: number | undefined;
  at: string;
  rewritten: string[];
}

interface NeedsMessage {
  type: 'ready' | 'action';
  action?: 'open' | 'create' | 'owed' | 'report' | 'registry' | 'openProject' | 'script';
  script?: string;
  path?: string;
  id?: string;
  title?: string;
}

export class NeedsPage {
  private panel: vscode.WebviewPanel | undefined;
  /** The last run of each script, by id — this session only: a run is a thing that happened, not state. */
  private readonly runs = new Map<string, ScriptRun>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly roots: () => readonly DocsRoot[]
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal(pageColumn());
      void this.seed();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(NEEDS_VIEW_TYPE, 'What needs doing', pageColumn(), {
      enableScripts: true,
      localResourceRoots: [],
    });
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'knowledge.svg');
    this.panel.webview.html = html(nonce());
    this.panel.webview.onDidReceiveMessage((message: NeedsMessage) => void this.receive(message));
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  /** Re-renders if it is open. Called by the refresh path, so the page follows the workspace. */
  refresh(): void {
    if (this.panel) {
      void this.seed();
    }
  }

  private async receive(message: NeedsMessage): Promise<void> {
    if (message.type === 'ready') {
      await this.seed();
      return;
    }
    if (message.type !== 'action') {
      return;
    }

    switch (message.action) {
      case 'open':
        await vscode.commands.executeCommand('temcoKnowledge.openFile', {
          path: message.path,
          id: message.id,
          title: message.title,
        });
        return;
      case 'create':
        await vscode.commands.executeCommand('temcoKnowledge.createPage', {
          path: message.path,
          title: message.title,
        });
        await this.seed();
        return;
      case 'registry':
        await vscode.commands.executeCommand('temcoKnowledge.openRegistry');
        return;
      case 'report':
        await vscode.commands.executeCommand('temcoKnowledge.stalenessReport');
        return;
      case 'openProject':
        await vscode.commands.executeCommand('temcoKnowledge.openProjects');
        return;
      case 'script': {
        const id = message.script ?? '';
        const result = await vscode.commands.executeCommand<ScriptRun | undefined>(
          'temcoKnowledge.runScript',
          id
        );
        if (result) {
          this.runs.set(id, result);
        }
        await this.seed();
        return;
      }
      case 'owed': {
        // Kept for the old button: the same run, under the name the owed gate has everywhere else.
        const result = await vscode.commands.executeCommand<ScriptRun | undefined>('temcoKnowledge.runOwed');
        if (result) {
          this.runs.set('docs:owed', result);
        }
        await this.seed();
        return;
      }
    }
  }

  private async seed(): Promise<void> {
    if (!this.panel) {
      return;
    }

    const roots = this.roots();
    const scriptsPresent = scriptsIn(roots);
    const sources: {
      name: string;
      origin: string;
      pages: number;
      errors: number;
      warnings: number;
      neverReviewed: number;
      stale: number;
      unowned: number;
      missing: number;
      folder?: string;
      owed: boolean;
    }[] = [];

    const faults: { root: string; id: string; title: string; owner: string; path?: string; severity: string; message: string }[] = [];
    const missing: { root: string; id: string; title: string; path: string }[] = [];
    const stale: { root: string; id: string; title: string; owner: string; changed?: string; path?: string }[] = [];
    const unowned: { root: string; id: string; title: string; path?: string }[] = [];

    for (const root of roots) {
      const pages = collectPages(root);
      const local = root.origin !== 'catalog';
      const path = (uri: vscode.Uri): string | undefined => (uri.scheme === 'file' ? uri.fsPath : undefined);

      sources.push({
        name: root.folder.name,
        origin: root.origin === 'catalog' ? 'read from the source' : 'on this machine',
        pages: root.pages,
        errors: root.errors,
        warnings: root.warnings,
        neverReviewed: root.neverReviewed,
        stale: countStale(pages),
        unowned: pages.filter((page) => page.owner.length === 0).length,
        missing: pages.filter((page) => !page.exists).length,
        folder: path(root.rootUri),
        owed: root.origin !== 'catalog',
      });

      for (const page of pages) {
        if (!page.exists) {
          missing.push({ root: root.folder.name, id: page.id, title: page.title, path: page.uri.fsPath });
        }
        for (const issue of page.issues) {
          faults.push({
            root: root.folder.name,
            id: page.id,
            title: page.title,
            owner: page.owner,
            path: path(page.uri),
            severity: issue.severity,
            message: issue.message,
          });
        }
        if (page.provenance?.stale === true) {
          stale.push({
            root: root.folder.name,
            id: page.id,
            title: page.title,
            owner: page.owner,
            changed: page.provenance.updated ?? page.provenance.git?.date,
            path: path(page.uri),
          });
        }
        if (page.owner.length === 0 && local) {
          unowned.push({ root: root.folder.name, id: page.id, title: page.title, path: path(page.uri) });
        }
      }
    }

    await this.panel.webview.postMessage({
      type: 'needs',
      sources,
      faults,
      missing,
      stale,
      unowned,
      // The scripts this repository actually has, each with what its last run in this session left behind.
      scripts: OFFERED_SCRIPTS
        .filter((script) => scriptsPresent.has(script.id))
        .map((script) => ({
          id: script.id,
          label: script.label,
          detail: script.detail,
          run: this.runs.get(script.id),
        })),
      anyLocal: sources.some((source) => source.owed),
      totals: {
        faults: faults.length,
        errors: faults.filter((fault) => fault.severity === 'error').length,
        missing: missing.length,
        stale: stale.length,
        unowned: unowned.length,
      },
    });
  }
}

function nonce(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let text = '';
  for (let index = 0; index < 32; index += 1) {
    text += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return text;
}

function html(script: string): string {
  const style = `
    :root { color-scheme: light dark; }
    body { margin: 0; padding: 1.6em 2em 3em; font-family: var(--vscode-font-family);
           font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
    h1 { font-size: 1.5em; font-weight: 600; margin: 0 0 .2em; }
    h2 { font-size: 1.05em; font-weight: 600; margin: 1.8em 0 .4em; }
    h2 .n { color: var(--vscode-descriptionForeground); font-weight: 400; padding-left: .5em; }
    p { line-height: 1.55; margin: .3em 0; }
    .meta { color: var(--vscode-descriptionForeground); max-width: 74em; }
    .actions { display: flex; gap: .6em; flex-wrap: wrap; margin: .6em 0 1em; }
    button { padding: .3em .8em; border: none; border-radius: 2px; cursor: pointer;
             font-family: inherit; font-size: inherit;
             color: var(--vscode-button-secondaryForeground);
             background: var(--vscode-button-secondaryBackground); }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    .scroll { overflow-x: auto; max-width: 100%; }
    table { border-collapse: collapse; width: 100%; max-width: 84em; }
    th, td { text-align: left; padding: .3em .8em .3em 0; vertical-align: top;
             border-bottom: 1px solid var(--vscode-panel-border); overflow-wrap: anywhere; }
    th { color: var(--vscode-descriptionForeground); font-weight: 500; }
    td.id { color: var(--vscode-descriptionForeground); }
    td.act { text-align: right; white-space: nowrap; }
    .mark { font-weight: 600; padding-right: .4em; }
    .mark.error { color: var(--vscode-errorForeground); }
    .mark.warn { color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); }
    .mark.quiet { color: var(--vscode-descriptionForeground); }
    a.link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
    a.link:hover { text-decoration: underline; }
    .empty { color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-panel-border);
             border-radius: 3px; padding: 1em 1.2em; max-width: 74em; }
    .verdict { border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: .8em 1em;
               max-width: 74em; }
    .verdict code { font-family: var(--vscode-editor-font-family); }
    code { font-family: var(--vscode-editor-font-family); font-size: .95em; overflow-wrap: anywhere; }
    .foot { color: var(--vscode-descriptionForeground); margin-top: 2.4em; max-width: 84em;
            border-top: 1px solid var(--vscode-panel-border); padding-top: 1em; }
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
  <h1>What needs doing</h1>
  <p class="meta" id="lede"></p>
  <div class="actions">
    <button id="report">Staleness report</button>
    <button id="registry">Open the registry</button>
    <button id="projects">The projects page</button>
  </div>

  <div id="sources"></div>
  <h2>Faults <span class="n" id="faults-n"></span></h2>
  <div id="faults"></div>
  <h2>Declared, but the file is not there <span class="n" id="missing-n"></span></h2>
  <div id="missing"></div>
  <h2>Stale <span class="n" id="stale-n"></span></h2>
  <div id="stale"></div>
  <h2>No owner <span class="n" id="unowned-n"></span></h2>
  <div id="unowned"></div>
  <h2>The repository's own checks</h2>
  <p class="meta">Each of these is the repository's own npm script, run as a task in the folder being read —
    visible in the terminal, cancellable, and its output there is the verdict. This page says where a run
    happened, when, and what it exited with; it never interprets one. A second opinion about what is owed, or
    about what the media audit found, is the one thing a documentation platform must not invent.</p>
  <div id="checks"></div>

  <p class="foot" id="foot"></p>

<script nonce="${script}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

$('report').addEventListener('click', () => vscode.postMessage({ type: 'action', action: 'report' }));
$('registry').addEventListener('click', () => vscode.postMessage({ type: 'action', action: 'registry' }));
$('projects').addEventListener('click', () => vscode.postMessage({ type: 'action', action: 'openProject' }));

function empty(text) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = text;
  return div;
}

function mark(kind, text) {
  const span = document.createElement('span');
  span.className = 'mark ' + kind;
  span.textContent = text;
  return span;
}

function link(row, text, done) {
  const a = document.createElement('a');
  a.className = 'link';
  a.textContent = text;
  a.addEventListener('click', done);
  row.append(a);
  return row;
}

function row(cells, action) {
  const tr = document.createElement('tr');
  for (const [text, className] of cells) {
    const td = document.createElement('td');
    if (className) { td.className = className; }
    td.textContent = text;
    tr.append(td);
  }
  const act = document.createElement('td');
  act.className = 'act';
  if (action) { link(act, action.label, action.done); }
  tr.append(act);
  return tr;
}

function table(headers, rows) {
  const box = document.createElement('div');
  box.className = 'scroll';
  const el = document.createElement('table');
  const head = document.createElement('tr');
  for (const text of headers) {
    const th = document.createElement('th');
    th.textContent = text;
    head.append(th);
  }
  el.append(head);
  for (const r of rows) { el.append(r); }
  box.append(el);
  return box;
}

function openPage(row) {
  return () => vscode.postMessage({
    type: 'action', action: 'open', path: row.path, id: row.id, title: row.title,
  });
}

function render(data) {
  const t = data.totals;
  $('lede').textContent =
    t.faults + ' fault' + (t.faults === 1 ? '' : 's') + ' · ' +
    t.missing + ' file' + (t.missing === 1 ? '' : 's') + ' to create · ' +
    t.stale + ' stale · ' + t.unowned + ' without an owner. ' +
    'Staleness is the generator\\'s verdict; the owed check is the repository\\'s own script.';
  $('faults-n').textContent = String(t.faults);
  $('missing-n').textContent = String(t.missing);
  $('stale-n').textContent = String(t.stale);
  $('unowned-n').textContent = String(t.unowned);

  $('sources').replaceChildren(table(
    ['Source', 'Where', 'Pages', 'Errors', 'Warnings', 'Never reviewed', 'Stale', 'Unowned', 'Missing'],
    data.sources.map((source) => row([
      [source.name], [source.origin], [String(source.pages)], [String(source.errors)],
      [String(source.warnings)], [String(source.neverReviewed)], [String(source.stale)],
      [String(source.unowned)], [String(source.missing)],
    ]))
  ));

  $('faults').replaceChildren(
    data.faults.length === 0
      ? empty('No structural fault. Nothing here is a fault of the registry or of a page\\'s own declaration.')
      : table(['', 'Page', 'Id', 'Owner', 'What'], data.faults.map((fault) => {
          const r = row([
            ['', ''], [fault.title], [fault.id, 'id'], [fault.owner || '—'], [fault.message],
          ], fault.path ? { label: 'Open', done: openPage(fault) } : undefined);
          r.firstChild.replaceChildren(mark(fault.severity === 'error' ? 'error' : 'warn', fault.severity === 'error' ? '⊗' : '▲'));
          return r;
        }))
  );

  $('missing').replaceChildren(
    data.missing.length === 0
      ? empty('Every declared page has its file.')
      : table(['', 'Page', 'Id', 'File'], data.missing.map((page) => {
          const r = row([['', ''], [page.title], [page.id, 'id'], [page.path]], {
            label: 'Create it',
            done: () => vscode.postMessage({
              type: 'action', action: 'create', path: page.path, title: page.title,
            }),
          });
          r.firstChild.replaceChildren(mark('error', '!'));
          return r;
        }))
  );

  $('stale').replaceChildren(
    data.stale.length === 0
      ? empty('Nothing is stale — either nothing claims code that has moved, or the generator has not judged yet (it needs the page\\'s code globs).')
      : table(['', 'Page', 'Id', 'Owner', 'Last change'], data.stale.map((page) => {
          const r = row([['', ''], [page.title], [page.id, 'id'], [page.owner || '—'], [page.changed || '—']],
            page.path ? { label: 'Open', done: openPage(page) } : undefined);
          r.firstChild.replaceChildren(mark('quiet', '↺'));
          return r;
        }))
  );

  $('unowned').replaceChildren(
    data.unowned.length === 0
      ? empty('Every page on this machine has an owner.')
      : table(['', 'Page', 'Id', 'Where'], data.unowned.map((page) => {
          const r = row([['', ''], [page.title], [page.id, 'id'], [page.path || '—']],
            page.path ? { label: 'Open', done: openPage(page) } : undefined);
          r.firstChild.replaceChildren(mark('warn', '▲'));
          return r;
        }))
  );

  // The repository's own checks, each with what its last run in this session left behind. A run is a fact:
  // where, when, and the exit code. What the script *decided* is in its own output, in the terminal.
  const checks = $('checks');
  if (data.scripts.length === 0) {
    checks.replaceChildren(
      data.anyLocal
        ? empty('The repository being read has none of these scripts. Nothing is offered that the repository does not have.')
        : empty('Nothing on this machine is being read, so there is no repository to check. A source read over the API has no working tree to check in.')
    );
  } else {
    checks.replaceChildren(table(
      ['Script', 'What it does', 'Last run in this session', ''],
      data.scripts.map((script) => {
        const run = script.run;
        const last = run
          ? 'in ' + run.folder + ' at ' + run.at + ' · exit ' + (run.exit === undefined ? 'none' : run.exit) +
            (run.rewritten && run.rewritten.length > 0
              ? ' · rewrote ' + run.rewritten.join(', ')
              : '')
          : 'not run yet';
        return row([[script.label], [script.detail], [last]], {
          label: 'Run',
          done: () => vscode.postMessage({ type: 'action', action: 'script', script: script.id }),
        });
      })
    ));
  }

  $('foot').textContent =
    'Every count on this page comes from a check that already exists somewhere else: the structural checks in ' +
    'the registry reader, the generator’s stale verdict, and the repository’s own scripts. Nothing is ' +
    'computed twice here, and nothing is written except the empty file for a page that is declared and missing.';
}

window.addEventListener('message', (event) => {
  if (event.data.type === 'needs') {
    render(event.data);
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
