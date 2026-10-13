// The prompts, as files the repository reviews and the extension ships.
//
// `12-ai-features.md` §5: prompts take commit metadata, paths and documentation text — nothing else. There is
// no repository sweep here, no credential, no customer data, and no way for a page's prose to make the model
// do something to another file. The wording lives in `prompts/*.md` so it is reviewable as text and diffs as
// text; every answer names the version below, so a draft can be traced to the instructions behind it.

import * as fs from 'fs';
import * as vscode from 'vscode';

/** Bumped whenever a file under `prompts/` changes, so a draft can be traced to the instructions behind it. */
export const PROMPT_VERSION = 'ai-v2';

const TEMPLATE_FOLDER = 'prompts';
const loaded = new Map<string, string>();

/** The prompt text, read once. A missing file is a packaging bug and says so. */
function template(context: vscode.ExtensionContext, name: string): string {
  const cached = loaded.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const file = vscode.Uri.joinPath(context.extensionUri, TEMPLATE_FOLDER, `${name}.md`).fsPath;
  const text = fs.readFileSync(file, 'utf8');
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
  body: string;
}

/** A page the question might be about — title and headings only, so the candidate list stays small. */
export interface Candidate {
  id: string;
  title: string;
  headings: string[];
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
        `- ${candidate.id} — ${candidate.title}${candidate.headings.length ? `: ${candidate.headings.join(', ')}` : ''}`
    )
    .join('\n');
  return fill(template(context, 'area'), {
    path: page?.path ?? '(no page is open)',
    body: page?.body.trim() ?? '',
    candidates: list || '(none)',
    question,
  });
}
