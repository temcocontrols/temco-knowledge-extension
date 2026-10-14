// The dashboard — the application's own window.
//
//   TOP    identity, and how the application works, in four steps
//   MAIN   one scrolling column: what we have now, how to start now, and what the application can do
//
// A single column, because the rail proved to be a second place to look for the same facts. Nothing here is
// specific to a product: the documents and sources come from the catalog, the folders from what is open, and
// the organisation is a setting rather than a name in the code.

import * as vscode from 'vscode';
import { Catalog, CatalogUnavailable } from './catalog/store';
import { DocsRoot, collectPages, countStale, totals } from './registry';

import { slugOf } from './projectPage';
import { HOME_VIEW_TYPE, pageColumn } from './surface';
import { Selection } from './selected';

interface Feature {
  name: string;
  state: 'working';
  detail: string;
}

/** Every feature, and whether it is built. The list is the page's centre, so it is kept honest. */
const FEATURES: Feature[] = [
  {
    name: 'Content view',
    state: 'working',
    detail:
      "Every open project's registry as areas → chapters → pages, the faults marked in the file that has to be fixed, and a Gaps node that gathers them.",
  },
  {
    name: 'Local AI',
    state: 'working',
    detail:
      'An offline model: ask about the open page, Draft update as a diff you accept, Ask the area for an answer that cites real pages. Needs a model downloaded once.',
  },
  {
    name: 'Builds',
    state: 'working',
    detail:
      "The open project's own scripts, invoked as tasks and judged by the artifact they leave behind — never by an exit code, and never by deploying.",
  },
  {
    name: 'Documentation Owed',
    state: 'working',
    detail:
      'What needs attention, grouped by the owner who owes it, with counts rather than lists for pages that were merely never reviewed.',
  },
  {
    name: 'The Catalog',
    state: 'working',
    detail:
      'The application’s memory: one SQLite database on this machine for sources, documents, builds and what changed. Never in a repository, never committed.',
  },
  {
    name: 'Projects',
    state: 'working',
    detail:
      'Create a project — the thing you manage and version — and give it sources: a repository at a branch you choose, a folder on this machine, or an archive.',
  },
  {
    name: 'Start a Registry',
    state: 'working',
    detail:
      'Creates the smallest valid registry in a folder you have open, on a confirmation, and leaves filling it to that project’s own generator.',
  },
];

const STEPS: [string, string][] = [
  ['Read', 'a source where it lives — a repository at a branch you choose, a folder, an archive'],
  ['Remember', 'what it found goes into one local catalog: what exists, what changed, what is owed'],
  ['Build', 'a project cites its sources, declares its outputs, and leaves an artifact: CHM, PDF, site'],
  ['Review', 'the model drafts, a person approves — nothing is published on its own'],
];

