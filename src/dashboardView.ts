// The organisation view: one row per repository, and the reasons for the ones that need attention.
//
// Two sources, never mixed. The folders you have open are exact — the same checks the Content view makes,
// including whether a registered page's file exists. The organisation read over the API is a floor, because a
// remote reader cannot see the files. Offline, the first still renders in full and the second says when it was
// last read, so the view is useful with no network at all.

import * as vscode from 'vscode';
import { Dashboard, ageText, stateWords, STALE_DAYS } from './dashboard';
import { DocsRoot, collectPages, countStale } from './registry';

export const DASHBOARD_VIEW_ID = 'temcoKnowledge.dashboard';

const CACHE_KEY = 'temcoKnowledge.dashboard';

interface Row {
  repository: string;
  pages: number;
  owners: string;
  changed: string;
  state: string[];
  /** The lines a maintainer acts on, shown as the row's children. */
  reasons: string[];
  /** Where the row came from — which decides what clicking it does, and how much it can be trusted. */
  local: boolean;
  url?: string;
  folder?: vscode.Uri;
}

class HeaderNode {
  readonly kind = 'header';
  constructor(readonly label: string, readonly note: string, readonly rows: Row[]) {}
}

class RepoNode {
  readonly kind = 'repo';
  constructor(readonly row: Row) {}
}

class ReasonNode {
  readonly kind = 'reason';
  constructor(readonly text: string) {}
}

class NoteNode {
  readonly kind = 'note';
  constructor(readonly text: string, readonly command?: string) {}
}

type Node = HeaderNode | RepoNode | ReasonNode | NoteNode;

export class DashboardView implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly roots: () => readonly DocsRoot[]
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'header': {
        const item = new vscode.TreeItem(
          node.label,
          node.rows.length > 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None
        );
        item.description = node.rows.length > 0 ? `${node.rows.length} repositories` : '';
        item.tooltip = new vscode.MarkdownString(`**${node.label}**\n\n${node.note}`);
        item.iconPath = new vscode.ThemeIcon('organization');
        return item;
      }
      case 'repo': {
        const { row } = node;
        const item = new vscode.TreeItem(
          row.repository,
          row.reasons.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
        );
        const attention = row.state[0] !== 'current';
        item.description = `${row.pages} pages · ${row.changed} · ${row.state.join(', ')}`;
        item.tooltip = new vscode.MarkdownString(
          [
            `**${row.repository}**`,
            '',
            `${row.pages} pages · owner ${row.owners}`,
            `last change: ${row.changed}`,
            `state: ${row.state.join(', ')}`,
            '',
            row.local
              ? '_Measured in the folder you have open, so it can see the files themselves._'
              : '_Read over the GitHub API: registry and last commit only — a floor, not a ceiling._',
          ].join('\n')
        );
        item.iconPath = new vscode.ThemeIcon(
          attention ? 'warning' : 'repo',
          attention ? new vscode.ThemeColor('problemsWarningIcon.foreground') : undefined
        );
        item.contextValue = 'repository';
        item.command = { command: 'temcoKnowledge.openRepository', title: 'Open', arguments: [node] };
        return item;
      }
      case 'reason':
        return new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      case 'note': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon('info');
        if (node.command) {
          item.command = { command: node.command, title: 'Run it' };
        }
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.sections();
    }
    if (node.kind === 'header') {
      return node.rows.map((row) => new RepoNode(row));
    }
    if (node.kind === 'repo') {
      return node.row.reasons.map((text) => new ReasonNode(text));
    }
    return [];
  }

  private sections(): Node[] {
    const sections: Node[] = [];
    const local = localRows(this.roots());
    if (local.length === 1) {
      sections.push(new RepoNode(local[0]));
    } else if (local.length > 1) {
      sections.push(
        new HeaderNode(
          'Open folders',
          'Read from the folders you have open — no network, and the checks see the files themselves.',
          local
        )
      );
    }

    const cached = this.context.globalState.get<Dashboard>(CACHE_KEY);
    if (cached && cached.rows.length > 0) {
      const minutes = Math.max(0, Math.round((Date.now() - cached.at) / 60_000));
      sections.push(
        new HeaderNode(
          cached.owner,
          `Read from GitHub ${minutes === 0 ? 'just now' : `${minutes} minute(s) ago`}` +
            `${cached.limited ? `, and stopped early: ${cached.limited}` : ''}` +
            (cached.skipped.length > 0 ? `\n\n${cached.skipped.length} repositories carry no registry.` : ''),
          cached.rows.map(orgRow)
        )
      );
      return sections;
    }

    sections.push(
      new NoteNode('Run “Documentation Dashboard” to read the organisation', 'temcoKnowledge.dashboard')
    );
    return sections;
  }
}

function orgRow(row: Dashboard['rows'][number]): Row {
  return {
    repository: row.repository,
    pages: row.pages,
    owners: row.owners,
    changed: row.changed,
    state: row.state,
    reasons: reasons(row.state, row.changed, row.issues),
    local: false,
    url: row.url,
  };
}

/** The same row, measured in the folder the maintainer has open. */
function localRows(roots: readonly DocsRoot[]): Row[] {
  return roots.map((root) => {
    const pages = collectPages(root);
    const owners = new Set(
      pages.map((page) => page.owner.trim()).filter((owner) => owner.length > 0 && owner !== 'docs')
    );
    const dates = pages
      .map((page) => page.provenance?.updated)
      .filter((date): date is string => typeof date === 'string' && date.length > 0)
      .sort();
    const newest = dates[dates.length - 1];
    const age = newest ? Math.round((Date.now() - Date.parse(newest)) / 86_400_000) : undefined;
    const stale = countStale(pages) > 0 || (age !== undefined && age > STALE_DAYS);
    const state = stateWords({
      stale,
      unowned: owners.size === 0 && pages.length > 0,
      issues: root.issues,
    });
    return {
      repository: root.folder.name,
      pages: root.pages,
      owners: owners.size > 0 ? [...owners].sort().join(', ') : '—',
      changed: ageText(age),
      state,
      reasons: reasons(state, ageText(age), root.issues),
      local: true,
      folder: root.folder.uri,
    };
  });
}

/** What to do about a row, in the words of the thing that has to be done. */
function reasons(state: readonly string[], changed: string, issues: number): string[] {
  const lines: string[] = [];
  if (state.includes('stale')) {
    lines.push(`stale — last change ${changed}`);
  }
  if (state.includes('no owner')) {
    lines.push('no owner — every page still carries the placeholder owner');
  }
  if (issues > 0) {
    lines.push(`${issues} gap${issues === 1 ? '' : 's'} — open the repository to see them on the pages`);
  }
  return lines;
}

/** Opening a row: a folder for a row measured here, GitHub for one read over the API. */
export async function openRepository(node: unknown): Promise<void> {
  const row = (node as { row?: Row } | undefined)?.row;
  if (!row) {
    return;
  }
  if (row.url) {
    await vscode.env.openExternal(vscode.Uri.parse(row.url));
    return;
  }
  if (row.folder) {
    await vscode.commands.executeCommand('revealInExplorer', row.folder);
  }
}
