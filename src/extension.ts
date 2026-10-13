// Temco Knowledge — activation.
//
// The extension is a reader of the folder you open: it finds each workspace folder's registry, shows it in
// the Content view, and reports structural problems where they can be fixed. Nothing is written to a page
// without an explicit command, and nothing is published from here at all.

import * as vscode from 'vscode';
import { registerAiCommands } from './ai/commands';
import { disposeAi } from './ai/runtime';
import { publishDiagnostics } from './diagnostics';
import { DocsRoot, RegistryError, collectPages, countStale, loadDocsRoot, registryUriFor, totals } from './registry';
import { KnowledgeNode, KnowledgeTreeProvider, pageFromNode } from './tree';

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

  const treeView = vscode.window.createTreeView(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'temcoKnowledge.validate';
  context.subscriptions.push(output, diagnostics, treeView, status);

  let roots: DocsRoot[] = [];

  const refresh = async (): Promise<void> => {
    const broken: BrokenRegistry[] = [];
    roots = [];

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const root = await loadDocsRoot(folder);
        if (root) {
          roots.push(root);
        }
      } catch (error) {
        broken.push({
          uri: registryUriFor(folder),
          message: error instanceof RegistryError ? error.message : messageOf(error),
        });
      }
    }

    provider.setRoots(roots);
    publishDiagnostics(diagnostics, roots);
    for (const { uri, message } of broken) {
      diagnostics.set(uri, [
        new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), message, vscode.DiagnosticSeverity.Error),
      ]);
    }
    updateStatus(status, roots, broken);
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
      await vscode.window.showTextDocument(document, { preview: false });
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
      await vscode.window.showTextDocument(document, { preview: false });
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

  void refresh();
}

export function deactivate(): void {
  // The local AI may have left a server process running; nothing else is holding anything open.
  disposeAi();
}

/** A new page starts as a title and nothing else — the structure lives in the registry, not in front matter. */
async function createPage(uri: vscode.Uri, title: string): Promise<void> {
  const content = Buffer.from(`# ${title}\n\n`, 'utf8');
  await vscode.workspace.fs.writeFile(uri, content);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
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
