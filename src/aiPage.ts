// The AI page: the AI as something you own and configure, not a popup you dismiss.
//
// Four facts a person needs before trusting an answer — which runtime, which model, whether the server is up,
// and what instructions it was given — plus what can be downloaded, and a box to try it. The *Models and
// Runtime* quick pick still exists for keyboard use; this is the same information with room to stand back.
//
// It is a page about the AI in general, not about one project. A project's AI tab is where the AI meets that
// project's pages; this is where the AI itself is set up, and both point at each other.

import * as vscode from 'vscode';
import { MODELS, RUNTIMES, entryById, formatBytes } from './ai/catalog';
import { install, installedArtifacts, modelRoot, uninstall } from './ai/install';
import { PROMPT_VERSION } from './ai/prompts';
import { aiStatus, showAiLog, startAiServer, stopAiServer } from './ai/runtime';
import { AI_PAGE_VIEW_TYPE, pageColumn } from './surface';

interface AiPageMessage {
  type: 'ready' | 'download' | 'remove' | 'start' | 'stop' | 'folder' | 'log' | 'models' | 'apply' | 'panel' | 'dock';
  id?: string;
  model?: string;
  runtime?: string;
}

export class AiPage {
  private panel: vscode.WebviewPanel | undefined;
  private busy = '';

