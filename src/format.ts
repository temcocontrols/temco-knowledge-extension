// The Markdown toolbar: the buttons the design package's editor calls for, on the editor that is already here.
//
// `15-online-editor.md` §2 lists the toolbar its editor needs — emphasis, blocks, a link to a real page, an
// outline — and says plainly that the core it chose ships none of it, so the toolbar is written by hand. On the
// website that is true. Here it is smaller: VS Code **is** Monaco plus an application shell, so the editing
// core, find and replace, folding, the breadcrumb outline and the problem markers already exist, and the
// toolbar is the only missing piece. VS Code ships no Markdown formatting commands either — there is no
// `toggleBold` to defer to — so these are ours to provide.
//
// Every action edits the document in front: the buffer a person is typing in, undoable with Ctrl+Z. Nothing
// here writes a file, opens a tab, or touches the registry. A page that is not a file on disk — one read from a
// source, a diff — is told so rather than left with a button that does nothing.
//
// Two things are deliberately absent.
//
// **No keybindings.** `Ctrl+B` hides the side bar everywhere else, and this extension has to keep working in an
// ordinary VS Code, so nothing here claims a chord. Every action is a command named `temcoKnowledge.format.*`,
// so a person who wants the chords can bind them; the quick pick and the editor menus give everyone else the
// buttons.
//
// **No image insertion yet.** An image is the one action here that would have to *write* into a source
// repository — the file has to land in the page's own `media/` before the reference to it means anything — and
// that is a rule change rather than a button. It waits for that decision instead of arriving with it.

import * as path from 'path';
import * as vscode from 'vscode';
import { DocsRoot, collectPages } from './registry';

/** The heading levels the design's toolbar offers: a page's own title is the `#`. */
const HEADINGS = [2, 3, 4];

/** Enough languages to cover the code in these pages, and no pretence of being a list of all of them. */
const LANGUAGES = [
  'text',
  'bash',
  'powershell',
  'json',
  'yaml',
  'javascript',
  'typescript',
  'csharp',
  'cpp',
  'rust',
  'python',
  'sql',
  'ini',
  'mermaid',
  'plantuml',
];

/** The five DocFX renders, with the words its own documentation uses for them. */
const CALLOUTS = [
  { label: 'Note', detail: 'information to notice even when skimming' },
  { label: 'Tip', detail: 'optional information that helps a reader succeed' },
  { label: 'Important', detail: 'essential information' },
  { label: 'Caution', detail: 'a negative consequence of an action' },
  { label: 'Warning', detail: 'a dangerous consequence of an action' },
];

const TABLE = ['|  |  |', '| --- | --- |', '|  |  |'].join('\n');
const RULE = '---';

interface Action {
  command: string;
  label: string;
  /** What the button puts in the page, shown beside the label in the picker. */
  detail: string;
  run: (editor: vscode.TextEditor) => Promise<void>;
}

export function registerFormatCommands(
  context: vscode.ExtensionContext,
  roots: () => readonly DocsRoot[]
): void {
  const actions: Action[] = [
    { command: 'temcoKnowledge.format.bold', label: 'Bold', detail: '**…**', run: (editor) => toggleWrap(editor, '**') },
    { command: 'temcoKnowledge.format.italic', label: 'Italic', detail: '*…*', run: (editor) => toggleWrap(editor, '*') },
    { command: 'temcoKnowledge.format.code', label: 'Inline code', detail: '`…`', run: (editor) => toggleWrap(editor, '`') },
    { command: 'temcoKnowledge.format.heading', label: 'Heading', detail: '## · ### · ####', run: chooseHeading },
    {
      command: 'temcoKnowledge.format.bullet',
      label: 'Bullet list',
      detail: '- item',
      run: (editor) => toggleLineMark(editor, () => '- ', /^[-*+] /),
    },
    {
      command: 'temcoKnowledge.format.numbered',
      label: 'Numbered list',
      detail: '1. 2. 3.',
      run: (editor) => toggleLineMark(editor, (index) => `${index + 1}. `, /^\d+[.)] /),
    },
    {
      command: 'temcoKnowledge.format.task',
      label: 'Task list',
      detail: '- [ ] item',
      run: (editor) => toggleLineMark(editor, () => '- [ ] ', /^[-*+] \[[ xX]\] /),
    },
    {
      command: 'temcoKnowledge.format.quote',
      label: 'Block quote',
      detail: '> text',
      run: (editor) => toggleLineMark(editor, () => '> ', /^> ?/),
    },
    { command: 'temcoKnowledge.format.codeBlock', label: 'Code block', detail: 'a fence with a language', run: insertCodeBlock },
    { command: 'temcoKnowledge.format.table', label: 'Table', detail: 'two columns', run: (editor) => insertBlock(editor, TABLE) },
    { command: 'temcoKnowledge.format.rule', label: 'Horizontal rule', detail: '---', run: (editor) => insertBlock(editor, RULE) },
    { command: 'temcoKnowledge.format.callout', label: 'Callout', detail: '> [!NOTE]', run: insertCallout },
    { command: 'temcoKnowledge.format.link', label: 'Link', detail: '[text](address)', run: insertLink },
    {
      command: 'temcoKnowledge.format.linkPage',
      label: 'Link to a page',
      detail: 'a real page, as a relative .md link',
      run: (editor) => linkToPage(editor, roots()),
    },
    { command: 'temcoKnowledge.format.outline', label: 'Go to a heading', detail: 'this page’s outline', run: goToHeading },
  ];

  context.subscriptions.push(
    ...actions.map((action) =>
      vscode.commands.registerCommand(action.command, () => withEditor(action.run))
    ),
    // The toolbar's own entry point: one button that names every action, for the keyboard and for the palette.
    vscode.commands.registerCommand('temcoKnowledge.format.pick', () => pick(actions))
  );
}

