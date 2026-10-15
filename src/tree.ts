// The Content view.
//
// Areas, then chapters, then pages — the same shape the registry describes, so the tree never has to be
// explained. Counts sit on the parents because the question a maintainer actually asks is "which area
// needs attention", not "show me page 217". A page with a problem gets its reasons as children.

import * as vscode from 'vscode';
import {
  AreaGroup,
  ChapterGroup,
  DocsRoot,
  PageEntry,
  Provenance,
  collectPages,
  countStale,
  totals,
} from './registry';

class FolderNode {
  readonly kind = 'folder';
  constructor(readonly root: DocsRoot) {}
}

class AreaNode {
  readonly kind = 'area';
  /**
   * True when this area is the view's own top level — with one repository open its areas are, and they open by
   * themselves so the pages are one click away instead of three. Anything deeper waits to be asked.
   */
  constructor(readonly root: DocsRoot, readonly area: AreaGroup, readonly top = false) {}
}

class ChapterNode {
  readonly kind = 'chapter';
  constructor(readonly root: DocsRoot, readonly area: AreaGroup, readonly chapter: ChapterGroup) {}
}

class PageNode {
  readonly kind = 'page';
  constructor(readonly root: DocsRoot, readonly page: PageEntry) {}
}

class IssueNode {
  readonly kind = 'issue';
  constructor(readonly root: DocsRoot, readonly page: PageEntry, readonly index: number) {}
}

/** Stands in for the list of every page with a problem, across all open repositories. */
class GapsNode {
  readonly kind = 'gaps';
  constructor(readonly count: number) {}
}

/**
 * A row that exists because there is nothing else to show: why the list is empty, and the one act that fills it.
 *
 * These are rows rather than a `viewsWelcome`, which was tried and dropped — a welcome's `when` clause is
 * resolved when the view is first painted, before the refresh has read anything, so it kept announcing "nothing
 * recorded yet" over a catalog that held five projects.
 */
export interface TreeNote {
  label: string;
  detail: string;
  command?: { command: string; args?: unknown[] };
}

class NoteNode {
  readonly kind = 'note';
  constructor(readonly note: TreeNote) {}
}

export type KnowledgeNode =
  | FolderNode
  | AreaNode
  | ChapterNode
  | PageNode
  | IssueNode
  | GapsNode
  | NoteNode;

export function pageFromNode(node: KnowledgeNode | undefined): PageNode | undefined {
  return node?.kind === 'page' ? node : undefined;
}

export class KnowledgeTreeProvider implements vscode.TreeDataProvider<KnowledgeNode> {
  private readonly changed = new vscode.EventEmitter<KnowledgeNode | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;

  private roots: DocsRoot[] = [];
  private notes: TreeNote[] = [];

  setRoots(roots: DocsRoot[], notes: TreeNote[] = []): void {
    this.roots = roots;
    this.notes = notes;
    this.changed.fire();
  }

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(node: KnowledgeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'folder':
        return folderItem(node);
      case 'area':
        return areaItem(node);
      case 'chapter':
        return chapterItem(node);
      case 'page':
        return pageItem(node);
      case 'issue':
        return issueItem(node);
      case 'gaps': {
        const item = new vscode.TreeItem(`Gaps (${node.count})`, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        item.tooltip = 'Every page with a structural problem, across all open repositories.';
        return item;
      }
      case 'note': {
        const item = new vscode.TreeItem(node.note.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.note.detail;
        item.tooltip = `${node.note.label} — ${node.note.detail}`;
        item.iconPath = new vscode.ThemeIcon(node.note.command ? 'arrow-right' : 'info');
        if (node.note.command) {
          item.command = {
            command: node.note.command.command,
            title: node.note.label,
            arguments: node.note.command.args ?? [],
          };
        }
        return item;
      }
    }
  }

  getChildren(node?: KnowledgeNode): KnowledgeNode[] {
    if (!node) {
      const roots = this.roots;
      if (roots.length === 0) {
        // Nothing read is not nothing to say: the rows carry the reason and the way out of it.
        return this.notes.map((note) => new NoteNode(note));
      }
      const gaps = totals(roots).issues;
      const entry =
        roots.length === 1
          ? roots[0].areas.map((area) => new AreaNode(roots[0], area, true))
          : roots.map((root) => new FolderNode(root));
      return gaps > 0 ? [new GapsNode(gaps), ...entry] : entry;
    }

    switch (node.kind) {
      case 'gaps':
        return this.roots.flatMap((root) =>
          collectPages(root)
            .filter((page) => page.issues.length > 0)
            .map((page) => new PageNode(root, page))
        );
      case 'folder':
        return node.root.areas.map((area) => new AreaNode(node.root, area));
      case 'area':
        return node.area.chapters.map((chapter) => new ChapterNode(node.root, node.area, chapter));
      case 'chapter':
        return node.chapter.pages.map((page) => new PageNode(node.root, page));
      case 'page':
        return node.page.issues.map((_, index) => new IssueNode(node.root, node.page, index));
      default:
        return [];
    }
  }
}

function folderItem(node: FolderNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    node.root.folder.name,
    node.root.areas.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
  );
  const { root } = node;
  const recorded = root.origin === 'catalog';
  item.description = recorded ? `${root.pages} pages · read from the source` : `${root.pages} pages`;
  const stale = countStale(collectPages(root));
  item.tooltip = new vscode.MarkdownString(
    [
      `**${root.folder.name}**`,
      '',
      recorded
        ? `${root.pages} pages as the read recorded them. The checks need a folder on this machine, so none ` +
          'has been run on this source.'
        : `${root.pages} pages · ${root.issues} issues · ${root.neverReviewed} never reviewed` +
          (stale > 0 ? ` · ${stale} stale` : ''),
    ].join('\n')
  );
  item.iconPath = new vscode.ThemeIcon(recorded ? 'cloud' : 'library');
  item.contextValue = recorded ? 'source' : 'folder';
  return item;
}

