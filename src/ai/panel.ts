// The `Temco Knowledge` panel: the AI beside the page.
//
// A panel, not an application — it reads the page in the editor and the registry, and it decides nothing by
// itself. A draft arrives as a diff, and putting it into the page is a button a person presses. With no model
// installed the panel still opens and says what to do, so the extension never looks broken.

import * as vscode from 'vscode';
import { DocsRoot, PageEntry, collectPages, pageForUri } from '../registry';
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
import { ChatMessage, aiStatus, complete } from './runtime';

export const AI_VIEW_ID = 'temcoKnowledge.ai';
/** How many earlier turns are resent: enough for a follow-up, small enough to stay cheap and fast. */
const HISTORY_TURNS = 6;
/** The most candidate pages one area question may carry. Headings only, so the prompt stays bounded. */
const AREA_CANDIDATES = 40;

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
    private readonly roots: () => readonly DocsRoot[]
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
      model: status.model ? entryById(status.model.id)?.label ?? status.model.id : undefined,
      runtimeReady: status.runtime !== undefined,
      busy: this.busy,
      canApply: this.draft !== undefined,
    });
  }

  private async receive(message: unknown): Promise<void> {
    const data = message as { type?: string; text?: string };
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
      case 'apply':
        await this.apply();
        return;
      case 'models':
        await vscode.commands.executeCommand('temcoKnowledge.models');
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
    this.busy = true;
    this.refresh();
    this.post({ type: 'user', text: this.label(kind, question) });
    this.post({ type: 'start' });
    this.post({ type: 'busy', busy: true });

    const tokenSource = new vscode.CancellationTokenSource();
    this.cancelling = tokenSource;
    let streamed = '';
    try {
      const messages = this.messages(kind, question, page, entry);
      const answer = await complete(this.context, messages, {
        onToken: (piece) => {
          streamed += piece;
          this.post({ type: 'chunk', text: piece });
        },
        token: tokenSource.token,
      });
      const text = (answer || streamed).trim();
      if (text.length === 0) {
        this.post({ type: 'note', text: 'The model returned nothing. Try again, or a different model.' });
      } else if (kind === 'draft') {
        this.remember(question, text);
        await this.showDraft(text, entry);
      } else {
        this.remember(question, text);
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

  /** A draft is shown against the page it came from, never written straight into it. */
  private async showDraft(text: string, entry: PageEntry | undefined): Promise<void> {
    if (!entry) {
      return;
    }
    this.draft = { page: entry, text };
    const draft = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' });
    await vscode.commands.executeCommand(
      'vscode.diff',
      entry.uri,
      draft.uri,
      `${entry.title} ↔ draft (${PROMPT_VERSION})`
    );
    this.post({
      type: 'note',
      text: `Draft from ${PROMPT_VERSION}. Read the diff: Apply replaces the whole page, and one Ctrl+Z takes it back.`,
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
    entry: PageEntry | undefined
  ): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(page) }];
    for (const turn of this.turns.slice(-HISTORY_TURNS)) {
      messages.push({ role: turn.role, content: turn.text });
    }
    switch (kind) {
      case 'ask':
        messages.push({ role: 'user', content: askPrompt(question, page) });
        break;
      case 'area':
        messages.push({
          role: 'user',
          content: areaPrompt(question, page, this.candidates(entry)),
        });
        break;
      case 'draft':
        if (page) {
          messages.push({ role: 'user', content: draftPrompt(page, question || DEFAULT_DRAFT_NOTE) });
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
    if (!uri || uri.scheme !== 'file') {
      return undefined;
    }
    return pageForUri(this.roots(), uri);
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
      body,
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
<header>
  <span id="where">no page open</span>
  <span id="model" class="muted">no model</span>
</header>
<div id="transcript"></div>
<div id="foot" class="muted">local &middot; offline &middot; a draft is a diff</div>
<form id="form">
  <textarea id="text" rows="2" placeholder="Ask about the open page&hellip;"></textarea>
  <div id="buttons">
    <button id="send" type="submit" class="primary">Ask</button>
    <button id="draft" type="button">Draft update</button>
    <button id="area" type="button">Ask the area</button>
    <button id="apply" type="button" class="hidden">Apply draft</button>
    <button id="models" type="button" class="quiet">Models&hellip;</button>
  </div>
</form>
<script src="${script}"></script>
</body>
</html>`;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
