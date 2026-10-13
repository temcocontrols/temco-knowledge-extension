// Feedback about a page, routed to whoever owns it.
//
// `09-feedback-subscriptions-notifications.md` was written against an endpoint on the T3000 server plus database
// tables, and `16-management-overview.md` supersedes that hosting model — the platform is a standalone
// application now. So where a row comes *from* was never settled, and this is the smallest shape that carries
// what routing needs: a page, a kind, a note, a date, a state.
//
// **That shape is a proposal, not a fact** (recorded in `docs/plan.md` for the docs owner to accept or replace).
// With no such file in any open repository, the command says so plainly rather than reporting "no feedback".

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DocsRoot, PageEntry, collectPages } from './registry';

/** Where a repository would keep its rows, if the shape below is accepted. */
const FEEDBACK_FILE = ['docs', 'help', 'feedback.json'];
/** Older than this and a row gets its own section, without anyone having to search for it. */
const AGING_DAYS = 30;

interface RawRow {
  page?: string;
  kind?: string;
  note?: string;
  at?: string;
  state?: string;
  by?: string;
}

interface FeedbackFile {
  version?: number;
  rows?: RawRow[];
}

interface Routed {
  repository: string;
  page: string;
  title: string;
  owner: string;
  kind: string;
  note: string;
  at?: string;
  days?: number;
  handled: boolean;
  /** The page's file, when a page with that id exists — what the link in the report points at. */
  uri?: vscode.Uri;
}

export function registerFeedbackCommands(
  context: vscode.ExtensionContext,
  roots: () => readonly DocsRoot[]
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.feedback', () => show(roots()))
  );
}

async function show(roots: readonly DocsRoot[]): Promise<void> {
  const { rows, files, problems } = read(roots);

  for (const problem of problems) {
    void vscode.window.showWarningMessage(`Temco Knowledge: ${problem}`);
  }

  if (files.length === 0) {
    void vscode.window.showInformationMessage(
      'Temco Knowledge: no open repository has docs/help/feedback.json. Where a feedback row comes from is not ' +
        'settled yet — docs/plan.md records the shape this command would read.'
    );
    return;
  }

  const document = await vscode.workspace.openTextDocument({ content: render(rows, files), language: 'markdown' });
  await vscode.window.showTextDocument(document, { preview: false });
  const open = rows.filter((row) => !row.handled);
  const old = open.filter((row) => (row.days ?? 0) > AGING_DAYS);
  void vscode.window.showInformationMessage(
    `Temco Knowledge: ${open.length} open row(s)${old.length > 0 ? `, ${old.length} waiting over ${AGING_DAYS} days` : ''}.`
  );
}

function read(roots: readonly DocsRoot[]): { rows: Routed[]; files: string[]; problems: string[] } {
  const rows: Routed[] = [];
  const files: string[] = [];
  const problems: string[] = [];

  for (const root of roots) {
    const file = path.join(root.folder.uri.fsPath, ...FEEDBACK_FILE);
    if (!fs.existsSync(file)) {
      continue;
    }
    files.push(vscode.workspace.asRelativePath(file));

    let parsed: FeedbackFile;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as FeedbackFile;
    } catch (error) {
      problems.push(`${vscode.workspace.asRelativePath(file)} could not be read (${messageOf(error)})`);
      continue;
    }

    const pages = collectPages(root);
    for (const raw of parsed.rows ?? []) {
      const id = (raw.page ?? '').trim();
      if (id.length === 0) {
        problems.push(`${vscode.workspace.asRelativePath(file)} has a row without a page`);
        continue;
      }
      const page = pages.find((candidate) => candidate.id === id);
      const days = age(raw.at);
      rows.push({
        repository: root.folder.name,
        page: id,
        title: page?.title ?? id,
        owner: page ? ownerOf(page) : '(no page with that id)',
        kind: (raw.kind ?? 'note').trim(),
        note: (raw.note ?? '').trim(),
        at: raw.at,
        days,
        handled: (raw.state ?? 'open').toLowerCase() !== 'open',
        uri: page?.uri,
      });
    }
  }

  return {
    rows: rows.sort((a, b) => (b.days ?? -1) - (a.days ?? -1) || a.page.localeCompare(b.page)),
    files,
    problems,
  };
}

function render(rows: readonly Routed[], files: readonly string[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const open = rows.filter((row) => !row.handled);
  const handled = rows.length - open.length;
  const aged = open.filter((row) => (row.days ?? 0) > AGING_DAYS);
  const lines: string[] = [
    `# Feedback by owner — ${date}`,
    '',
    `${open.length} open row(s) from ${files.length} file(s) · ${aged.length} waiting over ${AGING_DAYS} days · ` +
      `${handled} handled`,
    '',
  ];

  if (rows.length === 0) {
    lines.push('_The file is there, but it carries no rows._', '');
    return lines.join('\n');
  }

  if (aged.length > 0) {
    lines.push(`## Waiting over ${AGING_DAYS} days`, '', '| owner | page | kind | waiting | note |', '|---|---|---|---:|---|');
    for (const row of aged) {
      lines.push(`| ${row.owner} | ${titleCell(row)} | ${row.kind} | ${row.days} days | ${row.note} |`);
    }
    lines.push('');
  }

  const byOwner = new Map<string, Routed[]>();
  for (const row of open) {
    byOwner.set(row.owner, [...(byOwner.get(row.owner) ?? []), row]);
  }
  if (byOwner.size > 0) {
    lines.push('## Open, by owner', '');
    for (const [owner, owned] of [...byOwner].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`### ${owner} — ${owned.length}`, '', '| page | kind | waiting | note |', '|---|---|---:|---|');
      for (const row of owned) {
        const waiting = row.days === undefined ? 'unknown' : `${row.days} days`;
        lines.push(`| ${titleCell(row)} | ${row.kind} | ${waiting} | ${row.note} |`);
      }
      lines.push('');
    }
  } else {
    lines.push('_Nothing is open._', '');
  }

  if (handled > 0) {
    lines.push(`_${handled} row(s) are already handled._`, '');
  }
  lines.push('---', '', `Read from ${files.join(', ')}. Nothing was written.`);
  return lines.join('\n');
}

/**
 * The page as a link when it exists, and as plain text when it does not.
 *
 * A row can name a page that is not in the registry — that is a finding, not a reason to render a broken link.
 */
function titleCell(row: Routed): string {
  return row.uri ? `[${row.title}](${row.uri.toString()})` : `${row.title} _(id: \`${row.page}\`)_`;
}

function ownerOf(page: PageEntry): string {
  return page.owner.trim().length > 0 ? page.owner.trim() : '(no owner)';
}

function age(at: string | undefined): number | undefined {
  if (!at) {
    return undefined;
  }
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? undefined : Math.round((Date.now() - parsed) / 86_400_000);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
