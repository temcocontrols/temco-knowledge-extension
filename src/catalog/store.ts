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

  close(): void {
    this.db.close();
  }
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
