// The catalog: the platform's memory.
//
// SQLite, in the extension's own storage — never in a repository, never committed. The database engine is
// `node:sqlite`, which ships with the Node the extension host runs, so the platform adds no runtime dependency
// for it; where that built-in is missing, the absence is reported in words at the point of use and activation
// is unaffected.

import * as vscode from 'vscode';
import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA, SCHEMA_VERSION } from './schema';

export const CATALOG_FILE = 'catalog.db';

/** The store cannot be used at all, for a reason worth reading. */
export class CatalogUnavailable extends Error {}

type SqliteModule = typeof import('node:sqlite');

/**
 * `node:sqlite`, loaded lazily.
 *
 * A top-level import would run at load time, so an editor whose Node predates the built-in would fail
 * activation rather than the one command that needs a database.
 */
function sqlite(): SqliteModule | undefined {
  try {
    return require('node:sqlite') as SqliteModule;
  } catch {
    return undefined;
  }
}

/** One instance per session: the schema is applied once, and every view reads the same handle. */
export class Catalog {
  private constructor(
    private readonly db: DatabaseSync,
    readonly file: vscode.Uri
  ) {}

  static async open(context: vscode.ExtensionContext): Promise<Catalog> {
    const sqliteModule = sqlite();
    if (!sqliteModule) {
      throw new CatalogUnavailable(
        'this editor does not provide `node:sqlite`, which is built into Node 22.5 and later. Update the ' +
          'editor to a build whose extension host runs that Node, or set the store to the file fallback.'
      );
    }

    // Its own folder, so the database, its write-ahead log and the source cache live together and can be
    // measured, moved or deleted as one thing.
    const folder = vscode.Uri.joinPath(context.globalStorageUri, 'catalog');
    await vscode.workspace.fs.createDirectory(folder);
    const file = vscode.Uri.joinPath(folder, CATALOG_FILE);

    const db = new sqliteModule.DatabaseSync(file.fsPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA);

    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value?: unknown }
      | undefined;
    const found = row?.value === undefined ? undefined : Number(row.value);
    if (found === undefined) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    } else if (found > SCHEMA_VERSION) {
      // Refused rather than half-read: a newer build may have changed what a row means.
      db.close();
      throw new CatalogUnavailable(
        `the catalog at ${file.fsPath} was written by a newer version of the platform (schema ${found}, ` +
          `this build knows ${SCHEMA_VERSION}).`
      );
    }

    return new Catalog(db, file);
  }

  /** Rows per table, alphabetically. The cheapest proof that the store is real, and what the status shows. */
  counts(): [string, number][] {
    const tables = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name?: unknown }[];

    return tables
      .map((table) => String(table.name))
      .map((name) => {
        const counted = this.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as
          | { n?: unknown }
          | undefined;
        return [name, Number(counted?.n ?? 0)] as [string, number];
      });
  }

  /** What the schema this database carries says it is. */
  schemaVersion(): number {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value?: unknown }
      | undefined;
    return row?.value === undefined ? SCHEMA_VERSION : Number(row.value);
  }

  /**
   * The documents, with the two facts a list needs: how many sources cite it, and when anything of it was
   * last built. Both are subqueries rather than joins, so a document with neither still appears.
   */
  documents(): DocumentRow[] {
    const rows = this.db
      .prepare(
        `SELECT d.name AS name, d.version AS version,
                (SELECT COUNT(*) FROM doc_sources ds WHERE ds.document_id = d.id) AS sources,
                (SELECT MAX(a.built_at) FROM artifacts a WHERE a.document_id = d.id) AS builtAt
           FROM documents d
          ORDER BY d.name`
      )
      .all() as Record<string, unknown>[];

    return rows.map((row) => ({
      name: String(row.name ?? ''),
      version: row.version === null || row.version === undefined ? undefined : String(row.version),
      sources: Number(row.sources ?? 0),
      builtAt: row.builtAt === null || row.builtAt === undefined ? undefined : String(row.builtAt),
    }));
  }

  /** The sources, with the branch and how they were last read — the two facts that decide how much to trust. */
  sources(): SourceRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, slug, name, kind, branch, pages, state, last_read_mode AS lastReadMode
           FROM sources
          ORDER BY name`
      )
      .all() as Record<string, unknown>[];

    return rows.map((row) => ({
      id: Number(row.id ?? 0),
      slug: String(row.slug ?? ''),
      name: String(row.name ?? ''),
      kind: String(row.kind ?? ''),
      branch: row.branch === null || row.branch === undefined ? undefined : String(row.branch),
      pages: row.pages === null || row.pages === undefined ? undefined : Number(row.pages),
      state: row.state === null || row.state === undefined ? undefined : String(row.state),
      lastReadMode:
        row.lastReadMode === null || row.lastReadMode === undefined ? undefined : String(row.lastReadMode),
    }));
  }

  /** What the platform noticed and has not shown. Zero is the normal state. */
  unseenEvents(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE seen_at IS NULL').get() as
      | { n?: unknown }
      | undefined;
    return Number(row?.n ?? 0);
  }

  /**
   * Remembers a source, or updates the one with the same slug.
   *
   * Keyed by slug rather than by URL so a folder, a fork and a clone of the same project stay one row when the
   * caller says they are — R2's discovery decides that, and the catalog only records the decision.
   */
  addSource(source: SourceInput): number {
    this.db
      .prepare(
        `INSERT INTO sources
           (kind, name, slug, remote_url, path, default_branch, branch, docs_root, registry_path, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           kind = excluded.kind, name = excluded.name, remote_url = excluded.remote_url, path = excluded.path,
           default_branch = excluded.default_branch, branch = excluded.branch, docs_root = excluded.docs_root,
           registry_path = excluded.registry_path`
      )
      .run(
        source.kind,
        source.name,
        source.slug,
        source.remoteUrl ?? null,
        source.path ?? null,
        source.defaultBranch ?? null,
        source.branch ?? null,
        source.docsRoot ?? null,
        source.registryPath ?? null,
        new Date().toISOString()
      );

    const row = this.db.prepare('SELECT id FROM sources WHERE slug = ?').get(source.slug) as
      | { id?: unknown }
      | undefined;
    return Number(row?.id ?? 0);
  }

  /** Forgets a source and everything recorded under it — the scan rows go with it, by foreign key. */
  removeSource(slug: string): void {
    this.db.prepare('DELETE FROM sources WHERE slug = ?').run(slug);
  }

  /** Records what a read of a source found, so the next read can say what changed. */
  recordScan(sourceId: number, mode: string, revision: string | undefined, counts: unknown): void {
    this.db
      .prepare('INSERT INTO scans (source_id, at, mode, revision, counts) VALUES (?, ?, ?, ?, ?)')
      .run(sourceId, new Date().toISOString(), mode, revision ?? null, JSON.stringify(counts ?? {}));
    this.db
      .prepare('UPDATE sources SET last_read = ?, last_read_mode = ?, last_commit = ? WHERE id = ?')
      .run(new Date().toISOString(), mode, revision ?? null, sourceId);
  }

  /** Creates a document — the project a person manages — and returns its id. */
  createDocument(document: DocumentInput): number {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO documents (name, slug, version, audience, owner, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           name = excluded.name, version = excluded.version, audience = excluded.audience,
           owner = excluded.owner, updated_at = excluded.updated_at`
      )
      .run(
        document.name,
        document.slug,
        document.version ?? null,
        document.audience ?? null,
        document.owner ?? null,
        now,
        now
      );
    return this.documentId(document.slug);
  }

  /** Attaches a source to a document — what it is built from, at which branch, in what role. */
  attachSource(documentSlug: string, sourceSlug: string, role = 'primary'): void {
    const document = this.documentId(documentSlug);
    const sourceId = this.sourceId(sourceSlug);
    if (document === 0 || sourceId === 0) {
      throw new Error(`cannot attach ${sourceSlug} to ${documentSlug}: one of the two is not recorded`);
    }
    this.db
      .prepare(
        `INSERT INTO doc_sources (document_id, source_id, role) VALUES (?, ?, ?)
         ON CONFLICT(document_id, source_id) DO UPDATE SET role = excluded.role`
      )
      .run(document, sourceId, role);
  }

  /** The slugs of the sources a document cites — what the edit page pre-ticks. */
  documentSourceSlugs(documentSlug: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT s.slug AS slug
           FROM doc_sources d JOIN sources s ON s.id = d.source_id
          WHERE d.document_id = ? ORDER BY s.slug`
      )
      .all(this.documentId(documentSlug)) as Record<string, unknown>[];
    return rows.map((row) => String(row.slug ?? ''));
  }

  /**
   * Replaces what a document cites.
   *
   * One call with the whole list, because the ticks on the page are the truth: a project that stopped citing
   * a source must stop citing it here, and the alternative — attach and detach called by the caller — is the
   * shape that leaves stale links behind. Existing links are kept as they are (`role`, a branch override), so
   * re-saving a project does not quietly reset them.
   */
  setDocumentSources(documentSlug: string, sourceSlugs: readonly string[]): void {
    const document = this.documentId(documentSlug);
    if (document === 0) {
      throw new Error(`there is no document called ${documentSlug}`);
    }

    const ids = sourceSlugs
      .map((slug) => this.sourceId(slug))
      .filter((id) => id > 0);

    if (ids.length === 0) {
      this.db.prepare('DELETE FROM doc_sources WHERE document_id = ?').run(document);
      return;
    }

    const holes = ids.map(() => '?').join(', ');
    this.db
      .prepare(`DELETE FROM doc_sources WHERE document_id = ? AND source_id NOT IN (${holes})`)
      .run(document, ...ids);

    const keep = this.db.prepare(
      `INSERT INTO doc_sources (document_id, source_id, role) VALUES (?, ?, 'primary')
       ON CONFLICT(document_id, source_id) DO NOTHING`
    );
    for (const id of ids) {
      keep.run(document, id);
    }
  }

  private sourceId(slug: string): number {
    const row = this.db.prepare('SELECT id FROM sources WHERE slug = ?').get(slug) as
      | { id?: unknown }
      | undefined;
    return Number(row?.id ?? 0);
  }

  /** What a document is made of: its sources, each with the branch it is read at. */
  documentSources(documentSlug: string): { name: string; kind: string; branch?: string }[] {
    const rows = this.db
      .prepare(
        `SELECT s.name AS name, s.kind AS kind, COALESCE(ds.branch, s.branch) AS branch
           FROM doc_sources ds
           JOIN sources s ON s.id = ds.source_id
           JOIN documents d ON d.id = ds.document_id
          WHERE d.slug = ?
          ORDER BY s.name`
      )
      .all(documentSlug) as Record<string, unknown>[];
    return rows.map((row) => ({
      name: String(row.name ?? ''),
      kind: String(row.kind ?? ''),
      branch: row.branch === null || row.branch === undefined ? undefined : String(row.branch),
    }));
  }

  /** What a document has produced, newest first — the artifacts, by file. */
  documentArtifacts(documentSlug: string): { kind: string; path: string; builtAt: string }[] {    const rows = this.db
      .prepare(
        `SELECT a.kind AS kind, a.path AS path, a.built_at AS builtAt
           FROM artifacts a JOIN documents d ON d.id = a.document_id
          WHERE d.slug = ? ORDER BY a.built_at DESC`
      )
      .all(documentSlug) as Record<string, unknown>[];
    return rows.map((row) => ({
      kind: String(row.kind ?? ''),
      path: String(row.path ?? ''),
      builtAt: String(row.builtAt ?? ''),
    }));
  }

  /**
   * Records a build that has started.
   *
   * A build row is opened before the script runs, so a build that crashes the editor still leaves the attempt
   * behind — the alternative is a Builds tab that only remembers the runs that went well.
   */
  startBuild(documentSlug: string, revision?: string): number {
    const id = this.documentId(documentSlug);
    if (id === 0) {
      throw new Error(`there is no document called ${documentSlug}`);
    }
    const result = this.db
      .prepare('INSERT INTO builds (document_id, started_at, status, revision) VALUES (?, ?, ?, ?)')
      .run(id, new Date().toISOString(), 'running', revision ?? null);
    return Number(result.lastInsertRowid);
  }

  /** Closes a build row. `status` is the outcome the caller judged, not the exit code it was given. */
  finishBuild(buildId: number, status: string): void {
    this.db
      .prepare('UPDATE builds SET finished_at = ?, status = ? WHERE id = ?')
      .run(new Date().toISOString(), status, buildId);
  }

  /**
   * Records one file a build left behind.
   *
   * Keyed by path without a unique index: an artifact is the file, so a second build of the same site
   * produces the same paths and must not turn one output into two rows. Updating first rather than relying on
   * `ON CONFLICT` keeps the schema — and therefore an existing catalog — untouched.
   */
  recordArtifact(
    documentSlug: string,
    artifact: { kind: string; path: string; bytes?: number; buildId?: number }
  ): void {
    const id = this.documentId(documentSlug);
    if (id === 0) {
      throw new Error(`there is no document called ${documentSlug}`);
    }
    const now = new Date().toISOString();
    const updated = this.db
      .prepare(
        `UPDATE artifacts SET build_id = ?, kind = ?, bytes = ?, built_at = ?
          WHERE document_id = ? AND path = ?`
      )
      .run(artifact.buildId ?? null, artifact.kind, artifact.bytes ?? null, now, id, artifact.path);

    if (updated.changes === 0) {
      this.db
        .prepare(
          'INSERT INTO artifacts (build_id, document_id, kind, path, bytes, built_at) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(artifact.buildId ?? null, id, artifact.kind, artifact.path, artifact.bytes ?? null, now);
    }
  }

  /** One document, with everything the edit page needs to fill itself in. */
  document(slug: string): DocumentDetail | undefined {
    const row = this.db
      .prepare('SELECT name, version, audience, owner FROM documents WHERE slug = ?')
      .get(slug) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    const id = this.documentId(slug);
    const recipe = this.db.prepare('SELECT engine, outputs FROM recipes WHERE document_id = ?').get(id) as
      | Record<string, unknown>
      | undefined;

    let outputs: string[] = [];
    if (recipe?.outputs !== null && recipe?.outputs !== undefined) {
      try {
        const parsed: unknown = JSON.parse(String(recipe.outputs));
        outputs = Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
      } catch {
        outputs = [];
      }
    }

    return {
      name: String(row.name ?? ''),
      version: row.version === null || row.version === undefined ? undefined : String(row.version),
      audience: row.audience === null || row.audience === undefined ? undefined : String(row.audience),
      owner: row.owner === null || row.owner === undefined ? undefined : String(row.owner),
      engine: recipe?.engine === null || recipe?.engine === undefined ? undefined : String(recipe.engine),
      outputs,
      sources: this.documentSources(slug),
    };
  }

  /** How a document is built: one row per document, replaced when the choice changes. */
  setRecipe(slug: string, engine: string, outputs: string[]): void {
    const id = this.documentId(slug);
    if (id === 0) {
      throw new Error(`there is no document called ${slug}`);
    }
    this.db
      .prepare(
        `INSERT INTO recipes (document_id, engine, outputs) VALUES (?, ?, ?)
         ON CONFLICT(document_id) DO UPDATE SET engine = excluded.engine, outputs = excluded.outputs`
      )
      .run(id, engine, JSON.stringify(outputs));
  }

  /** Forgets a document. Its artifacts and source links go with it, by foreign key. */
  deleteDocument(slug: string): void {
    this.db.prepare('DELETE FROM documents WHERE slug = ?').run(slug);
  }

  /**
   * The branch a source is read at. Empty clears it, so the default branch is used again.
   *
   * The recorded pages are dropped with it, because they described *another* branch: keeping them would let a
   * read that never happened look like a read that did. The source becomes unread, which is what makes
   * "read every unread source" pick it up again.
   */
  setSourceBranch(slug: string, branch: string | undefined): void {
    this.db
      .prepare('UPDATE sources SET branch = ?, pages = NULL, state = ? WHERE slug = ?')
      .run(branch ?? null, 'the branch changed — read it again', slug);
  }

  /** One source's coordinates — everything a read needs, and nothing else. */
  source(slug: string): SourceDetail | undefined {
    const row = this.db
      .prepare(
        `SELECT id, kind, name, remote_url, path, branch, default_branch, docs_root, registry_path
           FROM sources WHERE slug = ?`
      )
      .get(slug) as Record<string, unknown> | undefined;
    if (!row) {
      return undefined;
    }
    const text = (value: unknown): string | undefined =>
      value === null || value === undefined ? undefined : String(value);
    return {
      id: Number(row.id ?? 0),
      kind: String(row.kind ?? 'folder') as SourceDetail['kind'],
      name: String(row.name ?? ''),
      remoteUrl: text(row.remote_url),
      path: text(row.path),
      branch: text(row.branch),
      defaultBranch: text(row.default_branch),
      docsRoot: text(row.docs_root),
      registryPath: text(row.registry_path),
    };
  }

  /**
   * Replaces what a source holds. A read is a snapshot, not an accumulation: a page that disappeared must
   * disappear here too, or the tree would keep showing documentation that is no longer there.
   */
  replacePages(sourceId: number, pages: PageInput[]): void {
    this.db.prepare('DELETE FROM pages WHERE source_id = ?').run(sourceId);
    const insert = this.db.prepare(
      `INSERT INTO pages (id, document_id, source_id, path, title, owner, stale, counts)
       VALUES (?, NULL, ?, ?, ?, ?, NULL, ?)`
    );
    for (const page of pages) {
      insert.run(
        page.id,
        sourceId,
        page.path ?? null,
        page.title ?? null,
        page.owner ?? null,
        JSON.stringify(page.counts ?? {})
      );
    }
  }

  /** What a read found, kept on the source row so a list can show it without touching the pages. */
  setSourceState(
    slug: string,
    state: { pages?: number; docsRoot?: string; registryPath?: string; state?: string }
  ): void {
    this.db
      .prepare(
        `UPDATE sources SET
           pages = COALESCE(?, pages),
           docs_root = COALESCE(?, docs_root),
           registry_path = COALESCE(?, registry_path),
           state = COALESCE(?, state)
         WHERE slug = ?`
      )
      .run(state.pages ?? null, state.docsRoot ?? null, state.registryPath ?? null, state.state ?? null, slug);
  }

  /**
   * Where a source's local copy is.
   *
   * The working area sets this after a clone, and from then on the source is read from disk: the registry, the
   * checks, the code files and the history all work on a working tree instead of one API call at a time.
   */
  setSourcePath(slug: string, path: string | undefined): void {
    this.db.prepare('UPDATE sources SET path = ? WHERE slug = ?').run(path ?? null, slug);
  }

  /** The pages a source holds, in the order the registry declared them. */
  pagesFor(sourceId: number): PageRow[] {
    const rows = this.db
      .prepare('SELECT id, path, title, owner FROM pages WHERE source_id = ? ORDER BY id')
      .all(sourceId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id ?? ''),
      path: row.path === null || row.path === undefined ? undefined : String(row.path),
      title: row.title === null || row.title === undefined ? undefined : String(row.title),
      owner: row.owner === null || row.owner === undefined ? undefined : String(row.owner),
    }));
  }

  /**
   * Every page a project holds, through the sources it cites — what its Pages tab lists.
   *
   * A join rather than a loop of {@link pagesFor}: the tab shows them grouped by source, so it needs the
   * source name on every row, which is exactly what the join is for.
   */
  documentPages(slug: string): (PageRow & { source: string })[] {
    const rows = this.db
      .prepare(
        `SELECT s.name AS source, p.id, p.path, p.title, p.owner
           FROM doc_sources d
           JOIN sources s ON s.id = d.source_id
           JOIN pages p ON p.source_id = s.id
          WHERE d.document_id = ?
          ORDER BY s.name, p.id`
      )
      .all(this.documentId(slug)) as Record<string, unknown>[];

    return rows.map((row) => ({
      source: String(row.source ?? ''),
      id: String(row.id ?? ''),
      path: row.path === null || row.path === undefined ? undefined : String(row.path),
      title: row.title === null || row.title === undefined ? undefined : String(row.title),
      owner: row.owner === null || row.owner === undefined ? undefined : String(row.owner),
    }));
  }

  private documentId(slug: string): number {
    const row = this.db.prepare('SELECT id FROM documents WHERE slug = ?').get(slug) as
      | { id?: unknown }
      | undefined;
    return Number(row?.id ?? 0);
  }

  close(): void {
    this.db.close();
  }
}

/** What `createDocument` needs. An empty slug is refused by the caller, not here. */
export interface DocumentInput {
  name: string;
  slug: string;
  version?: string;
  audience?: string;
  owner?: string;
}

/** A document as the edit page sees it. */
export interface DocumentDetail {
  name: string;
  version?: string;
  audience?: string;
  owner?: string;
  engine?: string;
  outputs: string[];
  sources: { name: string; kind: string; branch?: string }[];
}

/** A source's coordinates, as a read needs them. */
export interface SourceDetail {
  id: number;
  kind: 'git' | 'folder' | 'archive';
  name: string;
  remoteUrl?: string;
  path?: string;
  branch?: string;
  defaultBranch?: string;
  docsRoot?: string;
  registryPath?: string;
}

/** A page as a read found it — enough for a tree, and nothing invented. */
export interface PageInput {
  id: string;
  path?: string;
  title?: string;
  owner?: string;
  counts?: Record<string, number>;
}

/** A page as a tree reads it back. */
export interface PageRow {
  id: string;
  path?: string;
  title?: string;
  owner?: string;
}

/** What `addSource` needs. Everything optional is genuinely optional: a folder has no branch. */
export interface SourceInput {
  kind: 'git' | 'folder' | 'archive';
  name: string;
  slug: string;
  remoteUrl?: string;
  path?: string;
  defaultBranch?: string;
  branch?: string;
  docsRoot?: string;
  registryPath?: string;
}

/** A row of the Documents page. */
export interface DocumentRow {
  name: string;
  version?: string;
  sources: number;
  builtAt?: string;
}

/** A row of the Sources page. */
export interface SourceRow {
  id: number;
  slug: string;
  name: string;
  kind: string;
  branch?: string;
  pages?: number;
  /** What the last read concluded, in one line. */
  state?: string;
  lastReadMode?: string;
}

/** The database file for a storage folder, whether or not it exists yet — used for reporting and for a click. */
export function catalogFileUri(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'catalog', CATALOG_FILE);
}
