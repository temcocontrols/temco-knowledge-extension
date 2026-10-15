// The prompts, as files the repository reviews and the extension ships.
//
// `12-ai-features.md` §5: prompts take commit metadata, paths and documentation text — nothing else. There is
// no repository sweep here, no credential, no customer data, and no way for a page's prose to make the model
// do something to another file. The wording lives in `prompts/*.md` so it is reviewable as text and diffs as
// text; every answer names the version below, so a draft can be traced to the instructions behind it.

import * as fs from 'fs';
import * as vscode from 'vscode';

/** Bumped whenever a file under `prompts/` changes, so a draft can be traced to the instructions behind it. */
export const PROMPT_VERSION = 'ai-v4';

const TEMPLATE_FOLDER = 'prompts';
const loaded = new Map<string, string>();

/** The prompt text, read once. A missing file is a packaging bug, and says so in those words. */
function template(context: vscode.ExtensionContext, name: string): string {
  const cached = loaded.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const file = vscode.Uri.joinPath(context.extensionUri, TEMPLATE_FOLDER, `${name}.md`).fsPath;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `The instructions at prompts/${name}.md are missing from the extension. Reinstall it (or the .vsix) and try again.`
    );
  }
  loaded.set(name, text);
  return text;
}

/** `{{placeholder}}` substitution. An unknown placeholder is left visible rather than silently blanked. */
function fill(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole: string, key: string) => values[key] ?? whole);
}

/** Everything a prompt is allowed to see about the page in front of the user. */
export interface PageContext {
  id: string;
  title: string;
  path: string;
  area: string;
  chapter: string;
  owner: string;
  audience: string;
  reviewed: string | null;
  updated: string | null;
  stale: boolean;
  headings: string[];
  /** Set when the page was too large to send whole, so nothing may be drafted from it. */
  truncated: boolean;
  body: string;
}

/** A page the question might be about — title and headings only, so the candidate list stays small. */
export interface Candidate {
  id: string;
  title: string;
  headings: string[];
  /** The generator's verdict: the code this page documents moved on after its last review. */
  stale: boolean;
}

/** The lines the system prompt adds about the page, or about there being none. */
function pageLines(page: PageContext | undefined): string {
  if (!page) {
    return 'No page is open, so answer from general knowledge of Markdown and documentation practice only.';
  }
  const lines = [
    `The page in front of the user is "${page.title}" (id ${page.id}, area ${page.area}, owner ${page.owner || 'unknown'}).`,
    `Its last change was ${page.updated ?? 'unknown'}, its last human review ${page.reviewed ?? 'never'}.`,
  ];
  if (page.stale) {
    lines.push(
      'This page is flagged stale: the code it documents changed after that review. Say so when it matters.'
    );
  }
  return lines.join('\n');
}

function facts(page: PageContext): Record<string, string> {
  return {
    path: page.path,
    title: page.title,
    area: page.area,
    chapter: page.chapter,
    headings: page.headings.join(' · ') || '(none)',
    updated: page.updated ?? 'unknown',
    reviewed: page.reviewed ?? 'never',
    body: page.body.trim(),
  };
}

export function systemPrompt(context: vscode.ExtensionContext, page: PageContext | undefined): string {
  return fill(template(context, 'system'), { page: pageLines(page) });
}

/** A question about the page on screen. */
export function askPrompt(
  context: vscode.ExtensionContext,
  question: string,
  page: PageContext | undefined
): string {
  return fill(template(context, 'ask'), {
    path: page?.path ?? '(no page is open)',
    body: page?.body.trim() ?? '',
    question,
    closing: page
      ? 'Answer in a few sentences. If the page does not answer it, say which page or section would.'
      : 'Answer in a few sentences.',
  });
}

/**
 * A proposed update to the whole page, against the commits that prompted it.
 *
 * The whole page, not a fragment: a diff is what a maintainer reviews, and a partial answer would leave the
 * reviewer reconciling two documents by hand.
 */
export function draftPrompt(
  context: vscode.ExtensionContext,
  page: PageContext,
  changes: string,
  note: string
): string {
  const what = note.trim().length > 0 ? `${changes}\n\n# What the maintainer says\n\n${note.trim()}` : changes;
  return fill(template(context, 'draft'), { ...facts(page), changes: what });
}

/**
 * A first draft of a **new** page, from material a person chose.
 *
 * This is the one prompt whose material may be a code file rather than documentation — the case where the page
 * being written *is* about that file. The person picked it, the page shows the draft, and nothing is written
 * until they accept it; that is what keeps this inside `12-ai-features.md`'s rule that the model makes the
 * human's edit smaller rather than publishing on its own.
 */
export function newPagePrompt(
  context: vscode.ExtensionContext,
  page: { title: string; kind: string; headings: readonly string[]; path: string; area: string; material: string }
): string {
  return fill(template(context, 'newpage'), {
    title: page.title,
    kind: page.kind,
    headings: page.headings.join(' · ') || '(none)',
    path: page.path,
    area: page.area.trim() || '(this is the first page here)',
    material: page.material.trim() || '(nothing was chosen)',
  });
}

/**
 * What documentation a repository is missing.
 *
 * The material is file **paths** and the titles of the pages that already exist — never file contents, so the
 * model cannot describe what it has not read; that is the next step, and it happens in `newpage.md` after a
 * person has chosen which files a page is written from.
 */
export function analysePrompt(
  context: vscode.ExtensionContext,
  source: { name: string; files: readonly string[]; pages: readonly string[]; note: string }
): string {
  return fill(template(context, 'analyse'), {
    source: source.name,
    count: String(source.files.length),
    files: source.files.length === 0 ? '(no files were listed)' : source.files.join('\n'),
    pages: source.pages.length === 0 ? '(none yet)' : source.pages.map((page) => `- ${page}`).join('\n'),
    note: source.note.trim() || '(nothing more)',
  });
}

/** A question that spans the pages of one area. */
export function areaPrompt(
  context: vscode.ExtensionContext,
  question: string,
  page: PageContext | undefined,
  candidates: readonly Candidate[]
): string {
  const list = candidates
    .map(
      (candidate) =>
        `- ${candidate.id} — ${candidate.title}${candidate.stale ? ' (stale)' : ''}${
          candidate.headings.length ? `: ${candidate.headings.join(', ')}` : ''
        }`
    )
    .join('\n');
  return fill(template(context, 'area'), {
    path: page?.path ?? '(no page is open)',
    body: page?.body.trim() ?? '',
    candidates: list || '(none)',
    question,
  });
}