/**
 * The editor an action runs on.
 *
 * Two refusals, both in words, because both are ordinary cases rather than errors: nothing open, and a page
 * that is a read of a source rather than a file — the same distinction the Workspace view draws.
 */
async function withEditor(run: (editor: vscode.TextEditor) => Promise<void>): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    void vscode.window.showInformationMessage('Temco Knowledge: put the cursor in a page first — these buttons edit the file in front.');
    return;
  }
  if (editor.document.uri.scheme !== 'file') {
    void vscode.window.showInformationMessage('Temco Knowledge: this page is not a file on disk, so it cannot be edited here.');
    return;
  }
  await run(editor);
}

/** One button, every action: what the title bar and the palette offer. */
async function pick(actions: readonly Action[]): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    actions.map((action) => ({ label: action.label, description: action.detail, action })),
    {
      title: 'Temco Knowledge: format the page',
      placeHolder: 'Every action here is also its own command, and its own button in the editor’s menus',
    }
  );
  if (picked !== undefined) {
    await withEditor(picked.action.run);
  }
}

/**
 * The lines a command acts on: the ones the selection touches, or the one the cursor is on.
 *
 * A block command is marks at the start of lines, so one selection becomes several list items — which is what
 * selecting three lines and pressing the list button means. Dragging to the start of the next line selects that
 * line too as far as the editor is concerned, and nobody who selected three lines meant four.
 */
function linesOf(editor: vscode.TextEditor): { start: number; lines: string[] } {
  const selection = editor.selection;
  const start = selection.start.line;
  let end = selection.end.line;
  if (end > start && selection.end.character === 0) {
    end -= 1;
  }
  const lines: string[] = [];
  for (let line = start; line <= end; line += 1) {
    lines.push(editor.document.lineAt(line).text);
  }
  return { start, lines };
}

/** Wraps the selection, or unwraps it — the toggle every editor's bold button is. */
async function toggleWrap(editor: vscode.TextEditor, prefix: string, suffix = prefix): Promise<void> {
  const document = editor.document;
  const selection = editor.selection;

  if (selection.isEmpty) {
    // Nothing selected: the pair goes in and the cursor goes between the halves, so the next word typed is
    // the bold one. That is what a person pressing the button with no selection is asking for.
    const at = selection.active;
    const offset = document.offsetAt(at);
    await editor.edit((builder) => builder.insert(at, prefix + suffix));
    const inside = document.positionAt(offset + prefix.length);
    editor.selection = new vscode.Selection(inside, inside);
    return;
  }

  const selected = document.getText(selection);
  const before = textBefore(document, selection.start, prefix.length);
  const after = textAfter(document, selection.end, suffix.length);

  if (selected.length >= prefix.length + suffix.length && selected.startsWith(prefix) && selected.endsWith(suffix)) {
    await editor.edit((builder) => builder.replace(selection, selected.slice(prefix.length, selected.length - suffix.length)));
    return;
  }
  if (before === prefix && after === suffix) {
    // The cursor is inside a pair — `**bold**` with the word selected — so the marks are the thing to remove,
    // not the words.
    await editor.edit((builder) => {
      builder.delete(new vscode.Range(document.positionAt(document.offsetAt(selection.start) - prefix.length), selection.start));
      builder.delete(new vscode.Range(selection.end, document.positionAt(document.offsetAt(selection.end) + suffix.length)));
    });
    return;
  }

  await editor.edit((builder) => builder.replace(selection, prefix + selected + suffix));
  const start = selection.start.translate(0, prefix.length);
  editor.selection = new vscode.Selection(start, start.translate(0, selected.length));
}

