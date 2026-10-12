// Temco Knowledge Studio — extension entry point.
//
// This extension is the whole platform: registry, checks, AI, publishing.
// It holds no content of its own — it operates on whatever folder is open.

import * as vscode from 'vscode';

const OUTPUT_NAME = 'Temco Knowledge';

/** Registry file every product repository keeps, relative to its docs folder. */
const REGISTRY_RELATIVE_PATH = ['docs', 'help', 'registry.json'];

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(OUTPUT_NAME);
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.showStatus', async () => {
      const version: string = context.extension.packageJSON.version ?? 'unknown';
      const folders = vscode.workspace.workspaceFolders ?? [];

      output.appendLine(`Temco Knowledge Studio ${version}`);
      output.appendLine(`Open folders: ${folders.length}`);

      for (const folder of folders) {
        const registry = vscode.Uri.joinPath(folder.uri, ...REGISTRY_RELATIVE_PATH);
        const found = await exists(registry);
        output.appendLine(`  ${folder.name}: registry ${found ? 'found' : 'not found'}`);
      }

      output.show(true);
    })
  );
}

export function deactivate(): void {
  // Nothing to release yet: no server, no background work starts on activate.
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
