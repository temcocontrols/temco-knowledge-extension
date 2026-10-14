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
        `SELECT name, kind, branch, pages, last_read_mode AS lastReadMode
           FROM sources
          ORDER BY name`
      )
      .all() as Record<string, unknown>[];

    return rows.map((row) => ({
      name: String(row.name ?? ''),
      kind: String(row.kind ?? ''),
      branch: row.branch === null || row.branch === undefined ? undefined : String(row.branch),
      pages: row.pages === null || row.pages === undefined ? undefined : Number(row.pages),
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
    const source = this.db.prepare('SELECT id FROM sources WHERE slug = ?').get(sourceSlug) as
      | { id?: unknown }
      | undefined;
    const sourceId = Number(source?.id ?? 0);
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
  documentArtifacts(documentSlug: string): { kind: string; path: string; builtAt: string }[] {
    const rows = this.db
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
  name: string;
  kind: string;
  branch?: string;
  pages?: number;
  lastReadMode?: string;
}

/** The database file for a storage folder, whether or not it exists yet — used for reporting and for a click. */
export function catalogFileUri(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'catalog', CATALOG_FILE);
}