export class HomePanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly selection: Selection,
    private readonly roots: () => readonly DocsRoot[]
  ) {}

  /** Opens the page, or brings it forward if it is already open. One instance, always. */
  open(): void {
    if (this.panel) {
      this.panel.reveal(pageColumn());
      this.render();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(HOME_VIEW_TYPE, 'Temco Knowledge', pageColumn(), {
      enableScripts: false,
      localResourceRoots: [],
    });
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'knowledge.svg');
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.render();
  }

  /** Re-renders if the page is open. Called by the refresh path, so the page follows the workspace. */
  refresh(): void {
    if (this.panel) {
      this.render();
    }
  }

  private render(): void {
    const panel = this.panel;
    if (!panel) {
      return;
    }
    void this.compose().then(
      (html) => {
        if (this.panel === panel) {
          panel.webview.html = html;
        }
      },
      (error: unknown) => {
        if (this.panel === panel) {
          panel.webview.html = shell(
            `<h1>Temco Knowledge</h1><p class="bad">The dashboard could not be rendered: ${escapeHtml(
              String(error)
            )}</p>`
          );
        }
      }
    );
  }

  private async compose(): Promise<string> {
    const roots = this.roots();
    const sums = totals(roots);

    let catalog: Catalog | undefined;
    let unavailable: string | undefined;
    try {
      catalog = await Catalog.open(this.context);
    } catch (error) {
      unavailable = error instanceof CatalogUnavailable ? error.message : String(error);
    }

    const counts = catalog?.counts() ?? [];
    const recorded = counts.reduce((total, [, n]) => total + n, 0);
    const unseen = catalog?.unseenEvents() ?? 0;
    const documents = catalog?.documents() ?? [];
    const sources = catalog?.sources() ?? [];
    const catalogPath = catalog?.file.fsPath ?? '';
    const schema = catalog?.schemaVersion() ?? 0;
    catalog?.close();

    const settings = vscode.workspace.getConfiguration('temcoKnowledge');
    const organisation = (settings.get<string>('organisation', 'temcocontrols') || 'temcocontrols').trim();
    const manifest = this.context.extension.packageJSON as { version?: string; publisher?: string };

    const working = FEATURES.filter((feature) => feature.state === 'working');

    const cards = (list: Feature[]): string =>
      `<div class="grid">${list
        .map(
          (feature) => `
        <article class="card">
          <h3>${feature.name}<span class="mark">✓</span></h3>
          <p>${feature.detail}</p>
        </article>`
        )
        .join('')}</div>`;

    const openRows = roots.map((root) => {
      const stale = countStale(collectPages(root));
      return [
        escapeHtml(root.folder.name),
        String(root.pages),
        String(root.errors),
        String(root.warnings),
        String(root.neverReviewed),
        stale > 0 ? String(stale) : '—',
      ];
    });

    // What is being read, and what it is read *from*: with a project selected the answer is the project's
    // sources, not the window's folders — the same one world the Workspace view shows.
    const project = this.selection.project();
    const projectName = project === undefined ? undefined : documents.find((row) => slugOf(row.name) === project)?.name;
    const reading =
      projectName ?? (roots.length === 1 ? roots[0].folder.name : `${roots.length} open folders`);

    const body = `
      <header class="top">
        <div class="ident">
          <svg class="icon" viewBox="0 0 48 48" aria-hidden="true">
            <rect x="7" y="5" width="34" height="38" rx="7" fill="none" stroke="currentColor" stroke-width="3"/>
            <path d="M16 16h16M16 24h16M16 32h10" stroke="currentColor" stroke-width="3"
                  stroke-linecap="round"/>
          </svg>
          <div class="text">
            <h1>Temco Knowledge</h1>
            <p class="meta">
              v${escapeHtml(String(manifest.version ?? '—'))}
              <span class="dot">·</span> ${escapeHtml(String(manifest.publisher ?? '—'))}
              <span class="dot">·</span> ${roots.length} source${roots.length === 1 ? '' : 's'} being read
              <span class="dot">·</span> ${sums.pages} pages
            </p>
            <p class="lede">Reads every project’s documentation where it already lives, keeps what it finds in one
            local catalog, and builds the documents that ship.</p>
          </div>
        </div>
        <div class="how">
          ${STEPS.map(
            ([label, detail]) => `<div><h4>${label}${label === 'Review' ? '' : '<i>→</i>'}</h4><span>${detail}</span></div>`
          ).join('')}
        </div>
      </header>

      <main class="main">
        <section>
          <h2>What we have now</h2>
          <table class="facts">
            <tr><th>Working on</th><td>${escapeHtml(reading)}</td><th>Pages</th><td>${sums.pages}</td></tr>
            <tr><th>Projects</th><td>${documents.length}</td><th>Sources</th><td>${sources.length}</td></tr>
            <tr><th>Issues</th><td>${sums.issues}</td><th>Unseen changes</th><td>${unseen}</td></tr>
          </table>
          ${
            roots.length === 0
              ? `<p class="quiet">${escapeHtml(
                  projectName !== undefined
                    ? `${projectName} has no source that can be read yet — add one from the Library or the project's own page, then read it.`
                    : 'Nothing is being read: no project is being worked on and no open folder holds a docs/help/registry.json.'
                )}</p>`
              : table(['Source', 'Pages', 'Errors', 'Warnings', 'Never reviewed', 'Stale'], openRows)
          }
          <p class="quiet">Kept in one SQLite database on this machine — never in a repository, never
          committed, ${counts.length} tables at schema ${schema}${
            unavailable === undefined ? '' : `: ${escapeHtml(unavailable)}`
          }.${recorded === 0 ? ' Empty so far.' : ''}
          <code>${escapeHtml(catalogPath)}</code></p>
        </section>

        <section>
          <h2>How to start now <span class="count">nothing has to be built first</span></h2>
          <ol class="steps">
            <li><b>Create a project</b> —
                <a href="command:temcoKnowledge.newProject">Create a project</a>: name it, give it a version
                and an owner. This is the button marked <code>+</code> on the <b>Library</b> title bar, and it
                is in the command palette as <i>Create a Project</i>.</li>
            <li><b>Give it a source</b> —
                <a href="command:temcoKnowledge.addSource">Add a source</a>: a repository at a branch you
                choose, a folder on this machine, or an archive. The <code>+</code> beside it on the same title
                bar.</li>
            <li><b>Read it, then build it</b> — the Library shows each project's sources and the artifact it
                produced, and the two remaining steps — reading a source, and building the document — are what
                turn a project into a CHM, a PDF or a site.</li>
          </ol>
          <p class="quiet">Nothing has to exist first. A project can be created before its sources are settled:
          the application records what it found and says what is still missing. Where the documentation lives is
          <a href="https://github.com/${escapeHtml(organisation)}">github.com/${escapeHtml(organisation)}</a> —
          next to the code, in each project's own <code>docs/</code> folder.</p>
        </section>

        <section>
          <h2>What this application can do</h2>
          ${cards(working)}
        </section>
      </main>`;

    return shell(body);
  }
}

