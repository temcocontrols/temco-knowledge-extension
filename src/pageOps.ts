// Operating on a page: creating one, naming it, moving it, retiring it.
//
// The Workspace view is a *view* of the registry, so everything here is one of two kinds of act, and the
// difference matters to whoever reviews the diff:
//
//   * a **file** is written — a new page. The repository's own generator then finds it, derives its `area`,
//     `chapter` and `order` from its path and its title from its first `#`, and adds the entry. That is why
//     nothing here writes an entry for a page that did not exist: it does not have to.
//   * a **value** is changed in `docs/help/registry.json` — a title, an order, a chapter, a retirement. These
//     are the fields a person curated, the generator keeps them (`existing values win`), and each write names
//     the value it replaces in the confirmation before it happens.
//
// Three things this deliberately never does.
//
// **It never renames or moves a file.** `05-content-and-registry.md` rule 1: no page is moved or renamed,
// because the page id *is* the path and the app's routes, the MCP input and every inbound link are built on it.
// A move is therefore a named act with an `aliases` entry, never a shortcut — and it is not built here yet.
//
// **It never renumbers a chapter.** Placing a page between two others by rewriting every `order` in the chapter
// is the generator's own job (it hands out 10, 20, 30… to whatever nobody curated); a two-page swap is what a
// move means here, so the diff is two numbers.
//
// **It never deletes a page.** Retirement is a registry act — `deprecated` and the replacement — and the file
// stays where it is so the generated redirect keeps old links working (`14-governance.md` §5).

import * as vscode from 'vscode';
import { runScript } from './builds';
import { DocsRoot, PageEntry, ROOT_CHAPTER, collectPages } from './registry';
import { RegistryEdit, describeChange } from './registryEdit';
import { fileColumn } from './surface';
import { KnowledgeNode } from './tree';

/** The MIME a dragged page carries. One kind of thing can be dragged into a chapter: a page. */
const PAGE_MIME = 'application/vnd.code.tree.temcoKnowledge.page';

const EMPTY_CHAPTER_HINT = 'A chapter exists as soon as it has a page: this creates the folder and the page.';

interface Kind {
  label: string;
  detail: string;
  /** The headings a page of this kind starts with — and nothing else. An invented sentence is a sentence to delete. */
  headings: string[];
}

const KINDS: Kind[] = [
  { label: 'Article', detail: 'what it is · how it is set up · what to read next', headings: ['Overview', 'Configuration', 'Related pages'] },
  { label: 'Task', detail: 'a job a reader has to finish', headings: ['Before you start', 'Steps', 'If it does not work'] },
  { label: 'Reference', detail: 'fields, registers, commands — tables', headings: ['Fields', 'Notes'] },
  { label: 'Troubleshooting', detail: 'one symptom, one cause, one fix', headings: ['Symptom', 'Cause', 'Fix'] },
  { label: 'Release note', detail: 'what changed in a build', headings: ['What is new', 'Fixed', 'Known issues'] },
];

export interface PageDeps {
  roots: () => readonly DocsRoot[];
  output: vscode.OutputChannel;
  /** Re-read the views: every act here changes either a file the view lists or a value it shows. */
  redraw: () => void;
  /**
   * The row the person has selected in the Workspace view.
   *
   * A command can be started where nothing names a row — the view's own toolbar, or the palette — and there the
   * row they have selected is the one they mean. A reader rather than a node, so this module never holds the
   * tree view itself.
   */
  selected: () => KnowledgeNode | undefined;
}

interface Place {
  root: DocsRoot;
  area: string;
  chapter: string;
}

export class PageOperations implements vscode.TreeDragAndDropController<KnowledgeNode> {
  readonly dragMimeTypes = [PAGE_MIME];
  readonly dropMimeTypes = [PAGE_MIME];

  constructor(private readonly deps: PageDeps) {}

  handleDrag(source: readonly KnowledgeNode[], data: vscode.DataTransfer): void {
    const page = source.find((node) => node.kind === 'page');
    if (page?.kind === 'page') {
      data.set(PAGE_MIME, new vscode.DataTransferItem(page.page.id));
    }
  }

