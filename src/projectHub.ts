// The project hub: what a project *is*, once it exists.
//
// The edit page answers "what is this project made of"; this one answers "what is in it, and what next". One
// panel, five tabs, and the same fact written twice nowhere: the counts come from the catalog, the pages come
// from the last read, and the AI tab says what the AI is allowed to do with either.
//
// Everything the page offers is an action it posts back: read a source, build, edit, open a page, add a source.
// The page never writes anything itself.

import * as fs from 'fs';
import * as vscode from 'vscode';
import { aiStatus } from './ai/runtime';
import { MODELS, RUNTIMES } from './ai/catalog';
import { PROMPT_VERSION } from './ai/prompts';
import { Catalog, CatalogUnavailable } from './catalog/store';
import { Selection } from './selected';
import { HUB_VIEW_TYPE, pageColumn } from './surface';
import { slugOf } from './projectPage';

/** Where a chapter stops being a chapter. A count, not a rule — it is advice the page shows, never a problem. */
const CHAPTER_LIMIT = 25;

interface Suggestion {
  title: string;
  why: string;
  action?: { command: string; args?: unknown[] };
}

interface HubMessage {
  type:
    | 'ready'
    | 'edit'
    | 'addSourceSubmit'
    | 'pick'
    | 'read'
    | 'readAll'
    | 'build'
    | 'openPage'
    | 'select'
    | 'clear'
    | 'models'
    | 'openModelFolder';
  slug?: string;
  path?: string;
  id?: string;
  title?: string;
  kind?: 'git' | 'folder' | 'archive';
  url?: string;
  branch?: string;
  name?: string;
}

