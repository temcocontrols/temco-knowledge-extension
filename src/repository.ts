// The repository side of a source: the organisation's list, and the code files inside one repository.
//
// `src/read.ts` reads a source's **documentation** — its registry, and the pages that registry declares. This
// reads what a repository is *besides* its documentation: which repositories an organisation holds, which code
// files one of them carries, and what is in one of those files. Drafting a page from a class needs exactly
// that, and nothing more: one file's text, chosen by a person.
//
// Two ways in, because a source is one of two things. A **folder** on this machine is read from the disk, with
// no network at all. A **repository with no clone** goes through the contents API at the branch that was chosen,
// with the token `src/read.ts` already knows how to find. A source that is neither says so instead of failing
// halfway through.
//
// Everything here is a read. Nothing in this file writes anywhere.

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { coordinatesOf, tokenOf } from './read';

/** What "from a class" may offer: code, in the extensions a documentation page is written from. */
const CODE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.ino',
  '.cs', '.ts', '.tsx', '.js', '.jsx', '.py', '.java', '.kt', '.go', '.rs',
  '.swift', '.m', '.mm', '.sql', '.ps1', '.sh', '.xaml',
]);

/** Folders that are generated, vendored or enormous — never offered as material. */
const NOT_CODE = /(^|[\\/])(node_modules|out|dist|build|bin|obj|\.git|vendor|third_party|__pycache__|coverage)([\\/]|$)/i;

/** How much of one file may be given to the model. A class header fits; a generated 2 MB file does not. */
const MATERIAL_LIMIT = 12_000;
/** How many files are offered to pick from, so the list stays a list. */
const FILE_LIMIT = 2_000;

/** One row of the organisation's list. */
export interface RepositoryRow {
  name: string;
  fullName: string;
  description: string;
  language: string;
  pushedAt: string;
  isPrivate: boolean;
  webUrl: string;
  cloneUrl: string;
  defaultBranch: string;
}

/** A source, as the catalog records it — enough to find its files, on disk or through the API. */
export interface RepositorySource {
  name: string;
  path?: string;
  remoteUrl?: string;
  branch?: string;
  defaultBranch?: string;
}

/**
 * The organisation's repositories, most recently pushed first.
 *
 * A private repository needs the token; a public one does not, and GitHub's own rate limit is the only other
 * thing that can refuse. Every refusal is returned as a sentence to show, never as a thrown error: this page is
 * one click away from a person who cannot see the network.
 */
export async function listRepositories(
  context: vscode.ExtensionContext,
  org: string
): Promise<{ repositories: RepositoryRow[]; truncated: boolean } | { error: string }> {
  const token = await tokenOf(context);
  const query = 'per_page=100&sort=pushed&direction=desc';
  const headers = requestHeaders(token);

  let response = await get(`https://api.github.com/orgs/${encodeURIComponent(org)}/repos?${query}`, headers);
  if ('error' in response) {
    return response;
  }
  if (response.status === 404) {
    // An account that is not an organisation answers on the user endpoint, and that is still the list to show.
    response = await get(`https://api.github.com/users/${encodeURIComponent(org)}/repos?${query}`, headers);
    if ('error' in response) {
      return response;
    }
  }
  if (response.status === 401 || response.status === 403) {
    return {
      error:
        'GitHub refused the list — a rate limit, or a token without access to this organisation. ' +
        'Set a token (Temco Knowledge: Set a GitHub Token) and open the page again.',
    };
  }
  if (response.status === 404) {
    return { error: `GitHub has no organisation or account called “${org}”.` };
  }
  if (!response.ok) {
    return { error: `GitHub answered ${response.status} ${response.statusText}.` };
  }

  const body = (await response.json()) as unknown;
  if (!Array.isArray(body)) {
    return { error: 'GitHub returned something that is not a list of repositories.' };
  }

  const repositories = body.map((entry) => rowOf(entry)).filter((row): row is RepositoryRow => row !== undefined);
  return { repositories, truncated: repositories.length >= 100 };
}

/** The code files a source carries, relative to its own root. */
export async function codeFiles(
  context: vscode.ExtensionContext,
  source: RepositorySource
): Promise<{ files: string[]; note?: string }> {
  if (source.path !== undefined && source.path.length > 0) {
    return localCodeFiles(source.path);
  }
  const coordinates = source.remoteUrl !== undefined ? coordinatesOf(source.remoteUrl) : undefined;
  if (!coordinates) {
    return {
      files: [],
      note:
        'this source is neither a folder on this machine nor a GitHub repository, so its files cannot be listed',
    };
  }

  const token = await tokenOf(context);
  const ref = encodeURIComponent(source.branch ?? source.defaultBranch ?? 'HEAD');
  const response = await get(
    `https://api.github.com/repos/${coordinates.owner}/${coordinates.repo}/git/trees/${ref}?recursive=1`,
    requestHeaders(token)
  );
  if ('error' in response) {
    return { files: [], note: response.error };
  }
  if (!response.ok) {
    return { files: [], note: `GitHub answered ${response.status} ${response.statusText} for the file list` };
  }

  const body = (await response.json()) as { tree?: { path?: string; type?: string }[] };
  const found = (body.tree ?? [])
    .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string' && isCode(entry.path))
    .map((entry) => entry.path as string)
    .sort();

  return {
    files: found.slice(0, FILE_LIMIT),
    note: found.length > FILE_LIMIT ? `the first ${FILE_LIMIT} of ${found.length} files` : undefined,
  };
}

