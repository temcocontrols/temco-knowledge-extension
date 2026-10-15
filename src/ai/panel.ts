// The `Temco Knowledge` panel: the AI beside the page.
//
// A panel, not an application — it reads the page in the editor and the registry, and it decides nothing by
// itself. A draft arrives as a diff, and putting it into the page is a button a person presses. With no model
// installed the panel still opens and says what to do, so the extension never looks broken.

import * as vscode from 'vscode';
import { DocsRoot, PageEntry, collectPages, pageForUri } from '../registry';
import { Selection } from '../selected';
import { entryById } from './catalog';
import {
  Candidate,
  PageContext,
  PROMPT_VERSION,
  areaPrompt,
  askPrompt,
  draftPrompt,
  systemPrompt,
} from './prompts';
import { resolveCitations, searchPages } from './citations';
import { ChangeRange, readChangeRange } from './history';
import { ChatMessage, aiStatus, complete } from './runtime';

export const AI_VIEW_ID = 'temcoKnowledge.ai';
/** How many earlier turns are resent: enough for a follow-up, small enough to stay cheap and fast. */
const HISTORY_TURNS = 6;
/** The most candidate pages one area question may carry. Headings only, so the prompt stays bounded. */
const AREA_CANDIDATES = 40;
/** The most page text one request may carry. Past this a draft would be a truncated page, which is worse than none. */
const MAX_BODY = 100_000;
/** An answer is a few sentences; a draft is a whole page. Both are bounded so a request cannot run away. */
const ANSWER_TOKENS = 1024;
const DRAFT_TOKENS = 2048;