  /**
   * Dropping a page on a chapter moves it there; dropping it on a page puts it in that page's place.
   *
   * Both are registry writes, and both are confirmed first — the one place where dragging something in a tree
   * changes a file in a product repository, so it says what it will write before it writes it.
   */
  async handleDrop(target: KnowledgeNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const item = data.get(PAGE_MIME);
    if (item === undefined || target === undefined) {
      return;
    }
    const id = await item.asString();
    const found = findPage(this.deps.roots(), id);
    if (!found) {
      return;
    }
    const { root, page } = found;
    if (root.origin === 'catalog' || !page.exists) {
      void vscode.window.showInformationMessage(
        'Temco Knowledge: this page was read from a source rather than found on this machine, so it cannot be moved from here.'
      );
      return;
    }

    const edit = await RegistryEdit.open(root.registryUri);
    if (!edit || edit.entry(page.id) === undefined) {
      void vscode.window.showInformationMessage(
        `Temco Knowledge: the registry has no entry for “${page.title}” yet. Run the repository's own ` +
          'generator (Regenerate the index), and it will have one.'
      );
      return;
    }

    if (target.kind === 'page') {
      await dropOnPage(this.deps, edit, page, target.page);
      return;
    }
    const place = placeOf(target);
    if (!place) {
      void vscode.window.showInformationMessage('Temco Knowledge: drop a page on a chapter, or on another page.');
      return;
    }
    await moveToChapter(this.deps, edit, page, place.area, place.chapter);
  }
}

export function registerPageCommands(context: vscode.ExtensionContext, deps: PageDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.newPage', (node?: KnowledgeNode) => newPage(deps, node)),
    vscode.commands.registerCommand('temcoKnowledge.newChapter', (node?: KnowledgeNode) => newChapter(deps, node)),
    // The kinds, one command each. A menu entry cannot carry an argument, so the submenu in `package.json` is the
    // list of kinds and each entry names the command that already knows its own. They are written out rather than
    // built in a loop so that `scripts/check-commands.mjs` sees every id like it sees the others.
    vscode.commands.registerCommand('temcoKnowledge.newPage.article', (node?: KnowledgeNode) =>
      newPageOfKind(deps, node, 'Article')
    ),
    vscode.commands.registerCommand('temcoKnowledge.newPage.task', (node?: KnowledgeNode) =>
      newPageOfKind(deps, node, 'Task')
    ),
    vscode.commands.registerCommand('temcoKnowledge.newPage.reference', (node?: KnowledgeNode) =>
      newPageOfKind(deps, node, 'Reference')
    ),
    vscode.commands.registerCommand('temcoKnowledge.newPage.troubleshooting', (node?: KnowledgeNode) =>
      newPageOfKind(deps, node, 'Troubleshooting')
    ),
    vscode.commands.registerCommand('temcoKnowledge.newPage.releaseNote', (node?: KnowledgeNode) =>
      newPageOfKind(deps, node, 'Release note')
    ),
    vscode.commands.registerCommand('temcoKnowledge.renamePage', (node?: KnowledgeNode) => renamePage(deps, node)),
    vscode.commands.registerCommand('temcoKnowledge.movePageUp', (node?: KnowledgeNode) => movePage(deps, node, -1)),
    vscode.commands.registerCommand('temcoKnowledge.movePageDown', (node?: KnowledgeNode) => movePage(deps, node, 1)),
    vscode.commands.registerCommand('temcoKnowledge.retirePage', (node?: KnowledgeNode) => retirePage(deps, node))
  );
}

/**
 * The row a command means.
 *
 * It arrives with a row when it was started from the tree — the row's own icon, or the selection the view's
 * toolbar carries — and with nothing when it was started from the palette. There, the selected row is the one
 * they mean. Anything else is handed on unchanged, and an act that cannot tell which row it is about says so
 * rather than guessing: every write still names the file it will touch in its own confirmation.
 */
function targeted(deps: PageDeps, node?: KnowledgeNode): KnowledgeNode | undefined {
  return node ?? deps.selected();
}

