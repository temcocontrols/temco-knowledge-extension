// New page — the form that creates a page, and the drafts that make writing one smaller.
//
// Why a page and not three questions: VS Code's input box lives at the top of the window, one question at a
// time, and cannot show what the answer will produce. A page can show every field at once, the exact file the
// answers will make, the kind's headings beside each other, and a draft of the body — so a person decides once
// instead of four times. Both *New page…* and *New chapter…* and the kind entries open this, and it writes
// through `writePage` in `src/pageOps.ts`, which is the only thing here that touches the disk.
//
// **Nothing is written until *Write the page* is pressed**, and the confirmation names the file. That is the
// rule the whole extension is built on, and it is what keeps a model-written draft inside
// `12-ai-features.md`'s bargain: the model makes the human's edit small, a person approves, nothing publishes
// itself.
//
// Two kinds of material can be drafted from, and they are different on purpose:
//   * **the pages already in this area** — the same material the AI panel already works from;
//   * **one file of the source** — a class, a header, a script. This is the one prompt that may see code
//     (`prompts/newpage.md`), because the page being written is *about* that file, and a person chose it.

import * as fs from 'fs';
import * as vscode from 'vscode';
import { newPagePrompt, systemPrompt } from './ai/prompts';
import { complete, aiStatus } from './ai/runtime';
import { DocsRoot, PageEntry, collectPages } from './registry';
import {
  AREA_CHAPTER,
  KINDS,
  NewPageSeed,
  NewPageSpec,
  PageDeps,
  writePage,
} from './pageOps';
import { codeFiles, readCodeFile, RepositorySource } from './repository';
import { NEW_PAGE_VIEW_TYPE, pageColumn } from './surface';

/** How much of another page may be given to the model, so one huge page cannot fill the window. */
const MATERIAL_CHARS = 12_000;

interface FormMessage {
  type?: string;
  source?: string;
  file?: string;
  from?: string;
  spec?: NewPageSpec;
  pageId?: string;
}

/** What the form is told about one writable source. */
interface SourceForm {
  name: string;
  /** The folder, for the line under the name. */
  where: string;
  areas: {
    area: string;
    title: string;
    chapters: string[];
    pages: { id: string; title: string; headings: string[] }[];
  }[];
}