/** One file's text, for the model to draft from. Truncated, and it says so rather than pretending. */
export async function readCodeFile(
  context: vscode.ExtensionContext,
  source: RepositorySource,
  file: string
): Promise<{ text: string } | { error: string }> {
  let text: string | undefined;

  if (source.path !== undefined && source.path.length > 0) {
    try {
      text = await fs.readFile(path.join(source.path, ...file.split('/')), 'utf8');
    } catch (error) {
      return { error: `${file} could not be read: ${reason(error)}` };
    }
  } else {
    const coordinates = source.remoteUrl !== undefined ? coordinatesOf(source.remoteUrl) : undefined;
    if (!coordinates) {
      return { error: 'this source has no files that can be read from here' };
    }
    const token = await tokenOf(context);
    const ref = source.branch ?? source.defaultBranch;
    const response = await get(
      `https://api.github.com/repos/${coordinates.owner}/${coordinates.repo}/contents/${file}` +
        (ref ? `?ref=${encodeURIComponent(ref)}` : ''),
      requestHeaders(token)
    );
    if ('error' in response) {
      return { error: response.error };
    }
    if (!response.ok) {
      return { error: `GitHub answered ${response.status} ${response.statusText} for ${file}` };
    }
    const body = (await response.json()) as { content?: string; encoding?: string };
    if (typeof body.content !== 'string') {
      return { error: `GitHub returned no content for ${file}` };
    }
    text = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
  }

  if (text.length > MATERIAL_LIMIT) {
    return {
      text:
        `${text.slice(0, MATERIAL_LIMIT)}\n\n… the file continues for ${text.length - MATERIAL_LIMIT} more ` +
        'characters, which were not given to the model …',
    };
  }
  return { text };
}

// ------------------------------------------------------------------ the two ways in

async function localCodeFiles(folder: string): Promise<{ files: string[]; note?: string }> {
  let found: vscode.Uri[];
  try {
    found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(vscode.Uri.file(folder), '**/*'),
      '**/{node_modules,out,dist,build,bin,obj,.git,vendor,third_party,__pycache__,coverage}/**',
      FILE_LIMIT * 2
    );
  } catch (error) {
    return { files: [], note: `${folder} could not be searched: ${reason(error)}` };
  }

  const files = found
    .map((uri) => path.relative(folder, uri.fsPath).split(path.sep).join('/'))
    .filter((file) => isCode(file))
    .sort();

  return {
    files: files.slice(0, FILE_LIMIT),
    note: files.length > FILE_LIMIT ? `the first ${FILE_LIMIT} of ${files.length} files` : undefined,
  };
}

async function get(url: string, headers: Record<string, string>): Promise<Response | { error: string }> {
  try {
    return await fetch(url, { headers });
  } catch (error) {
    return { error: `GitHub could not be reached: ${reason(error)}` };
  }
}

function requestHeaders(token: string | undefined): Record<string, string> {
  return {
    'user-agent': 'temco-knowledge-extension',
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function rowOf(entry: unknown): RepositoryRow | undefined {
  const raw = entry as {
    name?: unknown;
    full_name?: unknown;
    description?: unknown;
    language?: unknown;
    pushed_at?: unknown;
    private?: unknown;
    html_url?: unknown;
    clone_url?: unknown;
    default_branch?: unknown;
  };
  if (typeof raw.name !== 'string') {
    return undefined;
  }
  return {
    name: raw.name,
    fullName: typeof raw.full_name === 'string' ? raw.full_name : raw.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    language: typeof raw.language === 'string' ? raw.language : '',
    pushedAt: typeof raw.pushed_at === 'string' ? raw.pushed_at.slice(0, 10) : '',
    isPrivate: raw.private === true,
    webUrl: typeof raw.html_url === 'string' ? raw.html_url : `https://github.com/${raw.full_name ?? raw.name}`,
    cloneUrl: typeof raw.clone_url === 'string' ? raw.clone_url : '',
    defaultBranch: typeof raw.default_branch === 'string' ? raw.default_branch : '',
  };
}

/** A file a page could be written from: code by extension, and never something generated or vendored. */
function isCode(file: string): boolean {
  if (NOT_CODE.test(file)) {
    return false;
  }
  const dot = file.lastIndexOf('.');
  return dot >= 0 && CODE_EXTENSIONS.has(file.slice(dot).toLowerCase());
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