const DEFAULT_DRAFT_NOTE =
  'No description of the change was given. Review the page against its own headings and propose the update ' +
  'that makes it accurate and complete.';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export class AiPanel implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private turns: Turn[] = [];
  private busy = false;
  private draft?: { page: PageEntry; text: string };
  private cancelling?: vscode.CancellationTokenSource;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly roots: () => readonly DocsRoot[],
    private readonly selection: Selection
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.onDidDispose(() => {
      this.view = undefined;
    });
    view.webview.onDidReceiveMessage((message: unknown) => void this.receive(message));
    this.refresh();
  }

  /** Re-states what the header shows: the page, the model, whether a draft is waiting. */
  refresh(): void {
    const page = this.page();
    const status = aiStatus(this.context);
    this.post({
      type: 'state',
      page: page
        ? { title: page.title, id: page.id, stale: page.provenance?.stale === true }
        : undefined,
      // Which project the question is about, in the panel rather than in the reader's head: the pages this
      // answers from are the selected project's, so a panel that did not say so would be answering about
      // something the reader cannot see.
      project: this.selection.project(),
      model: status.model ? entryById(status.model.id)?.label ?? status.model.id : undefined,
      runtimeReady: status.runtime !== undefined,
      version: PROMPT_VERSION,
      busy: this.busy,
      canApply: this.draft !== undefined,
    });
  }

  private async receive(message: unknown): Promise<void> {
    const data = message as { type?: string; text?: string; id?: string };
    switch (data.type) {
      case 'ask':
        await this.run('ask', data.text?.trim() ?? '');
        return;
      case 'draft':
        await this.run('draft', data.text?.trim() ?? '');
        return;
      case 'area': {
        let question = data.text?.trim() ?? '';
        if (question.length === 0) {
          question =
            (await vscode.window.showInputBox({
              title: 'Ask the area',
              prompt: 'What should the AI look for across this documentation area?',
            })) ?? '';
        }
        if (question.length > 0) {
          await this.run('area', question);
        }
        return;
      }
      case 'open': {
        const wanted = data.id ?? '';
        const page = this.roots()
          .flatMap((root) => collectPages(root))
          .find((entry) => entry.id === wanted);
        if (page) {
          await vscode.window.showTextDocument(page.uri, { preview: false });
        }
        return;
      }
      case 'apply':
        await this.apply();
        return;
      case 'models':
        // The page, not the quick pick: choosing a model is downloading one, and that needs the page's room to
        // read what each model needs. The quick pick stays where it belongs — behind its own command and the
        // page's own "list a keyboard user gets" button.
        await vscode.commands.executeCommand('temcoKnowledge.aiPage', 'downloads');
        this.refresh();
        return;
      case 'stop':
        this.cancelling?.cancel();
        return;
      default:
        return;
    }
  }

  private async run(kind: 'ask' | 'area' | 'draft', question: string): Promise<void> {
    if (this.busy) {
      return;
    }
    const status = aiStatus(this.context);
    if (!status.runtime || !status.model) {
      this.post({
        type: 'note',
        text: 'No local model yet. Use “Models…” to download the runtime and a model — once they are on the disk, nothing leaves this machine.',
        models: true,
      });
      return;
    }

    const entry = this.page();
    if (kind === 'draft' && !entry) {
      this.post({ type: 'note', text: 'Open the page you want a draft for, then press Draft update.' });
      return;
    }

    const page = await this.pageContext(entry);
    // A draft is a whole page. If the page did not fit, applying a draft would delete whatever was cut.
    if (kind === 'draft' && page?.truncated) {
      this.post({
        type: 'note',
        text:
          `This page is longer than one draft can carry (over ${MAX_BODY.toLocaleString('en-US')} characters). ` +
          'Nothing was changed — split the page, or edit it by hand.',
      });
      return;
    }
    // A draft is *about a change*, so the change is read before anything is asked.
    const range = kind === 'draft' && entry ? await this.changeRange(entry) : undefined;
    this.busy = true;
    this.refresh();
    this.post({ type: 'user', text: this.label(kind, question) });
    this.post({ type: 'start' });
    this.post({ type: 'busy', busy: true });

    const tokenSource = new vscode.CancellationTokenSource();
    this.cancelling = tokenSource;
    let streamed = '';
    try {
      const messages = this.messages(kind, question, page, entry, range);
      const answer = await complete(this.context, messages, {
        onToken: (piece) => {
          streamed += piece;
          this.post({ type: 'chunk', text: piece });
        },
        token: tokenSource.token,
        maxTokens: kind === 'draft' ? DRAFT_TOKENS : ANSWER_TOKENS,
      });
      const text = (answer || streamed).trim();
      if (text.length === 0) {
        this.post({ type: 'note', text: 'The model returned nothing. Try again, or a different model.' });
      } else if (kind === 'draft') {
        this.remember(question, text);
        await this.showDraft(text, entry, range);
      } else {
        this.remember(question, text);
        this.verify(text, question, kind);
      }
    } catch (error) {
      this.post({ type: 'error', text: messageOf(error) });
    } finally {
      tokenSource.dispose();
      this.cancelling = undefined;
      this.busy = false;
      this.post({ type: 'end' });
      this.post({ type: 'busy', busy: false });
      this.refresh();
    }
  }

  /** The commits that prompted this draft — or a plain statement that none could be read. */
  private async changeRange(entry: PageEntry): Promise<ChangeRange> {
    const root = this.rootOf(entry);
    if (!root) {
      return {
        commits: 0,
        label: 'no range — the page is not inside an open repository',
        text: '(no change history was read)',
      };
    }
    return readChangeRange(root, entry);
  }

  /** A draft is shown against the page it came from, never written straight into it. */
  private async showDraft(
    text: string,
    entry: PageEntry | undefined,
    range: ChangeRange | undefined
  ): Promise<void> {
    if (!entry) {
      return;
    }
    this.draft = { page: entry, text };
    const draft = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
    const commits = range ? `, ${range.commits} commit${range.commits === 1 ? '' : 's'}` : '';
    await vscode.commands.executeCommand(
      'vscode.diff',
      entry.uri,
      draft.uri,
      `${entry.title} ↔ draft (${PROMPT_VERSION}${commits})`
    );
    this.post({
      type: 'note',
      text:
        `Draft from ${PROMPT_VERSION}${range ? ` · ${range.label}` : ''}. ` +
        'Read the diff: Apply replaces the whole page, and one Ctrl+Z takes it back.',
    });
  }

  private async apply(): Promise<void> {
    const draft = this.draft;
    if (!draft) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Replace the whole of "${draft.page.title}" with the draft?`,
      { modal: true, detail: `The draft came from ${PROMPT_VERSION}. The edit is a normal, undoable change.` },
      'Replace'
    );
    if (answer !== 'Replace') {
      return;
    }
    // Opening the document first is what gives the change an undo history to live in.
    const document = await vscode.workspace.openTextDocument(draft.page.uri);
    await vscode.window.showTextDocument(document, { preview: false });
    const edit = new vscode.WorkspaceEdit();
    const last = document.lineAt(document.lineCount - 1).range.end;
    const text = draft.text.endsWith('\n') ? draft.text : `${draft.text}\n`;
    edit.replace(draft.page.uri, new vscode.Range(new vscode.Position(0, 0), last), text);
    if (await vscode.workspace.applyEdit(edit)) {
      this.draft = undefined;
      this.post({ type: 'note', text: 'The draft was applied. Ctrl+Z takes it back.' });
      this.refresh();
    } else {
      this.post({ type: 'error', text: 'The editor refused the edit; nothing was changed.' });
    }
  }

  /**
   * What the model is allowed to see: the page, and for an area question the titles and headings of its
   * neighbours. Nothing else — no other file, no repository sweep, no path outside the documentation.
   */
  private messages(
    kind: 'ask' | 'area' | 'draft',
    question: string,
    page: PageContext | undefined,
    entry: PageEntry | undefined,
    range: ChangeRange | undefined
  ): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(this.context, page) }];
    for (const turn of this.turns.slice(-HISTORY_TURNS)) {
      messages.push({ role: turn.role, content: turn.text });
    }
    switch (kind) {
      case 'ask':
        messages.push({ role: 'user', content: askPrompt(this.context, question, page) });
        break;
      case 'area':
        messages.push({
          role: 'user',
          content: areaPrompt(this.context, question, page, this.candidates(entry)),
        });
        break;
      case 'draft':
        if (page) {
          messages.push({
            role: 'user',
            content: draftPrompt(
              this.context,
              page,
              range?.text ?? '(no change history was read)',
              question || DEFAULT_DRAFT_NOTE
            ),
          });
        }
        break;
    }
    return messages;
  }

  /** How an action reads in the transcript, where the model never sees it. */
  private label(kind: 'ask' | 'area' | 'draft', question: string): string {
    if (kind === 'draft') {
      return question ? `Draft update — ${question}` : 'Draft update — what has changed?';
    }
    if (kind === 'area') {
      return `Ask the area — ${question}`;
    }
    return question;
  }

  private remember(question: string, answer: string): void {
    this.turns.push({ role: 'user', text: question }, { role: 'assistant', text: answer });
  }

  /**
   * What the answer pointed at.
   *
   * A name that is not a page is reported rather than believed. And when an area answer cites nothing at all,
   * the pages whose words match the question are offered instead of the synthesis — the design's rule for a
   * low-confidence answer, and the honest thing to do with a small model.
   */
  private verify(text: string, question: string, kind: 'ask' | 'area' | 'draft'): void {
    if (kind === 'draft') {
      return;
    }
    const pages = this.roots().flatMap((root) => collectPages(root));
    const { known, unknown } = resolveCitations(text, pages);

    if (known.length > 0) {
      this.post({
        type: 'citations',
        items: known.map((page) => ({
          id: page.id,
          title: page.title,
          stale: page.provenance?.stale === true,
        })),
      });
    }
    if (unknown.length > 0) {
      this.post({
        type: 'note',
        text:
          `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a page' : 'are not pages'} in this ` +
          'documentation set. Treat anything they claim with suspicion.',
      });
    }
    if (kind === 'area' && known.length === 0) {
      const results = searchPages(pages, question, 5);
      if (results.length > 0) {
        this.post({
          type: 'results',
          text: 'That answer named no page, so here are the pages whose words match the question:',
          items: results.map((page) => ({
            id: page.id,
            title: page.title,
            stale: page.provenance?.stale === true,
          })),
        });
      }
    }
  }

  /** The page's own chapter first, then the rest of its area: the pages a question is most likely about. */
  private candidates(entry: PageEntry | undefined): Candidate[] {
    if (!entry) {
      return [];
    }
    const root = this.rootOf(entry);
    if (!root) {
      return [];
    }
    const pages = collectPages(root);
    const rank = (page: PageEntry): number =>
      page.chapter === entry.chapter ? 0 : page.area === entry.area ? 1 : 2;
    return pages
      .sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title))
      .slice(0, AREA_CANDIDATES)
      .map((page) => ({
        id: page.id,
        title: page.title,
        headings: page.provenance?.headings ?? [],
        stale: page.provenance?.stale === true,
      }));
  }

  private rootOf(entry: PageEntry): DocsRoot | undefined {
    const wanted = entry.uri.toString();
    return this.roots().find((root) =>
      collectPages(root).some((page) => page.uri.toString() === wanted)
    );
  }

  private page(): PageEntry | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri && uri.scheme === 'file') {
      const open = pageForUri(this.roots(), uri);
      if (open) {
        return open;
      }
    }
    // Nothing of ours is open in an editor — so the page the project remembers stands in, when the roots being
    // read contain it. That is what lets a question be asked from the hub, about the page you were just on,
    // without a text editor being open at all.
    const remembered = this.selection.page();
    if (remembered?.path !== undefined) {
      return pageForUri(this.roots(), vscode.Uri.file(remembered.path));
    }
    return undefined;
  }

  private async pageContext(entry: PageEntry | undefined): Promise<PageContext | undefined> {
    if (!entry) {
      return undefined;
    }
    const editor = vscode.window.activeTextEditor;
    let body = '';
    if (editor && editor.document.uri.toString() === entry.uri.toString()) {
      body = editor.document.getText();
    } else {
      try {
        body = Buffer.from(await vscode.workspace.fs.readFile(entry.uri)).toString('utf8');
      } catch {
        body = '';
      }
    }
    return {
      id: entry.id,
      title: entry.title,
      path: vscode.workspace.asRelativePath(entry.uri),
      area: entry.area,
      chapter: entry.chapter,
      owner: entry.owner,
      audience: entry.audience,
      reviewed: entry.reviewed,
      updated: entry.provenance?.updated ?? null,
      stale: entry.provenance?.stale === true,
      headings: entry.provenance?.headings ?? [],
      truncated: body.length > MAX_BODY,
      body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body,
    };
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'ai-panel.js')
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'ai-panel.css')
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
<link rel="stylesheet" href="${style}">
<title>Temco Knowledge</title>
</head>
<body>
<div id="transcript">
  <div id="empty" class="empty">
    <p class="lede">The AI works from the page you have open. It runs on this machine, and nothing it writes is
    applied until you accept the diff.</p>

    <div class="guide">
      <section>
        <h4><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.4 2.1l2.5 2.5M3 13l.9-3.6 7.1-7.1 2.5 2.5-7.1 7.1z"/></svg>Draft a page</h4>
        <p>Ask for an update and it comes back as a diff. The commit range it read is named on the diff, and one
        undo takes it back.</p>
        <button type="button" class="ask" data-text="Draft update — say what changed since the last review">Draft update — say what changed since the last review</button>
        <button type="button" class="ask" data-text="Draft update — the manifest format is missing from this page">Draft update — the manifest format is missing from this page</button>
      </section>

      <section>
        <h4><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>Ask about a page</h4>
        <p>An answer about the page in front. It cites the pages it used, so you can check it yourself.</p>
        <button type="button" class="ask" data-text="What does this page leave out?">What does this page leave out?</button>
        <button type="button" class="ask" data-text="Where does the controller read the firmware version?">Where does the controller read the firmware version?</button>
      </section>

      <section>
        <h4><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2l5.2 2.6L8 7.4 2.8 4.8z"/><path d="M2.8 7.6L8 10.2l5.2-2.6"/><path d="M2.8 10.4L8 13l5.2-2.6"/></svg>Ask across an area</h4>
        <p>The pages around this one — its area and its tags. When it finds only search results, it says so instead
        of guessing.</p>
        <button type="button" class="ask" data-text="Which pages describe the version check?">Which pages describe the version check?</button>
        <button type="button" class="ask" data-text="Is the manifest format documented anywhere in this area?">Is the manifest format documented anywhere in this area?</button>
      </section>

      <section>
        <h4><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.2L12.5 4.8v9.7h-8.5z"/><path d="M9.2 1.5v3.3h3.3"/></svg>A document for a product</h4>
        <p>Read a project's sources from the Library — a repository at a branch you choose — and every page they
        hold appears in the Workspace. Open one, and the AI works on it.</p>
      </section>
    </div>

    <p id="modelNote" class="hidden">No model is installed yet.
      <button type="button" id="chooseModel" class="choose">Choose a model&hellip;</button></p>
  </div>
