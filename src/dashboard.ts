// The organisation's documentation state, read from GitHub instead of from clones.
//
// `app-layout.md`: three calls per repository — the list, the registry, the last commit touching `docs/` — cached
// for an hour, so a maintainer sees the whole organisation without cloning anything and without a build.
//
// Two boundaries this keeps: it runs only when the command is invoked (no poll, no background refresh), and the
// token lives in secret storage — it is never written to a file, a setting or a log.

import * as https from 'https';
import * as vscode from 'vscode';
import { Registry } from './registry';

const CACHE_KEY = 'temcoKnowledge.dashboard';
const SECRET_KEY = 'temcoKnowledge.githubToken';
const CACHE_MINUTES = 60;
const PER_PAGE = 100;
/** Older than this and a repository's documentation is called stale. */
export const STALE_DAYS = 180;
/** Nothing is endless: an organisation scan stops here and says so. */
const MAX_REPOS = 200;

export interface RepoRow {
  repository: string;
  pages: number;
  owners: string;
  changed: string;
  /** Structural problems found in the registry alone. */
  issues: number;
  state: string[];
  url: string;
}

export interface Skipped {
  repository: string;
  reason: string;
}

export interface Dashboard {
  at: number;
  owner: string;
  rows: RepoRow[];
  skipped: Skipped[];
  /** Set when GitHub stopped the scan part-way, with what it said. */
  limited?: string;
}

export function registerDashboardCommands(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  view: { refresh(): void }
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.dashboard', () => show(context, output, view, false)),
    vscode.commands.registerCommand('temcoKnowledge.dashboardRefresh', () =>
      show(context, output, view, true)
    ),
    vscode.commands.registerCommand('temcoKnowledge.setGithubToken', () => setToken(context))
  );
}

async function show(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  view: { refresh(): void },
  force: boolean
): Promise<void> {
  const owner = vscode.workspace
    .getConfiguration('temcoKnowledge')
    .get<string>('dashboard.owner', 'temcocontrols')
    .trim();
  if (owner.length === 0) {
    void vscode.window.showWarningMessage('Temco Knowledge: set `temcoKnowledge.dashboard.owner` first.');
    return;
  }

  const cached = context.globalState.get<Dashboard>(CACHE_KEY);
  const fresh =
    cached && cached.owner === owner && Date.now() - cached.at < CACHE_MINUTES * 60_000 && !force;
  const dashboard =
    fresh && cached ? cached : await collect(context, output, owner, force ? cached : undefined);

  report(output, dashboard, Boolean(fresh));
  // The view is a rendering of what was just collected, so it follows rather than re-reads.
  view.refresh();
  output.show(true);

  const summary =
    `${dashboard.rows.length} repo(s) with a registry` +
    (dashboard.skipped.length > 0 ? `, ${dashboard.skipped.length} without` : '') +
    (dashboard.limited ? ' · stopped early' : '');
  const answer = await vscode.window.showInformationMessage(
    `Temco Knowledge: ${owner} — ${summary}`,
    'Refresh',
    'Set a GitHub token…',
    'Show the report'
  );
  if (answer === 'Refresh') {
    await vscode.commands.executeCommand('temcoKnowledge.dashboardRefresh');
  } else if (answer === 'Set a GitHub token…') {
    await vscode.commands.executeCommand('temcoKnowledge.setGithubToken');
  } else if (answer === 'Show the report') {
    output.show(true);
  }
}

/** The token, if one has been stored. Without it the scan works, but GitHub allows far fewer calls. */
async function tokenOf(context: vscode.ExtensionContext): Promise<string | undefined> {
  const stored = await context.secrets.get(SECRET_KEY);
  return stored && stored.trim().length > 0 ? stored.trim() : undefined;
}

async function setToken(context: vscode.ExtensionContext): Promise<void> {
  const existing = await tokenOf(context);
  const entered = await vscode.window.showInputBox({
    title: 'Temco Knowledge: GitHub token',
    prompt: 'Stored in VS Code secret storage. A public-only scan needs none; a private repository or a full scan does.',
    password: true,
    ignoreFocusOut: true,
    placeHolder: existing ? '(set — leave empty and confirm to remove it)' : 'github_pat_… or ghp_…',
    value: '',
    validateInput: (value) =>
      value.length > 0 && value.length < 20 ? 'That does not look like a token.' : undefined,
  });
  if (entered === undefined) {
    return;
  }
  if (entered.trim().length === 0) {
    await context.secrets.delete(SECRET_KEY);
    void vscode.window.showInformationMessage('Temco Knowledge: the GitHub token was removed.');
    return;
  }
  await context.secrets.store(SECRET_KEY, entered.trim());
  void vscode.window.showInformationMessage('Temco Knowledge: the GitHub token is stored.');
}

