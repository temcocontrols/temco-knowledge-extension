// The dashboard — the application's own window.
//
//   TOP    identity, and how the application works, in four steps
//   MAIN   one scrolling column: what we have now, how to start now, what the application can do, and what is
//          planned
//
// A single column, because the rail proved to be a second place to look for the same facts. Nothing here is
// specific to a product: the documents and sources come from the catalog, the folders from what is open, and
// the organisation is a setting rather than a name in the code.

import * as vscode from 'vscode';
import { Catalog, CatalogUnavailable } from './catalog/store';
import { DocsRoot, collectPages, countStale, totals } from './registry';

export const HOME_VIEW_TYPE = 'temcoKnowledge.home';

interface Feature {
  name: string;
  state: 'working' | 'planned';
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
    name: 'Start a Registry',
    state: 'working',
    detail:
      'Creates the smallest valid registry in a folder you have open, on a confirmation, and leaves filling it to that project’s own generator.',
  },
  {
    name: 'Sources',
    state: 'planned',
    detail:
      'Add a repository at a branch you choose, a folder on this machine, or an archive — and one of three ways to read it, so a row says how much it can be trusted.',
  },
  {
    name: 'Documents',
    state: 'planned',
    detail:
      'Create and version a document: one help set, built into a CHM, a PDF or a site, citing whichever sources it is made of.',
  },
  {
    name: 'AI over history',
    state: 'planned',
    detail:
      'Summarise the commits since the last scan, find the pages they affect, draft the edits and list what is owed — a resumable job, and a person approves every draft.',
  },
];

const STEPS: [string, string][] = [
  ['Read', 'a source where it lives — a repository at a branch you choose, a folder, an archive'],
  ['Remember', 'what it found goes into one local catalog: what exists, what changed, what is owed'],
  ['Build', 'a document cites its sources, declares its outputs, and leaves an artifact: CHM, PDF, site'],
  ['Review', 'the model drafts, a person approves — nothing is published on its own'],
];

export class HomePanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly roots: () => readonly DocsRoot[]
  ) {}

  /** Opens the page, or brings it forward if it is already open. One instance, always. */
  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      this.render();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(HOME_VIEW_TYPE, 'Temco Knowledge', vscode.ViewColumn.One, {
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
    const planned = FEATURES.filter((feature) => feature.state === 'planned');

    const cards = (list: Feature[]): string =>
      `<div class="grid">${list
        .map(
          (feature) => `
        <article class="card${feature.state === 'planned' ? ' soon' : ''}">
          <h3>${feature.name}<span class="mark">${feature.state === 'working' ? '✓' : 'planned'}</span></h3>
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
              <span class="dot">·</span> ${roots.length} open folder${roots.length === 1 ? '' : 's'}
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
            <tr><th>Documents</th><td>${documents.length}</td><th>Sources</th><td>${sources.length}</td></tr>
            <tr><th>Folders open</th><td>${roots.length}</td><th>Pages</th><td>${sums.pages}</td></tr>
            <tr><th>Issues</th><td>${sums.issues}</td><th>Unseen changes</th><td>${unseen}</td></tr>
          </table>
          ${
            roots.length === 0
              ? `<p class="quiet">No folder with a <code>docs/help/registry.json</code> is open, so nothing is
                   being measured yet.</p>`
              : table(['Folder', 'Pages', 'Errors', 'Warnings', 'Never reviewed', 'Stale'], openRows)
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
            <li><b>See what exists</b> — <a href="https://github.com/${escapeHtml(
              organisation
            )}">github.com/${escapeHtml(organisation)}</a> lists every project. Documentation is kept next to
                the code, in each project’s own <code>docs/</code> folder.</li>
            <li><b>Open one of them here</b> — open that project as a folder in this editor. The
                <i>Content</i> view reads its registry straight away, and <i>Documentation Owed</i> says what
                needs attention.</li>
            <li><b>No registry in it?</b> Run <i>Start a Registry</i>: it creates the smallest valid one, and the
                project’s own generator fills it in.</li>
            <li><b>Then the rest follows</b> — sources, documents and the AI over the history are the next steps,
                each with its state in the lists below.</li>
          </ol>
        </section>

        <section>
          <h2>What this application can do <span class="count">${working.length} working</span></h2>
          ${cards(working)}
        </section>

        <section>
          <h2>Planned <span class="count">${planned.length} designed, not built</span></h2>
          ${cards(planned)}
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
    code { font-family: var(--vscode-editor-font-family); font-size: .95em; }
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
    .how { display: grid; grid-template-columns: repeat(auto-fit, minmax(14em, 1fr)); gap: 1em 1.6em;
           margin: 1em 0 0; padding-top: .8em; border-top: 1px solid var(--vscode-panel-border);
           width: 100%; }
    .how h4 i { font-style: normal; color: var(--vscode-descriptionForeground); padding-left: .45em; }
    .how span { display: block; margin-top: .15em; line-height: 1.5;
                color: var(--vscode-descriptionForeground); }

    .main { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 1.6em 2em 1em; }
    /* One vertical rhythm for the whole page: every section is separated by the same margin. */
    .main section { margin: 0 0 2.2em; }
    .main section:last-child { margin-bottom: 0; }

    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(20em, 1fr)); gap: .8em; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: .7em .8em; }
    .card p { margin: .3em 0 0; color: var(--vscode-descriptionForeground); font-size: .95em; }
    .card .mark { float: right; font-weight: 400; font-size: .85em;
                  color: var(--vscode-descriptionForeground); }
    .card.soon { border-style: dashed; }
    .card.soon h3 { color: var(--vscode-descriptionForeground); }

    .facts { border-collapse: collapse; width: 100%; margin: .3em 0 .6em; }
    .facts th, .facts td { text-align: left; padding: .3em 1em .3em 0; font-weight: 400;
                           border-bottom: 1px solid var(--vscode-panel-border); }
    .facts th { color: var(--vscode-descriptionForeground); white-space: nowrap; width: 9em; }
    table.grid2 { border-collapse: collapse; width: 100%; }
    table.grid2 th, table.grid2 td { text-align: left; padding: .3em .8em .3em 0;
                                     border-bottom: 1px solid var(--vscode-panel-border); }
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
