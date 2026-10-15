// The organisation's repositories, as a page.
//
// The Library's *Sources* row lists what has already been read. This is the step before it: what the
// organisation has, which of them the project being worked on already cites, and one button that **starts** a
// repository — adds it as a source of that project and reads its own registry.
//
// The project hub's *Add a source* form does the same thing one source at a time, by hand. This does it from a
// list, which is what a person with forty repositories actually needs: the list is the thing they have to read
// before they can choose.
//
// Nothing here writes to a repository. A source is a row in the catalog on this machine, and reading one is
// `read.ts`'s job — the same command the Library uses, so the output and the notes are the same too.

import * as vscode from 'vscode';
import { Catalog } from './catalog/store';
import { slugOf } from './projectPage';
import { REPOSITORIES_VIEW_TYPE, pageColumn } from './surface';
import { Selection } from './selected';
import { RepositoryRow, listRepositories } from './repository';
import { cloneSize, hasClone } from './workarea';

interface RepositoriesMessage {
  type?: string;
  name?: string;
  url?: string;
  text?: string;
}

/** The organisation the page lists: a setting, with the default the platform was built for. */
function organisation(): string {
  const configured = vscode.workspace.getConfiguration('temcoKnowledge').get<string>('organisation');
  return configured !== undefined && configured.trim().length > 0 ? configured.trim() : 'temcocontrols';
}

export class RepositoriesPage {
  private panel: vscode.WebviewPanel | undefined;
  /** The last list GitHub gave, so a click does not mean a second round trip. */
  private listed: RepositoryRow[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly selection: Selection,
    private readonly refresh: () => void
  ) {}