</div>
<div id="tip">
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.5h5.2L12.5 4.8v9.7h-8.5z"/><path d="M9.2 1.5v3.3h3.3"/></svg>
  <span id="where">no page open</span>
</div>
<form id="form">
  <div class="box" id="box">
    <textarea id="text" rows="1" placeholder="Ask about the open page&hellip;"></textarea>
    <div class="row">
      <div class="left">
        <button id="draft" type="button" class="action" title="Draft an update to this page — it opens as a diff you accept">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.4 2.1l2.5 2.5M3 13l.9-3.6 7.1-7.1 2.5 2.5-7.1 7.1z"/></svg><span class="label">Draft update</span>
        </button>
        <button id="area" type="button" class="action" title="Ask about the pages around this one">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2l5.2 2.6L8 7.4 2.8 4.8z"/><path d="M2.8 7.6L8 10.2l5.2-2.6"/><path d="M2.8 10.4L8 13l5.2-2.6"/></svg><span class="label">Ask the area</span>
        </button>
        <button id="apply" type="button" class="action hidden" title="Replace the page with the draft — one undo takes it back">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.4l3.2 3.2L13 4.8"/></svg><span class="label">Apply draft</span>
        </button>
      </div>
      <button id="send" type="submit" class="send" title="Ask about this page (Enter)">
        <svg class="icon-send" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 13V3.4"/><path d="M3.8 7.6L8 3.4l4.2 4.2"/></svg>
        <svg class="icon-stop hidden" viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="6" height="6" rx="1.2"/></svg>
      </button>
    </div>
  </div>
</form>
<div id="status">
  <span class="dot" id="dot"></span>
  <span>Local</span>
  <span class="sep">&middot;</span>
  <button id="models" type="button" class="model" title="Which local model answers, and what is installed">
    <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2"/></svg>
    <span id="model">nothing installed</span>
  </button>
</div>
<script src="${script}"></script>
</body>
</html>`;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
