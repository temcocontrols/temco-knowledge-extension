// The sidebar's two derived sections.
//
// Workspace is the page tree (`src/tree.ts`). These are the other two: **Work** — what needs doing, and what
// changed — and **Library** — what the application reads and produces. Both are built from the same facts the
// dashboard shows, and both are plain text: an empty section is a sentence, never a button.

import * as vscode from 'vscode';
import { Catalog } from './catalog/store';
import { DocsRoot, collectPages, countStale } from './registry';

export const WORK_VIEW_ID = 'temcoKnowledge.work';
export const LIBRARY_VIEW_ID = 'temcoKnowledge.library';

class Row {
  constructor(
    readonly label: string,
    readonly description: string,
    readonly icon: string,
    readonly children: Row[] = []
  ) {}
}

class SectionView implements vscode.TreeDataProvider<Row> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly roots: () => readonly DocsRoot[],
    private readonly kind: 'work' | 'library'
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(row: Row): vscode.TreeItem {
    const item = new vscode.TreeItem(
      row.label,
      row.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.description = row.description;
    item.iconPath = new vscode.ThemeIcon(row.icon);
    item.tooltip = row.description ? `${row.label} — ${row.description}` : row.label;
    return item;
  }

  async getChildren(row?: Row): Promise<Row[]> {
    if (row) {
      return row.children;
    }
    if (this.kind === 'work') {
      return await this.work();
    }
    return await this.library();
  }

  /** The rows a maintainer acts on, gathered across everything open. */
  private async work(): Promise<Row[]> {
    const rows: Row[] = [];

    for (const root of this.roots()) {
      const pages = collectPages(root);
      const missing = pages.filter((page) => !page.exists);
      const stale = countStale(pages);
      const faulty = pages.filter((page) => page.issues.length > 0);

      const children: Row[] = faulty.map(
        (entry) =>
          new Row(
            entry.title || entry.id,
            entry.issues.map((issue) => issue.message).join(' · '),
            entry.issues.some((issue) => issue.severity === 'error') ? 'error' : 'warning'
          )
      );
      if (missing.length > 0) {
        children.unshift(
          new Row(
            `${missing.length} page${missing.length === 1 ? '' : 's'} declared but no file`,
            'its registry.json entry names a page that is not there',
            'error'
          )
        );
      }

      rows.push(
        new Row(
          root.folder.name,
          [
            `${root.errors} error${root.errors === 1 ? '' : 's'}`,
            `${root.warnings} warning${root.warnings === 1 ? '' : 's'}`,
            `${root.neverReviewed} never reviewed`,
            stale > 0 ? `${stale} stale` : undefined,
          ]
            .filter((part): part is string => part !== undefined)
            .join(' · '),
          children.length > 0 ? 'warning' : 'pass',
          children
        )
      );
    }

    const unseen = await this.unseen();
    if (unseen > 0) {
      rows.unshift(
        new Row(
          `${unseen} change${unseen === 1 ? '' : 's'} not shown yet`,
          'the application noticed these and has not told you',
          'bell'
        )
      );
    }

    return rows;
  }

  /** What it reads, and what it produces — as counts, because neither is collected yet. */
  private async library(): Promise<Row[]> {
    const counts = await this.catalogCounts();
    return [
      new Row('Sources', counts.sources === 0 ? 'none recorded yet' : String(counts.sources), 'repo'),
      new Row(
        'Documents',
        counts.documents === 0 ? 'none created yet' : String(counts.documents),
        'book'
      ),
      new Row(
        'Catalog',
        counts.tables === 0
          ? 'not opened yet'
          : `${counts.tables} tables · schema ${counts.schema} · on this machine`,
        'database'
      ),
    ];
  }

  private async unseen(): Promise<number> {
    let catalog: Catalog | undefined;
    try {
      catalog = await Catalog.open(this.context);
      return catalog.unseenEvents();
    } catch {
      return 0;
    } finally {
      catalog?.close();
    }
  }

  private async catalogCounts(): Promise<{
    sources: number;
    documents: number;
    tables: number;
    schema: number;
  }> {
    let catalog: Catalog | undefined;
    try {
      catalog = await Catalog.open(this.context);
      const counts = catalog.counts();
      return {
        sources: counts.find(([table]) => table === 'sources')?.[1] ?? 0,
        documents: counts.find(([table]) => table === 'documents')?.[1] ?? 0,
        tables: counts.length,
        schema: catalog.schemaVersion(),
      };
    } catch {
      return { sources: 0, documents: 0, tables: 0, schema: 0 };
    } finally {
      catalog?.close();
    }
  }
}

export function registerSectionViews(
  context: vscode.ExtensionContext,
  roots: () => readonly DocsRoot[]
): { refresh(): void } {
  const work = new SectionView(context, roots, 'work');
  const library = new SectionView(context, roots, 'library');
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(WORK_VIEW_ID, work),
    vscode.window.registerTreeDataProvider(LIBRARY_VIEW_ID, library)
  );
  return {
    refresh(): void {
      work.refresh();
      library.refresh();
    },
  };
}