export class ProjectHub {
  private panel: vscode.WebviewPanel | undefined;
  private slug = '';
  private tab: 'overview' | 'pages' | 'sources' | 'ai' | 'builds' = 'overview';
  /** Set only when a caller asked for a tab — otherwise the page keeps the tab the reader chose. */
  private askedTab?: 'overview' | 'pages' | 'sources' | 'ai' | 'builds';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly selection: Selection,
    /** Called after a write. The slug is passed when the project itself was removed. */
    private readonly refresh: (removed?: string) => void
  ) {}

  /**
   * Opens a project's page — and makes it *the* project.
   *
   * Opening a project and working on it are the same act in this application: the Workspace view, the counts,
   * the faults and the AI all read the selected project, so a page that changed without saying so would leave
   * the sidebar answering about something else.
   */
  open(slug: string, tab?: 'overview' | 'pages' | 'sources' | 'ai' | 'builds'): void {
    this.slug = slug;
    this.tab = tab ?? this.tab;
    this.askedTab = tab;
    void this.selection.select(slug);

    if (this.panel) {
      this.panel.title = `Project — ${slug}`;
      this.panel.reveal(pageColumn());
      void this.seed();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(HUB_VIEW_TYPE, `Project — ${slug}`, pageColumn(), {
      enableScripts: true,
      localResourceRoots: [],
    });
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'knowledge.svg');
    this.panel.webview.html = html(nonce());
    this.panel.webview.onDidReceiveMessage((message: HubMessage) => void this.receive(message));
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  /**
   * Told by whoever removed a project.
   *
   * A tab about something that no longer exists is worse than no tab: this closes, and the removal opens the
   * projects page — where what is left is listed, which is the one useful thing to show. Any *other* open
   * project just re-reads itself.
   */
  notifyRemoved(slug: string): void {
    if (!this.panel) {
      return;
    }
    if (this.slug === slug) {
      this.panel.dispose();
      return;
    }
    void this.seed();
  }

  private async receive(message: HubMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.seed();
        return;
      case 'edit':
        await vscode.commands.executeCommand('temcoKnowledge.editProject', this.slug);
        return;
      case 'read':
        await vscode.commands.executeCommand('temcoKnowledge.readSource', message.slug);
        await this.seed();
        this.refresh();
        return;
      case 'readAll':
        await vscode.commands.executeCommand('temcoKnowledge.readAllSources');
        await this.seed();
        this.refresh();
        return;
      case 'addSourceSubmit':
        await this.addSource(message);
        return;
      case 'pick': {
        const kind = message.kind === 'archive' ? 'archive' : 'folder';
        const picked = await vscode.window.showOpenDialog({
          title: kind === 'folder' ? 'Which folder?' : 'Which file?',
          canSelectFolders: kind === 'folder',
          canSelectFiles: kind === 'archive',
          canSelectMany: false,
          openLabel: 'Use this',
        });
        if (picked && picked.length > 0) {
          await this.panel?.webview.postMessage({
            type: 'picked',
            kind,
            name: picked[0].path.split('/').filter(Boolean).pop() ?? picked[0].fsPath,
            path: picked[0].fsPath,
          });
        }
        return;
      }
      case 'select':
        await this.selection.select(this.slug);
        this.refresh();
        return;
      case 'clear':
        await this.selection.select(undefined);
        this.refresh();
        return;
      case 'build':
        await vscode.commands.executeCommand('temcoKnowledge.buildProject', this.slug);
        await this.seed();
        return;
      case 'openPage':
        await vscode.commands.executeCommand('temcoKnowledge.openFile', {
          path: message.path,
          id: message.id,
          title: message.title,
        });
        return;
      case 'models':
        await vscode.commands.executeCommand('temcoKnowledge.aiPage');
        return;
      case 'openModelFolder':
        await vscode.commands.executeCommand('temcoKnowledge.openModelFolder');
        return;
    }
  }

  /**
   * Adds one source to this project, from the Sources tab.
   *
   * A source is added once and cited by any number of projects, so this records it in the catalog and cites it
   * here — the same two calls the create page makes, without asking for the project's own fields again.
   */
  private async addSource(message: HubMessage): Promise<void> {
    const kind = message.kind ?? 'git';
    const name = (message.name ?? '').trim();
    if (kind === 'git' && (message.url ?? '').trim().length < 3) {
      void vscode.window.showWarningMessage('Temco Knowledge: a repository needs an owner/name or a URL.');
      return;
    }
    if (kind !== 'git' && name.length === 0) {
      void vscode.window.showWarningMessage('Temco Knowledge: that source has no name.');
      return;
    }

    const slug = this.slug;
    const ok = await this.withCatalog((catalog) => {
      const sourceSlug = slugOf(name);
      catalog.addSource({
        kind,
        name,
        slug: sourceSlug,
        remoteUrl: kind === 'git' ? (message.url ?? '').trim() : undefined,
        path: kind === 'git' ? undefined : message.path,
        branch: (message.branch ?? '').trim() || undefined,
      });
      catalog.attachSource(slug, sourceSlug);
    });

    if (!ok) {
      return;
    }
    this.refresh();
    await this.seed();
    void vscode.window.showInformationMessage(
      `Temco Knowledge: ${name} is now a source of this project. Read it to see its pages.`
    );
  }

  /** Everything the five tabs show, gathered once per save. */
  private async seed(): Promise<void> {
    if (!this.panel) {
      return;
    }

    let catalog: Catalog | undefined;
    try {
      catalog = await Catalog.open(this.context);
      const detail = catalog.document(this.slug);
      if (!detail) {
        // Opened for a project that is not there — a stale menu argument, or a removal that did not tell us.
        // Either way this is not the page to be on, so it goes and the list of what exists replaces it.
        this.panel?.dispose();
        await vscode.commands.executeCommand('temcoKnowledge.openProjects');
        return;
      }

      const slug = this.slug;
      const pages = catalog.documentPages(slug);
      const artifacts = catalog.documentArtifacts(slug);
      const cited = catalog.documentSources(slug);
      const sources = catalog.sources().filter((source) => cited.some((one) => one.name === source.name));
      const folders = sources
        .map((source) => catalog?.source(source.slug)?.path)
        .filter((path): path is string => typeof path === 'string' && path.length > 0);

      const status = aiStatus(this.context);
      const known = [...RUNTIMES, ...MODELS].length;

      await this.panel.webview.postMessage({
        type: 'project',
        slug,
        project: {
          name: detail.name,
          version: detail.version,
          owner: detail.owner,
          audience: detail.audience,
          engine: detail.engine,
          outputs: detail.outputs,
        },
        counts: {
          pages: pages.length,
          sources: sources.length,
          artifacts: artifacts.length,
          unowned: pages.filter((page) => !page.owner).length,
        },
        pages: pages.map((page) => ({
          source: page.source,
          id: page.id,
          title: page.title,
          owner: page.owner,
          path: page.path,
          onDisk: page.path !== undefined && folders.some((folder) => page.path?.startsWith(folder)),
        })),
        sources: sources.map((source) => ({
          slug: source.slug,
          name: source.name,
          kind: source.kind,
          branch: source.branch,
          state: source.state,
          read: source.lastReadMode,
        })),
        artifacts: artifacts.map((artifact) => ({
          kind: artifact.kind,
          path: artifact.path,
          builtAt: artifact.builtAt,
        })),
        ai: {
          runtime: status.runtime ? status.runtime.id : undefined,
          model: status.model ? status.model.id : undefined,
          running: status.running?.baseUrl,
          promptVersion: PROMPT_VERSION,
          known,
        },
        selected: this.selection.project() === slug,
        tab: this.askedTab,
        suggestions: this.suggest({
          pages,
          sources: sources.map((source) => ({ name: source.name, kind: source.kind, read: source.state })),
          outputs: detail.outputs,
          artifacts: artifacts.length,
        }),
      });
      // Asked once, honoured once: a re-render after a read must not pull the reader off the tab they chose.
      this.askedTab = undefined;
    } catch (error) {
      if (error instanceof CatalogUnavailable) {
        void vscode.window.showErrorMessage(`Temco Knowledge: ${error.message}`);
      } else {
        void vscode.window.showErrorMessage(`Temco Knowledge: ${String(error)}`);
      }
    } finally {
      catalog?.close();
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

  /**
   * What the AI can see and say about a project with no model running.
   *
   * Every suggestion is a fact the catalog already holds — an owner that is missing, a source never read, a
   * chapter past the point where a list is readable. Nothing here is invented, and nothing here is a problem:
   * they are things to consider, each with the action that would deal with it.
   */
  private suggest(facts: {
    pages: { source: string; id: string; title?: string; owner?: string; path?: string }[];
    sources: { name: string; kind: string; read?: string }[];
    outputs: string[];
    artifacts: number;
  }): Suggestion[] {
    const found: Suggestion[] = [];

    if (facts.sources.length === 0) {
      found.push({
        title: 'This project has no sources',
        why: 'A project is built from what it cites. Nothing can be read or built until one is added.',
        action: { command: 'addSource' },
      });
    }

    for (const source of facts.sources) {
      if (!source.read) {
        found.push({
          title: `${source.name} has never been read`,
          why: 'Its pages are unknown, so the Pages tab is empty and no count here includes them.',
          action: { command: 'read', args: [source.name] },
        });
      }
    }

    if (facts.pages.length > 0 && facts.artifacts === 0) {
      found.push({
        title: 'Nothing has been built yet',
        why: `${facts.pages.length} pages are recorded and no output exists. A build is what turns one into the other.`,
        action: { command: 'build' },
      });
    }

    for (const [folder, count] of chapters(facts.pages.map((page) => page.id))) {
      if (count > CHAPTER_LIMIT) {
        found.push({
          title: `${folder} holds ${count} pages`,
          why: `Past about ${CHAPTER_LIMIT} a chapter reads as a list. Splitting it — by function, or by release — is usually what makes it navigable again.`,
        });
      }
    }

    const unowned = facts.pages.filter((page) => !page.owner);
    if (unowned.length > 0) {
      found.push({
        title: `${unowned.length} page${unowned.length === 1 ? '' : 's'} declare no owner`,
        why: 'An owner is where a defect goes. Without one a report is only ever a count.',
      });
    }

    const onDisk = facts.pages.filter((page) => page.path !== undefined && fs.existsSync(page.path));
    const missing = facts.pages.filter((page) => page.path !== undefined && !fs.existsSync(page.path));
    if (facts.sources.some((source) => source.kind === 'folder') && missing.length > 0) {
      found.push({
        title: `${missing.length} recorded page${missing.length === 1 ? '' : 's'} ${missing.length === 1 ? 'is' : 'are'} not on disk`,
        why: 'The registry declares them and their file is gone. A read would correct the list; a page is what restores it.',
      });
    }

    const repeated = repeatedTitles(facts.pages.filter((page) => page.path !== undefined && fs.existsSync(page.path)));
    for (const [title, count] of repeated) {
      found.push({
        title: `${count} pages are titled “${title}”`,
        why: 'Search and the outline cannot tell them apart, and on disk or in an index the second one wins.',
      });
    }

    if (onDisk.length === 0 && facts.pages.length > 0) {
      found.push({
        title: 'No page is on this machine',
        why: 'They were read over the API and recorded, not downloaded. Reading a local clone is what makes their files openable.',
      });
    }

    if (facts.outputs.length === 0) {
      found.push({
        title: 'No output is selected',
        why: 'A build with nothing to produce leaves nothing behind, so the Builds tab stays empty.',
        action: { command: 'edit' },
      });
    }

    return found;
  }
}

/** How a page id begins — the chapter it belongs to. A top-level page is its own chapter. */
function chapters(ids: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const slash = id.indexOf('/');
    const folder = slash === -1 ? '(top level)' : id.slice(0, slash);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return counts;
}

function repeatedTitles(pages: readonly { title?: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const page of pages) {
    if (page.title) {
      counts.set(page.title, (counts.get(page.title) ?? 0) + 1);
    }
  }
  return new Map([...counts].filter(([, count]) => count > 1));
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
    h2 { font-size: 1em; font-weight: 600; margin: 1.6em 0 .5em; }
    h3 { font-size: .95em; font-weight: 600; margin: 1.2em 0 .4em; }
    p { line-height: 1.55; margin: .3em 0; }
    .meta { color: var(--vscode-descriptionForeground); margin: 0 0 1em; }
    .addform { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(16em, 100%), 1fr));
               gap: .8em 1.4em; max-width: 70em; align-items: end; }
    .addform > div { min-width: 0; }
    .addform label { display: block; color: var(--vscode-descriptionForeground); margin-bottom: .2em; }
    .addform input { width: 100%; min-width: 0; padding: .3em .5em; box-sizing: border-box;
                     color: var(--vscode-input-foreground); background: var(--vscode-input-background);
                     border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
                     font-family: inherit; font-size: inherit; }
    .addform input:focus { outline: 1px solid var(--vscode-focusBorder); }
    .addform .do { display: flex; gap: .5em; flex-wrap: wrap; }
    .tabs { display: flex; gap: .2em; border-bottom: 1px solid var(--vscode-panel-border); margin: 0 0 1.2em;
            flex-wrap: wrap; }
    .tabs button { border: none; background: none; color: var(--vscode-foreground); padding: .5em .9em;
                   cursor: pointer; font-family: inherit; font-size: inherit;
                   border-bottom: 2px solid transparent; border-radius: 0; }
    .tabs button:hover { background: var(--vscode-toolbar-hoverBackground); }
    .tabs button[aria-selected=true] { border-bottom-color: var(--vscode-focusBorder); font-weight: 600; }
    .tabs .n { color: var(--vscode-descriptionForeground); font-weight: 400; margin-left: .4em; }
    section[hidden] { display: none; }
    .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(15em, 100%), 1fr)); gap: .8em 2em;
             max-width: 70em; margin: 0 0 1em; }
    .facts div { border-left: 2px solid var(--vscode-panel-border); padding-left: .7em; min-width: 0; }
    .facts dt { color: var(--vscode-descriptionForeground); }
    .facts dd { margin: .1em 0 0; overflow-wrap: anywhere; }
    /* A table wider than the pane scrolls in here rather than widening the page. */
    .scroll { overflow-x: auto; max-width: 100%; }
    table { border-collapse: collapse; width: 100%; max-width: 80em; }
    th, td { text-align: left; padding: .3em .8em .3em 0; vertical-align: top;
             border-bottom: 1px solid var(--vscode-panel-border); overflow-wrap: anywhere; }
    th { color: var(--vscode-descriptionForeground); font-weight: 500; }
    td.id { color: var(--vscode-descriptionForeground); }
    td.act { text-align: right; white-space: nowrap; }
    a.link { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
    a.link:hover { text-decoration: underline; }
    button { padding: .3em .8em; border: none; border-radius: 2px; cursor: pointer;
             font-family: inherit; font-size: inherit;
             color: var(--vscode-button-secondaryForeground);
             background: var(--vscode-button-secondaryBackground); }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    .actions { display: flex; gap: .6em; flex-wrap: wrap; margin: 0 0 1.4em; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: .7em 1em; margin: 0 0 .6em;
            max-width: 70em; }
    .card h3 { margin: 0 0 .2em; }
    .card p { color: var(--vscode-descriptionForeground); margin: 0; }
    .card .do { margin-top: .5em; }
    .empty { color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-panel-border);
             border-radius: 3px; padding: 1em 1.2em; max-width: 70em; }
    code { font-family: var(--vscode-editor-font-family); font-size: .95em; }
    .foot { color: var(--vscode-descriptionForeground); margin-top: 2em; max-width: 70em;
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
  <h1 id="name">Project</h1>
  <p class="meta" id="meta"></p>

  <div class="actions">
    <button class="primary" id="read">Read every source</button>
    <button id="build">Build</button>
    <button id="add">Add a source</button>
    <button id="edit">Edit this project</button>
    <button id="work"></button>
  </div>

  <div class="tabs" role="tablist">
    <button role="tab" aria-selected="true" data-tab="overview">Overview</button>
    <button role="tab" aria-selected="false" data-tab="pages">Pages<span class="n" id="pages-n"></span></button>
    <button role="tab" aria-selected="false" data-tab="sources">Sources<span class="n" id="sources-n"></span></button>
    <button role="tab" aria-selected="false" data-tab="ai">AI</button>
    <button role="tab" aria-selected="false" data-tab="builds">Builds<span class="n" id="builds-n"></span></button>
  </div>

  <section id="tab-overview">
    <dl class="facts" id="overview"></dl>
    <h2>What this project is for</h2>
    <p class="meta" id="purpose"></p>
  </section>

  <section id="tab-pages" hidden>
    <h2>Pages</h2>
    <div id="pages"></div>
  </section>

  <section id="tab-sources" hidden>
    <h2>Sources</h2>
    <p class="meta">What this project is built from. A source is recorded once and cited by any number of
      projects; reading one is what fills its pages in.</p>
    <div id="sources"></div>

    <h3>Add a source</h3>
    <div class="addform">
      <div>
        <label for="addUrl">Repository — owner/name or a full URL</label>
        <input id="addUrl" type="text" placeholder="owner/name" autocomplete="off">
      </div>
      <div>
        <label for="addBranch">Branch</label>
        <input id="addBranch" type="text" placeholder="main" autocomplete="off">
      </div>
      <div class="do">
        <button class="primary" id="addRepo">Add repository</button>
        <button id="addFolder">Add a folder…</button>
        <button id="addArchive">Add an archive…</button>
      </div>
    </div>
  </section>

  <section id="tab-ai" hidden>
    <h2>The AI, on this project</h2>
    <dl class="facts" id="ai"></dl>
    <p class="meta">Suggestions are read from the catalog — a missing owner, a source never read, a chapter past
      the point where a list is readable. Nothing is generated by a model to produce them, so they are the same
      with the AI off. With a model running, the same facts are what it is allowed to reason over.</p>
    <h3>Suggestions</h3>
    <div id="suggestions"></div>
    <h3>Manage the AI</h3>
    <p class="meta">Which runtime, which model, and where they live is the AI page's business, not this
      project's:
      <a class="link" id="models">Open the AI page</a> · <a class="link" id="folder">Open the model folder</a></p>
  </section>

  <section id="tab-builds" hidden>
    <h2>Builds</h2>
    <div id="builds"></div>
  </section>

  <p class="foot" id="foot"></p>

<script nonce="${script}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let picture = null;
/** The tab the reader is on. The extension only overrides it when it asked for a tab on purpose. */
let currentTab = 'overview';

/**
 * The tab the reader is on, drawn. The extension only overrides it when it asked for a tab on purpose, so a
 * re-render after a read never pulls the reader off the tab they chose.
 */
function showTab(which) {
  currentTab = which;
  for (const button of document.querySelectorAll('.tabs button')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === which));
  }
  for (const section of document.querySelectorAll('section')) {
    section.hidden = section.id !== 'tab-' + which;
  }
}

