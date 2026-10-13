// Starting a documentation set in a folder that has none.
//
// This is the Content view's empty state: with no registry there is nothing to show, so the view offers the one
// thing that applies. Two honest limits:
//
// - It works on a folder you have **open**. A repository you have not cloned cannot be started from here without
//   committing to it through the API on your behalf, and this extension does not commit.
// - It writes the **smallest valid registry** — structure declared, no pages. Filling it is the repository's own
//   generator's job (`npm run docs:registry`), and guessing at that seed format here would be a second
//   implementation of the pipeline.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { REGISTRY_RELATIVE_PATH } from './registry';

/** A registry with nothing in it: the shape the reader expects, and nothing invented. */
const EMPTY_REGISTRY = { version: 1, areas: {}, pages: {}, exclude: {}, waivers: {} };

export function registerScaffoldCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.startRegistry', () => start())
  );
}

async function start(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const candidates = folders.filter((folder) => !hasRegistry(folder));

  if (folders.length === 0) {
    void vscode.window.showInformationMessage('Temco Knowledge: open the folder you want to document first.');
    return;
  }
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage(
      'Temco Knowledge: every open folder already has docs/help/registry.json. A repository that is not open ' +
        'here cannot be started from this command — that would be a commit made through the API on your behalf.'
    );
    return;
  }

  const folder =
    candidates.length === 1
      ? candidates[0]
      : (
          await vscode.window.showQuickPick(
            candidates.map((candidate) => ({ label: candidate.name, candidate })),
            { title: 'Which folder should get a registry?' }
          )
        )?.candidate;
  if (!folder) {
    return;
  }

  const target = vscode.Uri.joinPath(folder.uri, ...REGISTRY_RELATIVE_PATH);
  const answer = await vscode.window.showWarningMessage(
    `Create ${vscode.workspace.asRelativePath(target)}?`,
    {
      modal: true,
      detail:
        'It is created with no pages: the structure is declared, the content is not. Fill it with the ' +
        "repository's own generator, `npm run docs:registry`, which owns that format.",
    },
    'Create'
  );
  if (answer !== 'Create') {
    return;
  }

  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, 'docs', 'help'));
  await vscode.workspace.fs.writeFile(
    target,
    Buffer.from(`${JSON.stringify(EMPTY_REGISTRY, null, 2)}\n`, 'utf8')
  );
  const document = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(document, { preview: false });
  void vscode.window.showInformationMessage(
    "Temco Knowledge: the registry is empty on purpose — run the repository's own `docs:registry` to seed it."
  );
}

function hasRegistry(folder: vscode.WorkspaceFolder): boolean {
  return fs.existsSync(path.join(folder.uri.fsPath, ...REGISTRY_RELATIVE_PATH));
}
