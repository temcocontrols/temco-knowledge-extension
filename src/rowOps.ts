// Where a row is, and how to look at it.
//
// Nothing here writes anything. Opening a page belongs to the editor, revealing belongs to the operating
// system's file manager, and the terminal and the clipboard are the two ways a person carries a page's address
// out of the tree. They live together because they are what a row's menu offers *besides* the writes in
// `src/pageOps.ts` — and because they follow the same rule about which row an act is about: the row the command
// was handed, else the row the person has selected in the Workspace view, because the view's toolbar and the
// palette can start an act without naming a row.
//
// **A row's place is derived from the platform's own path rule**, not from where a page happens to be: a page id
// *is* its path under `docs/` (`05-content-and-registry.md` rule 1), so `docs/<area>/<chapter>/` is the folder —
// except for the chapter that is the area folder itself, where the pages sit directly in `docs/<area>`. Nothing
// here reads the disk to find out, so the answer is the same whether or not the folder has been created yet.

import * as vscode from 'vscode';
import { ROOT_CHAPTER, contentUri, pageUri } from './registry';
import { KnowledgeNode } from './tree';

export interface RowDeps {
  /** The row the person has selected in the Workspace view; see `src/pageOps.ts` for the same reader. */
  selected: () => KnowledgeNode | undefined;
}

export function registerRowCommands(context: vscode.ExtensionContext, deps: RowDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.reveal', (node?: KnowledgeNode) => reveal(deps, node)),
    vscode.commands.registerCommand('temcoKnowledge.openTerminal', (node?: KnowledgeNode) =>
      openTerminal(deps, node)
    ),
    vscode.commands.registerCommand('temcoKnowledge.copyPath', (node?: KnowledgeNode) => copyPath(deps, node, false)),
    vscode.commands.registerCommand('temcoKnowledge.copyRelativePath', (node?: KnowledgeNode) =>
      copyPath(deps, node, true)
    )
  );
}

/** The row an act is about: the one it was handed, else the one the tree has selected. */
function targeted(deps: RowDeps, node?: KnowledgeNode): KnowledgeNode | undefined {
  return node ?? deps.selected();
}

/** Reveal the page itself — or, for a page with no file, where that file has to go. */
async function reveal(deps: RowDeps, node?: KnowledgeNode): Promise<void> {
  const row = targeted(deps, node);
  const uri = row ? whereOf(row) : undefined;
  if (uri === undefined) {
    return explained(row);
  }
  // The operating system's file manager, which is what the Explorer's own *Reveal in File Explorer* opens —
  // not `revealInExplorer`, which is the VS Code view of that name and knows nothing about a folder in `docs/`.
  await vscode.commands.executeCommand('revealFileInOS', uri);
}

/** A terminal at the row's own folder: what a person wants next after reading a page or a chapter. */
async function openTerminal(deps: RowDeps, node?: KnowledgeNode): Promise<void> {
  const row = targeted(deps, node);
  const folder = row ? folderOf(row) : undefined;
  if (row === undefined || folder === undefined) {
    return explained(row);
  }
  vscode.window.createTerminal({ name: `Temco Knowledge: ${rowName(row)}`, cwd: folder }).show();
}

/** The path, absolute or relative to the open folder — the two entries a file manager offers, to the letter. */
async function copyPath(deps: RowDeps, node: KnowledgeNode | undefined, relative: boolean): Promise<void> {
  const row = targeted(deps, node);
  const uri = row ? whereOf(row) : undefined;
  if (uri === undefined) {
    return explained(row);
  }
  await vscode.env.clipboard.writeText(relative ? vscode.workspace.asRelativePath(uri) : uri.fsPath);
}

/**
 * What a row points at: the page's own file, or the folder the row stands for.
 *
 * A declared page with no file has nothing to reveal or copy, so its folder is what is offered instead —
 * "where does this page have to go?" — rather than a path that is not there.
 */
function whereOf(row: KnowledgeNode): vscode.Uri | undefined {
  return row.kind === 'page' && row.page.exists ? fileOf(row) : folderOf(row);
}

/** Why nothing happened: no row was named and none is selected, or the row is not on this machine. */
function explained(row: KnowledgeNode | undefined): void {
  if (row === undefined) {
    void vscode.window.showInformationMessage(
      'Temco Knowledge: pick a page, a chapter or a source in the Workspace view first.'
    );
    return;
  }
  if (row.kind === 'gaps' || row.kind === 'note') {
    // A summary row and an empty-state row stand for nothing on disk, so there is nowhere to point at.
    void vscode.window.showInformationMessage(
      'Temco Knowledge: this row is a summary rather than a folder, so it has no place to show.'
    );
    return;
  }
  void vscode.window.showInformationMessage(
    `Temco Knowledge: ${rowName(row)} was read from a source rather than found on this machine, so there is no folder here to show.`
  );
}

/** The page's own file, as the platform's path rule makes it. */
function fileOf(row: KnowledgeNode): vscode.Uri | undefined {
  return row.kind === 'page' && row.root.origin !== 'catalog'
    ? pageUri(row.root.rootUri, row.page.id)
    : undefined;
}

/** The folder a row stands for — `docs/<area>[/<chapter>]`, and never a folder outside `docs/`. */
function folderOf(row: KnowledgeNode): vscode.Uri | undefined {
  if (row.kind === 'gaps' || row.kind === 'note' || row.root.origin === 'catalog') {
    return undefined;
  }
  const rootUri = row.root.rootUri;
  switch (row.kind) {
    case 'folder':
      return rootUri;
    case 'area':
      return contentUri(rootUri, row.area.area);
    case 'chapter':
      return row.chapter.chapter === ROOT_CHAPTER
        ? contentUri(rootUri, row.area.area)
        : contentUri(rootUri, row.area.area, row.chapter.chapter);
    case 'page':
      // A page's folder is the chapter's, whatever the page's own name is: the last id segment is the file.
      return contentUri(rootUri, ...row.page.id.split('/').slice(0, -1));
    default:
      // An issue row hangs off a page, so it has that page's folder; anything else has none to show.
      return row.kind === 'issue' ? contentUri(rootUri, ...row.page.id.split('/').slice(0, -1)) : undefined;
  }
}

/** What the terminal is called, so two of them are told apart by the row they came from. */
function rowName(row: KnowledgeNode): string {
  switch (row.kind) {
    case 'page':
    case 'issue':
      return row.page.title || row.page.id;
    case 'area':
      return row.area.title;
    case 'chapter':
      return row.chapter.chapter;
    case 'folder':
      return row.root.folder.name;
    case 'note':
      return row.note.label;
    case 'gaps':
      return 'this summary';
  }
}
