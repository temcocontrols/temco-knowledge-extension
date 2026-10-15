// The projects page: every project, what it is made of, and what you can do with it.
//
// The Library's *Projects* row opens this. It exists because the alternative is a list of names with no room to
// say anything: a project's version, its owner, how many pages it has, which sources are unread and whether it
// has ever been built are all one line each — and every one of them is a reason to do something, so the
// operations sit on the same card rather than in a menu somewhere else.
//
// This is the page that is *not* about one project. The hub (`src/projectHub.ts`) is the opposite: one project,
// in depth. Both are tabs in the same group, so going from the list to one project and back is two clicks.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { OFFERED_SCRIPTS } from './builds';
import { Catalog, CatalogUnavailable } from './catalog/store';
import { slugOf } from './projectPage';
import { Selection } from './selected';
import { PROJECTS_VIEW_TYPE, pageColumn } from './surface';

export interface ProjectCard {
  slug: string;
  name: string;
  version?: string;
  owner?: string;
  outputs: string[];
  sources: { name: string; kind: string; branch?: string; pages?: number; read?: string }[];
  pages: number;
  unowned: number;
  artifacts: number;
  builtAt?: string;
  selected: boolean;
  /** The repository's own scripts this project's folders have — empty when none is a folder on this machine. */
  scripts: string[];
}

interface ProjectsMessage {
  type: 'ready' | 'action';
  action?: 'new' | 'open' | 'edit' | 'work' | 'clear' | 'read' | 'build' | 'remove' | 'scripts';
  slug?: string;
  path?: string;
}

/**
 * The offered scripts a folder has, read from its own `package.json`.
 *
 * A read, and only a read: what runs is the Library's own `runScript`, which reports a run as where, when and
 * what it exited with. The allowlist is shared for the same reason it exists — invoking an arbitrary npm script
 * from a page is exactly what it is there to prevent.
 */
function offeredIn(directory: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const names = parsed.scripts ?? {};
    return OFFERED_SCRIPTS.filter((script) => names[script.id] !== undefined).map((script) => script.id);
  } catch {
    return [];
  }
}

export class ProjectsPage {
  private panel: vscode.WebviewPanel | undefined;
  /** What the last render put on screen: the page answers a click without asking the catalog again. */
  private cards: ProjectCard[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly selection: Selection
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal(pageColumn());
      void this.seed();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(PROJECTS_VIEW_TYPE, 'Projects', pageColumn(), {
      enableScripts: true,
      localResourceRoots: [],
    });
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'knowledge.svg');
    this.panel.webview.html = html(nonce());
    this.panel.webview.onDidReceiveMessage((message: ProjectsMessage) => void this.receive(message));
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  /** Re-renders if it is open — what the rest of the application calls after creating or removing a project. */
  refresh(): void {
    if (this.panel) {
      void this.seed();
    }
  }