  constructor(private readonly context: vscode.ExtensionContext) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal(pageColumn());
      void this.seed();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      AI_PAGE_VIEW_TYPE,
      'The AI',
      pageColumn(),
      { enableScripts: true, localResourceRoots: [] }
    );
    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'knowledge.svg');
    this.panel.webview.html = html(nonce());
    this.panel.webview.onDidReceiveMessage((message: AiPageMessage) => void this.receive(message));
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private async receive(message: AiPageMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.seed();
        return;
      case 'download':
        await this.download(message.id ?? '');
        return;
      case 'remove': {
        const id = message.id ?? '';
        if (installedArtifacts(this.context).some((artifact) => artifact.id === id)) {
          uninstall(this.context, id);
        }
        await this.seed();
        return;
      }
      case 'start':
        this.busy = 'starting';
        await this.seed();
        try {
          const info = await startAiServer(this.context);
          void vscode.window.showInformationMessage(`Temco Knowledge: the local AI is on ${info.baseUrl}.`);
        } catch (error) {
          void vscode.window.showErrorMessage(`Temco Knowledge: ${String(error)}`);
        }
        this.busy = '';
        await this.seed();
        return;
      case 'stop':
        stopAiServer();
        await this.seed();
        return;
      case 'folder':
        await vscode.env.openExternal(vscode.Uri.file(modelRoot(this.context)));
        return;
      case 'log':
        showAiLog();
        return;
      case 'panel':
        await vscode.commands.executeCommand('temcoKnowledge.ai.focus');
        return;
      case 'dock':
        await vscode.commands.executeCommand('temcoKnowledge.aiDockRight');
        return;
      case 'models':
        await vscode.commands.executeCommand('temcoKnowledge.models');
        await this.seed();
        return;
      case 'apply': {
        const configuration = vscode.workspace.getConfiguration('temcoKnowledge');
        await configuration.update('ai.model', message.model ?? '', vscode.ConfigurationTarget.Global);
        await configuration.update('ai.runtime', message.runtime ?? '', vscode.ConfigurationTarget.Global);
        await this.seed();
        return;
      }
    }
  }

  private async download(id: string): Promise<void> {
    const entry = entryById(id);
    if (!entry) {
      return;
    }

    this.busy = id;
    await this.seed();
    try {
      await install(this.context, entry);
      // Installing and choosing are separate acts, but a first install with nothing chosen would leave the
      // server unable to start for no reason. Choose it only when the choice is still empty.
      const key = entry.kind === 'runtime' ? 'ai.runtime' : 'ai.model';
      const configuration = vscode.workspace.getConfiguration('temcoKnowledge');
      if (configuration.get<string>(key, '').length === 0) {
        await configuration.update(key, entry.id, vscode.ConfigurationTarget.Global);
      }
      void vscode.window.showInformationMessage(`Temco Knowledge: ${entry.label} is installed.`);
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      const answer = await vscode.window.showWarningMessage(`Temco Knowledge: ${message}`, 'Open Settings');
      if (answer === 'Open Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'temcoKnowledge.ai.allowUnpinned');
      }
    }
    this.busy = '';
    await this.seed();
  }

  /** Whether the catalogue pins checksums for this kind at all — the wording of a refusal depends on it. */

  private async seed(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const configuration = vscode.workspace.getConfiguration('temcoKnowledge');
    const status = aiStatus(this.context);
    const installed = installedArtifacts(this.context);
    const have = new Set(installed.map((artifact) => artifact.id));

    const describe = (entry: (typeof RUNTIMES)[number]) => {
      const artifact = installed.find((one) => one.id === entry.id);
      return {
        id: entry.id,
        label: entry.label,
        licence: entry.licence,
        size: entry.bytes > 0 ? formatBytes(entry.bytes) : 'size not pinned',
        notes: entry.notes,
        pinned: entry.sha256.length > 0,
        needs: entry.needs,
        platform: [entry.platform, entry.architecture].filter(Boolean).join(' '),
        installed: have.has(entry.id),
        path: artifact?.path,
        installedAt: artifact?.installedAt,
        busy: this.busy === entry.id,
      };
    };

    await this.panel.webview.postMessage({
      type: 'ai',
      facts: {
        runtime: status.runtime ? entryById(status.runtime.id)?.label ?? status.runtime.id : undefined,
        model: status.model ? entryById(status.model.id)?.label ?? status.model.id : undefined,
        running: status.running ? `${status.running.baseUrl} (${status.running.label})` : undefined,
        promptVersion: PROMPT_VERSION,
        root: modelRoot(this.context),
        busy: this.busy === 'starting' ? 'starting the server' : undefined,
      },
      chosen: {
        runtime: configuration.get<string>('ai.runtime', ''),
        model: configuration.get<string>('ai.model', ''),
      },
      installed: installed.map((artifact) => ({
        id: artifact.id,
        label: entryById(artifact.id)?.label ?? artifact.id,
        kind: artifact.kind,
        path: artifact.path,
        bytes: formatBytes(artifact.bytes),
        at: artifact.installedAt.slice(0, 16).replace('T', ' '),
      })),
      runtimes: RUNTIMES.map(describe),
      models: MODELS.map(describe),
    });
  }
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
    h1 { font-size: 1.5em; font-weight: 600; margin: 0 0 .6em; }
    h2 { font-size: 1em; font-weight: 600; margin: 1.8em 0 .5em; }
    h3 { font-size: .95em; font-weight: 600; margin: 0 0 .2em; }
    p { line-height: 1.55; margin: .3em 0; }
    .meta { color: var(--vscode-descriptionForeground); }
    .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(16em, 100%), 1fr)); gap: .8em 2em;
             max-width: 70em; }
    .facts div { border-left: 2px solid var(--vscode-panel-border); padding-left: .7em; min-width: 0; }
    .facts dt { color: var(--vscode-descriptionForeground); }
    .facts dd { margin: .1em 0 0; overflow-wrap: anywhere; }
    button { padding: .3em .8em; border: none; border-radius: 2px; cursor: pointer;
             font-family: inherit; font-size: inherit;
             color: var(--vscode-button-secondaryForeground);
             background: var(--vscode-button-secondaryBackground); }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .5; cursor: default; }
    .actions { display: flex; gap: .6em; flex-wrap: wrap; margin: .8em 0 0; }
    .place { display: flex; gap: .6em; flex-wrap: wrap; margin: .8em 0 0; align-items: center; }
    .place p { margin: 0; color: var(--vscode-descriptionForeground); flex: 1 1 20em; min-width: 0; }
    .card { border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: .8em 1em;
            margin: 0 0 .7em; max-width: 70em; display: flex; gap: 1em; align-items: flex-start; }
    .card .body { flex: 1 1 auto; min-width: 0; }
    .card .side { flex: 0 0 auto; display: flex; gap: .4em; align-items: center; }
    .card p { color: var(--vscode-descriptionForeground); margin: .2em 0 0; }
    .card code { overflow-wrap: anywhere; }
    .badge { color: var(--vscode-descriptionForeground); font-size: .9em; }
    .empty { color: var(--vscode-descriptionForeground); border: 1px dashed var(--vscode-panel-border);
             border-radius: 3px; padding: 1em 1.2em; max-width: 70em; }
    code { font-family: var(--vscode-editor-font-family); font-size: .95em; overflow-wrap: anywhere; }
    select { font-family: inherit; font-size: inherit; padding: .25em .4em;
             color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
             border: 1px solid var(--vscode-dropdown-border); }
    .pick { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(18em, 100%), 1fr)); gap: 1em 2em;
            max-width: 70em; }
    .pick label { display: block; color: var(--vscode-descriptionForeground); margin-bottom: .2em; }
    .pick select { width: 100%; min-width: 0; }
    .foot { color: var(--vscode-descriptionForeground); margin-top: 2.4em; max-width: 70em;
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
  <h1>The AI</h1>
  <p class="meta">A model on this machine, answering about your own pages. Nothing is sent anywhere: the runtime
    is a program run as a child process, on loopback only, started when it is needed and stopped when it is
    not. Nothing is downloaded until you ask for it.</p>

  <dl class="facts" id="facts"></dl>
  <div class="actions" id="controls"></div>

  <h2>Where the AI sits</h2>
  <div class="place">
    <p>The panel belongs in the right side bar, beside the page you are reading — and that is where it is
      <em>declared</em> (<code>contributes.viewsContainers.secondarySidebar</code>), so it opens there without
      anything to set up. Drag it anywhere you like; this puts it back where it belongs.</p>
    <button class="primary" id="dock">Put it back in the right side bar</button>
    <button id="panel">Show the panel</button>
  </div>

  <h2>Which runtime and model</h2>
  <p class="meta">Installing something and choosing it are two separate acts — the choice below is what the
    server actually starts with.</p>
  <div class="pick" id="pick"></div>

  <h2>Installed on this machine</h2>
  <div id="installed"></div>

  <h2>Runtimes</h2>
  <p class="meta">A compiled inference engine is per-OS, which is why it is fetched rather than bundled.</p>
  <div id="runtimes"></div>

  <h2>Models</h2>
  <p class="meta">Permissive licences only, and the licence is shown before anything is downloaded.</p>
  <div id="models"></div>

  <p class="foot" id="foot"></p>

<script nonce="${script}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let selection = { runtime: '', model: '' };

// The two static buttons above the lists: the panel itself, and the one-time move to the right side bar.
$('dock').addEventListener('click', () => vscode.postMessage({ type: 'dock' }));
$('panel').addEventListener('click', () => vscode.postMessage({ type: 'panel' }));

function fact(label, value) {
  const div = document.createElement('div');
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  div.append(dt, dd);
  return div;
}

function button(text, kind, onClick, disabled) {
  const b = document.createElement('button');
  b.textContent = text;
  if (kind) { b.className = kind; }
  b.disabled = Boolean(disabled);
  b.addEventListener('click', onClick);
  return b;
}

function empty(text) {
  const div = document.createElement('div');
  div.className = 'empty';
  div.textContent = text;
  return div;
}

function entryCard(entry, allowRemove) {
  const card = document.createElement('div');
  card.className = 'card';
  const body = document.createElement('div');
  body.className = 'body';
  const h = document.createElement('h3');
  h.textContent = entry.label;
  const p = document.createElement('p');
  const parts = [entry.licence, entry.size];
  if (entry.platform) { parts.push(entry.platform); }
  if (entry.needs) { parts.push(entry.needs); }
  if (!entry.pinned) { parts.push('checksum not pinned'); }
  p.textContent = parts.join(' · ');
  body.append(h, p);
  if (entry.path) {
    const where = document.createElement('p');
    where.append(document.createTextNode('Installed: '));
    const code = document.createElement('code');
    code.textContent = entry.path;
    where.append(code);
    body.append(where);
  }
  const side = document.createElement('div');
  side.className = 'side';
  if (entry.installed) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'installed';
    side.append(badge);
    if (allowRemove) {
      side.append(button('Remove', null, () => vscode.postMessage({ type: 'remove', id: entry.id })));
    }
  } else {
    side.append(
      button(
        entry.busy ? 'Downloading…' : 'Download',
        'primary',
        () => vscode.postMessage({ type: 'download', id: entry.id }),
        entry.busy
      )
    );
  }
  card.append(body, side);
  return card;
}

