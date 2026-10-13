// The prompts, versioned with the code.
//
// `12-ai-features.md` §5: prompts take commit metadata, paths and documentation text — nothing else. There is
// no repository sweep here, no credential, no customer data, and no way for a page's prose to make the model
// do something to another file. Every answer names the prompt version it came from, so a draft can be traced
// to the instructions that produced it.

/** Bumped whenever the wording below changes, so a draft can be traced to the instructions behind it. */
export const PROMPT_VERSION = 'ai-v1';

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

const HOUSE_RULES = [
  'You help maintain Temco product documentation, which is Markdown with no front matter.',
  'Use ONLY the material given in this conversation. If it does not contain the answer, say so plainly.',
  'Never invent an API, a setting, a screen label, a version number or a menu path.',
  'Prefer short, declarative sentences. No marketing language, no hedging.',
  'The pages are hard-wrapped; keep the existing line breaks and structure when you propose text.',
];

export function systemPrompt(page: PageContext | undefined): string {
  const lines = [...HOUSE_RULES];
  if (page) {
    lines.push(
      `The page in front of the user is "${page.title}" (id ${page.id}, area ${page.area}, owner ${page.owner || 'unknown'}).`,
      `Its last change was ${page.updated ?? 'unknown'}, its last human review ${page.reviewed ?? 'never'}.`
    );
    if (page.stale) {
      lines.push(
        'This page is flagged stale: the code it documents changed after that review. Say so when it matters.'
      );
    }
  } else {
    lines.push('No page is open, so answer from general knowledge of Markdown and documentation practice only.');
  }
  return lines.join('\n');
}

/** A question about the page on screen. */
export function askPrompt(question: string, page: PageContext | undefined): string {
  return [
    page ? `# Page: ${page.path}\n\n${page.body}` : '# Page\n\n(none is open)',
    '',
    '# Question',
    '',
    question,
    '',
    page
      ? 'Answer in a few sentences. If the page does not answer it, say which page or section would.'
      : 'Answer in a few sentences.',
  ].join('\n');
}

/**
 * A proposed update to the whole page.
 *
 * The whole page, not a fragment: a diff is what a maintainer reviews, and a partial answer would leave the
 * reviewer reconciling two documents by hand.
 */
export function draftPrompt(page: PageContext, changes: string): string {
  return [
    `# Page: ${page.path}`,
    '',
    `Title: ${page.title}`,
    `Area and chapter: ${page.area} / ${page.chapter}`,
    `Headings: ${page.headings.join(' · ') || '(none)'}`,
    `Last change: ${page.updated ?? 'unknown'} · last review: ${page.reviewed ?? 'never'}`,
    '',
    '# What changed in the code',
    '',
    changes,
    '',
    '# The page as it stands',
    '',
    page.body,
    '',
    '# What to return',
    '',
    'Return the complete new text of the page, and nothing else: no explanation, no code fence around it,',
    'no front matter. Keep every heading, table and line break that does not have to change, and change only',
    'what the code change requires.',
  ].join('\n');
}

/** A question that spans the pages of one area. */
export function areaPrompt(
  question: string,
  page: PageContext | undefined,
  candidates: readonly Candidate[]
): string {
  const list = candidates
    .map((candidate) => `- ${candidate.id} — ${candidate.title}${candidate.headings.length ? `: ${candidate.headings.join(', ')}` : ''}`)
    .join('\n');
  return [
    page ? `# The page on screen\n\n${page.path}\n\n${page.body}` : '# The page on screen\n\n(none is open)',
    '',
    '# Other pages in this documentation set',
    '',
    list || '(none)',
    '',
    '# Question',
    '',
    question,
    '',
    '# What to return',
    '',
    'Answer in a few sentences, and name the page ids you used, like `t3000/features/trendlogs`.',
    'If the pages you were given cannot answer it, say which page ids should be looked at instead.',
  ].join('\n');
}