  /**
   * Runs one of the repository's own scripts for a project.
   *
   * Which scripts is decided by the folders this project cites, not by a list in the page: a repository that has
   * no such script is not offered it. A script runs in the folder *being read*, and the folder being read follows
   * the project being worked on — so when the project is not that one, it is made so first, out loud, because
   * the Workspace view changes with it.
   */
  private async runOne(slug?: string): Promise<void> {
    const card = this.cards.find((candidate) => candidate.slug === slug);
    const offered = OFFERED_SCRIPTS.filter((script) => card?.scripts.includes(script.id) === true);
    if (!card || offered.length === 0) {
      void vscode.window.showInformationMessage(
        'Temco Knowledge: none of this project’s sources is a folder on this machine, so its own scripts cannot be run from here.'
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      offered.map((script) => ({ label: script.label, detail: script.detail, description: script.id, id: script.id })),
      { title: `Run one of the repository’s own scripts — ${card.name}`, placeHolder: 'Each one writes to your repository, in its own format' }
    );
    if (!picked) {
      return;
    }
    if (this.selection.project() !== card.slug) {
      await vscode.commands.executeCommand('temcoKnowledge.selectProject', card.slug);
    }
    await vscode.commands.executeCommand('temcoKnowledge.runScript', picked.id);
  }

  private async receive(message: ProjectsMessage): Promise<void> {
    if (message.type === 'ready') {
      await this.seed();
      return;
    }
    if (message.type !== 'action') {
      return;
    }

    const slug = message.slug;
    switch (message.action) {
      case 'new':
        await vscode.commands.executeCommand('temcoKnowledge.newProject');
        break;
      case 'open':
        await vscode.commands.executeCommand('temcoKnowledge.openProject', slug);
        break;
      case 'edit':
        await vscode.commands.executeCommand('temcoKnowledge.editProject', slug);
        break;
      case 'work':
        await vscode.commands.executeCommand('temcoKnowledge.selectProject', slug);
        break;
      case 'clear':
        await vscode.commands.executeCommand('temcoKnowledge.clearProject');
        break;
      case 'read':
        await vscode.commands.executeCommand('temcoKnowledge.readAllSources', slug);
        break;
      case 'build':
        await vscode.commands.executeCommand('temcoKnowledge.buildProject', slug);
        break;
      case 'scripts':
        await this.runOne(slug);
        break;
      case 'remove':
        await vscode.commands.executeCommand('temcoKnowledge.removeProject', slug);
        break;
    }
    await this.seed();
  }

  private async seed(): Promise<void> {
    if (!this.panel) {
      return;
    }

    let catalog: Catalog | undefined;
    try {
      catalog = await Catalog.open(this.context);
      const selected = this.selection.project();
      const sources = catalog.sources();
      const cards: ProjectCard[] = [];

      for (const row of catalog.documents()) {
        const slug = slugOf(row.name);
        const detail = catalog.document(slug);
        const cited = catalog.documentSources(slug);
        const pages = catalog.documentPages(slug);
        const artifacts = catalog.documentArtifacts(slug);

        cards.push({
          slug,
          name: row.name,
          version: row.version,
          owner: detail?.owner,
          outputs: detail?.outputs ?? [],
          pages: pages.length,
          unowned: pages.filter((page) => !page.owner).length,
          artifacts: artifacts.length,
          builtAt: artifacts[0]?.builtAt,
          selected: slug === selected,
          // The sources this project cites, each with what the last read found — the two facts that decide
          // whether anything here is trustworthy yet.
          sources: cited.map((source) => {
            const known = sources.find((one) => one.name === source.name);
            return {
              name: source.name,
              kind: source.kind,
              branch: source.branch,
              pages: known?.pages,
              read: known?.lastReadMode,
            };
          }),
          scripts: [],
        });

        // The repository's own scripts, for the projects whose source is a folder on this machine. A script
        // belongs to a repository, so this is offered per project only because a project is what cites one.
        const card = cards[cards.length - 1];
        for (const source of cited) {
          const known = sources.find((one) => one.name === source.name);
          const detail = known ? catalog.source(known.slug) : undefined;
          if (detail?.path !== undefined) {
            for (const id of offeredIn(detail.path)) {
              if (!card.scripts.includes(id)) {
                card.scripts.push(id);
              }
            }
          }
        }
      }

      // The one being worked on first: this page is read top-down, and the top is what you are on.
      cards.sort((a, b) => Number(b.selected) - Number(a.selected) || a.name.localeCompare(b.name));
      this.cards = cards;

      await this.panel.webview.postMessage({
        type: 'projects',
        cards,
        counts: {
          projects: cards.length,
          sources: sources.length,
          pages: cards.reduce((total, card) => total + card.pages, 0),
          unread: sources.filter((source) => source.pages === undefined).length,
          artifacts: cards.reduce((total, card) => total + card.artifacts, 0),
        },
        selected,
      });
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
    h3 { font-size: 1.05em; font-weight: 600; margin: 0 0 .2em; }
    p { line-height: 1.55; margin: .3em 0; }
    .meta { color: var(--vscode-descriptionForeground); }
    .actions { display: flex; gap: .6em; flex-wrap: wrap; margin: .2em 0 1.4em; }
    .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(13em, 100%), 1fr)); gap: .8em 2em;
             max-width: 70em; margin: 0 0 1.2em; }
    .facts div { border-left: 2px solid var(--vscode-panel-border); padding-left: .7em; min-width: 0; }
    .facts dt { color: var(--vscode-descriptionForeground); }
    .facts dd { margin: .1em 0 0; overflow-wrap: anywhere; }
    button { padding: .3em .8em; border: none; border-radius: 2px; cursor: pointer;
             font-family: inherit; font-size: inherit;
             color: var(--vscode-button-secondaryForeground);
             background: var(--vscode-button-secondaryBackground); }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: .9em 1.1em;
            margin: 0 0 .8em; max-width: 74em; }
    .card.here { border-color: var(--vscode-focusBorder); }
    .card .head { display: flex; gap: 1em; align-items: baseline; flex-wrap: wrap; }
    .card .head h3 { flex: 0 1 auto; }
    .card .head .tag { color: var(--vscode-descriptionForeground); flex: 1 1 auto; }
    .card .line { color: var(--vscode-descriptionForeground); margin: .25em 0 0; overflow-wrap: anywhere; }
    .card .do { display: flex; gap: .5em; flex-wrap: wrap; margin: .7em 0 0; }
    .warn { color: var(--vscode-errorForeground); }
    .empty { color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-panel-border);
             border-radius: 3px; padding: 1.2em 1.4em; max-width: 70em; }
    code { font-family: var(--vscode-editor-font-family); font-size: .95em; overflow-wrap: anywhere; }
    .foot { color: var(--vscode-descriptionForeground); margin-top: 2.4em; max-width: 74em;
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
  <h1>Projects</h1>
  <p class="meta">A project is what this application manages: the sources it is built from, the pages that come
    out of them, and the artifact that ships. One of them is the one being worked on — the Workspace view and
    the AI follow it.</p>
  <div class="actions">
    <button class="primary" id="new">Create a project</button>
    <button id="readAll">Read every unread source</button>
  </div>

  <dl class="facts" id="counts"></dl>
  <div id="cards"></div>

  <p class="foot">Everything on this page is read from the catalog on this machine — 12 tables, no network
    needed. Removing a project forgets it and its artifacts here; it touches nothing at its sources.</p>

<script nonce="${script}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

$('new').addEventListener('click', () => vscode.postMessage({ type: 'action', action: 'new' }));
$('readAll').addEventListener('click', () => vscode.postMessage({ type: 'action', action: 'read' }));

function fact(label, value) {
  const div = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  div.append(dt, dd);
  return div;
}

function action(card, label, kind, name, primary) {
  const button = document.createElement('button');
  button.textContent = label;
  if (primary) { button.className = 'primary'; }
  button.addEventListener('click', () => vscode.postMessage({ type: 'action', action: kind, slug: card.slug }));
  button.title = name;
  return button;
}

function line(...parts) {
  return parts.filter((part) => part !== undefined && part !== null && part !== '').join(' · ');
}

function card(data) {
  const box = document.createElement('div');
  box.className = 'card' + (data.selected ? ' here' : '');

  const head = document.createElement('div');
  head.className = 'head';
  const title = document.createElement('h3');
  title.textContent = data.name;
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = line(
    data.selected ? 'being worked on' : undefined,
    data.version ? 'v' + data.version : 'no version',
    data.owner ? 'owner ' + data.owner : 'no owner',
    data.outputs.length === 0 ? 'no output chosen' : 'outputs ' + data.outputs.join(', ')
  );
  head.append(title, tag);
  box.append(head);

  const sources = document.createElement('p');
  sources.className = 'line';
  sources.textContent = data.sources.length === 0
    ? 'No sources — this project cannot be read or built yet.'
    : 'Sources: ' + data.sources.map((source) =>
        source.name + ' (' + [
          source.kind,
          source.branch,
          source.pages === undefined ? 'never read' : source.pages + ' pages',
          source.read ? 'read by ' + source.read : undefined,
        ].filter(Boolean).join(', ') + ')').join(' · ');
  box.append(sources);

  const state = document.createElement('p');
  state.className = 'line' + (data.pages > 0 && data.unowned > 0 ? ' warn' : '');
  state.textContent = line(
    data.pages + ' page' + (data.pages === 1 ? '' : 's'),
    data.unowned > 0 ? data.unowned + ' without an owner' : 'every page has an owner',
    data.artifacts === 0
      ? 'never built'
      : data.artifacts + ' artifact' + (data.artifacts === 1 ? '' : 's') +
        (data.builtAt ? ' · last ' + data.builtAt.slice(0, 16).replace('T', ' ') : '')
  ) + '.';
  box.append(state);

  const do_ = document.createElement('div');
  do_.className = 'do';
  if (data.selected) {
    do_.append(
      action(data, 'Stop working on it', 'clear', 'The Workspace view is hidden again — the Library is all there is'),
      action(data, 'Open the project', 'open', 'Its own page, with tabs')
    );
  } else {
    do_.append(
      action(data, 'Work on it', 'work', 'The Workspace view and the AI follow this project', true),
      action(data, 'Open', 'open', 'Its own page, with tabs')
    );
  }
  do_.append(
    action(data, 'Read sources', 'read', 'Reads this project’s sources that have never been read'),
    action(data, 'Build', 'build', 'Runs the repository’s own generator, then the output script')
  );
  if (data.scripts.length > 0) {
    do_.append(
      action(data, 'Scripts…', 'scripts', 'The repository’s own checks and generators: pick one to run')
    );
  }
  do_.append(
    action(data, 'Edit', 'edit', 'Name, version, owner, sources, outputs'),
    action(data, 'Remove…', 'remove', 'Forgets the project; its sources are kept')
  );
  box.append(do_);
  return box;
}

function render(data) {
  $('counts').replaceChildren(
    fact('Projects', String(data.counts.projects)),
    fact('Sources recorded', String(data.counts.sources)),
    fact('Pages recorded', String(data.counts.pages)),
    fact('Sources never read', data.counts.unread === 0 ? 'none — everything has been read' : String(data.counts.unread)),
    fact('Artifacts', String(data.counts.artifacts)),
    fact('Being worked on', data.selected ?? 'nothing yet')
  );

  const cards = $('cards');
  if (data.cards.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      'No projects yet. A project is created before its sources are settled — name it, then give it one.';
    cards.replaceChildren(empty);
    return;
  }
  cards.replaceChildren(...data.cards.map(card));
}

window.addEventListener('message', (event) => {
  if (event.data.type === 'projects') {
    render(event.data);
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
