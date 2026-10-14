// Creating a project, and giving it sources.
//
// The order matters and is deliberate: **the project first, then what it is made of.** A document is the thing a
// person creates, versions and builds; a source is only something it cites. So *Create a Document* asks for the
// few facts a document needs and nothing else, and *Add a Source* then asks which document it belongs to.
//
// Nothing here reaches the network. A source is only *recorded* — reading it is the next step, and the row says
// which of the three ways it will be read.

import * as vscode from 'vscode';
import { Catalog, CatalogUnavailable } from './catalog/store';

export function registerProjectCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.newDocument', () => newDocument(context, output)),
    vscode.commands.registerCommand('temcoKnowledge.addSource', () => addSource(context, output))
  );
}

/** Name, version, owner — then the document exists and can be given sources. */
async function newDocument(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Create a document — 1 of 3',
    prompt: 'What is it called? This is what you will see in the Library.',
    placeHolder: 'Product Help',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? 'A document needs a name.' : undefined),
  });
  if (name === undefined) {
    return;
  }

  const version = await vscode.window.showInputBox({
    title: 'Create a document — 2 of 3',
    prompt: 'Which version? Documentation is versioned with the product it describes.',
    value: '1.0',
    ignoreFocusOut: true,
  });
  if (version === undefined) {
    return;
  }

  const owner = await vscode.window.showInputBox({
    title: 'Create a document — 3 of 3',
    prompt: 'Who owns it? One name or team — this is what the owed report groups by.',
    value: 'docs',
    ignoreFocusOut: true,
  });
  if (owner === undefined) {
    return;
  }

  const slug = slugOf(name);
  await withCatalog(context, output, (catalog) => {
    catalog.createDocument({
      name: name.trim(),
      slug,
      version: version.trim() || undefined,
      owner: owner.trim() || undefined,
    });
    output.appendLine(`document created: ${name.trim()} (${slug})`);
  });

  const answer = await vscode.window.showInformationMessage(
    `Temco Knowledge: “${name.trim()}” is in the Library. It has no sources yet.`,
    'Add a source',
    'Show the Library'
  );
  if (answer === 'Add a source') {
    await vscode.commands.executeCommand('temcoKnowledge.addSource');
  }
}

/** A repository at a branch you choose, a folder on this machine, or an archive to keep for reference. */
async function addSource(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  const documents = await listDocuments(context);
  if (documents.length === 0) {
    const answer = await vscode.window.showWarningMessage(
      'Temco Knowledge: a source belongs to a document. Create the document first.',
      'Create a document'
    );
    if (answer === 'Create a document') {
      await vscode.commands.executeCommand('temcoKnowledge.newDocument');
    }
    return;
  }

  const chosen =
    documents.length === 1
      ? documents[0]
      : (
          await vscode.window.showQuickPick(
            documents.map((document) => ({ label: document.name, detail: document.slug, document })),
            { title: 'Add a source — which document is it for?' }
          )
        )?.document;
  if (!chosen) {
    return;
  }

  const kind = await vscode.window.showQuickPick<
    { label: string; detail: string; sourceKind: 'git' | 'folder' | 'archive' }
  >(
    [
      {
        label: 'Repository',
        detail: 'a git repository — owner/name and a branch you choose',
        sourceKind: 'git' as const,
      },
      {
        label: 'Folder',
        detail: 'a folder on this machine, read where it lies',
        sourceKind: 'folder' as const,
      },
      {
        label: 'Archive',
        detail: 'a file to keep for reference, read-only',
        sourceKind: 'archive' as const,
      },
    ],
    { title: 'Add a source — what kind?' }
  );
  if (!kind) {
    return;
  }

  if (kind.sourceKind === 'folder' || kind.sourceKind === 'archive') {
    const picked = await vscode.window.showOpenDialog({
      title: kind.sourceKind === 'folder' ? 'Which folder?' : 'Which file?',
      canSelectFolders: kind.sourceKind === 'folder',
      canSelectFiles: kind.sourceKind === 'archive',
      canSelectMany: false,
      openLabel: 'Use this',
    });
    if (!picked || picked.length === 0) {
      return;
    }
    const uri = picked[0];
    const name = uri.path.split('/').filter(Boolean).pop() ?? uri.fsPath;
    await withCatalog(context, output, (catalog) => {
      catalog.addSource({
        kind: kind.sourceKind,
        name,
        slug: slugOf(name),
        path: uri.fsPath,
      });
      catalog.attachSource(chosen.slug, slugOf(name));
      output.appendLine(`source added: ${name} (${kind.sourceKind}) → ${chosen.name}`);
    });
    void vscode.window.showInformationMessage(`Temco Knowledge: “${name}” added to “${chosen.name}”.`);
    return;
  }

  const remote = await vscode.window.showInputBox({
    title: 'Add a source — which repository?',
    prompt: 'owner/name. A full URL works too.',
    placeHolder: 'owner/name',
    ignoreFocusOut: true,
    value: 'https://github.com/',
    validateInput: (value) => (value.trim().length < 3 ? 'Give a repository.' : undefined),
  });
  if (remote === undefined) {
    return;
  }

  const branch = await vscode.window.showInputBox({
    title: 'Add a source — which branch?',
    prompt: 'The branch its documentation lives on. Empty means the repository’s default branch.',
    placeHolder: 'main',
    ignoreFocusOut: true,
  });
  if (branch === undefined) {
    return;
  }

  const url = remote.trim().startsWith('http')
    ? remote.trim()
    : `https://github.com/${remote.trim()}`;
  const name = url.replace(/\.git$/, '').split('/').slice(-1)[0] || 'repository';
  const slug = slugOf(name);

  await withCatalog(context, output, (catalog) => {
    catalog.addSource({
      kind: 'git',
      name,
      slug,
      remoteUrl: url,
      branch: branch.trim() || undefined,
    });
    catalog.attachSource(chosen.slug, slug);
    output.appendLine(`source added: ${name} (git${branch.trim() ? ` @ ${branch.trim()}` : ''}) → ${chosen.name}`);
  });
  void vscode.window.showInformationMessage(
    `Temco Knowledge: “${name}” added to “${chosen.name}”. Reading it comes next.`
  );
}

function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function listDocuments(
  context: vscode.ExtensionContext
): Promise<{ name: string; slug: string }[]> {
  let rows: { name: string; slug: string }[] = [];
  await withCatalog(context, undefined, (catalog) => {
    rows = catalog
      .documents()
      .map((document) => ({ name: document.name, slug: slugOf(document.name) }));
  });
  return rows;
}

/** Opens the catalog, runs the work, closes it, and reports a refusal in words rather than a stack trace. */
async function withCatalog(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel | undefined,
  work: (catalog: Catalog) => void
): Promise<void> {
  let catalog: Catalog | undefined;
  try {
    catalog = await Catalog.open(context);
    work(catalog);
  } catch (error) {
    const message = error instanceof CatalogUnavailable ? error.message : String(error);
    void vscode.window.showErrorMessage(`Temco Knowledge: ${message}`);
  } finally {
    catalog?.close();
    if (output) {
      output.show(true);
    }
  }
}
