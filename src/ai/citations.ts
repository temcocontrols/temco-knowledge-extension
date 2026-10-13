// Citations: what an answer points at, and whether those pages exist.
//
// `12-ai-features.md` §4: an answer is a short statement plus the pages it used, and a low-confidence answer is
// search results rather than a synthesis. A small local model sometimes names a page that does not exist, or
// names none at all — both are made visible here instead of being smoothed over.

import { PageEntry } from '../registry';

/** An id-shaped token: at least one slash, nothing word-like on either side. */
const ID = /(?<![\w./-])([A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+)(?![\w./-])/g;

export interface Citations {
  /** Pages the answer named that really are pages. */
  known: PageEntry[];
  /** Tokens shaped like a page of this documentation set, but not one. */
  unknown: string[];
}

/**
 * Splits what an answer points at into pages that exist and ids that do not.
 *
 * Only id-shaped tokens whose first segment is an area of this documentation set are reported as unknown:
 * `docs/help` in a sentence is not a broken citation.
 */
export function resolveCitations(text: string, pages: readonly PageEntry[]): Citations {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const areas = new Set(pages.map((page) => page.area));
  const known: PageEntry[] = [];
  const unknown: string[] = [];

  for (const match of text.matchAll(ID)) {
    const token = match[1];
    const page = byId.get(token);
    if (page) {
      if (!known.includes(page)) {
        known.push(page);
      }
      continue;
    }
    if (areas.has(token.split('/')[0]) && !unknown.includes(token)) {
      unknown.push(token);
    }
  }
  return { known, unknown };
}

/**
 * The pages whose words match the question.
 *
 * Deliberately plain: term overlap over the title, the headings the generator recorded, the registry's
 * keywords and tags, and the id. No index to build, no model to load, and the same answer every time — which
 * is what the fallback needs to be when the model is the part that was unsure.
 */
export function searchPages(pages: readonly PageEntry[], question: string, limit = 5): PageEntry[] {
  const tokens = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
  if (tokens.length === 0) {
    return [];
  }
  return pages
    .map((page) => ({ page, score: score(page, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.page.title.localeCompare(b.page.title))
    .slice(0, limit)
    .map((entry) => entry.page);
}

function score(page: PageEntry, tokens: readonly string[]): number {
  const title = page.title.toLowerCase();
  const id = page.id.toLowerCase();
  const headings = (page.provenance?.headings ?? []).map((heading) => heading.toLowerCase());
  const keywords = page.keywords.map((keyword) => keyword.toLowerCase());
  const tags = page.tags.map((tag) => tag.toLowerCase());

  let total = 0;
  for (const token of tokens) {
    if (title.includes(token)) {
      total += 4;
    }
    if (keywords.some((keyword) => keyword.includes(token))) {
      total += 3;
    }
    if (headings.some((heading) => heading.includes(token))) {
      total += 2;
    }
    if (tags.some((tag) => tag.includes(token))) {
      total += 2;
    }
    if (id.includes(token)) {
      total += 1;
    }
  }
  return total;
}
