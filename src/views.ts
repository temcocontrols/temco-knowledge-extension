// The sidebar's two derived sections.
//
// Workspace is the page tree (`src/tree.ts`). These are the other two: **Work** — what needs doing, and what
// changed — and **Library** — what the application reads and produces. Both are built from the same facts the
// dashboard shows, and both are plain text: an empty section is a sentence, never a button.

import * as vscode from 'vscode';
import { entryById } from './ai/catalog';
import { aiStatus } from './ai/runtime';
import { Catalog } from './catalog/store';
import { slugOf } from './projectPage';
import { DocsRoot, collectPages, countStale } from './registry';
import { Selection } from './selected';

export const LIBRARY_VIEW_ID = 'temcoKnowledge.library';

/** The organisation the Repositories row names: a setting, with the default the platform was built for. */
function organisation(): string {
  const configured = vscode.workspace.getConfiguration('temcoKnowledge').get<string>('organisation');
  return configured !== undefined && configured.trim().length > 0 ? configured.trim() : 'temcocontrols';
}

export class Row {
  constructor(
    readonly label: string,
    readonly description: string,
    readonly icon: string,
    readonly children: Row[] = [],
    /** What clicking the row does. Only rows that stand for something openable have one. */
    readonly command?: { command: string; args: unknown[] },
    /**
     * What a context menu can match: `project`, `source`, `page`. Unset on a row that is only text — a heading,
     * a count, an empty-state sentence — so nothing offers an action on something that is not a thing.
     */
    readonly contextValue?: string,
    /** The catalog slug this row stands for, when it stands for one. */
    readonly slug?: string,
    /**
     * Whether the row shows its children without being asked.
     *
     * Only a row the sidebar is *opened* for asks this — everything else waits to be clicked, because a tree
     * that opens itself everywhere is a wall of text. The person's own click always beats it.
     */
    readonly expanded = false,
    /**
     * A theme colour for the icon, when the row's meaning is a severity rather than a kind: a red fault, an
     * amber something-to-look-at, a green nothing-at-all. Unset draws the icon in the ordinary foreground.
     */
    readonly colour?: string
  ) {}
}

/**
 * A row's identity across the refreshes that rebuild it.
 *
 * Rows are made fresh on every read, so a person's expand/collapse choice cannot be kept against the object;
 * it is kept against what the row *is* — the kind of thing it stands for, and which one.
 */
function rowKey(row: Row): string {
  return `${row.contextValue ?? row.label}|${row.slug ?? row.label}`;
}

/**
 * A row's slug, whatever the caller was handed.
 *
 * A context-menu command receives the tree element — a {@link Row} — while the same command is also useful with
 * a slug from a keybinding or a test. Both arrive here, and both leave as a slug or nothing.
 */
export function rowSlug(target: unknown): string | undefined {
  if (typeof target === 'string') {
    return target.length > 0 ? target : undefined;
  }
  if (target !== null && typeof target === 'object') {
    const direct = (target as { slug?: unknown }).slug;
    if (typeof direct === 'string' && direct.length > 0) {
      return direct;
    }
    const first = (target as { command?: { args?: unknown[] } }).command?.args?.[0];
    if (typeof first === 'string' && first.length > 0) {
      return first;
    }
  }
  return undefined;
}

