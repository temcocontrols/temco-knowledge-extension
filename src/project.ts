// The project commands — and nothing else.
//
// The work happens on a page (`src/projectPage.ts`): the popups this replaces asked one field at a time and
// could not show a source list at all. These commands only decide **which** project the page opens for, so
// there is one form to maintain instead of a wizard and an editor that drift apart.

import * as vscode from 'vscode';
import { Catalog, CatalogUnavailable } from './catalog/store';
import { ProjectPage, slugOf } from './projectPage';
import { ProjectHub } from './projectHub';

export function registerProjectCommands(context: vscode.ExtensionContext, refresh: () => void): void {
  const page = new ProjectPage(context, refresh);
  const hub = new ProjectHub(context, refresh);

  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.newProject', () => page.openNew()),
    vscode.commands.registerCommand('temcoKnowledge.addSource', () => withDocument(context, page, true)),
    // Two doors on purpose: the hub is what a project *is*, the page is what it is *made of*. Opening the
    // editor for every look at a project would make reading its pages and editing its fields the same act.
    vscode.commands.registerCommand('temcoKnowledge.openProject', (slug?: string) =>
      withProject(context, (chosen) => hub.open(chosen), slug)
    ),
    vscode.commands.registerCommand('temcoKnowledge.editProject', (slug?: string) =>
      withProject(context, (chosen) => page.openEdit(chosen), slug)
    )
  );
}

/**
 * Picks a project, then hands its slug to whoever asked — the hub or the edit page.
 *
 * One project opens without asking; several ask. None offers to create one, because both callers were reached
 * from somewhere that wanted a project to already exist.
 */
async function withProject(
  context: vscode.ExtensionContext,
  open: (slug: string) => void,
  slug?: string
): Promise<void> {
  if (slug !== undefined && slug.length > 0) {
    open(slug);
    return;
  }

  const documents = await listDocuments(context);
  if (documents.length === 0) {
    const answer = await vscode.window.showWarningMessage(
      'Temco Knowledge: there are no projects yet.',
      'Create a project'
    );
    if (answer === 'Create a project') {
      await vscode.commands.executeCommand('temcoKnowledge.newProject');
    }
    return;
  }
  if (documents.length === 1) {
    open(documents[0].slug);
    return;
  }

  const chosen = await vscode.window.showQuickPick(
    documents.map((document) => ({ label: document.name, detail: document.description, slug: document.slug })),
    { title: 'Which project?' }
  );
  if (chosen) {
    open(chosen.slug);
  }
}

/**
 * Opens a project's page, asking which one only when it has to.
 *
 * `forSources` says the caller meant *Add a source*: with no documents there is nothing to add one to, so it
 * offers to create the project first instead of failing.
 */
async function withDocument(
  context: vscode.ExtensionContext,
  page: ProjectPage,
  forSources: boolean,
  slug?: string
): Promise<void> {
  if (slug !== undefined && slug.length > 0) {
    page.openEdit(slug);
    return;
  }

  const documents = await listDocuments(context);

  if (documents.length === 0) {
    if (forSources) {
      const answer = await vscode.window.showWarningMessage(
        'Temco Knowledge: a source belongs to a project, and there are none yet.',
        'Create a project'
      );
      if (answer === 'Create a project') {
        page.openNew();
      }
      return;
    }
    page.openNew();
    return;
  }

  if (documents.length === 1) {
    page.openEdit(documents[0].slug);
    return;
  }

  const chosen = await vscode.window.showQuickPick(
    documents.map((document) => ({ label: document.name, detail: document.description, slug: document.slug })),
    { title: forSources ? 'Add a source — which project?' : 'Which project?' }
  );
  if (chosen) {
    page.openEdit(chosen.slug);
  }
}

/** The catalog's projects, in the shape the picker wants. One {@link Catalog} per call, closed again. */
async function listDocuments(
  context: vscode.ExtensionContext
): Promise<{ name: string; slug: string; description: string }[]> {
  let catalog: Catalog | undefined;
  try {
    catalog = await Catalog.open(context);
    return catalog.documents().map((document) => ({
      name: document.name,
      slug: slugOf(document.name),
      description: [
        document.version ? `v${document.version}` : undefined,
        `${document.sources} source${document.sources === 1 ? '' : 's'}`,
        document.builtAt ? 'built' : 'never built',
      ]
        .filter((part): part is string => part !== undefined)
        .join(' · '),
    }));
  } catch (error) {
    const message = error instanceof CatalogUnavailable ? error.message : String(error);
    void vscode.window.showErrorMessage(`Temco Knowledge: ${message}`);
    return [];
  } finally {
    catalog?.close();
  }
}