function textBefore(document: vscode.TextDocument, position: vscode.Position, length: number): string {
  const start = document.positionAt(Math.max(0, document.offsetAt(position) - length));
  return document.getText(new vscode.Range(start, position));
}

function textAfter(document: vscode.TextDocument, position: vscode.Position, length: number): string {
  const end = document.positionAt(Math.min(document.getText().length, document.offsetAt(position) + length));
  return document.getText(new vscode.Range(position, end));
}

/** Adds or removes a mark at the start of every selected line: the list, quote and task buttons. */
async function toggleLineMark(
  editor: vscode.TextEditor,
  mark: (index: number) => string,
  pattern: RegExp
): Promise<void> {
  const { start, lines } = linesOf(editor);
  // Every line already carries it, so the button means "take it off" — press it twice and nothing has changed.
  const every = lines.every((line) => pattern.test(line));
  await editor.edit((builder) => {
    for (let index = 0; index < lines.length; index += 1) {
      const range = editor.document.lineAt(start + index).range;
      const text = editor.document.getText(range);
      builder.replace(range, every ? text.replace(pattern, '') : mark(index) + text.replace(pattern, ''));
    }
  });
}

async function chooseHeading(editor: vscode.TextEditor): Promise<void> {
  const level = await vscode.window.showQuickPick(
    HEADINGS.map((candidate) => ({
      label: `${'#'.repeat(candidate)} Heading ${String(candidate)}`,
      description: candidate === 2 ? 'the usual level under a page title' : 'a level below it',
      level: candidate,
    })),
    { title: 'Heading level', placeHolder: 'Pressing the same level again removes it' }
  );
  if (level === undefined) {
    return;
  }
  const { start, lines } = linesOf(editor);
  const mark = `${'#'.repeat(level.level)} `;
  const pattern = /^#{1,6} /;
  const every = lines.every((line) => line.startsWith(mark));
  await editor.edit((builder) => {
    for (let index = 0; index < lines.length; index += 1) {
      const range = editor.document.lineAt(start + index).range;
      const text = editor.document.getText(range);
      builder.replace(range, every ? text.replace(pattern, '') : mark + text.replace(pattern, ''));
    }
  });
}

/**
 * A block on its own line: a table, a rule.
 *
 * The blank line is not decoration. `text` followed by `---` is a level-2 heading in Markdown, and a table glued
 * to the paragraph above it is a paragraph — so the one thing a block button must get right is the gap.
 */
async function insertBlock(editor: vscode.TextEditor, block: string): Promise<void> {
  const line = editor.document.lineAt(editor.selection.start.line);
  const empty = line.text.trim() === '';
  const above = line.lineNumber > 0 ? editor.document.lineAt(line.lineNumber - 1).text : '';
  const gap = above.trim().length > 0;
  const anchor = empty ? new vscode.Position(line.lineNumber, 0) : new vscode.Position(line.lineNumber, line.text.length);
  const text = empty ? `${gap ? '\n' : ''}${block}` : `\n\n${block}`;
  await editor.edit((builder) => builder.insert(anchor, text));
}

async function insertCodeBlock(editor: vscode.TextEditor): Promise<void> {
  const language = await vscode.window.showQuickPick(LANGUAGES, {
    title: 'The code block’s language',
    placeHolder: 'text — the fence is what makes it a block; the word is what colours it',
  });
  if (language === undefined) {
    return;
  }
  const fence = '```';
  const open = language === 'text' ? fence : fence + language;
  const selected = editor.document.getText(editor.selection);

  if (selected.trim() === '') {
    // A fence owns its lines: mid-line it would glue the closing fence to the text after the cursor.
    const at = editor.selection.active;
    const lead = at.character === 0 ? '' : '\n';
    const offset = editor.document.offsetAt(at);
    const text = `${lead}${open}\n\n${fence}`;
    await editor.edit((builder) => builder.insert(at, text));
    // The cursor lands on the empty line between the fences, which is where the code goes.
    const inside = editor.document.positionAt(offset + lead.length + open.length + 1);
    editor.selection = new vscode.Selection(inside, inside);
    return;
  }

  const body = selected.endsWith('\n') ? selected : `${selected}\n`;
  const atLineStart = editor.selection.start.character === 0;
  await editor.edit((builder) =>
    builder.replace(editor.selection, `${atLineStart ? '' : '\n'}${open}\n${body}${fence}`)
  );
}

