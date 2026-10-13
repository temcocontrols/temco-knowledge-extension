// The catalog's commands.
//
// R1 exposes one: what the store is, where it is, and what it currently holds. Everything else the platform
// does with the catalog — adding sources, creating documents, building them, analysing history — is R2 onwards,
// and each of those gets its own command rather than a switch on this one.

import * as vscode from 'vscode';
import { Catalog, CatalogUnavailable, catalogFileUri } from './store';

export function registerCatalogCommands(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.catalog', () => show(context, output))
  );
}

async function show(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  let catalog: Catalog;
  try {
    catalog = await Catalog.open(context);
  } catch (error) {
    const message = error instanceof CatalogUnavailable ? error.message : String(error);
    void vscode.window.showErrorMessage(`Temco Knowledge: ${message}`);
    return;
  }

  const counts = catalog.counts();
  const empty = counts.every(([, n]) => n === 0);

  output.appendLine('');
  output.appendLine("The catalog — the platform's memory");
  output.appendLine(`  file            ${catalog.file.fsPath}`);
  output.appendLine(`  schema          ${catalog.schemaVersion()}`);
  output.appendLine('');
  for (const [table, n] of counts) {
    output.appendLine(`  ${table.padEnd(14)} ${String(n).padStart(6)}`);
  }
  if (empty) {
    output.appendLine('');
    output.appendLine('  Nothing has been recorded yet: no sources, no documents, no builds.');
  }
  output.show(true);
  catalog.close();

  const file = catalogFileUri(context);
  const answer = await vscode.window.showInformationMessage(
    `Temco Knowledge: catalog ready — ${counts.length} tables, ${empty ? 'nothing recorded yet' : 'in use'}.`,
    'Open the folder',
    'Copy the path'
  );
  if (answer === 'Open the folder') {
    await vscode.commands.executeCommand('revealFileInOS', file);
  } else if (answer === 'Copy the path') {
    await vscode.env.clipboard.writeText(file.fsPath);
  }
}