class SectionView implements vscode.TreeDataProvider<Row> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly selection: Selection,
    private readonly roots: () => readonly DocsRoot[]
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  /**
   * What the person did to a row, by row identity — for the session only.
   *
   * The Library re-reads the catalog on every refresh, so without this a collapse would be undone the next
   * time a registry file changed. A refresh re-reads the data; it must not re-decide the layout.
   */
  private readonly chosenState = new Map<string, boolean>();

  /** Records the person's own answer about a row, which beats the row's default from then on. */
  chosen(row: Row, open: boolean): void {
    this.chosenState.set(rowKey(row), open);
  }

  /** Whether a row shows its children: what the person chose, else what the row asked for. */
  private state(row: Row): vscode.TreeItemCollapsibleState {
    if (row.children.length === 0) {
      return vscode.TreeItemCollapsibleState.None;
    }
    const open = this.chosenState.get(rowKey(row)) ?? row.expanded;
    return open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
  }

  getTreeItem(row: Row): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, this.state(row));
    item.description = row.description;
    item.iconPath = row.colour
      ? new vscode.ThemeIcon(row.icon, new vscode.ThemeColor(row.colour))
      : new vscode.ThemeIcon(row.icon);
    if (row.contextValue !== undefined) {
      item.contextValue = row.contextValue;
    }
    item.tooltip = row.description ? `${row.label} — ${row.description}` : row.label;
    if (row.command) {
      item.command = { command: row.command.command, title: row.label, arguments: row.command.args };
    }
    return item;
  }

  async getChildren(row?: Row): Promise<Row[]> {
    if (row) {
      return row.children;
    }
    return await this.library();
  }

  /**
   * The AI, as one row at the end of the Library.
   *
   * It was reachable only from the command palette and from the panel's own title bar — which you cannot see
   * when the panel is closed, which is exactly when you want it. The description carries the one fact that
   * decides whether it can answer at all: which model, and whether the server is up.
   *
   * Two children and no prose. The panel is the reason the row exists; the page is where everything else lives
   * — the model list, the folder, the dock link — so a second copy of each here is only noise.
   */
  private aiRow(): Row {
    const status = aiStatus(this.context);
    const model = status.model ? entryById(status.model.id)?.label ?? status.model.id : undefined;
    const line = status.running
      ? `${model ?? 'no model chosen'} · running`
      : model !== undefined
        ? `${model} · stopped`
        : status.runtime !== undefined
          ? 'no model chosen'
          : 'nothing installed';

    return new Row(
      'The AI',
      line,
      'hubot',
      [
        new Row('Open the panel', '', 'comment-discussion', [], {
          command: 'temcoKnowledge.ai.focus',
          args: [],
        }),
        new Row('The AI page', '', 'settings-gear', [], {
          command: 'temcoKnowledge.aiPage',
          args: [],
        }),
      ],
      // Clicking the row opens the AI *page*, not the panel: the page is where the AI is set up, it says whether
      // a model is installed at all, and it is the one surface that can explain itself when nothing is.
      { command: 'temcoKnowledge.aiPage', args: [] },
      'ai'
    );
  }

  /**
   * What wants a person, as one row.
   *
   * This is what the old **Work** view is now: it was a second copy of the tree's *Gaps* list plus a counter, in
   * a third place, behind one icon that meant five things. So the sidebar holds a count, the first few items,
   * and a way to the page that has room for the rest — and each item carries a mark that means only one thing.
   */
  private async attention(): Promise<Row> {
    const roots = this.roots();
    const faulty: Row[] = [];
    let errors = 0;
    let warnings = 0;
    let stale = 0;
    let unowned = 0;
    let missing = 0;

    for (const root of roots) {
      const pages = collectPages(root);
      errors += root.errors;
      warnings += root.warnings;
      stale += countStale(pages);
      unowned += pages.filter((page) => page.owner.length === 0).length;
      missing += pages.filter((page) => !page.exists).length;

      for (const page of pages.filter((entry) => entry.issues.length > 0)) {
        const worst = page.issues.some((issue) => issue.severity === 'error');
        faulty.push(
          new Row(
            page.title || page.id,
            page.issues.map((issue) => issue.message).join(' · '),
            worst ? 'error' : 'warning'
          )
        );
      }
    }

    const children: Row[] = [];
    if (missing > 0) {
      children.push(
        new Row(
          `${missing} page${missing === 1 ? '' : 's'} declared but no file`,
          'the registry names a page that is not there',
          'error',
          [],
          { command: 'temcoKnowledge.openRegistry', args: [] },
          'missing',
          undefined,
          false,
          'problemsErrorIcon.foreground'
        )
      );
    }
    if (stale > 0) {
      children.push(
        new Row(`${stale} stale`, 'the generator said so — read from index.json, never recomputed', 'history', [], undefined, 'stale')
      );
    }
    if (unowned > 0) {
      children.push(
        new Row(`${unowned} without an owner`, 'an owner is where a defect goes', 'person', [], undefined, 'unowned')
      );
    }
    children.push(...faulty.slice(0, 20));

    const unseen = await this.unseen();
    if (unseen > 0) {
      children.push(
        new Row(`${unseen} change${unseen === 1 ? '' : 's'} not shown yet`, 'noticed, and not yet told', 'bell')
      );
    }
    children.push(
      new Row(
        'More…',
        'everything that wants a person, with the reason and where the fix is',
        'ellipsis',
        [],
        { command: 'temcoKnowledge.openNeeds', args: [] },
        'needs'
      )
    );

    // Severity at a glance, because this row is read before anything else in the sidebar: **red** when something
    // is a fault, **amber** when something merely wants looking at, and a **green tick** only when the count is
    // nothing at all. The description still spells out which of those it is, term by term.
    const nothing = errors + warnings + stale + missing === 0;
    return new Row(
      'Needs attention',
      nothing
        ? 'nothing — no fault, nothing stale, every page has a file'
        : [
            errors > 0 ? `${errors} error${errors === 1 ? '' : 's'}` : undefined,
            warnings > 0 ? `${warnings} warning${warnings === 1 ? '' : 's'}` : undefined,
            stale > 0 ? `${stale} stale` : undefined,
            unowned > 0 ? `${unowned} unowned` : undefined,
            missing > 0 ? `${missing} missing file${missing === 1 ? '' : 's'}` : undefined,
          ]
            .filter((part): part is string => part !== undefined)
            .join(' · '),
      errors > 0 ? 'error' : nothing ? 'pass' : 'warning',
      children,
      { command: 'temcoKnowledge.openNeeds', args: [] },
      'needs',
      undefined,
      false,
      errors > 0 ? 'problemsErrorIcon.foreground' : nothing ? 'charts.green' : 'problemsWarningIcon.foreground'
    );
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
        const slug = slugOf(document.name);
        const current = this.selection.project() === slug;
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
            current ? 'being worked on' : undefined,
            document.version ? `v${document.version}` : undefined,
            `${document.sources} source${document.sources === 1 ? '' : 's'}`,
            document.builtAt ? 'built' : 'never built',
          ]
            .filter((part): part is string => Boolean(part))
            .join(' · '),
          current ? 'pass-filled' : 'book',
          children,
          { command: 'temcoKnowledge.openProject', args: [slug] },
          'project',
          slug
        );
      });

      // A source expands into what the read recorded — the pages it declares, in the order it declared them.
      // Never read yet means no children, and the row says so rather than pretending to be empty.
      const sourceRows = sources.map((source) => {
        const pages = catalog !== undefined ? catalog.pagesFor(source.id) : [];
        return new Row(
          source.name,
          [
            source.kind,
            source.branch,
            source.pages === undefined ? 'never read' : `${source.pages} pages`,
            source.lastReadMode ? `read by ${source.lastReadMode}` : undefined,
          ]
            .filter((part): part is string => Boolean(part))
            .join(' · '),
          source.kind === 'git' ? 'git-branch' : 'file',
          pages.map(
            (page) =>
              new Row(
                page.title || page.id,
                [page.id, page.owner].filter((part): part is string => Boolean(part)).join(' · '),
                'markdown',
                [],
                page.path
                  ? { command: 'temcoKnowledge.openFile', args: [{ path: page.path, id: page.id, title: page.title }] }
                  : undefined,
                page.path ? 'page' : undefined,
                page.id
              )
          ),
          undefined,
          'source',
          source.slug
        );
      });

      rows = [
        // The row itself opens the page: a list of names in a tree has no room to say anything about a project,
        // and the page has room for all of it plus what can be done.
        new Row(
          'Projects',
          documents.length === 0 ? 'none created yet' : String(documents.length),
          'library',
          documentRows,
          { command: 'temcoKnowledge.openProjects', args: [] },
          'projects',
          undefined,
          // Open by default, and only this one: the projects are what the sidebar is opened for, and the
          // names of what you have are more use than the word "Projects" twice a day. A click still closes it.
          true
        ),
        new Row(
          'Sources',
          sources.length === 0 ? 'none recorded yet' : String(sources.length),
          'repo',
          sourceRows
        ),
        // The step before *Sources*: what the organisation has, rather than what has been read. The row opens a
        // page, because a list of forty repositories with their branches and a Start button each is a page and
        // not a tree. Nothing is fetched until that page is open.
        new Row(
          'Repositories',
          `${organisation()} · choose one to start`,
          'github',
          [],
          { command: 'temcoKnowledge.repositories', args: [] },
          'repositories'
        ),
        new Row(
          'Catalog',
          `${catalog.counts().length} tables · schema ${catalog.schemaVersion()} · on this machine`,
          'database'
        ),
        // What wants a person, then the AI: the things you have, then what wants doing, then the helper.
        await this.attention(),
        // Last, and last on purpose: the AI is a helper, not something to be managed. Clicking it opens the
        // panel — the AI beside the page you are reading — and everything *about* the AI is one expansion down.
        this.aiRow(),
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
  selection: Selection,
  roots: () => readonly DocsRoot[]
): { refresh(): void } {
  const library = new SectionView(context, selection, roots);
  // A created view rather than `registerTreeDataProvider`, because the person's own expand and collapse have
  // to be heard: a row that opens by itself must still be closable, and must stay closed until it is reopened.
  const view = vscode.window.createTreeView(LIBRARY_VIEW_ID, { treeDataProvider: library });
  context.subscriptions.push(
    view,
    view.onDidExpandElement(({ element }) => library.chosen(element, true)),
    view.onDidCollapseElement(({ element }) => library.chosen(element, false))
  );
  return {
    refresh(): void {
      library.refresh();
    },
  };
}
