// The Content view.
//
// Areas, then chapters, then pages — the same shape the registry describes, so the tree never has to be
// explained. Counts sit on the parents because the question a maintainer actually asks is "which area
// needs attention", not "show me page 217". A page with a problem gets its reasons as children.

import * as vscode from 'vscode';
import { AreaGroup, ChapterGroup, DocsRoot, PageEntry, collectPages, totals } from './registry';

class FolderNode {
  readonly kind = 'folder';
  constructor(readonly root: DocsRoot) {}
}

class AreaNode {
  readonly kind = 'area';
  constructor(readonly root: DocsRoot, readonly area: AreaGroup) {}
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

class MessageNode {
  readonly kind = 'message';
  constructor(readonly text: string, readonly icon?: string) {}
}

export type KnowledgeNode =
  | FolderNode
  | AreaNode
  | ChapterNode
  | PageNode
  | IssueNode
  | GapsNode
  | MessageNode;

export function pageFromNode(node: KnowledgeNode | undefined): PageNode | undefined {
  return node?.kind === 'page' ? node : undefined;
}

export class KnowledgeTreeProvider implements vscode.TreeDataProvider<KnowledgeNode> {
  private readonly changed = new vscode.EventEmitter<KnowledgeNode | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;

  private roots: DocsRoot[] = [];

  setRoots(roots: DocsRoot[]): void {
    this.roots = roots;
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
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        if (node.icon) {
          item.iconPath = new vscode.ThemeIcon(node.icon);
        }
        return item;
      }
    }
  }

  getChildren(node?: KnowledgeNode): KnowledgeNode[] {
    if (!node) {
      const roots = this.roots;
      if (roots.length === 0) {
        return [
          new MessageNode(
            'No documented workspace. Open a repository that has docs/help/registry.json.',
            'info'
          ),
        ];
      }
      const gaps = totals(roots).issues;
      const entry =
        roots.length === 1
          ? roots[0].areas.map((area) => new AreaNode(roots[0], area))
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
  item.description = `${node.root.pages} pages`;
  item.tooltip = new vscode.MarkdownString(
    `**${node.root.folder.name}**\n\n${node.root.pages} pages · ${node.root.issues} issues · ${node.root.neverReviewed} never reviewed`
  );
  item.iconPath = new vscode.ThemeIcon('library');
  item.contextValue = 'folder';
  return item;
}

function areaItem(node: AreaNode): vscode.TreeItem {
  const { area } = node;
  const item = new vscode.TreeItem(
    area.title,
    area.chapters.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
  );
  item.description = `${area.pages} pages${describeIssues(area)}`;
  item.tooltip = new vscode.MarkdownString(
    [
      `**${area.title}**`,
      '',
      `audience: ${area.audience}${area.noindex ? ' · excluded from the published site' : ''}`,
      `${area.pages} pages · ${area.neverReviewed} never reviewed${area.unshipped ? ` · ${area.unshipped} not shipped` : ''}`,
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
  const item = new vscode.TreeItem(
    page.title,
    page.issues.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
  );
  item.id = `${node.root.folder.name}:${page.id}`;
  item.description = `${page.owner}${page.ship ? '' : ' · not shipped'}${page.reviewed ? '' : ' · never reviewed'}`;
  item.tooltip = new vscode.MarkdownString(
    [
      `**${page.title}**`,
      '',
      `id: \`${page.id}\``,
      `owner: ${page.owner || '—'} · audience: ${page.audience}`,
      `ship: ${page.ship ? 'yes' : 'no'} · reviewed: ${page.reviewed ?? 'never'}`,
      '',
      page.issues.length === 0
        ? '_No structural problem._'
        : page.issues.map((issue) => `- ${issue.severity === 'error' ? '$(error)' : '$(warning)'} ${issue.message}`).join('\n'),
    ].join('\n')
  );
  item.iconPath = page.exists
    ? new vscode.ThemeIcon(page.issues.length > 0 ? 'warning' : 'file', page.issues.length > 0 ? new vscode.ThemeColor('problemsWarningIcon.foreground') : undefined)
    : new vscode.ThemeIcon('question', new vscode.ThemeColor('problemsErrorIcon.foreground'));
  item.contextValue = 'page';
  item.command = {
    command: 'temcoKnowledge.openPage',
    title: 'Open Page',
    arguments: [node],
  };
  return item;
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
