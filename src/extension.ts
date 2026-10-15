// Temco Knowledge — activation.
//
// The extension is a reader, of the **project being worked on**: it finds each of that project's sources, shows
// their pages in the Workspace view, and reports structural problems where they can be fixed. The project is the
// front door — the Library lists what there is, choosing one loads the Workspace, and with none chosen nothing is
// read, so the view can never answer about a folder nobody named. Nothing is written to a page without an
// explicit command, and nothing is published from here at all.

import * as vscode from 'vscode';
import { registerAiCommands } from './ai/commands';
import { AiPanel, AI_VIEW_ID } from './ai/panel';
import { disposeAi } from './ai/runtime';
import { registerBuildCommands, registerScriptCommands } from './builds';
import { Catalog } from './catalog/store';
import { registerCatalogCommands } from './catalog/commands';
import { publishDiagnostics } from './diagnostics';
import { registerFeedbackCommands } from './feedback';
import { registerFormatCommands } from './format';
import { HomePanel } from './home';
import { NeedsPage } from './needsPage';
import { NewPagePage } from './newPagePage';
import { PageDeps, PageOperations, registerPageCommands } from './pageOps';
import { registerProjectCommands } from './project';
import { registerProjectBuildCommands } from './projectBuild';
import { slugOf } from './projectPage';
import { registerReadCommands } from './read';
import { registerReportCommands } from './report';
import { RepositoriesPage } from './repositoriesPage';
import { registerRowCommands } from './rowOps';
import { registerScaffoldCommands } from './scaffold';
import { Selection } from './selected';
import { fileColumn } from './surface';
import { DocsRoot, DeclaredPage, RegistryError, collectPages, countStale, folderForPath, loadDocsRoot, registryUriFor, rootFromDeclared, totals } from './registry';
import { KnowledgeNode, KnowledgeTreeProvider, TreeNote, pageFromNode } from './tree';
import { LIBRARY_VIEW_ID, registerSectionViews } from './views';
import { registerWorkareaCommands } from './workarea';

const OUTPUT_NAME = 'Temco Knowledge';
const VIEW_ID = 'temcoKnowledge.pages';
/** The Library's own view id, so the focus commands below are spelled from one place. */
const LIBRARY_FOCUS = `${LIBRARY_VIEW_ID}.focus`;
const WORKSPACE_FOCUS = `${VIEW_ID}.focus`;

interface BrokenRegistry {
  uri: vscode.Uri;
  message: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(OUTPUT_NAME);
  const diagnostics = vscode.languages.createDiagnosticCollection('temcoKnowledge');
  const provider = new KnowledgeTreeProvider();
  const selection = new Selection(context);

