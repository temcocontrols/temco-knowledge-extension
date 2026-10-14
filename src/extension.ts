// Temco Knowledge — activation.
//
// The extension is a reader of the folder you open: it finds each workspace folder's registry, shows it in
// the Content view, and reports structural problems where they can be fixed. Nothing is written to a page
// without an explicit command, and nothing is published from here at all.

import * as vscode from 'vscode';
import { registerAiCommands } from './ai/commands';
import { AiPanel, AI_VIEW_ID } from './ai/panel';
import { disposeAi } from './ai/runtime';
import { registerBuildCommands, runOwed } from './builds';
import { Catalog } from './catalog/store';
import { registerCatalogCommands } from './catalog/commands';
import { publishDiagnostics } from './diagnostics';
import { registerFeedbackCommands } from './feedback';
import { HomePanel } from './home';
import { NeedsPage } from './needsPage';
import { registerProjectCommands } from './project';
import { registerProjectBuildCommands } from './projectBuild';
import { registerReadCommands } from './read';
import { registerReportCommands } from './report';
import { registerScaffoldCommands } from './scaffold';
import { Selection } from './selected';
import { fileColumn } from './surface';
import { DocsRoot, DeclaredPage, RegistryError, collectPages, countStale, folderForPath, loadDocsRoot, registryUriFor, rootFromDeclared, totals } from './registry';
import { KnowledgeNode, KnowledgeTreeProvider, pageFromNode } from './tree';
import { registerSectionViews } from './views';

const OUTPUT_NAME = 'Temco Knowledge';
const VIEW_ID = 'temcoKnowledge.pages';

interface BrokenRegistry {
  uri: vscode.Uri;
  message: string;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(OUTPUT_NAME);
  const diagnostics = vscode.languages.createDiagnosticCollection('temcoKnowledge');
  const provider = new KnowledgeTreeProvider();
  const selection = new Selection(context);

  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'temcoKnowledge.validate';
  context.subscriptions.push(output, diagnostics, treeView, status);

  let roots: DocsRoot[] = [];

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

    // **One world.** With a project selected, the project decides what is read: each of its sources, whether or
    // not the folder is open in this window, and what a read recorded for the ones that are not here at all.
    // With no project selected, the open folders are read, exactly as before.
    const selected = selection.project();
    const read: { folder: vscode.WorkspaceFolder; source?: ReadableSource }[] = [];
    const recorded: DocsRoot[] = [];
    let projectName: string | undefined;

    if (selected === undefined) {
      read.push(...(vscode.workspace.workspaceFolders ?? []).map((folder) => ({ folder })));
    } else {
      const project = await projectSources(context, selected);
      if (project.missing) {
        // The project was removed while it was the one being worked on. Clear the selection and let the next
        // run read the open folders, rather than showing a view about something that is not there.
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

    provider.setRoots(roots);
    // The view says which project it is showing, because with a project selected it is no longer about the
    // window's folders — and a view that silently answers a different question is worse than an empty one.
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
      const uri = rootOf(node, roots)?.registryUri;
      if (!uri) {
        void vscode.window.showInformationMessage('Temco Knowledge: no registry in this workspace.');
        return;
      }
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false, viewColumn: fileColumn() });
    }),

    vscode.commands.registerCommand('temcoKnowledge.openPage', async (node?: KnowledgeNode) => {
      const page = pageFromNode(node);
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
          await vscode.commands.executeCommand('temcoKnowledge.openRegistry', node);
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

    vscode.commands.registerCommand('temcoKnowledge.revealPage', async (node?: KnowledgeNode) => {
      const page = pageFromNode(node);
      if (page) {
        await vscode.commands.executeCommand('revealInExplorer', page.page.uri);
      }
    }),

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
  registerReportCommands(context, () => roots);
  registerScaffoldCommands(context);
  registerFeedbackCommands(context, () => roots);
  registerCatalogCommands(context, output);
  registerProjectCommands(context, selection, () => void refresh());
  registerProjectBuildCommands(context, output);
  registerReadCommands(context, selection, output, () => void refresh());

  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.openNeeds', () => needs.open()),
    vscode.commands.registerCommand('temcoKnowledge.runOwed', () => runOwed(roots, output)),
    // The one write this extension makes to a page: the empty file for a page the registry already declares.
    vscode.commands.registerCommand(
      'temcoKnowledge.createPage',
      async (target?: { path?: string; title?: string }) => {
        if (!target?.path) {
          return;
        }
        await createPage(vscode.Uri.file(target.path), target.title ?? 'Page');
        await refresh();
      }
    )
  );

  // The selected project is what everything reads, so a change to it re-reads everything.
  context.subscriptions.push(selection.onDidChange(() => void refresh()));

  // Opening the extension shows the platform's home page — it is the first thing a person should see. It can
  // be turned off, because it opens a tab, and a tab is not always wanted.
  if (vscode.workspace.getConfiguration('temcoKnowledge').get<boolean>('home.openOnStart', true)) {
    home.open();
  }

  void refresh();
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