export class NewPagePage {
  private panel: vscode.WebviewPanel | undefined;
  private seed: NewPageSeed = {};

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly roots: () => readonly DocsRoot[],
    private readonly deps: PageDeps
  ) {}

  /** Opens the page for one act: a new page, a new chapter, or a kind already chosen. */
  open(seed: NewPageSeed = {}): void {
    this.seed = seed;
    if (this.panel) {
      this.panel.reveal(pageColumn());
      void this.render();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(NEW_PAGE_VIEW_TYPE, 'New page', pageColumn(), {
      enableScripts: true,
      localResourceRoots: [],
    });
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'knowledge.svg');
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    this.panel.webview.onDidReceiveMessage((message: FormMessage) => void this.receive(message));
    void this.render();
  }

  private async render(): Promise<void> {
    const panel = this.panel;
    if (!panel) {
      return;
    }    panel.webview.html = html(nonce());
    await panel.webview.postMessage({
      type: 'form',
      seed: this.seed,
      sources: this.sources(),
      kinds: KINDS.map((kind) => ({ label: kind.label, detail: kind.detail, headings: kind.headings })),
      areaChapter: AREA_CHAPTER,
      model: modelLabel(this.context),
    });
  }

  /** Closes the page: cancel, or the extension going away. */
  dispose(): void {
    this.panel?.dispose();
  }

  /** The sources a page can be written into: a folder on this machine, never one read over the API. */
  private sources(): SourceForm[] {
    return this.roots()
      .filter((root) => root.origin !== 'catalog')
      .map((root) => ({
        name: root.folder.name,
        where: root.rootUri.fsPath,
        areas: root.areas.map((area) => ({
          area: area.area,
          title: area.title,
          chapters: area.chapters.map((chapter) => chapter.chapter),
          // The pages as the material line shows them: what the model may read about this area, and what
          // *another page* can be picked from. Sent once with the form rather than asked for again.
          pages: area.chapters.flatMap((chapter) =>
            chapter.pages.map((page) => ({
              id: page.id,
              title: page.title,
              headings: page.provenance?.headings ?? [],
            }))
          ),
        })),
      }));
  }

  private async receive(message: FormMessage): Promise<void> {
    switch (message.type) {
      case 'files':
        await this.files(message.source ?? '');
        return;
      case 'draft':
        await this.draft(message);
        return;
      case 'write':
        if (message.spec !== undefined) {
          await this.write(message.spec);
        }
        return;
      case 'cancel':
        this.panel?.dispose();
        return;
      default:
        return;
    }
  }

  /**
   * The source's code files, for the *from a file* material.
   *
   * One call for a folder (the disk) and one for a repository (`git/trees`, no clone), and the answer says which
   * folders were left out: generated, vendored and build output are never offered as the material for a page.
   */
  private async files(source: string): Promise<void> {
    const root = this.roots().find((candidate) => candidate.folder.name === source);
    const panel = this.panel;
    if (!panel || root === undefined) {
      return;
    }
    const result = await codeFiles(this.context, repositorySource(root));
    await panel.webview.postMessage({ type: 'files', source, ...result });
  }

  /**
   * A draft of the body.
   *
   * The material is whatever the person picked, and only that: the pages of this area (ids, titles and headings —
   * what the AI panel is already allowed to see), one file of the source, or another page of the area, whole.
   * The answer streams into the page as it is written, and nothing is kept: a draft that is not accepted is gone
   * with the page.
   */
  private async draft(message: FormMessage): Promise<void> {
    const panel = this.panel;
    const spec = message.spec;
    if (!panel || spec === undefined) {
      return;
    }
    if (modelLabel(this.context) === undefined) {
      await panel.webview.postMessage({
        type: 'draftError',
        message: 'No local model is chosen. Download one on the AI page, then draft again.',
      });
      return;
    }

    const root = this.roots().find((candidate) => candidate.folder.name === spec.source);
    const kind = KINDS.find((candidate) => candidate.label === spec.kind) ?? KINDS[0];
    if (root === undefined) {
      await panel.webview.postMessage({ type: 'draftError', message: 'That source is not being read.' });
      return;
    }

    const material = await this.material(message, root, spec);
    if ('error' in material) {
      await panel.webview.postMessage({ type: 'draftError', message: material.error });
      return;
    }

    await panel.webview.postMessage({ type: 'draftStart' });
    const prompt = newPagePrompt(this.context, {
      title: spec.title,
      kind: kind.label,
      headings: kind.headings,
      path: fileOf(this.deps.roots(), spec),
      area: material.area,
      material: material.text,
    });

    try {
      await complete(
        this.context,
        [
          { role: 'system', content: systemPrompt(this.context, undefined) },
          { role: 'user', content: prompt },
        ],
        {
          maxTokens: 1200,
          onToken: (text) => void panel.webview.postMessage({ type: 'draftToken', text }),
        }
      );
      await panel.webview.postMessage({ type: 'draftDone' });
    } catch (error) {
      await panel.webview.postMessage({
        type: 'draftError',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The material for one draft, and the line saying what is already in the area. */
  private async material(
    message: FormMessage,
    root: DocsRoot,
    spec: NewPageSpec
  ): Promise<{ text: string; area: string } | { error: string }> {
    const area = spec.area ?? '';
    const group = root.areas.find((candidate) => candidate.area === area);
    const listed = (group?.chapters ?? [])
      .map((chapter) =>
        [`## ${chapter.chapter === AREA_CHAPTER ? 'directly in the area' : chapter.chapter}`, ...chapter.pages.map(summarise)].join(
          '\n'
        )
      )
      .join('\n\n');

    if (message.from === 'file') {
      if (message.file === undefined || message.file.length === 0) {
        return { error: 'No file was chosen to draft from.' };
      }
      const file = await readCodeFile(this.context, repositorySource(root), message.file);
      return 'error' in file ? { error: file.error } : { text: `# ${message.file}\n\n${file.text}`, area: listed };
    }

    if (message.from === 'page') {
      const page = collectPages(root).find((candidate) => candidate.id === message.pageId);
      if (page === undefined) {
        return { error: 'That page is not in this source.' };
      }
      return { text: pageBody(page), area: listed };
    }

    return { text: listed, area: listed };
  }

  /** The one write: `writePage` confirms, writes, opens the file, and offers the generator. */
  private async write(spec: NewPageSpec): Promise<void> {
    const panel = this.panel;
    const written = await writePage(this.deps, spec);
    if (written !== undefined) {
      await panel?.webview.postMessage({ type: 'written', relative: written.relative });
    }
  }
}

/** The model in use, or nothing — what the form needs to know before it offers to draft. */
function modelLabel(context: vscode.ExtensionContext): string | undefined {
  const status = aiStatus(context);
  if (status.model === undefined) {
    return undefined;
  }
  return status.model.id.split('/').pop() ?? status.model.id;
}

/** A page, as the material line for the area: its id, its title, and the headings it carries. */
function summarise(page: PageEntry): string {
  const headings = page.provenance?.headings ?? [];
  return `- \`${page.id}\` — ${page.title}${headings.length > 0 ? ` (${headings.join(' · ')})` : ''}`;
}

/** Another page of the area, whole: what a draft that adapts an existing page reads. */
function pageBody(page: PageEntry): string {
  try {
    const text = fs.readFileSync(page.uri.fsPath, 'utf8');
    return `# ${page.title} (\`${page.id}\`)\n\n${text.slice(0, MATERIAL_CHARS)}`;
  } catch {
    return `# ${page.title} (\`${page.id}\`)`;
  }
}

/** The source, as `src/repository.ts` needs it. Only a folder reaches this: an API source is not offered. */
function repositorySource(root: DocsRoot): RepositorySource {
  return { name: root.folder.name, path: root.rootUri.fsPath };
}

/** The file a spec would produce, for the prompt's own line — the confirmation names it again before writing. */
function fileOf(roots: readonly DocsRoot[], spec: NewPageSpec): string {
  const root = roots.find((candidate) => candidate.folder.name === spec.source) ?? roots[0];
  const area = spec.area ?? root?.areas[0]?.area ?? '';
  const chapter = spec.chapter === undefined || spec.chapter === AREA_CHAPTER ? '' : `${spec.chapter}/`;
  return root === undefined ? '' : `${root.folder.name}/docs/${area}/${chapter}${spec.slug ?? ''}.md`;
}

function nonce(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let text = '';
  for (let index = 0; index < 32; index += 1) {
    text += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return text;
}

function html(script: string): string {
  const style = `
    :root { color-scheme: light dark; }
    body { margin: 0; padding: 1.6em 2em 3em; font-family: var(--vscode-font-family);
           font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
    h1 { font-size: 1.5em; font-weight: 600; margin: 0 0 .2em; }
    h2 { font-size: .95em; font-weight: 600; text-transform: uppercase; letter-spacing: .04em;
         color: var(--vscode-descriptionForeground); margin: 1.9em 0 .5em; }
    p { line-height: 1.55; margin: .3em 0; }
    .meta { color: var(--vscode-descriptionForeground); }
    .fields { display: flex; gap: 1.6em; flex-wrap: wrap; }
    label.field { display: flex; flex-direction: column; gap: .25em; min-width: 0; flex: 0 1 22em; }
    label.field span { color: var(--vscode-descriptionForeground); }
    select, input[type=text] { padding: .35em .55em; font-family: inherit; font-size: inherit;
           color: var(--vscode-input-foreground); background: var(--vscode-input-background);
           border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; min-width: 0; }
    select:focus, input[type=text]:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(20em, 100%), 1fr));
               gap: .4em 1.2em; max-width: 78em; }
    .choice { display: flex; gap: .55em; align-items: baseline; padding: .45em .7em;
              border: 1px solid var(--vscode-panel-border); border-radius: 3px; cursor: pointer; }
    .choice.here { border-color: var(--vscode-focusBorder); }
    .choice input { margin: 0; }
    .choice .what { font-weight: 600; }
    .choice .detail { color: var(--vscode-descriptionForeground); display: block; }
    .path { font-family: var(--vscode-editor-font-family); font-size: .95em; overflow-wrap: anywhere; }
    button { padding: .35em .9em; border: none; border-radius: 2px; cursor: pointer; font-family: inherit;
             font-size: inherit; color: var(--vscode-button-secondaryForeground);
             background: var(--vscode-button-secondaryBackground); }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .5; cursor: default; }
    .do { display: flex; gap: .6em; flex-wrap: wrap; margin: 1.4em 0 0; align-items: center; }
    pre { font-family: var(--vscode-editor-font-family); font-size: .92em; line-height: 1.5;
          background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
          border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: .9em 1.1em;
          max-width: 78em; max-height: 34em; overflow: auto; white-space: pre-wrap; margin: .4em 0 0; }
    .note { color: var(--vscode-descriptionForeground); margin: .5em 0 0; max-width: 78em; }
    .warn { color: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder);
            background: var(--vscode-inputValidation-errorBackground); border-radius: 3px; padding: .8em 1em;
            max-width: 78em; margin: .8em 0; }
    .empty { color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-panel-border);
             border-radius: 3px; padding: 1.2em 1.4em; max-width: 78em; }
    .ok { color: var(--vscode-charts-green); }
    .foot { color: var(--vscode-descriptionForeground); margin-top: 2.4em; max-width: 78em;
            border-top: 1px solid var(--vscode-panel-border); padding-top: 1em; }
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${script}';">
<style>${style}</style>
<title>Temco Knowledge</title>
</head>
<body>
  <h1>New page</h1>
  <p class="meta" id="lede">Everything about the page in one place. Nothing is written until you press
    <em>Write the page</em>, and that confirmation names the file.</p>

  <div id="empty" hidden></div>
  <div id="form">
    <h2>Where</h2>
    <div class="fields">
      <label class="field"><span>Source</span><select id="source"></select></label>
      <label class="field"><span>Area</span><select id="area"></select></label>
      <label class="field"><span>Chapter</span><select id="chapter"></select></label>
    </div>

    <h2>What</h2>
    <div class="choices" id="mode">
      <label class="choice" id="mode-page"><input type="radio" name="mode" value="page"> <span><span class="what">A
        page</span><span class="detail">one Markdown file, named below</span></span></label>
      <label class="choice" id="mode-chapter"><input type="radio" name="mode" value="chapter">
        <span><span class="what">A chapter</span><span class="detail">a folder and its first page — an empty
        folder is not a chapter in the registry</span></span></label>
    </div>

    <h2>Kind</h2>
    <div class="choices" id="kinds"></div>

    <h2>Its name</h2>
    <div class="fields">
      <label class="field"><span id="titleLabel">Title</span>
        <input type="text" id="title" placeholder="Trend Logs"></label>
      <label class="field"><span id="slugLabel">File name (without .md)</span>
        <input type="text" id="slug" placeholder="trend-logs"></label>
    </div>
    <p class="note">It will be written to <span class="path" id="path">…</span> — the page id is that path, so the
      file name matters more than the title does.</p>

    <h2>Start the body from</h2>
    <div class="choices" id="from">
      <label class="choice"><input type="radio" name="from" value="empty"> <span><span class="what">Nothing</span>
        <span class="detail">the kind's headings, and no prose</span></span></label>
      <label class="choice"><input type="radio" name="from" value="area"> <span><span class="what">The pages
        already in this area</span><span class="detail">the model sees their ids, titles and headings</span></span></label>
      <label class="choice"><input type="radio" name="from" value="file"> <span><span class="what">A file of the
        source</span><span class="detail">a class, a header, a script — the page is about that file</span></span></label>
      <label class="choice"><input type="radio" name="from" value="page"> <span><span class="what">Another page</span>
        <span class="detail">adapt a page that already says something close</span></span></label>
    </div>
    <div class="fields" id="pickers" hidden>
      <label class="field" id="filesField" hidden><span>File</span>
        <input type="text" id="fileFilter" placeholder="Filter files…">
        <select id="file" size="8"></select>
        <span class="note" id="filesNote"></span></label>
      <label class="field" id="pagesField" hidden><span>Page</span><select id="page" size="8"></select>
        <span class="note" id="pagesNote"></span></label>
    </div>

    <div class="do">
      <button id="draft">Draft it with the AI</button>
      <span class="note" id="model"></span>
    </div>
    <div id="draftBox"></div>

    <div class="do">
      <button class="primary" id="write">Write the page</button>
      <button id="cancel">Cancel</button>
      <span class="note" id="result"></span>
    </div>
  </div>

  <p class="foot">The file is written with what you read above, and its first line is <code># title</code> — the
    repository's generator reads a new page's title from that heading. The registry entry comes from the
    repository's own generator afterwards, which is offered as soon as the file is written.</p>

<script nonce="${script}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let sources = [];
let kinds = [];
let areaChapter = '(root)';
let seed = {};
let files = [];
let pages = [];
let draft = '';

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'form') {
    sources = message.sources || [];
    kinds = message.kinds || [];
    areaChapter = message.areaChapter || '(root)';
    seed = message.seed || {};
    accept(message);
    return;
  }
  if (message.type === 'files') {
    files = message.files || [];
    $('file').replaceChildren(...files.map(option));
    $('filesNote').textContent = files.length === 0
      ? (message.note || 'No code files were found in this source.')
      : files.length + ' file' + (files.length === 1 ? '' : 's') + (message.note ? ' · ' + message.note : '');
    return;
  }
  if (message.type === 'draftStart') {
    draft = '';
    $('draftBox').replaceChildren(box('Drafting…'));
    return;
  }
  if (message.type === 'draftToken') {
    draft += message.text || '';
    $('draftBox').replaceChildren(pre(draft));
    return;
  }
  if (message.type === 'draftDone') {
    $('draftBox').replaceChildren(pre(draft), tell('Read it. Edit anything you like after it is written — or draft again.'));
    return;
  }
  if (message.type === 'draftError') {
    draft = '';
    $('draftBox').replaceChildren(warn(message.message));
    return;
  }
  if (message.type === 'written') {
    $('result').textContent = 'Written to ' + message.relative + ' — the editor has it.';
    $('result').className = 'note ok';
    $('write').disabled = true;
    return;
  }
});

function accept(message) {
  const model = message.model;
  $('model').textContent = model ? 'Local model: ' + model : 'No local model is chosen — the AI drafts are off.';
  $('draft').disabled = !model;

  if (sources.length === 0) {
    $('form').hidden = true;
    const box = document.createElement('div');
    box.className = 'empty';
    box.textContent = 'No source on this machine is being read, so there is nowhere to write a page. ' +
      'A source read over the API has no working tree; work on a project whose sources are folders.';
    $('empty').replaceChildren(box);
    $('empty').hidden = false;
    return;
  }

  $('source').replaceChildren(...sources.map((source) =>
    withValue(option(source.name), source.name + '  —  ' + source.where)));
  const wanted = sources.find((source) => source.name === seed.source) ? seed.source : sources[0].name;
  $('source').value = wanted;
  drawAreas();

  const kind = kinds.find((candidate) => candidate.label === seed.kind);
  drawKinds(kind ? kind.label : 'Article');

  const chapterMode = seed.chapterMode === true;
  document.querySelector('input[name=mode][value=' + (chapterMode ? 'chapter' : 'page') + ']').checked = true;
  drawMode();

  const from = 'empty';
  const radio = document.querySelector('input[name=from][value=' + from + ']');
  if (radio) { radio.checked = true; }
  drawFrom();
  drawPath();
}

function drawAreas() {
  const source = sources.find((candidate) => candidate.name === $('source').value) || sources[0];
  $('area').replaceChildren(...source.areas.map((area) => withValue(option(area.title + '  (' + area.area + ')'), area.area)));
  if (seed.area && source.areas.some((area) => area.area === seed.area)) {
    $('area').value = seed.area;
  }
  drawChapters();
}

function drawChapters() {
  const source = sources.find((candidate) => candidate.name === $('source').value) || sources[0];
  const area = source.areas.find((candidate) => candidate.area === $('area').value) || source.areas[0];
  const names = (area ? area.chapters : []).filter((chapter) => chapter !== areaChapter);
  const options = [withValue(option('directly in the area'), areaChapter)].concat(
    names.map((chapter) => withValue(option(chapter), chapter)));
  $('chapter').replaceChildren(...options);
  if (seed.chapter && (seed.chapter === areaChapter || names.includes(seed.chapter))) {
    $('chapter').value = seed.chapter;
  }
}

function drawKinds(selected) {
  $('kinds').replaceChildren(...kinds.map((kind) => {
    const label = document.createElement('label');
    label.className = 'choice' + (kind.label === selected ? ' here' : '');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'kind';
    input.value = kind.label;
    input.checked = kind.label === selected;
    input.addEventListener('change', () => { drawKinds(kind.label); drawPath(); });
    const text = document.createElement('span');
    text.innerHTML = '<span class="what">' + escape(kind.label) + '</span>' +
      '<span class="detail">' + escape(kind.headings.join(' · ')) + '</span>';
    label.append(input, text);
    return label;
  }));
}

function drawMode() {
  const chapter = document.querySelector('input[name=mode]:checked').value === 'chapter';
  $('mode-page').className = 'choice' + (chapter ? '' : ' here');
  $('mode-chapter').className = 'choice' + (chapter ? ' here' : '');
  // A chapter needs two names, because an empty folder is not a chapter: the chapter itself, and the first page
  // inside it — which is where the folder comes from. The chapter's name is typed naturally and becomes that
  // first page's own # heading; its folder is the slug of the same words. One field fewer to explain than a
  // separately named folder.
  $('titleLabel').textContent = chapter ? 'The chapter' : 'Title';
  $('slugLabel').textContent = chapter ? 'The first page’s file name (without .md)' : 'File name (without .md)';
  if (chapter && $('slug').dataset.touched !== 'yes') {
    $('slug').value = 'index';
  }
  if (!chapter && $('slug').value === 'index') {
    $('slug').value = slugify($('title').value);
  }
  $('chapter').disabled = chapter;
  drawPath();
}

function togglePath() { drawPath(); }

function slugify(text) {
  const slug = text.toLowerCase().normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug.length > 0 ? slug : 'page';
}

/** The path the answers make, exactly as the extension computes it: the chapter that *is* the area has none. */
function pathNow() {
  const chapterMode = document.querySelector('input[name=mode]:checked').value === 'chapter';
  const folder = chapterMode
    ? slugify($('title').value) + '/'
    : ($('chapter').value === areaChapter ? '' : $('chapter').value + '/');
  const name = ($('slug').value.trim() || (chapterMode ? 'index' : slugify($('title').value))) + '.md';
  return $('source').value + '/docs/' + $('area').value + '/' + folder + name;
}

function drawPath() {
  $('path').textContent = pathNow();
}

/** The pages of the chosen area, as the form was told them — no second round trip for a list we already have. */
function areaPages() {
  const source = sources.find((candidate) => candidate.name === $('source').value) || sources[0];
  const area = source.areas.find((candidate) => candidate.area === $('area').value) || source.areas[0];
  return area ? area.pages : [];
}

function drawFrom() {
  const from = document.querySelector('input[name=from]:checked').value;
  $('pickers').hidden = from !== 'file' && from !== 'page';
  $('filesField').hidden = from !== 'file';
  $('pagesField').hidden = from !== 'page';
  if (from === 'file' && files.length === 0) {
    $('filesNote').textContent = 'Reading the source’s file list…';
    vscode.postMessage({ type: 'files', source: $('source').value });
  }
  if (from === 'page') {
    const listed = areaPages();
    $('page').replaceChildren(...listed.map((page) => withValue(option(page.title + '  (' + page.id + ')'), page.id)));
    $('pagesNote').textContent = listed.length === 0
      ? 'This area has no pages yet, so there is nothing to adapt.'
      : listed.length + ' page' + (listed.length === 1 ? '' : 's') + ' in this area.';
  }
}

/** Exactly what the extension will write, from the same fields. */
function spec() {
  const chapterMode = document.querySelector('input[name=mode]:checked').value === 'chapter';
  const kind = document.querySelector('input[name=kind]:checked');
  const title = $('title').value.trim();
  return {
    source: $('source').value,
    area: $('area').value,
    chapter: chapterMode ? slugify(title) : $('chapter').value,
    kind: kind ? kind.value : 'Article',
    title,
    slug: $('slug').value.trim() || (chapterMode ? 'index' : slugify(title)),
  };
}

$('source').addEventListener('change', () => { files = []; drawAreas(); drawPath(); });
$('area').addEventListener('change', () => { drawChapters(); drawPath(); });
$('chapter').addEventListener('change', drawPath);
$('title').addEventListener('input', () => {
  if ($('slug').dataset.touched !== 'yes') {
    $('slug').value = slugify($('title').value);
  }
  drawPath();
});$('slug').addEventListener('input', () => { $('slug').dataset.touched = 'yes'; drawPath(); });
$('fileFilter').addEventListener('input', () => {
  const needle = $('fileFilter').value.trim().toLowerCase();
  $('file').replaceChildren(...files.filter((file) => file.toLowerCase().includes(needle)).map(option));
});
document.querySelectorAll('input[name=mode]').forEach((input) => input.addEventListener('change', drawMode));
document.querySelectorAll('input[name=from]').forEach((input) => input.addEventListener('change', drawFrom));

$('draft').addEventListener('click', () => {
  const from = document.querySelector('input[name=from]:checked').value;
  if (from === 'empty') {
    $('draftBox').replaceChildren(tell('Choose what to start from — the pages of the area, a file, or another page — and the draft has something to read.'));
    return;
  }
  const chosen = spec();
  vscode.postMessage({
    type: 'draft',
    from,
    file: $('file').value,
    pageId: $('page').value,
    spec: chosen,
  });
});

$('write').addEventListener('click', () => {
  const chosen = spec();
  if (chosen.title.length === 0) {
    $('result').textContent = 'A page needs a title (or, for a chapter, a name).';
    return;
  }
  const from = document.querySelector('input[name=from]:checked').value;
  vscode.postMessage({ type: 'write', spec: Object.assign({}, chosen, { body: from === 'empty' ? '' : draft }) });
});
$('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

function option(text) {
  const node = document.createElement('option');
  node.textContent = text;
  return node;
}
function withValue(node, value) { node.value = value; return node; }
function pre(text) {
  const node = document.createElement('pre');
  node.textContent = text;
  return node;
}
function box(text) { return tell(text); }
function tell(text) {
  const node = document.createElement('p');
  node.className = 'note';
  node.textContent = text;
  return node;
}
function warn(text) {
  const node = document.createElement('div');
  node.className = 'warn';
  node.textContent = text;
  return node;
}
function note(parent, text) { parent.textContent = text; }
function escape(text) {
  return String(text).replace(/[&<>"]/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
}
</script>
</body>
</html>
`;
}