  /** Opens the page, or brings it forward if it is already open. One instance, always. */
  open(): void {
    if (this.panel) {
      this.panel.reveal(pageColumn());
      void this.render();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(REPOSITORIES_VIEW_TYPE, 'Repositories', pageColumn(), {
      enableScripts: true,
      localResourceRoots: [],
    });
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'knowledge.svg');
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message: RepositoriesMessage) => void this.receive(message));
    void this.render();
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private async render(): Promise<void> {
    const panel = this.panel;
    if (!panel) {
      return;
    }
    panel.webview.html = html(nonce());
    await this.send();
  }

  /** Everything the page draws, in one message: the list, and what the project already cites. */
  private async send(): Promise<void> {
    const panel = this.panel;
    if (!panel) {
      return;
    }
    const org = organisation();
    const project = this.selection.project();
    const cited = project === undefined ? [] : await this.cited(project);
    const result = await listRepositories(this.context, org);

    if ('error' in result) {
      this.listed = [];
      await panel.webview.postMessage({ type: 'seed', org, project, cited, error: result.error });
      return;
    }
    this.listed = result.repositories;
    // Which of them already has a local copy, so the page offers *Fetch* or *Pull* rather than both.
    const copies: Record<string, string | undefined> = {};
    if (project !== undefined) {
      for (const row of result.repositories) {
        if (await hasClone(project, row.name)) {
          copies[row.name] = (await cloneSize(project, row.name)) ?? '';
        }
      }
    }
    await panel.webview.postMessage({
      type: 'seed',
      org,
      project,
      cited,
      copies,
      truncated: result.truncated,
      repositories: result.repositories,
    });
  }

  /** What the project being worked on already cites, by name — the names are what a repository is matched on. */
  private async cited(project: string): Promise<string[]> {
    let catalog: Catalog | undefined;
    try {
      catalog = await Catalog.open(this.context);
      return catalog.documentSources(project).map((source) => source.name);
    } catch {
      return [];
    } finally {
      catalog?.close();
    }
  }

  private async receive(message: RepositoriesMessage): Promise<void> {
    switch (message.type) {
      case 'start':
        await this.start(message.name ?? '');
        return;
      case 'fetch':
        // Fetching a repository that was never started makes it a source first: a clone belongs to a source.
        await this.cite(message.name ?? '');
        await vscode.commands.executeCommand('temcoKnowledge.fetchSource', slugOf(message.name ?? ''));
        await this.send();
        return;
      case 'pull':
        await vscode.commands.executeCommand('temcoKnowledge.pullSource', slugOf(message.name ?? ''));
        await this.send();
        return;
      case 'open':
        if (message.url !== undefined) {
          await vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        return;
      case 'openClone':
        await vscode.commands.executeCommand('temcoKnowledge.openClone', slugOf(message.name ?? ''));
        return;
      case 'removeClone':
        await vscode.commands.executeCommand('temcoKnowledge.removeClone', slugOf(message.name ?? ''));
        await this.send();
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(message.text ?? '');
        return;
      case 'reload':
        await this.send();
        return;
      default:
        return;
    }
  }

  /** Records a repository as a source of the project being worked on, without reading it. */
  private async cite(name: string): Promise<void> {
    const row = this.listed.find((candidate) => candidate.name === name);
    const project = this.selection.project();
    if (row === undefined || project === undefined) {
      return;
    }
    let catalog: Catalog | undefined;
    try {
      catalog = await Catalog.open(this.context);
      const slug = slugOf(row.name);
      catalog.addSource({
        kind: 'git',
        name: row.name,
        slug,
        remoteUrl: row.cloneUrl,
        defaultBranch: row.defaultBranch,
      });
      const cited = catalog.documentSourceSlugs(project);
      catalog.setDocumentSources(project, [...new Set([...cited, slug])]);
    } catch {
      // The commands that follow report their own refusals; this only records the coordinates.
    } finally {
      catalog?.close();
    }
  }

  /**
   * Start a repository: cite it in the project being worked on, then read it.
   *
   * The cite is what makes it part of the project; the read is what puts its pages in the Workspace view. Both
   * are the acts the hub already performs, reached from the other end — a list instead of a form.
   */
  private async start(name: string): Promise<void> {
    const row = this.listed.find((candidate) => candidate.name === name);
    const project = this.selection.project();
    if (row === undefined) {
      return;
    }
    if (project === undefined) {
      void vscode.window.showInformationMessage(
        'Temco Knowledge: a source belongs to a project being worked on. Choose one first — the Library’s Projects row.',
        'Projects'
      ).then((answer) => {
        if (answer === 'Projects') {
          void vscode.commands.executeCommand('temcoKnowledge.openProjects');
        }
      });
      return;
    }

    let catalog: Catalog | undefined;
    try {
      catalog = await Catalog.open(this.context);
      const slug = slugOf(row.name);
      catalog.addSource({
        kind: 'git',
        name: row.name,
        slug,
        remoteUrl: row.cloneUrl,
        defaultBranch: row.defaultBranch,
      });
      // The whole list, not the addition: this only ever adds, but the act is "this project cites these".
      const cited = catalog.documentSourceSlugs(project);
      catalog.setDocumentSources(project, [...new Set([...cited, slug])]);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Temco Knowledge: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    } finally {
      catalog?.close();
    }

    this.refresh();
    await this.send();
    // The read reports itself in the output channel, so nothing is said here about what it found.
    await vscode.commands.executeCommand('temcoKnowledge.readSource', slugOf(row.name));
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
    h2 { font-size: 1em; font-weight: 600; margin: 1.8em 0 .5em; }
    p { line-height: 1.55; margin: .3em 0; }
    .meta { color: var(--vscode-descriptionForeground); }
    .bar { display: flex; gap: .6em; align-items: center; flex-wrap: wrap; margin: 1.2em 0 .8em;
           max-width: 78em; }
    input[type=search] { flex: 1 1 16em; min-width: 8em; padding: .35em .6em; font-family: inherit;
           font-size: inherit; color: var(--vscode-input-foreground);
           background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent);
           border-radius: 2px; }
    input[type=search]:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    button { padding: .3em .8em; border: none; border-radius: 2px; cursor: pointer; font-family: inherit;
             font-size: inherit; color: var(--vscode-button-secondaryForeground);
             background: var(--vscode-button-secondaryBackground); }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .5; cursor: default; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: .8em 1em;
            margin: 0 0 .6em; max-width: 78em; }
    .card.cited { border-color: var(--vscode-focusBorder); }
    .card .top { display: flex; gap: .8em; align-items: baseline; flex-wrap: wrap; }
    .card .name { font-weight: 600; }
    .card .tags { color: var(--vscode-descriptionForeground); flex: 1 1 auto; }
    .card .desc { margin: .2em 0 0; overflow-wrap: anywhere; }
    .card .do { display: flex; gap: .5em; flex-wrap: wrap; margin: .6em 0 0; }
    .cited-mark { color: var(--vscode-charts-green); }
    .note { color: var(--vscode-descriptionForeground); margin: .4em 0 0; }
    .warn { color: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder);
            background: var(--vscode-inputValidation-errorBackground); border-radius: 3px; padding: .8em 1em;
            max-width: 78em; margin: 1em 0; }
    .empty { color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-panel-border);
             border-radius: 3px; padding: 1.2em 1.4em; max-width: 78em; }
    .foot { color: var(--vscode-descriptionForeground); margin-top: 2.4em; max-width: 78em;
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
  <h1 id="title">Repositories</h1>
  <p class="meta" id="lede">Reading the organisation from GitHub…</p>

  <div class="bar" hidden id="bar">
    <input type="search" id="filter" placeholder="Filter by name, description or language" aria-label="Filter">
    <button id="reload">Read GitHub again</button>
  </div>

  <div id="error"></div>
  <div id="list"></div>

  <p class="foot"><strong>Start</strong> adds the repository as a source of the project being worked on, then
    reads its own <code>docs/help/registry.json</code> over the API — no clone, nothing written to the
    repository. <strong>Fetch the local copy</strong> clones it into the working area instead (one branch, full
    history), which is what lets the AI read its files and its history; <strong>Pull</strong> freshens that copy,
    and <strong>Remove</strong> deletes only the copy. The repository itself is never written to and never
    pushed to. A private repository needs a token (<em>Set a GitHub Token</em>). The organisation is the
    <code>temcoKnowledge.organisation</code> setting; the working area is
    <code>temcoKnowledge.workspaceFolder</code>.</p>

<script nonce="${script}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let repositories = [];
let cited = [];
let copies = {};

$('reload').addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
$('filter').addEventListener('input', () => draw());

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type !== 'seed') {
    return;
  }
  const org = message.org;
  $('title').textContent = 'Repositories — ' + org;

  if (message.error) {
    $('lede').textContent = 'The list could not be read.';
    const box = document.createElement('div');
    box.className = 'warn';
    box.textContent = message.error;
    $('error').replaceChildren(box);
    $('bar').hidden = true;
    $('list').replaceChildren();
    return;
  }

  repositories = message.repositories || [];
  cited = message.cited || [];
  copies = message.copies || {};
  $('error').replaceChildren();
  $('bar').hidden = false;
  $('lede').textContent =
    repositories.length + (repositories.length === 1 ? ' repository' : ' repositories') +
    ' · most recently pushed first' +
    (message.truncated ? ' · the first 100' : '') +
    (message.project ? ' · starting one adds it to ' + message.project : ' · no project is being worked on yet');
  draw();
});