async function collect(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  owner: string,
  fallback: Dashboard | undefined
): Promise<Dashboard> {
  const token = await tokenOf(context);
  output.appendLine('');
  output.appendLine(`Dashboard: reading ${owner} from GitHub${token ? ' (authenticated)' : ' (no token)'}`);
  if (!token) {
    output.appendLine('  no token: GitHub allows 60 calls an hour unauthenticated, which is not a whole scan');
  }

  const rows: RepoRow[] = [];
  const skipped: Skipped[] = [];
  let limited: string | undefined;
  let repositories: string[];
  try {
    repositories = await listRepositories(owner, token);
  } catch (error) {
    output.appendLine(`  could not list repositories: ${messageOf(error)}`);
    // The previous answer is better than none when the network says no.
    return fallback ?? { at: Date.now(), owner, rows, skipped: [{ repository: '*', reason: messageOf(error) }] };
  }

  for (const repository of repositories.slice(0, MAX_REPOS)) {
    try {
      const registry = await registryOf(owner, repository, token);
      if (!registry) {
        skipped.push({ repository, reason: 'no docs/help/registry.json' });
        continue;
      }
      rows.push(await describe(owner, repository, registry, token));
    } catch (error) {
      const reason = messageOf(error);
      if (/rate limit/i.test(reason)) {
        limited = reason;
        break;
      }
      skipped.push({ repository, reason });
    }
  }

  const dashboard: Dashboard = { at: Date.now(), owner, rows, skipped, limited };
  await context.globalState.update(CACHE_KEY, dashboard);
  return dashboard;
}

async function listRepositories(owner: string, token: string | undefined): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= Math.ceil(MAX_REPOS / PER_PAGE); page++) {
    const batch = await get<{ name?: string; archived?: boolean; fork?: boolean }[]>(
      `/orgs/${owner}/repos?per_page=${PER_PAGE}&page=${page}&type=all&sort=pushed`,
      token
    );
    if (!batch) {
      throw new Error(`no organisation named "${owner}", or the token cannot see it`);
    }
    for (const repo of batch) {
      if (repo.name && !repo.archived && !repo.fork) {
        names.push(repo.name);
      }
    }
    if (batch.length < PER_PAGE) {
      break;
    }
  }
  return names;
}

async function registryOf(
  owner: string,
  repository: string,
  token: string | undefined
): Promise<Registry | undefined> {
  const file = await get<{ content?: string; encoding?: string }>(
    `/repos/${owner}/${repository}/contents/docs/help/registry.json`,
    token
  );
  if (!file?.content) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) as Registry;
  } catch {
    throw new Error('the registry is not valid JSON');
  }
}

async function describe(
  owner: string,
  repository: string,
  registry: Registry,
  token: string | undefined
): Promise<RepoRow> {
  const pages = Object.values(registry.pages ?? {});
  const owners = new Set<string>();
  let unowned = 0;
  for (const page of pages) {
    const owner = (page.owner ?? '').trim();
    if (owner.length === 0 || owner === 'docs') {
      unowned++;
    } else {
      owners.add(owner);
    }
  }

  const commits = await get<{ commit?: { committer?: { date?: string }; author?: { date?: string } } }[]>(
    `/repos/${owner}/${repository}/commits?path=docs&per_page=1`,
    token
  );
  const date = commits?.[0]?.commit?.committer?.date ?? commits?.[0]?.commit?.author?.date ?? null;
  const age = date ? Math.round((Date.now() - Date.parse(date)) / 86_400_000) : undefined;

  const issues = remoteIssues(registry);
  const state = stateWords({
    stale: age !== undefined && age > STALE_DAYS,
    unowned: unowned === pages.length && pages.length > 0,
    issues,
  });

  return {
    repository,
    pages: pages.length,
    owners: owners.size > 0 ? [...owners].sort().join(', ') : '—',
    changed: ageText(age),
    issues,
    state,
    url: `https://github.com/${owner}/${repository}`,
  };
}

/**
 * The structural checks that need nothing but the registry itself.
 *
 * Deliberately the same rules the local checks use — a duplicate title, a duplicate order, a page whose id
 * disagrees with its own area and chapter — minus the ones that need the files on disk, which a remote scan
 * cannot make.
 */
