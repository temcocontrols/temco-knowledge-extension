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

  /**
   * What a person creates, then what it is made of.
   *
   * Documents come first because they are the unit of management — a source is only something a document cites.
   * Before anything is created the section is a sentence, not a button.
   */
  private async library(): Promise<Row[]> {
    let rows: Row[] = [];
    let catalog: Catalog | undefined;
    try {
      catalog = await Catalog.open(this.context);
      const documents = catalog.documents();
      const sources = catalog.sources();

      const documentRows = documents.map((document) => {
        const slug = document.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        const cited = catalog !== undefined ? catalog.documentSources(slug) : [];
        const artifacts = catalog !== undefined ? catalog.documentArtifacts(slug) : [];

        const children: Row[] = [
          new Row(
            'Sources',
            cited.length === 0 ? 'none yet' : String(cited.length),
            'repo',
            cited.map(
              (source) =>
                new Row(
                  source.name,
                  [source.kind, source.branch].filter((part): part is string => Boolean(part)).join(' · '),
                  'git-branch'
                )
            )
          ),
          new Row(
            'Outputs',
            artifacts.length === 0 ? 'never built' : `${artifacts.length} built`,
            'package',
            artifacts.map(
              (artifact) => new Row(artifact.path, artifact.builtAt.slice(0, 10), 'file')
            )
          ),
        ];

        return new Row(
          document.name,
          [
            document.version ? `v${document.version}` : undefined,
            `${document.sources} source${document.sources === 1 ? '' : 's'}`,
            document.builtAt ? 'built' : 'never built',
          ]
            .filter((part): part is string => Boolean(part))
            .join(' · '),
          'book',
          children
        );
      });

      rows = [
        new Row('Documents', documents.length === 0 ? 'none created yet' : String(documents.length), 'library', documentRows),
        new Row(
          'Sources',
          sources.length === 0 ? 'none recorded yet' : String(sources.length),
          'repo',
          sources.map(
            (source) =>
              new Row(
                source.name,
                [source.kind, source.branch, source.lastReadMode].
                  filter((part): part is string => Boolean(part))
                  .join(' · '),
                source.kind === 'git' ? 'git-branch' : 'file'
              )
          )
        ),
        new Row(
          'Catalog',
          `${catalog.counts().length} tables · schema ${catalog.schemaVersion()} · on this machine`,
          'database'
        ),
      ];
    } catch {
      rows = [new Row('Catalog', 'not opened yet', 'database')];
    } finally {
      catalog?.close();
    }
    return rows;
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