// ------------------------------------------------------------------ creating

async function newPage(deps: PageDeps, node?: KnowledgeNode): Promise<void> {
  const place = await choosePlace(deps, node);
  if (place) {
    await createPage(deps, place);
  }
}

/** A new page of one kind, from the menu that lists the kinds: the kind is the entry that was clicked. */
async function newPageOfKind(deps: PageDeps, node: KnowledgeNode | undefined, label: string): Promise<void> {
  const kind = KINDS.find((candidate) => candidate.label === label);
  const place = await choosePlace(deps, node);
  if (kind !== undefined && place !== undefined) {
    await createPage(deps, place, kind);
  }
}

/**
 * A new chapter.
 *
 * There is no such thing as an empty chapter: the generator derives `chapter` from a page's *path*, so a folder
 * with nothing in it does not appear in the registry, in the tree, or in the table of contents. So this asks for
 * the name and then creates the first page in it — the folder arrives with it.
 */
async function newChapter(deps: PageDeps, node?: KnowledgeNode): Promise<void> {
  const row = targeted(deps, node);
  const from = row ? areaOf(row) : undefined;
  const root = from?.root ?? (row?.kind === 'folder' ? row.root : await chooseRoot(deps.roots()));
  if (!root || !writable(root)) {
    return;
  }
  const area = from?.area ?? (await chooseArea(root));
  if (!area) {
    return;
  }
  const name = await vscode.window.showInputBox({
    title: 'The chapter',
    prompt: EMPTY_CHAPTER_HINT,
    placeHolder: 'trend-logs',
    validateInput: (value) => (validSlug(value) ? undefined : 'Letters, digits and hyphens — it becomes a folder name.'),
  });
  if (name === undefined) {
    return;
  }
  await createPage(deps, { root, area, chapter: name });
}

/** The chapter and area a new page belongs in: the node that was right-clicked, or a question. */
async function choosePlace(deps: PageDeps, node?: KnowledgeNode): Promise<Place | undefined> {
  const row = targeted(deps, node);
  const from = row ? placeOf(row) : undefined;
  if (from) {
    return writable(from.root) ? from : undefined;
  }
  // A repository row is not in an area, so it answers the first question and the rest is still asked.
  const root = row?.kind === 'folder' ? row.root : await chooseRoot(deps.roots());
  if (!root || !writable(root)) {
    return undefined;
  }
  const area = await chooseArea(root);
  if (!area) {
    return undefined;
  }
  const group = root.areas.find((candidate) => candidate.area === area);
  const chapters = (group?.chapters ?? []).map((chapter) => chapter.chapter);
  const chapter = await vscode.window.showQuickPick(
    [
      { label: ROOT_CHAPTER, description: `directly in ${area}`, chapter: ROOT_CHAPTER },
      ...chapters.map((name) => ({ label: name, description: '', chapter: name })),
    ],
    { title: 'Which chapter?', placeHolder: ROOT_CHAPTER + ' means the file sits beside the chapter folders' }
  );
  return chapter ? { root, area, chapter: chapter.chapter } : undefined;
}