/** The window's shell: a fixed top, and one region that scrolls. */
function shell(body: string): string {
  const style = `
    :root { color-scheme: light dark; }
    html, body { height: 100%; }
    body { margin: 0; display: flex; flex-direction: column; overflow: hidden;
           font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
           font-weight: var(--vscode-font-weight); color: var(--vscode-foreground); }
    h1 { font-size: 1.5em; font-weight: 600; line-height: 1.2; margin: 0 0 .15em; }
    h2 { font-size: 1.05em; font-weight: 600; margin: 1.6em 0 .5em; }
    h3 { font-size: 1em; font-weight: 600; margin: 0 0 .35em; }
    h4 { font-size: 1em; font-weight: 600; margin: 0 0 .1em; }
    section > h2:first-child { margin-top: 0; }
    p { line-height: 1.6; margin: .45em 0; }
    ol, ul { line-height: 1.6; padding-left: 1.2em; margin: .4em 0; }
    li { margin: .3em 0; }
    a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    code { font-family: var(--vscode-editor-font-family); font-size: .95em; overflow-wrap: anywhere; }
    .quiet { color: var(--vscode-descriptionForeground); }
    .bad { color: var(--vscode-errorForeground); }
    .count { font-weight: 400; font-size: .9em; color: var(--vscode-descriptionForeground); padding-left: .5em; }

    .top { flex: 0 0 auto; padding: 1.2em 2em .9em; border-bottom: 1px solid var(--vscode-panel-border); }
    .ident { display: flex; gap: 1em; align-items: flex-start; }
    .icon { flex: 0 0 auto; width: 3.4em; height: 3.4em; color: var(--vscode-foreground); opacity: .9; }
    .text { min-width: 0; }
    .meta { margin: 0 0 .3em; color: var(--vscode-descriptionForeground); }
    .meta .dot { padding: 0 .45em; opacity: .6; }
    .lede { margin: 0; color: var(--vscode-descriptionForeground); }
    .how { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(14em, 100%), 1fr)); gap: 1em 1.6em;
           margin: 1em 0 0; padding-top: .8em; border-top: 1px solid var(--vscode-panel-border);
           width: 100%; }
    .how h4 i { font-style: normal; color: var(--vscode-descriptionForeground); padding-left: .45em; }
    .how span { display: block; margin-top: .15em; line-height: 1.5;
                color: var(--vscode-descriptionForeground); }

    /* min-width: 0 on the scrolling region, or a long path sets its minimum width and the pane scrolls
       sideways instead of wrapping. A flex item's default min-width: auto is the whole cause. */
    .main { flex: 1 1 auto; min-height: 0; min-width: 0; overflow: auto; padding: 1.6em 2em 1em; }
    /* One vertical rhythm for the whole page: every section is separated by the same margin. */
    .main section { margin: 0 0 2.2em; }
    .main section:last-child { margin-bottom: 0; }

    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(20em, 100%), 1fr)); gap: .8em; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: .7em .8em; }
    .card p { margin: .3em 0 0; color: var(--vscode-descriptionForeground); font-size: .95em; }
    .card .mark { float: right; font-weight: 400; font-size: .85em;
                  color: var(--vscode-descriptionForeground); }

    .facts { border-collapse: collapse; width: 100%; margin: .3em 0 .6em; }
    .facts th, .facts td { text-align: left; padding: .3em 1em .3em 0; font-weight: 400;
                           border-bottom: 1px solid var(--vscode-panel-border); overflow-wrap: anywhere; }
    .facts th { color: var(--vscode-descriptionForeground); white-space: nowrap; }
    table.grid2 { border-collapse: collapse; width: 100%; }
    table.grid2 th, table.grid2 td { text-align: left; padding: .3em .8em .3em 0;
                                     border-bottom: 1px solid var(--vscode-panel-border);
                                     overflow-wrap: anywhere; }
    table.grid2 th { font-weight: 600; color: var(--vscode-descriptionForeground); }
  `;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>${style}</style>
<title>Temco Knowledge</title>
</head>
<body>${body}</body>
</html>`;
}

function table(headers: string[], rows: string[][]): string {
  const head = headers.map((cell) => `<th>${cell}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table class="grid2">\n<tr>${head}</tr>\n${body}\n</table>`;
}

/** Folder names and page text come from the workspace, so everything interpolated is escaped. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