function remoteIssues(registry: Registry): number {
  const declared = registry.areas ?? {};
  const pages = registry.pages ?? {};
  const titleOwners = new Map<string, number>();
  const orderOwners = new Map<string, number>();
  let issues = 0;

  for (const [id, page] of Object.entries(pages)) {
    const segments = id.split('/');
    const area = page.area ?? segments[0] ?? '';
    const chapter = page.chapter ?? segments[1] ?? '';
    if (!page.title) {
      issues++;
    }
    if (!declared[area]) {
      issues++;
    }
    if (segments.length < 2 || segments[0] !== area || segments[1] !== chapter) {
      issues++;
    }
    if (page.title) {
      titleOwners.set(page.title.toLowerCase(), (titleOwners.get(page.title.toLowerCase()) ?? 0) + 1);
    }
    if (page.order !== undefined) {
      const key = `${area}/${chapter}#${page.order}`;
      orderOwners.set(key, (orderOwners.get(key) ?? 0) + 1);
    }
  }

  for (const count of titleOwners.values()) {
    issues += count > 1 ? count : 0;
  }
  for (const count of orderOwners.values()) {
    issues += count > 1 ? count : 0;
  }
  return issues;
}

function report(output: vscode.OutputChannel, dashboard: Dashboard, cached: boolean): void {
  const when = new Date(dashboard.at).toLocaleString();
  output.appendLine('');
  output.appendLine(
    `Documentation across ${dashboard.owner} — read ${cached ? 'from the cache' : 'from GitHub'} at ${when}`
  );
  output.appendLine('');
  output.appendLine('  REPOSITORY                     PAGES   OWNER            CHANGED      STATE');
  for (const row of dashboard.rows) {
    output.appendLine(
      `  ${row.repository.padEnd(30).slice(0, 30)} ${String(row.pages).padStart(5)}   ` +
        `${row.owners.padEnd(16).slice(0, 16)} ${row.changed.padEnd(12)} ${row.state.join(', ')}`
    );
  }
  if (dashboard.limited) {
    output.appendLine('');
    output.appendLine(`  Stopped early: ${dashboard.limited}`);
    if (!cached) {
      output.appendLine(`  Store a token with "Temco Knowledge: Set a GitHub Token…" to raise the hourly limit.`);
    }
  }
  if (dashboard.skipped.length > 0) {
    output.appendLine('');
    output.appendLine(`  Without a registry (${dashboard.skipped.length}):`);
    for (const entry of dashboard.skipped.slice(0, 20)) {
      output.appendLine(`    ${entry.repository} — ${entry.reason}`);
    }
  }
}

/**
 * The vocabulary both flavours of the table use, so a row reads the same whether it came from the API or from
 * the folders you have open.
 */
export function stateWords(parts: { stale: boolean; unowned: boolean; issues: number }): string[] {
  const words: string[] = [];
  if (parts.stale) {
    words.push('stale');
  }
  if (parts.unowned) {
    words.push('no owner');
  }
  if (parts.issues > 0) {
    words.push(`${parts.issues} gap${parts.issues === 1 ? '' : 's'}`);
  }
  return words.length > 0 ? words : ['current'];
}

/** How long ago, in the words the mock uses. `undefined` is a fact, not a failure. */
export function ageText(days: number | undefined): string {
  if (days === undefined) {
    return 'unknown';
  }
  if (days < 1) {
    return 'today';
  }
  if (days < 14) {
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (days < 60) {
    return `${Math.round(days / 7)} weeks`;
  }
  if (days < 730) {
    return `${Math.round(days / 30)} months`;
  }
  return `${Math.round(days / 365)} years`;
}

/** One GET against the API, with the limit's own words when it stops us. */
async function get<T>(path: string, token: string | undefined): Promise<T | undefined> {
  const response = await api(path, token);
  if (response.status === 200) {
    return JSON.parse(response.body) as T;
  }
  if (response.status === 404) {
    return undefined;
  }
  if (response.status === 401) {
    throw new Error('GitHub rejected the token (401) — store a new one, or clear it to work unauthenticated');
  }
  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers['x-ratelimit-remaining'];
    const reset = Number(response.headers['x-ratelimit-reset'] ?? 0);
    if (remaining === '0') {
      const minutes = reset > 0 ? Math.max(1, Math.round((reset * 1000 - Date.now()) / 60_000)) : undefined;
      throw new Error(
        `rate limit reached (${response.headers['x-ratelimit-limit'] ?? '?'} calls an hour` +
          `${minutes ? `, resetting in ${minutes} minute(s)` : ''})`
      );
    }
    throw new Error(`GitHub answered 403: ${response.body.slice(0, 200)}`);
  }
  throw new Error(`GitHub answered ${response.status}: ${response.body.slice(0, 200)}`);
}

interface ApiResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function api(path: string, token: string | undefined): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'user-agent': 'temco-knowledge-extension',
      'x-github-api-version': '2022-11-28',
    };
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    const call = https.get({ host: 'api.github.com', path, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body })
      );
      response.on('error', reject);
    });
    call.on('error', reject);
    call.setTimeout(20_000, () => call.destroy(new Error('GitHub did not answer within 20 seconds')));
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