  // Filled in once `refresh` exists: a page operation writes, and a write is not visible until the views have
  // been re-read. Passing a holder rather than the function keeps the tree's construction independent of it.
  let redraw = (): void => {};
  // The same holder trick, for the same reason: a page act can be started from the view's toolbar or from the
  // palette, where nothing names a row, and there the row the person has selected is the one they mean.
  let selectedRow = (): KnowledgeNode | undefined => undefined;
  // And once more for the page that creates a page: every act that makes one opens it, and the page writes
  // through the same dependencies the tree's own commands use — so there is one write, not two.
  let newPagePage: NewPagePage | undefined;
  const pageDeps: PageDeps = {
    roots: () => roots,
    output,
    redraw: () => redraw(),
    selected: () => selectedRow(),
    newPagePage: (seed) => newPagePage?.open(seed),
  };
  const pageOps = new PageOperations(pageDeps);

  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
    // A chapter is somewhere a page can be put, and the drop is a registry write — see `src/pageOps.ts`.
    dragAndDropController: pageOps,
  });
  selectedRow = () => treeView.selection[0];

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'temcoKnowledge.validate';
  context.subscriptions.push(output, diagnostics, treeView, status);

  let roots: DocsRoot[] = [];
  /**
   * Whether the single project has been allowed to select itself yet — once per window, at the first read.
   *
   * It must not be allowed again: with one project, *Stop working on it* would be impossible, because clearing
   * the selection would re-make it on the very next refresh, and the view would never go away.
   */
  let picked = false;

  // The AI panel reads the page and the registry through the same model the tree does; it decides nothing.
  const panel = new AiPanel(context, () => roots, selection);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AI_VIEW_ID, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.onDidChangeActiveTextEditor(() => panel.refresh())
  );

  // The home page: the platform's own entry point, and the one surface that is not about a folder.
  const home = new HomePanel(context, selection, () => roots);

  // The other section of the sidebar: what it reads and produces. What needs doing sits *in* it, as one row.
  const sections = registerSectionViews(context, selection, () => roots);

  // The page behind that row — the old Work view, with room to say why each thing is listed.
  const needs = new NeedsPage(context, () => roots);

  const refresh = async (): Promise<void> => {
    const broken: BrokenRegistry[] = [];
    roots = [];

    // The catalog is read before anything else, for the two facts the rest of this depends on: **which project
    // is being worked on** — with exactly one recorded there is nothing to choose between, so it chooses itself
    // — and **whether there is one at all**, which is what the Workspace view's empty state has to say.
    const projects = await chooseProject(context, selection, !picked);
    picked = true;

    // **One world.** The project being worked on decides what is read: each of its sources, whether or not the
    // folder is open in this window, and what a read recorded for the sources that are not here at all. With
    // nothing selected nothing is read — the Workspace view is about the project, and a tree built from whatever
    // happens to be open would be a second, unrelated answer to the same question.
    const selected = selection.project();
    const read: { folder: vscode.WorkspaceFolder; source?: ReadableSource }[] = [];
    const recorded: DocsRoot[] = [];
    let projectName: string | undefined;

    if (selected !== undefined) {
      const project = await projectSources(context, selected);
      if (project.missing) {
        // The project was removed while it was the one being worked on. Clear the selection and let the next
        // run read nothing, rather than showing a view about something that is not there.
        await selection.select(undefined);
        return;
      }
      projectName = project.name;
      for (const source of project.sources) {
        if (source.path !== undefined) {
          read.push({ folder: folderForPath(source.path, source.name), source });
        } else if (source.pages.length > 0) {
          recorded.push(rootFromDeclared(source.name, source.pages));
        }
      }
    }

    for (const { folder, source } of read) {
      try {
        const root = await loadDocsRoot(folder);
        if (root) {
          roots.push(root);
        } else if (source !== undefined && source.pages.length > 0) {
          // A source with no registry is not a hole: what the read recorded is what the view shows.
          recorded.push(rootFromDeclared(source.name, source.pages));
        }
      } catch (error) {
        broken.push({
          uri: registryUriFor(folder),
          message: error instanceof RegistryError ? error.message : messageOf(error),
        });
      }
    }
    roots.push(...recorded);

    // Why the list is empty, said *in* the list, so the view is never a blank pane and the row carries the one
    // act that fills it. `viewsWelcome` was tried first and dropped: its `when` clause is resolved at the view's
    // first paint, which is before the refresh has read anything, so it kept saying "nothing recorded yet" over a
    // catalog that had five projects in it.
    const notes: TreeNote[] = [];
    if (roots.length === 0) {
      notes.push(
        selected !== undefined
          ? {
              label: `${projectName ?? selected} has nothing to show`,
              detail: 'its sources have not been read, or they hold no pages',
              command: { command: 'temcoKnowledge.openProject', args: [selected] },
            }
          : (projects ?? 0) > 0
            ? {
                label: 'No project is being worked on',
                detail: 'choose one in the Library',
                command: { command: 'temcoKnowledge.openProjects' },
              }
            : {
                label: 'No project yet',
                detail: 'a project is what you manage — create one, then give it a source',
                command: { command: 'temcoKnowledge.newProject' },
              }
      );
    }
    for (const { message } of broken) {
      notes.push({ label: 'A source could not be read', detail: message });
    }

    provider.setRoots(roots, notes);
    // The view says which project it is showing: it answers about a project, never about the window, and a view
    // that silently answers a different question is worse than an empty one.
    treeView.description = projectName
      ? `${projectName} · ${totals(roots).pages} pages`
      : undefined;
    publishDiagnostics(diagnostics, roots);
    for (const { uri, message } of broken) {
      diagnostics.set(uri, [
        new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), message, vscode.DiagnosticSeverity.Error),
      ]);
    }
    updateStatus(status, roots, broken);
    panel.refresh();
    home.refresh();
    sections.refresh();
    needs.refresh();
  };

  const report = async (): Promise<void> => {
    await refresh();
    const sums = totals(roots);
    output.appendLine('');
    output.appendLine(`Temco Knowledge ${String(context.extension.packageJSON.version ?? '')}`.trim());
    output.appendLine(`Repositories with a registry: ${roots.length}`);

    for (const root of roots) {
      const stale = countStale(collectPages(root));
      output.appendLine(
        `  ${root.folder.name}: ${root.pages} pages · ${root.errors} errors · ${root.warnings} warnings · ` +
          `${root.neverReviewed} never reviewed · ${root.unshipped} not shipped${stale > 0 ? ` · ${stale} stale` : ''}`
      );
      for (const problem of root.problems) {
        output.appendLine(`    ${problem.severity}: ${problem.message}`);
      }
      for (const page of collectPages(root).filter((entry) => entry.issues.length > 0)) {
        output.appendLine(`    ${page.id}`);
        for (const issue of page.issues) {
          output.appendLine(`      ${issue.severity}: ${issue.message}`);
        }
      }
    }

    output.show(true);

    if (sums.issues === 0) {
      void vscode.window.showInformationMessage(`Temco Knowledge: ${sums.pages} pages, no structural problems.`);
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Temco Knowledge: ${sums.pages} pages, ${sums.errors} errors and ${sums.warnings} warnings.`,
      'Show Problems'
    );
    if (answer === 'Show Problems') {
      void vscode.commands.executeCommand('workbench.actions.view.problems');
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.home', () => home.open()),
    vscode.commands.registerCommand('temcoKnowledge.showStatus', report),
    vscode.commands.registerCommand('temcoKnowledge.validate', report),
    vscode.commands.registerCommand('temcoKnowledge.refresh', refresh),

    vscode.commands.registerCommand('temcoKnowledge.openRegistry', async (node?: KnowledgeNode) => {
      const uri = rootOf(node ?? selectedRow(), roots)?.registryUri;
      if (!uri) {
        void vscode.window.showInformationMessage('Temco Knowledge: no registry in this workspace.');
        return;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false, viewColumn: fileColumn() });
    }),

    vscode.commands.registerCommand('temcoKnowledge.openPage', async (node?: KnowledgeNode) => {
      const page = pageFromNode(node ?? selectedRow());
      if (!page) {
        return;
      }
      if (!page.page.exists) {
        const answer = await vscode.window.showWarningMessage(
          `No file for "${page.page.title}".`,
          'Create Page',
          'Open Registry'
        );
        if (answer === 'Create Page') {
          await createPage(page.page.uri, page.page.title);
        } else if (answer === 'Open Registry') {
          await vscode.commands.executeCommand('temcoKnowledge.openRegistry', node ?? selectedRow());
        }
        await refresh();
        return;
      }
      const document = await vscode.workspace.openTextDocument(page.page.uri);
      // Beside the dashboard rather than in its place: a page must never look as if the dashboard swallowed it.
      await vscode.window.showTextDocument(document, {
        preview: false,
        viewColumn: fileColumn(),
      });
      // The page you were on is what the AI answers about when no editor is in front.
      const project = selection.project();
      if (project !== undefined && page.page.uri.scheme === 'file') {
        await selection.rememberPage({
          project,
          id: page.page.id,
          title: page.page.title,
          path: page.page.uri.fsPath,
        });
      }
    }),

    // The home page lists the folders this editor has open, so it still has to hear about a change to them;
    // nothing the Workspace view reads depends on them any more.
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refresh())
  );

  // Three files change what the view shows: the registry — the shape of the tree — and the two generated
  // neighbours, which carry the provenance and headings the items display. Everything else, including
  // saving a page, does not refresh: the tree describes structure, not prose.
  for (const pattern of [
    '**/docs/help/registry.json',
    '**/docs/help/index.json',
    '**/docs/help/page-meta.json',
  ]) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    context.subscriptions.push(
      watcher,
      watcher.onDidChange(() => void refresh()),
      watcher.onDidCreate(() => void refresh()),
      watcher.onDidDelete(() => void refresh())
    );
  }

  registerAiCommands(context);
  registerBuildCommands(context, () => roots, output);
  // The repository's own maintenance scripts — the generator, the gates, the media audit, the owed check.
  registerScriptCommands(context, () => roots, output, () => void refresh());
  registerReportCommands(context, () => roots);
  registerScaffoldCommands(context);
  registerFeedbackCommands(context, () => roots);
  registerCatalogCommands(context, output);
  registerProjectCommands(context, selection, () => void refresh());
  registerProjectBuildCommands(context, output);
  registerReadCommands(context, selection, output, () => void refresh());
  // The working area: cloning a source so its files can be read, and pulling it when it has moved on.
  registerWorkareaCommands(context, selection, output, () => void refresh());
  // The Markdown toolbar: it edits the page in front, and reads the registry only to offer a link to a real
  // page — the one write-side surface in this extension that writes nothing.
  registerFormatCommands(context, () => roots);
  // Operating on a page: creating one, naming it, moving it, retiring it. The selected row stands in for the
  // row a command was started without — the view's toolbar and the palette are the two that do that.
  registerPageCommands(context, pageDeps);
  // and where a row is: opening it, revealing it, a terminal at its folder, its path on the clipboard.
  registerRowCommands(context, { selected: () => selectedRow() });
  // The two pages that exist because a name is asked for in a form and a list of forty repositories is not a
  // tree: the organisation's repositories, and the page that creates a page.
  const repositories = new RepositoriesPage(context, selection, () => void refresh());
  newPagePage = new NewPagePage(context, () => roots, pageDeps);
  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.repositories', () => repositories.open()),
    // *Analyse the source…* from a row: the form knows the source by the name the tree shows it under, while a
    // row carries its slug, so the catalog is asked which name that slug is.
    vscode.commands.registerCommand('temcoKnowledge.analyseSource', async (target?: unknown) => {
      const slug = typeof target === 'string' ? target : (target as { slug?: string } | undefined)?.slug;
      if (slug === undefined) {
        return;
      }
      let catalog: Catalog | undefined;
      try {
        catalog = await Catalog.open(context);
        const source = catalog.source(slug);
        if (source !== undefined) {
          newPagePage?.open({ source: source.name, analyse: true });
        }
      } catch {
        // Nothing to analyse: the page itself says when a source has no files to read.
      } finally {
        catalog?.close();
      }
    }),
    { dispose: () => { repositories.dispose(); newPagePage?.dispose(); } }
  );
  redraw = () => void refresh();

  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.openNeeds', () => needs.open()),
    // The one write this extension makes to a page: the empty file for a page the registry already declares.
    // It arrives two ways — the row in the tree that has no file behind it, and a page that names the path — and
    // both end in the same single write. Handling only the second is why the row's own *Create* did nothing.
    vscode.commands.registerCommand(
      'temcoKnowledge.createPage',
      async (target?: KnowledgeNode | { path?: string; title?: string }) => {
        // Named by a webview (a path), by a row (a node) — or by neither, and then it is the selected row.
        const named = target as { path?: string; title?: string } | undefined;
        const node =
          pageFromNode(target as KnowledgeNode | undefined) ??
          (typeof named?.path === 'string' ? undefined : pageFromNode(selectedRow()));
        const path = node?.page.uri.fsPath ?? named?.path;
        const title = node?.page.title ?? named?.title;
        if (path === undefined || path.length === 0) {
          return;
        }
        await createPage(vscode.Uri.file(path), title ?? 'Page');
        await refresh();
      }
    )
  );

  // Choosing and looking are one sequence, so the sidebar follows the choice: choosing a project brings the
  // Workspace forward, clearing one brings the Library back. `started` keeps the boot out of it — with one
  // project it selects itself on activation, and that is not the person choosing anything.
  let started = false;
  context.subscriptions.push(
    selection.onDidChange(async () => {
      // Read first, then bring a view forward: the tree it brings forward is the tree of what was just picked.
      await refresh();
      if (started) {
        await vscode.commands.executeCommand(selection.project() === undefined ? LIBRARY_FOCUS : WORKSPACE_FOCUS);
      }
    })
  );

  // Then the tab: `openStart`, the project's dashboard or the page you were last on. The sidebar itself is left
  // where the person put it — two views cannot both be "in front", and moving one under them is not a favour.
  void refresh().then(() => {
    started = true;
    return openStart(selection, home);
  });
}

export function deactivate(): void {
  // The local AI may have left a server process running; nothing else is holding anything open.
  disposeAi();
}

/** One source of a project, in the two shapes the Workspace view can read: a folder path, or recorded pages. */
interface ReadableSource {
  slug: string;
  name: string;
  path?: string;
  pages: DeclaredPage[];
}

/**
 * What the selected project is made of, as the Workspace view needs it.
 *
 * One catalog open for the whole question, then closed: the pages are read here and carried by the tree's nodes,
 * so expanding a source later never goes back to the database. A catalog that cannot be opened returns nothing
 * rather than throwing — it is reported where it is used (the Library, a read), not by an empty tree.
 */
async function projectSources(
  context: vscode.ExtensionContext,
  slug: string
): Promise<{ name: string; sources: ReadableSource[]; missing: boolean }> {
  let catalog: Catalog | undefined;
  try {
    catalog = await Catalog.open(context);
  } catch {
    return { name: slug, sources: [], missing: false };
  }

  try {
    const detail = catalog.document(slug);
    if (!detail) {
      return { name: slug, sources: [], missing: true };
    }
    const cited = new Set(detail.sources.map((source) => source.name));
    const sources: ReadableSource[] = [];

    for (const row of catalog.sources()) {
      if (!cited.has(row.name)) {
        continue;
      }
      const source = catalog.source(row.slug);
      if (!source) {
        continue;
      }
      sources.push({
        slug: row.slug,
        name: source.name,
        path: source.path,
        pages: catalog
          .pagesFor(source.id)
          .map((page) => ({ id: page.id, title: page.title, owner: page.owner })),
      });
    }
    return { name: detail.name, sources, missing: false };
  } finally {
    catalog.close();
  }
}

/**
 * The catalog's project list, read at the top of every refresh.
 *
 * It answers the two questions the rest of the refresh depends on: **whether any project exists at all**, which
 * is what the Workspace view's empty state has to say, and — allowed once, on the first read of a window —
 * **which project is being worked on**: with exactly one recorded there is nothing to choose between, so it
 * selects itself and the Workspace is ready behind the Library. With two or more nothing is guessed, because
 * guessing would show a workspace about something nobody named.
 *
 * `maySelect` is false after that first read, and it has to be: choosing on every refresh would make *Stop
 * working on it* impossible with a single project, since clearing the selection would re-make it on the next
 * read and the view would never go away. Returns how many projects there are, or `undefined` when the catalog
 * could not be opened at all — the empty state has to tell the two apart.
 */
async function chooseProject(
  context: vscode.ExtensionContext,
  selection: Selection,
  maySelect: boolean
): Promise<number | undefined> {
  let catalog: Catalog | undefined;
  try {
    catalog = await Catalog.open(context);
    const documents = catalog.documents();
    if (maySelect && selection.project() === undefined && documents.length === 1) {
      await selection.select(slugOf(documents[0].name));
    }
    return documents.length;
  } catch {
    // A catalog that cannot be opened is reported where it is used — the Library, a read — and activation must
    // not depend on it. Selecting nothing leaves the Workspace view saying there is nothing to show.
    return undefined;
  } finally {
    catalog?.close();
  }
}

/**
 * The tab the platform opens when it starts. `temcoKnowledge.start.open` decides, and nothing else.
 *
 * The order is the order a person works in: **the project you are on** — its dashboard, which says what is in
 * it and what next — then **the page you were last on**, because that is the work you left, then **the home
 * page**. A preference that cannot be honoured falls through instead of showing an empty editor, so `project`
 * with no project opens the page you left, and `page` whose file is gone opens the project's dashboard. Only
 * `none` opens no tab at all.
 */
async function openStart(selection: Selection, home: HomePanel): Promise<void> {
  const mode = vscode.workspace.getConfiguration('temcoKnowledge').get<string>('start.open', 'project');
  if (mode === 'none') {
    return;
  }

  const project = selection.project();
  if (mode === 'project' && project !== undefined) {
    await vscode.commands.executeCommand('temcoKnowledge.openProject', project);
    return;
  }
  if (mode !== 'home' && (await openRememberedPage(selection))) {
    return;
  }
  if (mode === 'page' && project !== undefined) {
    await vscode.commands.executeCommand('temcoKnowledge.openProject', project);
    return;
  }
  home.open();
}

/**
 * The page the selected project remembers, opened when the file is still there.
 *
 * The remembered path can be gone — a branch switched, a page moved — and opening it anyway would report a
 * fault before saying hello. Answers whether it opened one, so the caller can fall through to the next step.
 */
async function openRememberedPage(selection: Selection): Promise<boolean> {
  const page = selection.page();
  if (page?.path === undefined) {
    return false;
  }
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(page.path));
  } catch {
    return false;
  }
  await vscode.commands.executeCommand('temcoKnowledge.openFile', {
    path: page.path,
    id: page.id,
    title: page.title,
  });
  return true;
}

/** A new page starts as a title and nothing else — the structure lives in the registry, not in front matter. */
async function createPage(uri: vscode.Uri, title: string): Promise<void> {
  const content = Buffer.from(`# ${title}\n\n`, 'utf8');
  await vscode.workspace.fs.writeFile(uri, content);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false, viewColumn: fileColumn() });
}

function rootOf(node: KnowledgeNode | undefined, roots: readonly DocsRoot[]): DocsRoot | undefined {
  if (node && 'root' in node) {
    return node.root;
  }
  return roots[0];
}

function updateStatus(
  status: vscode.StatusBarItem,
  roots: readonly DocsRoot[],
  broken: readonly BrokenRegistry[]
): void {
  const sums = totals(roots);
  if (sums.pages === 0 && broken.length === 0) {
    status.hide();
    return;
  }
  const issuePart = sums.issues > 0 ? ` · ${sums.issues} issues` : '';
  const brokenPart = broken.length > 0 ? ` · ${broken.length} unreadable` : '';
  status.text = `$(book) ${sums.pages} pages${issuePart}${brokenPart} · ${sums.neverReviewed} never reviewed`;
  status.tooltip = 'Temco Knowledge: validate the documentation set';
  status.show();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