/** The kind, the title and the file name — then the one write, which the confirmation names first. */
async function createPage(deps: PageDeps, place: Place, chosen?: Kind): Promise<void> {
  const { root, area, chapter } = place;
  const kind =
    chosen ??
    (await vscode.window.showQuickPick(KINDS, {
      title: 'What kind of page is it?',
      placeHolder: 'The kind decides the headings it starts with, and nothing else',
    }));
  if (!kind) {
    return;
  }

  const title = await vscode.window.showInputBox({
    title: 'The page title',
    prompt: 'It becomes the page’s first `#` heading, and through it the title the registry records.',
    placeHolder: 'Trend Logs',
    validateInput: (value) => (value.trim().length > 0 ? undefined : 'A page needs a title.'),
  });
  if (title === undefined) {
    return;
  }

  const slug = await vscode.window.showInputBox({
    title: 'The file name',
    value: slugify(title),
    prompt: `docs/${area}/${chapter === ROOT_CHAPTER ? '' : `${chapter}/`}<name>.md — the page id is this path.`,
    validateInput: (value) => (validSlug(value) ? undefined : 'Letters, digits and hyphens only.'),
  });
  if (slug === undefined) {
    return;
  }

  const uri = pageUri(root, area, chapter, slug);
  const relative = vscode.workspace.asRelativePath(uri);
  if (await exists(uri)) {
    void vscode.window.showWarningMessage(`Temco Knowledge: there is already a file at ${relative}. Nothing was written.`);
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    `Write the new page to ${relative}?`,
    {
      modal: true,
      detail:
        `It starts as “# ${title.trim()}” and the ${kind.label.toLowerCase()} headings — no prose. ` +
        'The repository’s own generator then gives it its registry entry: its area and chapter from that path, ' +
        'its title from that heading, and a place at the end of the chapter.',
    },
    'Write the page'
  );
  if (answer !== 'Write the page') {
    return;
  }

  await ensureFolder(vscode.Uri.joinPath(uri, '..'));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(skeleton(title.trim(), kind), 'utf8'));
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false, viewColumn: fileColumn() });
  deps.redraw();

  // The entry is what makes it a page rather than a file: index.json, the table of contents, the CHM manifest
  // and the tree are all built from the registry, so the generator is the next step — offered, never assumed.
  const run = await vscode.window.showInformationMessage(
    `Temco Knowledge: ${relative} is written. It becomes a page when the registry names it.`,
    'Run the generator'
  );
  if (run === 'Run the generator') {
    await runScript(deps.roots(), deps.output, 'docs:registry');
    deps.redraw();
  }
}