async function insertCallout(editor: vscode.TextEditor): Promise<void> {
  const kind = await vscode.window.showQuickPick(CALLOUTS, {
    title: 'The callout',
    placeHolder: 'These are the five DocFX renders as coloured blocks',
  });
  if (kind === undefined) {
    return;
  }
  const marker = `> [!${kind.label.toUpperCase()}]`;
  const selected = editor.document.getText(editor.selection);

  if (selected.trim() === '') {
    // `> [!NOTE]` is an alert only at the start of a line, so the marker gets one of its own.
    const at = editor.selection.active;
    const lead = at.character === 0 ? '' : '\n';
    const offset = editor.document.offsetAt(at);
    const text = `${lead}${marker}\n> `;
    await editor.edit((builder) => builder.insert(at, text));
    const inside = editor.document.positionAt(offset + text.length);
    editor.selection = new vscode.Selection(inside, inside);
    return;
  }

  const body = selected
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
  await editor.edit((builder) => builder.replace(editor.selection, `${marker}\n${body}`));
}

async function insertLink(editor: vscode.TextEditor): Promise<void> {
  const selected = editor.document.getText(editor.selection).trim();
  // A copied address is the common case, so it is offered rather than asked for again.
  const clipboard = (await vscode.env.clipboard.readText()).trim();
  const absolute = /^https?:\/\/\S+$/.test(clipboard);
  const address = await vscode.window.showInputBox({
    title: 'Link',
    prompt: 'An address on the web — a link to a page in this documentation uses Link to a page instead.',
    value: absolute ? clipboard : '',
    placeHolder: 'https://…',
  });
  if (address === undefined || address.trim() === '') {
    return;
  }
  const label = selected === '' ? address.trim() : selected;
  await editor.edit((builder) => builder.replace(editor.selection, `[${label}](${address.trim()})`));
}

/**
 * A link to a page that exists, which is the one link worth inserting by hand.
 *
 * `05-content-and-registry.md` fixes the form: a **relative `.md` link**, resolved and warned on by the build,
 * with `~/` for a root-relative one. So the picker offers the pages the registry declares — the same list the
 * Workspace view shows — and inserts a relative path that the gate can resolve. A page in another source is
 * refused rather than linked, because no relative path reaches it.
 */
async function linkToPage(editor: vscode.TextEditor, roots: readonly DocsRoot[]): Promise<void> {
  const from = editor.document.uri;
  const root = roots.find((candidate) => within(candidate.rootUri, from));
  if (root === undefined) {
    void vscode.window.showInformationMessage('Temco Knowledge: this file is not inside a page tree that is being read, so there is nothing to link to.');
    return;
  }

  const pages = collectPages(root).filter((page) => page.exists && page.uri.fsPath !== from.fsPath);
  if (pages.length === 0) {
    void vscode.window.showInformationMessage(`Temco Knowledge: ${root.folder.name} declares no other page with a file to link to.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    pages.map((page) => ({ label: page.title, description: page.id, page })),
    {
      title: `Link to a page in ${root.folder.name}`,
      placeHolder: 'Type part of a title, or a path',
      matchOnDescription: true,
    }
  );
  if (picked === undefined) {
    return;
  }

  const selected = editor.document.getText(editor.selection).trim();
  const link = path.relative(path.dirname(from.fsPath), picked.page.uri.fsPath).split(path.sep).join('/');
  await editor.edit((builder) =>
    builder.replace(editor.selection, `[${selected === '' ? picked.page.title : selected}](${link})`)
  );
}

function within(root: vscode.Uri, file: vscode.Uri): boolean {
  if (root.scheme !== file.scheme) {
    return false;
  }
  const relative = path.relative(root.fsPath, file.fsPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

interface Heading {
  level: number;
  text: string;
  line: number;
}

/** The page's own outline, read from its text, so it is right while a page is being written. */
function headingsOf(document: vscode.TextDocument): Heading[] {
  const headings: Heading[] = [];
  let fenced = false;
  for (let line = 0; line < document.lineCount; line += 1) {
    const text = document.lineAt(line).text;
    // A fence's contents are code: `#` in there is a comment, not a heading.
    if (/^\s*(```|~~~)/.test(text)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(text);
    if (heading !== null) {
      headings.push({ level: heading[1].length, text: heading[2].trim(), line });
    }
  }
  return headings;
}

async function goToHeading(editor: vscode.TextEditor): Promise<void> {
  const headings = headingsOf(editor.document);
  if (headings.length === 0) {
    void vscode.window.showInformationMessage('Temco Knowledge: this page declares no headings yet.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    headings.map((heading) => ({
      label: `${'  '.repeat(heading.level - 1)}${heading.text}`,
      description: `${'#'.repeat(heading.level)} · line ${String(heading.line + 1)}`,
      heading,
    })),
    { title: 'Go to a heading' }
  );
  if (picked === undefined) {
    return;
  }
  const at = new vscode.Position(picked.heading.line, 0);
  editor.selection = new vscode.Selection(at, at);
  editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.AtTop);
}