for (const button of document.querySelectorAll('.tabs button')) {
  button.addEventListener('click', () => showTab(button.dataset.tab));
}

$('read').addEventListener('click', () => vscode.postMessage({ type: 'readAll' }));
$('build').addEventListener('click', () => vscode.postMessage({ type: 'build' }));
// Adding a source is a small form on the Sources tab — not the project's own edit page, which would ask for
// every field again to make one decision.
$('add').addEventListener('click', () => {
  showTab('sources');
  $('addUrl').focus();
});
$('edit').addEventListener('click', () => vscode.postMessage({ type: 'edit' }));

document.getElementById('work').addEventListener('click', () => {
  // One button for both directions: which one it is follows the page's own state, not a second control.
  const selected = Boolean(picture?.selected);
  vscode.postMessage({ type: selected ? 'clear' : 'select' });
});

/* A button is wired to exactly one handler, in one block, further down this script. An earlier version wired
   four of them twice — the second, stale block won, and *Add a source* opened the edit form. */

$('addRepo').addEventListener('click', () => {
  const url = $('addUrl').value.trim();
  if (url.length < 3) { $('addUrl').focus(); return; }
  const name = url.replace(/\.git$/, '').split('/').filter(Boolean).pop() || 'repository';
  vscode.postMessage({ type: 'addSourceSubmit', kind: 'git', name, url, branch: $('addBranch').value.trim() });
});
$('addFolder').addEventListener('click', () => vscode.postMessage({ type: 'pick', kind: 'folder' }));
$('addArchive').addEventListener('click', () => vscode.postMessage({ type: 'pick', kind: 'archive' }));
$('models').addEventListener('click', () => vscode.postMessage({ type: 'models' }));
$('folder').addEventListener('click', () => vscode.postMessage({ type: 'openModelFolder' }));