function render(data) {
  const facts = data.facts;
  $('facts').replaceChildren(
    fact('Runtime', facts.runtime || (facts.busy ? 'none selected' : 'none installed')),
    fact('Model', facts.model || 'none installed'),
    fact('Server', facts.busy || facts.running || 'not running'),
    fact('Instructions', facts.promptVersion),
    fact('Where they live', facts.root)
  );

  const controls = $('controls');
  if (data.facts.running) {
    controls.replaceChildren(
      button('Stop the server', null, () => vscode.postMessage({ type: 'stop' })),
      button('Show the log', null, () => vscode.postMessage({ type: 'log' })),
      button('Open the model folder', null, () => vscode.postMessage({ type: 'folder' }))
    );
  } else {
    controls.replaceChildren(
      button(
        facts.busy ? 'Starting…' : 'Start the server',
        'primary',
        () => vscode.postMessage({ type: 'start' }),
        Boolean(facts.busy) || !facts.model || !facts.runtime
      ),
      button('Show the log', null, () => vscode.postMessage({ type: 'log' })),
      button('Open the model folder', null, () => vscode.postMessage({ type: 'folder' })),
      button('The list a keyboard user gets', null, () => vscode.postMessage({ type: 'models' }))
    );
  }

  const pick = $('pick');
  pick.replaceChildren();
  selection = { runtime: data.chosen.runtime, model: data.chosen.model };
  for (const [key, entries] of [
    ['runtime', data.runtimes],
    ['model', data.models],
  ]) {
    const wrap = document.createElement('div');
    const label = document.createElement('label');
    label.textContent = key === 'runtime' ? 'Runtime' : 'Model';
    const select = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— not chosen —';
    select.append(none);
    for (const entry of entries) {
      if (!entry.installed) { continue; }
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = entry.label;
      option.selected = entry.id === selection[key];
      select.append(option);
    }
    if (select.options.length === 1) {
      const option = document.createElement('option');
      option.disabled = true;
      option.textContent = 'nothing installed yet';
      select.append(option);
    }
    // Both are always sent: the settings are two keys, and the server needs both to start.
    select.addEventListener('change', () => {
      selection[key] = select.value;
      vscode.postMessage({ type: 'apply', runtime: selection.runtime, model: selection.model });
    });
    wrap.append(label, select);
    pick.append(wrap);
  }

  const installed = $('installed');
  if (data.installed.length === 0) {
    installed.replaceChildren(empty('Nothing installed. The extension ships no model and no engine — pick one below and it is fetched into the folder above.'));
  } else {
    installed.replaceChildren(
      ...data.installed.map((artifact) => {
        const card = document.createElement('div');
        card.className = 'card';
        const body = document.createElement('div');
        body.className = 'body';
        const h = document.createElement('h3');
        h.textContent = artifact.label;
        const p = document.createElement('p');
        p.textContent = [artifact.kind, artifact.bytes, 'added ' + artifact.at].join(' · ');
        const where = document.createElement('p');
        const code = document.createElement('code');
        code.textContent = artifact.path;
        where.append(code);
        body.append(h, p, where);
        const side = document.createElement('div');
        side.className = 'side';
        side.append(button('Remove', null, () => vscode.postMessage({ type: 'remove', id: artifact.id })));
        card.append(body, side);
        return card;
      })
    );
  }

  $('runtimes').replaceChildren(...data.runtimes.map((entry) => entryCard(entry, false)));
  $('models').replaceChildren(...data.models.map((entry) => entryCard(entry, false)));
  $('foot').textContent =
    'A download is a file in the folder above — never in a repository, never part of the extension. Removing ' +
    'one deletes that file and nothing else.';
}

// A change on one select sends both, so both values are kept together between round trips.

window.addEventListener('message', (event) => {
  if (event.data.type === 'ai') {
    render(event.data);
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
