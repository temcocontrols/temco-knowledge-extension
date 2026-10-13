// What changed, according to git.
//
// The draft's input is commit metadata and file paths — never file contents (`12-ai-features.md` §1). This
// reads the range that matters for one page: the commits that touched the code the page claims, since the page
// was last reviewed. When a page claims no code — which is every page until the product repo fills the globs —
// it falls back to recent commits anywhere, and says so rather than pretending to be precise.

import { execFile } from 'child_process';
import { DocsRoot, PageEntry } from '../registry';

/** The most commits one draft may carry: enough for a month of work, small enough to stay cheap. */
const MAX_COMMITS = 40;
/** Files listed per commit before the rest are counted instead. */
const MAX_FILES = 12;
/** A separator that cannot occur in a commit subject. */
const FIELD = '\u0001';

export interface ChangeRange {
  /** How many commits the range holds; `0` means there was nothing to read. */
  commits: number;
  /** One line naming the range, so a draft can be traced to what it was given. */
  label: string;
  /** The commit list as the prompt receives it. */
  text: string;
}

/**
 * Reads the range for one page. Never throws: a repository without git, or a range with no commits, is a fact
 * to report, not a reason to leave the maintainer without a draft.
 */
export async function readChangeRange(root: DocsRoot, page: PageEntry): Promise<ChangeRange> {
  const since = page.reviewed ?? page.provenance?.updated ?? undefined;
  const globs = page.provenance?.code ?? [];
  const scope =
    globs.length > 0
      ? `touching ${globs.join(', ')}`
      : 'anywhere in the repository — this page declares no `code` globs';

  const args = [
    'log',
    '--no-merges',
    `-n ${MAX_COMMITS}`,
    '--date=short',
    `--format=${['%h', '%ad', '%an', '%s'].join(FIELD)}`,
    '--name-only',
  ];
  if (since) {
    args.push(`--since=${since}`);
  }
  if (globs.length > 0) {
    args.push('--', ...globs);
  }

  let output: string;
  try {
    output = await run(args, root.folder.uri.fsPath);
  } catch (error) {
    return {
      commits: 0,
      label: `no range — ${messageOf(error)}`,
      text: '(the change history could not be read)',
    };
  }

  const commits = parse(output);
  if (commits.length === 0) {
    return {
      commits: 0,
      label: `no commits ${since ? `since ${since} ` : ''}${scope}`,
      text: '(nothing has changed in that range)',
    };
  }

  return {
    commits: commits.length,
    label: `${commits.length} commit${commits.length === 1 ? '' : 's'}${since ? ` since ${since}` : ''}, ${scope}`,
    text: commits.map(describe).join('\n'),
  };
}

interface Commit {
  sha: string;
  date: string;
  author: string;
  subject: string;
  files: string[];
}

/** Splits `git log --name-only` output, whose blocks are a header line followed by paths. */
function parse(output: string): Commit[] {
  const commits: Commit[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const fields = line.split(FIELD);
    if (fields.length >= 4) {
      commits.push({
        sha: fields[0],
        date: fields[1],
        author: fields[2],
        subject: fields.slice(3).join(FIELD),
        files: [],
      });
      continue;
    }
    commits[commits.length - 1]?.files.push(line);
  }
  return commits;
}

function describe(commit: Commit): string {
  const shown = commit.files.slice(0, MAX_FILES);
  const more = commit.files.length - shown.length;
  const files = shown.length > 0 ? `\n  files: ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}` : '';
  return `- ${commit.sha} ${commit.date} ${commit.author}: ${commit.subject}${files}`;
}

function run(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