function run(action) {
  if (!action) { return; }
  if (action.command === 'read') {
    const wanted = action.args?.[0];
    const source = (picture?.sources ?? []).find((one) => one.name === wanted) ?? picture?.sources?.[0];
    vscode.postMessage({ type: 'read', slug: source?.slug });
    return;
  }
  vscode.postMessage({ type: action.command });
}

function line(...parts) {
  return parts.filter((part) => part !== undefined && part !== null && part !== '').join(' · ');
}

function fact(label, value) {
  const div = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  div.append(dt, dd);
  return div;
}

function empty(text) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = text;
  return div;
}

function scroll(table) {
  const box = document.createElement('div');
  box.className = 'scroll';
  box.append(table);
  return box;
}

function render(data) {
  picture = data;
  const project = data.project;
  $('name').textContent = project.name;
  $('work').textContent = data.selected ? 'Stop working on this project' : 'Work on this project';
  $('meta').textContent = line(
    project.version ? 'v' + project.version : undefined,
    project.owner ? 'owned by ' + project.owner : 'no owner',
    project.audience,
    project.engine ? 'built with ' + project.engine : 'no build engine'
  );
  $('purpose').textContent = line(
    data.counts.pages + ' pages',
    'read from ' + data.counts.sources + ' source' + (data.counts.sources === 1 ? '' : 's'),
    project.outputs.length > 0 ? 'producing ' + project.outputs.join(', ') : 'producing nothing yet'
  ) + '.';

  $('pages-n').textContent = String(data.counts.pages);
  $('sources-n').textContent = String(data.counts.sources);
  $('builds-n').textContent = String(data.counts.artifacts);

  const overview = $('overview');
  overview.replaceChildren(
    fact('Being worked on', data.selected ? 'yes — the Workspace view and the AI follow this project' : 'no'),
    fact('Pages', String(data.counts.pages)),
    fact('Sources', String(data.counts.sources)),
    fact('Outputs', project.outputs.length === 0 ? 'none chosen' : project.outputs.join(', ')),
    fact('Artifacts', data.counts.artifacts === 0 ? 'none built yet' : String(data.counts.artifacts)),
    fact('Pages without an owner', String(data.counts.unowned)),
    fact('Recorded as', data.slug)
  );

  const pages = $('pages');
  if (data.pages.length === 0) {
    pages.replaceChildren(
      empty(
        data.sources.length === 0
          ? 'Nothing to show: this project cites no sources. Add one, then read it.'
          : 'Nothing read yet. Use Read every source — its pages appear here once it has been read.'
      )
    );
  } else {
    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const text of ['Page', 'Id', 'Owner', 'Where', '']) {
      const th = document.createElement('th');
      th.textContent = text;
      head.append(th);
    }
    table.append(head);
    for (const page of data.pages) {
      const row = document.createElement('tr');
      const title = document.createElement('td');
      title.textContent = page.title || page.id;
      const id = document.createElement('td');
      id.className = 'id';
      id.textContent = page.id;
      const owner = document.createElement('td');
      owner.textContent = page.owner || '—';
      const where = document.createElement('td');
      where.textContent = page.onDisk ? 'this machine' : 'the source';
      const act = document.createElement('td');
      act.className = 'act';
      if (page.onDisk) {
        const link = document.createElement('a');
        link.className = 'link';
        link.textContent = 'Open';
        link.addEventListener('click', () =>
          vscode.postMessage({ type: 'openPage', path: page.path, id: page.id, title: page.title })
        );
        act.append(link);
      }
      row.append(title, id, owner, where, act);
      table.append(row);
    }
    pages.replaceChildren(scroll(table));
  }

  const sources = $('sources');
  if (data.sources.length === 0) {
    sources.replaceChildren(empty('No sources. A project is built from something — add a folder or a repository.'));
  } else {
    sources.replaceChildren(
      ...data.sources.map((source) => {
        const card = document.createElement('div');
        card.className = 'card';
        const h = document.createElement('h3');
        h.textContent = source.name;
        const p = document.createElement('p');
        p.textContent =
          line(source.kind, source.branch ? 'at ' + source.branch : undefined, source.read ? 'read by ' + source.read : 'never read') +
          (source.state ? ' — ' + source.state : '');
        const do_ = document.createElement('div');
        do_.className = 'do';
        const button = document.createElement('button');
        button.textContent = 'Read it';
        button.addEventListener('click', () => vscode.postMessage({ type: 'read', slug: source.slug }));
        do_.append(button);
        card.append(h, p, do_);
        return card;
      })
    );
  }

  const ai = $('ai');
  ai.replaceChildren(
    fact('Runtime', data.ai.runtime ?? 'none installed'),
    fact('Model', data.ai.model ?? 'none installed'),
    fact('Server', data.ai.running ?? 'not running'),
    fact('Instructions', data.ai.promptVersion),
    fact('Available to download', data.ai.known + ' entries')
  );

  const suggestions = $('suggestions');
  if (data.suggestions.length === 0) {
    suggestions.replaceChildren(empty('Nothing to suggest — every source has been read and every page has an owner.'));
  } else {
    suggestions.replaceChildren(
      ...data.suggestions.map((suggestion) => {
        const card = document.createElement('div');
        card.className = 'card';
        const h = document.createElement('h3');
        h.textContent = suggestion.title;
        const p = document.createElement('p');
        p.textContent = suggestion.why;
        card.append(h, p);
        if (suggestion.action) {
          const do_ = document.createElement('div');
          do_.className = 'do';
          const button = document.createElement('button');
          button.textContent = suggestion.action.command === 'build' ? 'Build' : 'Do it';
          button.addEventListener('click', () => run(suggestion.action));
          do_.append(button);
          card.append(do_);
        }
        return card;
      })
    );
  }

  const builds = $('builds');
  if (data.artifacts.length === 0) {
    builds.replaceChildren(
      empty(
        project.outputs.length === 0
          ? 'Never built, and no output chosen — edit the project to say what it should produce.'
          : 'Never built. A build runs the source repository\\'s own script and records the files it leaves behind.'
      )
    );
  } else {
    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const text of ['Artifact', 'Kind', 'Built', '']) {
      const th = document.createElement('th');
      th.textContent = text;
      head.append(th);
    }
    table.append(head);
    for (const artifact of data.artifacts) {
      const row = document.createElement('tr');
      const path = document.createElement('td');
      path.textContent = artifact.path;
      const kind = document.createElement('td');
      kind.textContent = artifact.kind;
      const built = document.createElement('td');
      built.textContent = artifact.builtAt.slice(0, 16).replace('T', ' ');
      const act = document.createElement('td');
      act.className = 'act';
      const link = document.createElement('a');
      link.className = 'link';
      link.textContent = 'Reveal';
      link.addEventListener('click', () => vscode.postMessage({ type: 'openPage', path: artifact.path }));
      act.append(link);
      row.append(path, kind, built, act);
      table.append(row);
    }
    builds.replaceChildren(scroll(table));
  }

  $('foot').textContent =
    'This page reads the catalog and asks for work; it writes nothing itself. Everything shown came from the ' +
    'last read of a source, and a read is always a snapshot of that moment.';
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'project') {
    render(message);
    if (message.tab) { showTab(message.tab); }
    return;
  }
  if (message.type === 'picked') {
    // A folder or an archive picked in the OS dialog is added straight away: the dialog already said yes.
    vscode.postMessage({ type: 'addSourceSubmit', kind: message.kind, name: message.name, path: message.path });
    return;
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
