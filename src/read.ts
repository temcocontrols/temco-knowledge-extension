// Reading a source: the step between "I have a project" and "I can see its pages".
//
// Three ways to read, chosen by *what the job needs*, not by taste (see `docs/platform-design.md`):
//
//   local   the folder is on this machine — read its `docs/help/registry.json` directly
//   api     a repository, no clone — read the registry through the host's contents API, at the branch chosen
//   fetch   a repository that must be materialised (drafts, builds, file checks) — the next step's work
//
// A read **records** what it found: the pages go into the catalog, the source row gains its counts, and a scan
// row marks when it happened. Nothing is written to the source itself, ever.

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { Catalog, CatalogUnavailable, PageInput } from './catalog/store';
import { slugOf } from './projectPage';
import { fileColumn } from './surface';

const REGISTRY_TAIL = ['docs', 'help', 'registry.json'];
const TOKEN_SECRET = 'temcoKnowledge.githubToken';

export function registerReadCommands(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  refresh: () => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.readSource', (slug?: string) =>
      readSource(context, output, refresh, slug)
    ),
    vscode.commands.registerCommand('temcoKnowledge.openFile', (target?: string) => openFile(target)),
    vscode.commands.registerCommand('temcoKnowledge.setToken', () => setToken(context, refresh))
  );
}

/**
 * Open a file the catalog knows about.
 *
 * A page read from a repository over the API has no local file, so this says where it came from instead of
 * failing to open something that was never downloaded.
 */
async function openFile(target?: string): Promise<void> {
  if (!target) {
    return;
  }
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: fileColumn() });
  } catch {
    void vscode.window.showInformationMessage(
      `Temco Knowledge: ${target} is not on this machine — pages read over the API are recorded, not downloaded.`
    );
  }
}

async function readSource(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  refresh: () => void,
  wanted?: string
): Promise<void> {
  const catalog = await open(context);
  if (!catalog) {
    return;
  }

  try {
    const sources = catalog.sources();
    if (sources.length === 0) {
      void vscode.window.showInformationMessage(
        'Temco Knowledge: no sources yet. Create a project and give it a source first.'
      );
      return;
    }

    // Aimed at a slug, or a single source, or the one the caller named — no question when the answer is known.
    const aimed = wanted !== undefined ? sources.filter((source) => source.slug === slugOf(wanted)) : [];
    const slug =
      aimed[0]?.slug ??
      (sources.length === 1
        ? sources[0].slug
        : (
            await vscode.window.showQuickPick(
              sources.map((source) => ({
                label: source.name,
                detail: [source.kind, source.branch].filter(Boolean).join(' · '),
                slug: source.slug,
              })),
              { title: 'Read a source — which one?' }
            )
          )?.slug);
    if (!slug) {
      return;
    }

    const source = catalog.source(slug);
    if (!source) {
      void vscode.window.showWarningMessage(`Temco Knowledge: ${slug} is not in the catalog any more.`);
      return;
    }

    output.appendLine('');
    output.appendLine(`Reading ${source.name} (${source.kind}${source.branch ? ` @ ${source.branch}` : ''})`);

    const found =
      source.kind === 'archive'
        ? { pages: [] as PageInput[], note: 'an archive is kept for reference; nothing is read from it yet' }
        : source.path !== undefined
          ? await readLocal(source.path)
          : await readRemote(context, source.remoteUrl ?? '', source.branch, source.defaultBranch);

    catalog.replacePages(source.id, found.pages);
    catalog.setSourceState(slug, {
      pages: found.pages.length,
      state: found.note ?? `${found.pages.length} pages`,
      registryPath: found.registryPath,
    });
    catalog.recordScan(source.id, source.path !== undefined ? 'local' : 'api', undefined, {
      pages: found.pages.length,
    });

    output.appendLine(`  ${found.note ?? `${found.pages.length} pages`}`);
    output.show(true);
    refresh();

    void vscode.window.showInformationMessage(
      `Temco Knowledge: ${source.name} — ${found.note ?? `${found.pages.length} pages read`}.`
    );
  } catch (error) {
    void vscode.window.showErrorMessage(`Temco Knowledge: ${String(error)}`);
  } finally {
    catalog.close();
  }
}

/** A folder on this machine: its registry is a file, so read the file. */
async function readLocal(folder: string): Promise<{
  pages: PageInput[];
  note?: string;
  registryPath?: string;
}> {
  const registry = path.join(folder, ...REGISTRY_TAIL);
  let text: string;
  try {
    text = await fs.readFile(registry, 'utf8');
  } catch {
    return {
      pages: [],
      note: `no ${REGISTRY_TAIL.join('/')} in that folder — its own generator creates one`,
    };
  }
  const parsed = parseRegistry(text, folder);
  return { ...parsed, registryPath: REGISTRY_TAIL.join('/') };
}

