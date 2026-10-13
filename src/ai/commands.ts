// The list a person picks from: what is installed, what can be downloaded, and how to undo it.
//
// This is the whole user interface of the local AI so far. It exists before the AI does, deliberately:
// choosing a model and moving it off the disk is the part that has to be trustworthy first.

import * as vscode from 'vscode';
import { CatalogEntry, MODELS, entryById, formatBytes, runtimeFor } from './catalog';
import { InstalledArtifact, install, installedArtifacts, modelRoot, uninstall } from './install';
import { aiStatus, showAiLog, stopAiServer } from './runtime';

interface Choice extends vscode.QuickPickItem {
  entry?: CatalogEntry;
  installed?: InstalledArtifact;
  action?: 'folder' | 'remove';
}

interface Removal extends vscode.QuickPickItem {
  artifact: InstalledArtifact;
}

export function registerAiCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.models', () => chooseModel(context)),
    vscode.commands.registerCommand('temcoKnowledge.removeModel', () => removeModel(context)),
    vscode.commands.registerCommand('temcoKnowledge.openModelFolder', async () => {
      await vscode.env.openExternal(vscode.Uri.file(modelRoot(context)));
    }),
    vscode.commands.registerCommand('temcoKnowledge.aiStatus', () => showAiStatus(context))
  );
}

/** One place to see which runtime and model are in use, and whether the server is up. */
async function showAiStatus(context: vscode.ExtensionContext): Promise<void> {
  const status = aiStatus(context);
  const label = status.model ? entryById(status.model.id)?.label ?? status.model.id : undefined;
  const summary = label
    ? `${status.running ? 'running' : 'stopped'} · ${label}`
    : 'nothing installed yet — no model, so no server';

  const items = status.running
    ? ['Stop the server', 'Show the log', 'Models and Runtime']
    : ['Models and Runtime', 'Show the log'];
  const answer = await vscode.window.showInformationMessage(
    `Temco Knowledge: local AI — ${summary}`,
    ...items
  );

  if (answer === 'Stop the server') {
    stopAiServer();
  } else if (answer === 'Show the log') {
    showAiLog();
  } else if (answer === 'Models and Runtime') {
    await vscode.commands.executeCommand('temcoKnowledge.models');
  }
}

async function chooseModel(context: vscode.ExtensionContext): Promise<void> {
  const installed = installedArtifacts(context);
  const have = new Set(installed.map((artifact) => artifact.id));
  const configuration = vscode.workspace.getConfiguration('temcoKnowledge');
  const chosenModel = configuration.get<string>('ai.model', '');
  const chosenRuntime = configuration.get<string>('ai.runtime', '');

  const items: Choice[] = [];

  if (installed.length > 0) {
    items.push({ label: 'Installed', kind: vscode.QuickPickItemKind.Separator });
    for (const artifact of installed) {
      const entry = entryById(artifact.id);
      const chosen = artifact.kind === 'runtime' ? chosenRuntime === artifact.id : chosenModel === artifact.id;
      items.push({
        label: entry?.label ?? artifact.id,
        description: `${formatBytes(artifact.bytes)}${entry ? ` · ${entry.licence}` : ''}${chosen ? ' · in use' : ''}`,
        detail: artifact.path,
        installed: artifact,
      });
    }
  }

  const thisRuntime = runtimeFor(process.platform, process.arch);
  const available: CatalogEntry[] = [];
  if (thisRuntime && !have.has(thisRuntime.id)) {
    available.push(thisRuntime);
  }
  for (const model of MODELS) {
    if (!have.has(model.id)) {
      available.push(model);
    }
  }
  if (available.length > 0) {
    items.push({ label: 'Available to download', kind: vscode.QuickPickItemKind.Separator });
    for (const entry of available) {
      items.push({
        label: entry.label,
        description: `${formatBytes(entry.bytes)} · ${entry.licence}${entry.sha256 ? '' : ' · checksum not pinned'}`,
        detail: entry.needs ?? entry.notes ?? entry.url,
        entry,
      });
    }
  }

  items.push({ label: 'This folder', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(folder-opened) Open the folder', detail: modelRoot(context), action: 'folder' });
  if (installed.length > 0) {
    items.push({ label: '$(trash) Remove something that is installed…', action: 'remove' });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Temco Knowledge: the local runtime and its models',
    placeHolder: thisRuntime
      ? 'Nothing ships with the extension — a download is verified against the catalog'
      : `No runtime in the catalog is built for ${process.platform}/${process.arch}`,
  });
  if (!picked) {
    return;
  }

  if (picked.action === 'folder') {
    await vscode.env.openExternal(vscode.Uri.file(modelRoot(context)));
    return;
  }
  if (picked.action === 'remove') {
    await removeModel(context);
    return;
  }

  if (picked.installed) {
    await use(picked.installed.kind, picked.installed.id);
    vscode.window.showInformationMessage(
      `Temco Knowledge: ${picked.label} is now the one in use.`
    );
    return;
  }

  if (!picked.entry) {
    return;
  }
  try {
    const artifact = await install(context, picked.entry);
    await use(picked.entry.kind, picked.entry.id);
    void vscode.window.showInformationMessage(
      `Temco Knowledge: ${picked.entry.label} is installed — ${formatBytes(artifact.bytes)}, ` +
        `sha256 ${artifact.sha256.slice(0, 12)}…`
    );
  } catch (error) {
    void vscode.window.showWarningMessage(`Temco Knowledge: ${messageOf(error)}`);
  }
}

async function removeModel(context: vscode.ExtensionContext): Promise<void> {
  const installed = installedArtifacts(context);
  if (installed.length === 0) {
    void vscode.window.showInformationMessage('Temco Knowledge: nothing is installed yet.');
    return;
  }

  const picks: Removal[] = installed.map((artifact) => ({
    label: entryById(artifact.id)?.label ?? artifact.id,
    description: formatBytes(artifact.bytes),
    detail: artifact.path,
    artifact,
  }));

  const picked = await vscode.window.showQuickPick(picks, {
    title: 'Temco Knowledge: remove what is installed',
  });
  if (!picked) {
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    `Remove "${picked.label}"?`,
    { modal: true, detail: `This deletes:\n${picked.artifact.path}` },
    'Remove'
  );
  // A running server must not outlive the files it was started from.
  const before = aiStatus(context);
  if (answer !== 'Remove' || !uninstall(context, picked.artifact.id)) {
    return;
  }
  const wasServing =
    before.running !== undefined &&
    (before.running.modelPath === picked.artifact.path ||
      before.runtime?.path === picked.artifact.path);
  if (wasServing) {
    stopAiServer();
  }

  // What has been removed must not stay selected.
  const configuration = vscode.workspace.getConfiguration('temcoKnowledge');
  const key = picked.artifact.kind === 'runtime' ? 'ai.runtime' : 'ai.model';
  if (configuration.get<string>(key, '') === picked.artifact.id) {
    await configuration.update(key, '', vscode.ConfigurationTarget.Global);
  }
  void vscode.window.showInformationMessage(`Temco Knowledge: ${picked.label} was removed.`);
}

/** Records which artifact is the one in use. It is a user-level choice, not a repository's. */
async function use(kind: string, id: string): Promise<void> {
  const key = kind === 'runtime' ? 'ai.runtime' : 'ai.model';
  await vscode.workspace
    .getConfiguration('temcoKnowledge')
    .update(key, id, vscode.ConfigurationTarget.Global);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