/** The skeleton: the first `#` because the generator reads a new page's title from it, then the kind's headings. */
function skeleton(title: string, kind: Kind): string {
  const lines = [`# ${title}`, ''];
  for (const heading of kind.headings) {
    lines.push(`## ${heading}`, '');
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ renaming

/**
 * The title, which is a registry value — never the file.
 *
 * The page id is the path, and the app's routes, the MCP input and inbound links are built on it
 * (`05-content-and-registry.md` §2), so a page is not renamed by moving its file. What a person means by
 * "rename" is what the page is *called*, and that is one string in the registry.
 *
 * When the page's own first heading carries the same words, it is changed too — the generator takes a page's
 * default title from that heading, and leaving the two disagreeing would leave two answers to one question.
 * Both are named in the confirmation.
 */
async function renamePage(deps: PageDeps, node?: KnowledgeNode): Promise<void> {
  const found = requirePage(deps, node);
  if (!found) {
    return;
  }
  const { root, page } = found;

  const title = await vscode.window.showInputBox({
    title: 'The page title',
    value: page.title,
    prompt: 'The registry keeps this value, so the next generator run will not replace it.',
    validateInput: (value) => (value.trim().length > 0 ? undefined : 'A page needs a title.'),
  });
  if (title === undefined || title.trim() === page.title) {
    return;
  }

  const edit = await RegistryEdit.open(root.registryUri);
  if (!edit) {
    return;
  }
  if (edit.entry(page.id) === undefined) {
    void vscode.window.showInformationMessage(
      `Temco Knowledge: the registry has no entry for “${page.title}” yet. Run the repository's own generator first.`
    );
    return;
  }
  edit.set(page.id, 'title', title.trim());

  const heading = page.exists ? await firstHeading(page) : undefined;
  const withHeading = heading !== undefined && heading === page.title;
  const lines = edit.changed.map(describeChange);
  if (withHeading && page.uri.scheme === 'file') {
    lines.push(`${vscode.workspace.asRelativePath(page.uri)}  first heading  “${page.title}” → “${title.trim()}”`);
  }

  const answer = await vscode.window.showWarningMessage(
    `Rename “${page.title}” to “${title.trim()}”?`,
    { modal: true, detail: 'It writes to the registry. The file is not moved: the page id is its path, and links point at it.' },
    ...(lines.length > 0 ? ['Write'] : []),
    'Cancel'
  );
  if (answer !== 'Write') {
    return;
  }

  await edit.save();
  if (withHeading && page.uri.scheme === 'file') {
    await replaceFirstHeading(page, title.trim());
  }
  deps.redraw();
}

// ------------------------------------------------------------------ moving

async function movePage(deps: PageDeps, node: KnowledgeNode | undefined, delta: number): Promise<void> {
  const found = requirePage(deps, node);
  if (!found) {
    return;
  }
  const { root, page } = found;
  const edit = await RegistryEdit.open(root.registryUri);
  if (!edit) {
    return;
  }

  const siblings = edit.chapterPages(page.area, page.chapter);
  const at = siblings.findIndex((sibling) => sibling.id === page.id);
  if (at < 0) {
    void vscode.window.showInformationMessage(
      `Temco Knowledge: “${page.title}” is not in chapter “${page.chapter}” of the registry yet. Run the generator first.`
    );
    return;
  }
  const other = siblings[at + delta];
  if (!other) {
    void vscode.window.showInformationMessage(
      `Temco Knowledge: “${page.title}” is already ${delta < 0 ? 'first' : 'last'} in “${page.chapter}”.`
    );
    return;
  }

  edit.set(page.id, 'order', other.order);
  edit.set(other.id, 'order', siblings[at].order);
  if (edit.changed.length === 0) {
    void vscode.window.showInformationMessage(
      `Temco Knowledge: “${page.title}” and “${nameOf(root, other.id)}” share the same order value, so there is nothing to swap.`
    );
    return;
  }

  const answer = await vscode.window.showWarningMessage(
    `Move “${page.title}” ${delta < 0 ? 'above' : 'below'} “${nameOf(root, other.id)}”?`,
    {
      modal: true,
      detail: `It writes two numbers in docs/help/registry.json:\n${edit.changed.map(describeChange).join('\n')}`,
    },
    'Move',
    'Cancel'
  );
  if (answer !== 'Move') {
    return;
  }
  await edit.save();
  deps.redraw();
}

/** Dropping a page on another page: the same chapter swaps the two places, another chapter is also a move across. */
async function dropOnPage(
  deps: PageDeps,
  edit: RegistryEdit,
  page: PageEntry,
  target: PageEntry
): Promise<void> {
  if (target.id === page.id) {
    return;
  }
  if (target.area === page.area && target.chapter === page.chapter) {
    edit.set(page.id, 'order', target.order);
    edit.set(target.id, 'order', page.order);
    if (edit.changed.length === 0) {
      void vscode.window.showInformationMessage(
        `Temco Knowledge: “${page.title}” and “${target.title}” are already in that order.`
      );
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Swap “${page.title}” and “${target.title}”?`,
      { modal: true, detail: `It writes two numbers in docs/help/registry.json:\n${edit.changed.map(describeChange).join('\n')}` },
      'Swap',
      'Cancel'
    );
    if (answer !== 'Swap') {
      return;
    }
  } else {
    edit.set(page.id, 'chapter', target.chapter);
    edit.set(page.id, 'order', target.order + 1);
    const answer = await vscode.window.showWarningMessage(
      `Move “${page.title}” from “${page.chapter}” into “${target.chapter}”, after “${target.title}”?`,
      {
        modal: true,
        detail:
          '**chapter** is structure: `15-online-editor.md` §5.4 marks it as the docs owner’s to change, so this ' +
          `one deserves a line in the pull request.\nIt writes to docs/help/registry.json:\n${edit.changed.map(describeChange).join('\n')}`,
      },
      'Move',
      'Cancel'
    );
    if (answer !== 'Move') {
      return;
    }
  }
  await edit.save();
  deps.redraw();
}

async function moveToChapter(
  deps: PageDeps,
  edit: RegistryEdit,
  page: PageEntry,
  area: string,
  chapter: string
): Promise<void> {
  if (page.area === area && page.chapter === chapter) {
    void vscode.window.showInformationMessage(`Temco Knowledge: “${page.title}” is already in “${chapter}”.`);
    return;
  }
  const siblings = edit.chapterPages(area, chapter);
  const last = siblings.length > 0 ? siblings[siblings.length - 1].order : 0;
  edit.set(page.id, 'chapter', chapter);
  edit.set(page.id, 'order', last + 10);

  const answer = await vscode.window.showWarningMessage(
    `Move “${page.title}” from “${page.chapter}” into “${chapter}”?`,
    {
      modal: true,
      detail:
        '**chapter** is structure: `15-online-editor.md` §5.4 marks it as the docs owner’s to change, so this one ' +
        `deserves a line in the pull request.\nIt writes to docs/help/registry.json:\n${edit.changed
          .map(describeChange)
          .join('\n')}`,
    },
    'Move',
    'Cancel'
  );
  if (answer !== 'Move') {
    return;
  }
  await edit.save();
  deps.redraw();
}

// ------------------------------------------------------------------ retiring

/**
 * Retirement, which is not deletion.
 *
 * `14-governance.md` §5: a page that is no longer supported is *retired* — the registry says so and names what
 * replaces it — and its address keeps resolving through a redirect stub the repository's own pipeline
 * generates. So nothing here removes a file, and nothing here decides that a page is finished with: it records
 * the decision a person just made, and says what it wrote.
 */
async function retirePage(deps: PageDeps, node?: KnowledgeNode): Promise<void> {
  const found = requirePage(deps, node);
  if (!found) {
    return;
  }
  const { root, page } = found;
  const edit = await RegistryEdit.open(root.registryUri);
  if (!edit || edit.entry(page.id) === undefined) {
    void vscode.window.showInformationMessage(
      `Temco Knowledge: the registry has no entry for “${page.title}” yet. Run the repository's own generator first.`
    );
    return;
  }

  const replacement = await vscode.window.showQuickPick(
    [
      { label: 'Nothing replaces it yet', description: 'the registry records that too', id: null },
      ...collectPages(root)
        .filter((candidate) => candidate.id !== page.id && candidate.exists)
        .map((candidate) => ({ label: candidate.title, description: candidate.id, id: candidate.id })),
    ],
    { title: `What replaces “${page.title}”?`, placeHolder: 'A retired page has to name a replacement, or say there is none' }
  );
  if (!replacement) {
    return;
  }

  edit.set(page.id, 'deprecated', true);
  edit.set(page.id, 'superseded_by', replacement.id);
  const answer = await vscode.window.showWarningMessage(
    `Retire “${page.title}”?`,
    {
      modal: true,
      detail:
        'The file stays where it is and its address keeps working: the redirect for a retired page is generated ' +
        'by the repository’s own pipeline. What is written:\n' +
        edit.changed.map(describeChange).join('\n'),
    },
    'Retire',
    'Cancel'
  );
  if (answer !== 'Retire') {
    return;
  }
  await edit.save();
  deps.redraw();
}

// ------------------------------------------------------------------ helpers

function placeOf(node: KnowledgeNode): Place | undefined {
  if (node.kind === 'chapter') {
    return { root: node.root, area: node.area.area, chapter: node.chapter.chapter };
  }
  if (node.kind === 'area') {
    return { root: node.root, area: node.area.area, chapter: ROOT_CHAPTER };
  }
  if (node.kind === 'page') {
    return { root: node.root, area: node.page.area, chapter: node.page.chapter };
  }
  return undefined;
}

function areaOf(node: KnowledgeNode): { root: DocsRoot; area: string } | undefined {
  const place = placeOf(node);
  return place ? { root: place.root, area: place.area } : undefined;
}

/** A page that can be operated on: one in the tree, with a working tree behind it. */
function requirePage(
  deps: PageDeps,
  node: KnowledgeNode | undefined
): { root: DocsRoot; page: PageEntry } | undefined {
  const row = targeted(deps, node);
  if (row?.kind !== 'page') {
    void vscode.window.showInformationMessage(
      'Temco Knowledge: this acts on one page — pick one in the Workspace view first.'
    );
    return undefined;
  }
  const found = findPage(deps.roots(), row.page.id);
  if (!found) {
    return undefined;
  }
  if (found.root.origin === 'catalog') {
    void vscode.window.showInformationMessage(
      `Temco Knowledge: “${found.page.title}” was read from a source rather than found on this machine, so there is nothing here to change.`
    );
    return undefined;
  }
  return found;
}

/**
 * Whether a source can be written into at all.
 *
 * A source read over the API is a record of what was read, not a folder: its uri has no file system behind it,
 * so a page there has to be created in the repository itself rather than appear to succeed and then fail.
 */
function writable(root: DocsRoot): boolean {
  if (root.origin !== 'catalog') {
    return true;
  }
  void vscode.window.showInformationMessage(
    `Temco Knowledge: ${root.folder.name} was read from a source rather than found on this machine, so there is no folder here to write a page into.`
  );
  return false;
}

function findPage(roots: readonly DocsRoot[], id: string): { root: DocsRoot; page: PageEntry } | undefined {
  for (const root of roots) {
    const page = collectPages(root).find((candidate) => candidate.id === id);
    if (page) {
      return { root, page };
    }
  }
  return undefined;
}

async function chooseRoot(roots: readonly DocsRoot[]): Promise<DocsRoot | undefined> {
  const local = roots.filter((root) => root.origin !== 'catalog');
  if (local.length === 0) {
    void vscode.window.showInformationMessage(
      'Temco Knowledge: no folder on this machine is being read, so there is nothing to create a page in. ' +
        'A source read over the API has no working tree.'
    );
    return undefined;
  }
  if (local.length === 1) {
    return local[0];
  }
  const picked = await vscode.window.showQuickPick(
    local.map((root) => ({ label: root.folder.name, description: root.rootUri.fsPath, root })),
    { title: 'Which source?' }
  );
  return picked?.root;
}

async function chooseArea(root: DocsRoot): Promise<string | undefined> {
  if (root.areas.length === 1) {
    return root.areas[0].area;
  }
  const picked = await vscode.window.showQuickPick(
    root.areas.map((area) => ({ label: area.area, description: `${String(area.pages)} pages`, area: area.area })),
    { title: 'Which area?' }
  );
  return picked?.area;
}

function pageUri(root: DocsRoot, area: string, chapter: string, slug: string): vscode.Uri {
  // The file name carries its extension: joined as separate segments it would become `trend-logs/.md`, which is
  // a folder with a file named `.md` in it — a mistake worth one comment, since it reads as harmless.
  const parts = chapter === ROOT_CHAPTER ? [`${slug}.md`] : [chapter, `${slug}.md`];
  return vscode.Uri.joinPath(root.rootUri, 'docs', area, ...parts);
}

function nameOf(root: DocsRoot, id: string): string {
  return collectPages(root).find((page) => page.id === id)?.title ?? id;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function ensureFolder(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.createDirectory(uri);
  } catch {
    // Already there is the ordinary case; a folder that cannot be made fails loudly on the write instead.
  }
}

/** A filename from a title: lower case, hyphens, nothing that needs escaping in a URL. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length > 0 ? slug : 'page';
}

function validSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(value);
}

/** The page's own `#` heading, which is where the generator takes a new page's title from. */
async function firstHeading(page: PageEntry): Promise<string | undefined> {
  try {
    const text = Buffer.from(await vscode.workspace.fs.readFile(page.uri)).toString('utf8');
    return /^#\s+(.+?)\s*$/m.exec(text)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

/** Replaces the page's first `#` heading, keeping the rest of the file as it is. */
async function replaceFirstHeading(page: PageEntry, title: string): Promise<void> {
  try {
    const text = Buffer.from(await vscode.workspace.fs.readFile(page.uri)).toString('utf8');
    const next = text.replace(/^#\s+(.+?)\s*$/m, `# ${title}`);
    if (next !== text) {
      await vscode.workspace.fs.writeFile(page.uri, Buffer.from(next, 'utf8'));
    }
  } catch (error) {
    void vscode.window.showWarningMessage(
      `Temco Knowledge: the registry was updated, but the page's own heading was not. (${String(error)})`
    );
  }
}