/** A repository with no clone: one contents call at the branch that was chosen. */
async function readRemote(
  context: vscode.ExtensionContext,
  remoteUrl: string,
  branch: string | undefined,
  defaultBranch: string | undefined
): Promise<{ pages: PageInput[]; note?: string; registryPath?: string }> {
  const coordinates = coordinatesOf(remoteUrl);
  if (!coordinates) {
    return { pages: [], note: 'that source is not a GitHub repository the contents API can read' };
  }

  const token = await tokenOf(context);
  const ref = branch ?? defaultBranch;
  const url =
    `https://api.github.com/repos/${coordinates.owner}/${coordinates.repo}/contents/${REGISTRY_TAIL.join('/')}` +
    (ref ? `?ref=${encodeURIComponent(ref)}` : '');

  const response = await fetch(url, {
    headers: {
      'user-agent': 'temco-knowledge-extension',
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

  if (response.status === 404) {
    return {
      pages: [],
      note: `no ${REGISTRY_TAIL.join('/')} on ${ref ?? 'the default branch'}`,
    };
  }
  if (response.status === 403) {
    return {
      pages: [],
      note: 'GitHub refused the read — a rate limit, most likely. Set a token and try again',
    };
  }
  if (!response.ok) {
    return { pages: [], note: `GitHub answered ${response.status} ${response.statusText}` };
  }

  const body = (await response.json()) as { content?: string; encoding?: string };
  if (typeof body.content !== 'string') {
    return { pages: [], note: 'GitHub returned no file content for the registry' };
  }
  const text = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
  return { ...parseRegistry(text, undefined), registryPath: REGISTRY_TAIL.join('/') };
}

/**
 * The registry, as the platform reads it: page ids, titles, owners — and the counts a list needs.
 *
 * Deliberately not the full check suite: that belongs to the Content view, which has the working tree and can
 * see whether each page's file exists. A read from here records what the registry *declares*.
 */
function parseRegistry(text: string, folder: string | undefined): { pages: PageInput[]; note?: string } {
  let parsed: { pages?: Record<string, { title?: string; owner?: string }> };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return { pages: [], note: 'the registry is not valid JSON' };
  }

  const declared = parsed.pages ?? {};
  const pages: PageInput[] = Object.entries(declared).map(([id, page]) => ({
    id,
    path: folder === undefined ? `docs/${id}.md` : path.join(folder, 'docs', `${id}.md`),
    title: page?.title,
    owner: page?.owner,
  }));

  return {
    pages,
    note:
      pages.length === 0
        ? 'the registry declares no pages yet'
        : `${pages.length} pages declared${
            pages.some((page) => page.owner === undefined) ? ', some without an owner' : ''
          }`,
  };
}

/** The owner and repository a URL names, whether it is an https clone URL or a web address. */
function coordinatesOf(remoteUrl: string): { owner: string; repo: string } | undefined {
  const match = remoteUrl
    .replace(/\.git$/, '')
    .match(/github\.com[/:]([^/]+)\/([^/]+)$/);
  return match ? { owner: match[1], repo: match[2] } : undefined;
}

/** The token: secret storage first, then the one the `gh` CLI already holds. */
async function tokenOf(context: vscode.ExtensionContext): Promise<string | undefined> {
  const stored = await context.secrets.get(TOKEN_SECRET);
  if (stored && stored.trim().length > 0) {
    return stored.trim();
  }
  return new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
      const token = typeof stdout === 'string' ? stdout.trim() : '';
      resolve(error || token.length === 0 ? undefined : token);
    });
  });
}

async function setToken(context: vscode.ExtensionContext, refresh: () => void): Promise<void> {
  const existing = await context.secrets.get(TOKEN_SECRET);
  const entered = await vscode.window.showInputBox({
    title: 'Temco Knowledge: GitHub token',
    prompt: 'Stored in VS Code secret storage. Reading a repository over the API needs it; a folder does not.',
    password: true,
    ignoreFocusOut: true,
    placeHolder: existing ? '(a token is stored — leave empty to remove it)' : 'github_pat_… or ghp_…',
    value: '',
  });
  if (entered === undefined) {
    return;
  }
  if (entered.trim().length === 0) {
    await context.secrets.delete(TOKEN_SECRET);
  } else {
    await context.secrets.store(TOKEN_SECRET, entered.trim());
  }
  refresh();
}

async function open(context: vscode.ExtensionContext): Promise<Catalog | undefined> {
  try {
    return await Catalog.open(context);
  } catch (error) {
    const message = error instanceof CatalogUnavailable ? error.message : String(error);
    void vscode.window.showErrorMessage(`Temco Knowledge: ${message}`);
    return undefined;
  }
}