function areaItem(node: AreaNode): vscode.TreeItem {
  const { area } = node;
  const item = new vscode.TreeItem(
    area.title,
    area.chapters.length > 0
      ? node.top
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None
  );
  item.description = `${area.pages} pages${describeIssues(area)}`;
  const stale = countStale(node.area.chapters.flatMap((chapter) => chapter.pages));
  item.tooltip = new vscode.MarkdownString(
    [
      `**${area.title}**`,
      '',
      [
        area.audience ? `audience: ${area.audience}` : '',
        area.noindex ? 'excluded from the published site' : '',
        `${area.pages} pages`,
        node.root.origin === 'catalog' ? '' : `${area.neverReviewed} never reviewed`,
        area.unshipped ? `${area.unshipped} not shipped` : '',
        stale > 0 ? `${stale} stale` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    ].join('\n')
  );
  item.iconPath = new vscode.ThemeIcon('book');
  item.contextValue = 'area';
  return item;
}

function chapterItem(node: ChapterNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    node.chapter.chapter,
    node.chapter.pages.length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None
  );
  item.description = `${node.chapter.pages.length}`;
  item.iconPath = new vscode.ThemeIcon('files');
  item.contextValue = 'chapter';
  return item;
}

function pageItem(node: PageNode): vscode.TreeItem {
  const { page } = node;
  const recorded = page.origin === 'catalog';
  const stale = page.provenance?.stale === true;
  const item = new vscode.TreeItem(
    page.title,
    page.issues.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
  );
  item.id = `${node.root.folder.name}:${page.id}`;

  if (recorded) {
    // Nothing was checked and nothing was reviewed, so the row says what it is: a page a read told us about.
    item.description = `${page.owner || 'no owner'} · read from the source`;
    item.tooltip = new vscode.MarkdownString(
      [
        `**${page.title}**`,
        '',
        `id: \`${page.id}\``,
        `owner: ${page.owner || '—'}`,
        '',
        `Read from ${node.root.folder.name}, which is not a folder on this machine — so the page's file, its ` +
          'headings, its staleness and its structural checks are all unknown. Reading a clone of the source is ' +
          'what makes them known.',
      ].join('\n')
    );
    item.iconPath = new vscode.ThemeIcon('cloud', new vscode.ThemeColor('descriptionForeground'));
    item.contextValue = 'catalogPage';
    return item;
  }

  item.description = `${stale ? 'stale · ' : ''}${page.owner}${page.ship ? '' : ' · not shipped'}${page.reviewed ? '' : ' · never reviewed'}`;
  item.tooltip = new vscode.MarkdownString(
    [
      `**${page.title}**`,
      '',
      `id: \`${page.id}\``,
      `owner: ${page.owner || '—'} · audience: ${page.audience}`,
      `ship: ${page.ship ? 'yes' : 'no'} · reviewed: ${page.reviewed ?? 'never'}`,
      ...provenanceLines(page.provenance),
      '',
      page.issues.length === 0
        ? '_No structural problem._'
        : page.issues.map((issue) => `- ${issue.severity === 'error' ? '$(error)' : '$(warning)'} ${issue.message}`).join('\n'),
    ].join('\n')
  );
  item.iconPath = !page.exists
    ? new vscode.ThemeIcon('question', new vscode.ThemeColor('problemsErrorIcon.foreground'))
    : page.issues.length > 0
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
      : stale
        ? new vscode.ThemeIcon('history', new vscode.ThemeColor('descriptionForeground'))
        : new vscode.ThemeIcon('file');
  item.contextValue = page.exists ? 'page' : 'missingPage';
  item.command = {
    command: 'temcoKnowledge.openPage',
    title: 'Open Page',
    arguments: [node],
  };
  return item;
}

/** The lines a page tooltip adds once the generator's provenance is known — none when it is not. */
function provenanceLines(provenance: Provenance | undefined): string[] {
  if (!provenance) {
    return [];
  }
  const lines: string[] = [];
  const changed = provenance.updated ?? provenance.git?.date;
  if (changed) {
    const by = provenance.git?.author ? ` by ${provenance.git.author}` : '';
    const sha = provenance.git?.sha ? ` (${provenance.git.sha})` : '';
    lines.push(`last change: ${changed}${by}${sha}`);
  } else if (provenance.git?.sha) {
    lines.push(`last change: ${provenance.git.sha}`);
  }
  if (provenance.stale) {
    lines.push('**stale**: a commit touched code this page claims, after its last review');
  }
  const shown = provenance.headings.slice(0, 8);
  if (shown.length > 0) {
    const more = provenance.headings.length - shown.length;
    lines.push(`headings: ${shown.join(' · ')}${more > 0 ? ` · +${more} more` : ''}`);
  }
  return lines;
}

function issueItem(node: IssueNode): vscode.TreeItem {
  const issue = node.page.issues[node.index];
  const item = new vscode.TreeItem(issue.message, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(
    issue.severity === 'error' ? 'error' : 'warning',
    new vscode.ThemeColor(issue.severity === 'error' ? 'problemsErrorIcon.foreground' : 'problemsWarningIcon.foreground')
  );
  item.contextValue = 'issue';
  return item;
}

function describeIssues(counts: { errors: number; warnings: number }): string {
  if (counts.errors === 0 && counts.warnings === 0) {
    return '';
  }
  const parts: string[] = [];
  if (counts.errors > 0) {
    parts.push(`${counts.errors} errors`);
  }
  if (counts.warnings > 0) {
    parts.push(`${counts.warnings} warnings`);
  }
  return ` · ${parts.join(', ')}`;
}
