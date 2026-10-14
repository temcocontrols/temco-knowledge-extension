// The project commands — and nothing else.
//
// The work happens on a page (`src/projectPage.ts`): the popups this replaces asked one field at a time and
// could not show a source list at all. These commands only decide **which** project the page opens for, so
// there is one form to maintain instead of a wizard and an editor that drift apart.

import * as vscode from 'vscode';
import { Catalog, CatalogUnavailable } from './catalog/store';
import { ProjectPage, slugOf } from './projectPage';
import { ProjectHub } from './projectHub';
import { ProjectsPage } from './projectsPage';
import { Selection } from './selected';
import { rowSlug } from './views';

/** A slug, or the sidebar row that stands for a project — the two things a command argument can be. */
type ProjectArgument = string | object | undefined;

export function registerProjectCommands(
  context: vscode.ExtensionContext,
  selection: Selection,
  refresh: () => void
): void {
  const projects = new ProjectsPage(context, selection);
  // The hub is built first and told what to call afterwards, because the callback it needs is the one that tells
  // the hub about a removal — a loop, unless the reference is filled in after both exist.
  let notify: (removed?: string) => void = () => void 0;
  const hub = new ProjectHub(context, selection, (removed) => notify(removed));
  const page = new ProjectPage(context, selection, (removed) => notify(removed));

  /** Anything about a project changed: the tree, the projects page, and a project's own page all say so. */
  notify = (removed?: string): void => {
    if (removed !== undefined) {
      hub.notifyRemoved(removed);
    }
    refresh();
    projects.refresh();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.newProject', () => page.openNew()),
    // The list of every project, with what each one is made of and what can be done with it.
    vscode.commands.registerCommand('temcoKnowledge.openProjects', () => projects.open()),
    vscode.commands.registerCommand('temcoKnowledge.removeProject', (target?: ProjectArgument) =>
      removeProject(context, selection, notify, rowSlug(target))
    ),
    // Adding a source opens the project's *own* page, on the Sources tab, rather than the edit form: a source is
    // one decision, and asking for every field of the project again to make it would be the wrong act.
    vscode.commands.registerCommand('temcoKnowledge.addSource', (target?: ProjectArgument) =>
      withProject(context, (chosen) => hub.open(chosen, 'sources'), rowSlug(target))
    ),
    // Two doors on purpose: the hub is what a project *is*, the page is what it is *made of*. Opening the
    // editor for every look at a project would make reading its pages and editing its fields the same act.
    vscode.commands.registerCommand('temcoKnowledge.openProject', (target?: ProjectArgument) =>
      withProject(context, (chosen) => hub.open(chosen), rowSlug(target))
    ),
    vscode.commands.registerCommand('temcoKnowledge.editProject', (target?: ProjectArgument) =>
      withProject(context, (chosen) => page.openEdit(chosen), rowSlug(target))
    ),
    // What the whole application reads: the Workspace view, the counts, the faults and the AI's context.
    vscode.commands.registerCommand('temcoKnowledge.selectProject', (target?: ProjectArgument) =>
      selectProject(context, selection, rowSlug(target))
    ),
    vscode.commands.registerCommand('temcoKnowledge.clearProject', () => selection.select(undefined)),
    // Which project is being worked on is on the projects page too, so it has to hear about a change.
    selection.onDidChange(() => projects.refresh())
  );
}

/**
 * Removes a project.
 *
 * Sources are kept: they are recorded once and cited by any number of projects, so forgetting one because the
 * project that used it has gone would quietly take a page away from every other project that cites it.
 */
async function removeProject(
  context: vscode.ExtensionContext,
  selection: Selection,
  notify: (removed?: string) => void,
  slug?: string
): Promise<void> {
  const projects = await listDocuments(context);
  if (projects.length === 0) {
    void vscode.window.showInformationMessage('Temco Knowledge: there are no projects to remove.');
    return;
  }

  const chosen =
    slug !== undefined
      ? projects.find((project) => project.slug === slug)
      : await pickProject(projects, undefined, 'Remove which project?');
  if (!chosen) {
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    `Remove “${chosen.name}”?`,
    {
      modal: true,
      detail:
        'The project, how it is built and the artifacts recorded against it are forgotten. Its sources are ' +
        'kept, and nothing is changed or deleted at a source.',
    },
    'Remove'
  );
  if (answer !== 'Remove') {
    return;
  }

  let catalog: Catalog | undefined;
  try {
    catalog = await Catalog.open(context);
    catalog.deleteDocument(chosen.slug);
  } catch (error) {
    const message = error instanceof CatalogUnavailable ? error.message : String(error);
    void vscode.window.showErrorMessage(`Temco Knowledge: ${message}`);
    return;
  } finally {
    catalog?.close();
  }

  // A project being worked on cannot be removed and still be what everything reads.
  if (selection.project() === chosen.slug) {
    await selection.select(undefined);
  }
  notify(chosen.slug);
  void vscode.window.showInformationMessage(`Temco Knowledge: “${chosen.name}” is removed.`);
  // Land where the removal happened, in the one useful sense: the list of what is left. The page about the
  // project that has just gone is not a page — it closes itself, and this takes its place.
  await vscode.commands.executeCommand('temcoKnowledge.openProjects');
}

/**
 * Points the application at a project.
 *
 * Said out loud, once, because the Workspace view changes what it is showing: a view that silently answers a
 * different question is worse than an empty one.
 */
async function selectProject(
  context: vscode.ExtensionContext,
  selection: Selection,
  slug?: string
): Promise<void> {
  const projects = await listDocuments(context);
  if (projects.length === 0) {
    await vscode.commands.executeCommand('temcoKnowledge.newProject');
    return;
  }

  const current = selection.project();
  const chosen =
    slug !== undefined
      ? projects.find((project) => project.slug === slug)
      : await pickProject(projects, current, 'Work on which project?');
  if (!chosen) {
    return;
  }

  await selection.select(chosen.slug);
  if (current !== chosen.slug) {
    void vscode.window.showInformationMessage(
      `Temco Knowledge: the Workspace view now follows ${chosen.name}.`
    );
  }
}

async function pickProject(
  projects: { name: string; slug: string; description: string }[],
  current: string | undefined,
  title: string
): Promise<{ name: string; slug: string; description: string } | undefined> {
  return await vscode.window.showQuickPick(
    projects.map((project) => ({
      label: project.slug === current ? `$(pass-filled) ${project.name}` : project.name,
      detail: project.description,
      slug: project.slug,
      name: project.name,
      description: project.slug === current ? 'the project being worked on' : project.description,
    })),
    { title }
  );
}

/**
 * Opens a project, asking which one only when it has to.
 *
 * Reached from the Library, the palette and the dashboard, all of which want a project to already exist — so
 * with none, it offers to create one instead of failing.
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
