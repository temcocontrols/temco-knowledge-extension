// What is owed, grouped by the person who owes it.
//
// `11-review-and-cicd.md` §2: a staleness report, grouped by owner, that needs no interpretation to act on. It is
// produced here from the folders you have open — the only source that can see whether a page's file exists and
// what its structural faults are — and it is written as Markdown so it can be read, kept, or sent as it is.
//
// One thing it deliberately does not do: list every page that has never been reviewed. In a registry this size
// that is nearly every page, and it would bury the handful that need work — the counts are at the top instead
// (`docs/registry-schema.md`: counts are not problems).

import * as vscode from 'vscode';
import { DocsRoot, PageEntry, collectPages, countStale } from './registry';
import { ageInDays, ageText } from './registry';

/** A page that needs attention, and the reasons in the words of the fix. */
interface Owed {
  page: PageEntry;
  why: string[];
  rank: number;
}

export function registerReportCommands(
  context: vscode.ExtensionContext,
  roots: () => readonly DocsRoot[]
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.stalenessReport', () => write(roots()))
  );
}

async function write(roots: readonly DocsRoot[]): Promise<void> {
  if (roots.length === 0) {
    void vscode.window.showWarningMessage(
      'Temco Knowledge: open a repository that has docs/help/registry.json first.'
    );
    return;
  }
  // An untitled document, so producing a report never writes anything anywhere: saving it is the reader's act.
  const document = await vscode.workspace.openTextDocument({
    content: render(roots),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(document, { preview: false });
  const answer = await vscode.window.showInformationMessage(
    `Temco Knowledge: ${owedIn(roots)} page(s) need attention.`,
    'Preview'
  );
  if (answer === 'Preview') {
    await vscode.commands.executeCommand('markdown.showPreview', document.uri);
  }
}

/** The pages that need work, across every open repository: stale, faulty, or both. */
function owedIn(roots: readonly DocsRoot[]): number {
  return roots.reduce((total, root) => total + collect(root).length, 0);
}

function collect(root: DocsRoot): Owed[] {
  const owed: Owed[] = [];
  for (const page of collectPages(root)) {
    const why: string[] = [];
    let rank = 3;
    if (page.provenance?.stale === true) {
      why.push('stale — a commit touched the code this page claims, after its last review');
      rank = 0;
    }
    for (const issue of page.issues) {
      why.push(issue.message);
      rank = Math.min(rank, issue.severity === 'error' ? 1 : 2);
    }
    if (why.length === 0) {
      continue;
    }
    // How old a page is does not make it wrong — but it is what the owner needs in order to judge it, so it
    // rides along on the pages that are already listed instead of being a reason to list one.
    const age = ageInDays(page.provenance?.updated);
    if (age !== undefined) {
      why.push(`last change ${ageText(age)} ago`);
    }
    owed.push({ page, why, rank });
  }
  return owed.sort((a, b) => a.rank - b.rank || a.page.title.localeCompare(b.page.title));
}

/** The owner a page is answerable to, with the placeholder named as what it is. */
function ownerName(page: PageEntry): string {
  return page.owner.trim().length > 0 ? page.owner.trim() : '(no owner)';
}

interface OwnerTally {
  pages: number;
  neverReviewed: number;
  stale: number;
}

/**
 * Per owner: how many pages, how many stale, how many never reviewed.
 *
 * Counts, not lists. A registry of this size has hundreds of pages that were never reviewed, and printing them
 * would bury the handful with a real fault — the same reason the tree reports them as a count.
 */
function tally(root: DocsRoot): Map<string, OwnerTally> {
  const map = new Map<string, OwnerTally>();
  for (const page of collectPages(root)) {
    const owner = ownerName(page);
    const entry = map.get(owner) ?? { pages: 0, neverReviewed: 0, stale: 0 };
    entry.pages++;
    if (!page.reviewed) {
      entry.neverReviewed++;
    }
    if (page.provenance?.stale === true) {
      entry.stale++;
    }
    map.set(owner, entry);
  }
  return map;
}

function render(roots: readonly DocsRoot[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`# Documentation owed — ${date}`, ''];

  const pages = roots.reduce((sum, root) => sum + root.pages, 0);
  const neverReviewed = roots.reduce((sum, root) => sum + root.neverReviewed, 0);
  const unshipped = roots.reduce((sum, root) => sum + root.unshipped, 0);
  lines.push(
    `${pages} pages in ${roots.length} repository${roots.length === 1 ? '' : 'ies'} · ` +
      `**${owedIn(roots)} need attention** · ${neverReviewed} have never been reviewed · ${unshipped} do not ship`,
    ''
  );
  lines.push(
    '_Pages that have never been reviewed are counted rather than listed: in a registry this size they would ' +
      'bury the pages that need work._',
    ''
  );

  for (const root of roots) {
    const entries = collect(root);
    const stale = countStale(collectPages(root));
    lines.push(`## ${root.folder.name}`, '');
    lines.push(
      `${root.pages} pages · ${root.errors} errors · ${root.warnings} warnings · ${stale} stale · ` +
        `${root.neverReviewed} never reviewed`,
      ''
    );

    if (entries.length === 0) {
      lines.push('_Nothing needs attention._', '');
      continue;
    }

    const byOwner = new Map<string, Owed[]>();
    for (const entry of entries) {
      const owner = ownerName(entry.page);
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), entry]);
    }

    const counts = tally(root);
    for (const [owner, owned] of [...byOwner].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`### ${owner} — ${owned.length} page${owned.length === 1 ? '' : 's'}`, '');
      const total = counts.get(owner);
      if (total) {
        lines.push(
          `_${total.pages} page${total.pages === 1 ? '' : 's'} owned here · ${total.stale} stale · ` +
            `${total.neverReviewed} never reviewed_`,
          ''
        );
      }
      for (const entry of owned) {
        lines.push(`- [${entry.page.title}](${entry.page.uri.toString()}) — ${entry.why.join(' · ')}`);
      }
      lines.push('');
    }
  }

  lines.push('---', '', 'Made by Temco Knowledge from the folders that were open. Nothing was written or sent.');
  return lines.join('\n');
}