function draw() {
  const needle = $('filter').value.trim().toLowerCase();
  const shown = repositories.filter((repo) =>
    needle.length === 0 ||
    (repo.name + ' ' + repo.description + ' ' + repo.language).toLowerCase().includes(needle));

  if (shown.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = repositories.length === 0
      ? 'This organisation has no repositories this token can see.'
      : 'No repository matches that filter.';
    $('list').replaceChildren(empty);
    return;
  }

  const nodes = shown.map((repo) => {
    const card = document.createElement('div');
    card.className = 'card' + (cited.includes(repo.name) ? ' cited' : '');

    const top = document.createElement('div');
    top.className = 'top';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = repo.name;
    const tags = document.createElement('span');
    tags.className = 'tags';
    tags.textContent = [repo.language, repo.pushedAt ? 'pushed ' + repo.pushedAt : '', repo.isPrivate ? 'private' : 'public']
      .filter(Boolean).join(' · ');
    top.append(name, tags);

    const desc = document.createElement('p');
    desc.className = 'desc';
    desc.textContent = repo.description || 'No description.';

    const do_ = document.createElement('div');
    do_.className = 'do';
    const start = document.createElement('button');
    start.className = 'primary';
    start.textContent = cited.includes(repo.name) ? 'Start again' : 'Start';
    start.addEventListener('click', () => vscode.postMessage({ type: 'start', name: repo.name }));
    const open = document.createElement('button');
    open.textContent = 'Open on GitHub';
    open.addEventListener('click', () => vscode.postMessage({ type: 'open', url: repo.webUrl }));
    const copy = document.createElement('button');
    copy.textContent = 'Copy the clone URL';
    copy.addEventListener('click', () => vscode.postMessage({ type: 'copy', text: repo.cloneUrl }));
    do_.append(start, open, copy);

    // The local copy: fetch it, or pull it when it is already here. Never automatic — this is the button.
    const cloned = Object.prototype.hasOwnProperty.call(copies, repo.name);
    const local = document.createElement('button');
    local.textContent = cloned ? 'Pull' : 'Fetch the local copy';
    local.addEventListener('click', () => vscode.postMessage({ type: cloned ? 'pull' : 'fetch', name: repo.name }));
    do_.append(local);
    if (cloned) {
      const show = document.createElement('button');
      show.textContent = 'Open the local copy';
      show.addEventListener('click', () => vscode.postMessage({ type: 'openClone', name: repo.name }));
      const drop = document.createElement('button');
      drop.textContent = 'Remove the local copy';
      drop.addEventListener('click', () => vscode.postMessage({ type: 'removeClone', name: repo.name }));
      do_.append(show, drop);
    }

    card.append(top, desc, do_);
    if (cited.includes(repo.name)) {
      const mark = document.createElement('p');
      mark.className = 'note cited-mark';
      mark.textContent = 'Already a source of the project being worked on.  '
        + 'Read from the API' + (Object.prototype.hasOwnProperty.call(copies, repo.name) ? '' : ' — fetching a local copy lets the AI read its files.');
      card.append(mark);
    }
    return card;
  });

  $('list').replaceChildren(...nodes);
}
</script>
</body>
</html>
`;
}
