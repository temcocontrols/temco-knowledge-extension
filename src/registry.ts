// Registry model — the only thing this extension assumes about a documented repository.
//
// Every product repository keeps its structure in `docs/help/registry.json`: the areas, the pages and
// the metadata each page carries (owner, audience, order, whether it ships). Nothing here writes to it;
// reading is enough for the first slice, and the file stays the single source of truth.

import * as vscode from 'vscode';

/** Path of the registry inside a documented repository. */
export const REGISTRY_RELATIVE_PATH = ['docs', 'help', 'registry.json'];

/** Folder that holds the pages themselves, relative to the repository root. */
const CONTENT_RELATIVE_PATH = ['docs'];

export interface RegistryArea {
  title?: string;
  audience?: string;
  noindex?: boolean;
}

export interface RegistryPage {
  title?: string;
  area?: string;
  chapter?: string;
  order?: number;
  audience?: string;
  ship?: boolean;
  owner?: string;
  tags?: string[];
  keywords?: string[];
  help_ids?: string[];
  code?: string[];
  reviewed?: string | null;
}

export interface Registry {
  version?: number;
  areas?: Record<string, RegistryArea>;
  pages?: Record<string, RegistryPage>;
}

export type IssueSeverity = 'error' | 'warning';

/** Something wrong with the shape of the documentation set, not with the prose. */
export interface Issue {
  severity: IssueSeverity;
  message: string;
}

export interface PageEntry {
  /** Registry key, which is also the page path under `docs/`, without the extension. */
  id: string;
  title: string;
  area: string;
  chapter: string;
  order: number;
  audience: string;
  ship: boolean;
  owner: string;
  reviewed: string | null;
  uri: vscode.Uri;
  exists: boolean;
  issues: Issue[];
}

export interface ChapterGroup {
  chapter: string;
  pages: PageEntry[];
}

export interface Counts {
  pages: number;
  issues: number;
  errors: number;
  warnings: number;
  neverReviewed: number;
  unshipped: number;
}

export interface AreaGroup extends Counts {
  area: string;
  title: string;
  audience: string;
  noindex: boolean;
  chapters: ChapterGroup[];
}

export interface DocsRoot extends Counts {
  folder: vscode.WorkspaceFolder;
  rootUri: vscode.Uri;
  registryUri: vscode.Uri;
  areas: AreaGroup[];
  /** Problems with the file as a whole, so they are reported on `registry.json` itself. */
  problems: Issue[];
}

/** Thrown when the registry cannot be read at all, so the caller can show one clear message. */
export class RegistryError extends Error {}

export async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Page id (`t3000/api-reference/data-points`) to the Markdown file that must exist for it. */
export function pageUri(rootUri: vscode.Uri, id: string): vscode.Uri {
  const segments = id.split('/');
  const file = segments.pop() ?? id;
  return vscode.Uri.joinPath(rootUri, ...CONTENT_RELATIVE_PATH, ...segments, `${file}.md`);
}

export function registryUriFor(folder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(folder.uri, ...REGISTRY_RELATIVE_PATH);
}

export function collectPages(root: DocsRoot): PageEntry[] {
  return root.areas.flatMap((area) => area.chapters.flatMap((chapter) => chapter.pages));
}

export function totals(roots: readonly DocsRoot[]): Counts {
  return roots.reduce<Counts>(
    (sum, root) => ({
      pages: sum.pages + root.pages,
      issues: sum.issues + root.issues,
      errors: sum.errors + root.errors,
      warnings: sum.warnings + root.warnings,
      neverReviewed: sum.neverReviewed + root.neverReviewed,
      unshipped: sum.unshipped + root.unshipped,
    }),
    { pages: 0, issues: 0, errors: 0, warnings: 0, neverReviewed: 0, unshipped: 0 }
  );
}

/**
 * Reads one workspace folder's registry.
 *
 * Returns `undefined` when the folder is simply not a documented repository — that is a normal state, not
 * an error. Structural problems with the registry are reported as issues instead of throwing, so one bad
 * page never hides the other three hundred.
 */
export async function loadDocsRoot(folder: vscode.WorkspaceFolder): Promise<DocsRoot | undefined> {
  const registryUri = registryUriFor(folder);
  if (!(await fileExists(registryUri))) {
    return undefined;
  }

  let registry: Registry;
  try {
    const bytes = await vscode.workspace.fs.readFile(registryUri);
    registry = JSON.parse(Buffer.from(bytes).toString('utf8')) as Registry;
  } catch (error) {
    throw new RegistryError(
      `${vscode.workspace.asRelativePath(registryUri)} could not be read: ${describe(error)}`
    );
  }

  const declaredAreas = registry.areas ?? {};
  const declaredPages = registry.pages ?? {};
  const problems: Issue[] = [];
  const ids = Object.keys(declaredPages);

  if (ids.length === 0) {
    problems.push({ severity: 'warning', message: 'The registry declares no pages.' });
  }

  const titleOwners = new Map<string, string[]>();
  const orderOwners = new Map<string, string[]>();

  const entries = new Map<string, PageEntry>();
  for (const id of ids) {
    const raw = declaredPages[id] ?? {};
    const issues: Issue[] = [];

    const segments = id.split('/');
    const area = raw.area ?? segments[0] ?? '';
    const chapter = raw.chapter ?? segments[1] ?? '';

    if (!raw.title) {
      issues.push({ severity: 'error', message: 'The page has no title.' });
    }
    if (!declaredAreas[area]) {
      issues.push({
        severity: 'error',
        message: `Area "${area}" is not declared in areas{}, so nothing groups or filters this page.`,
      });
    }
    if (segments.length < 2 || segments[0] !== area || segments[1] !== chapter) {
      issues.push({
        severity: 'error',
        message: `The page id disagrees with its own area and chapter (expected "${area}/${chapter}/…").`,
      });
    }
    if (raw.order === undefined) {
      issues.push({ severity: 'warning', message: 'No order: the page has no defined place in navigation.' });
    }

    const uri = pageUri(folder.uri, id);
    const exists = await fileExists(uri);
    if (!exists) {
      issues.push({ severity: 'error', message: `Registered, but ${vscode.workspace.asRelativePath(uri)} does not exist.` });
    }

    const title = raw.title ?? id;
    append(titleOwners, title.toLowerCase(), id);
    if (raw.order !== undefined) {
      append(orderOwners, `${area}/${chapter}`, String(raw.order));
    }

    entries.set(id, {
      id,
      title,
      area,
      chapter,
      order: raw.order ?? Number.MAX_SAFE_INTEGER,
      audience: raw.audience ?? declaredAreas[area]?.audience ?? 'user',
      ship: raw.ship !== false,
      owner: raw.owner ?? '',
      reviewed: raw.reviewed ?? null,
      uri,
      exists,
      issues,
    });
  }

  // Two pages with one title, or two pages fighting over one position, both make search and navigation
  // ambiguous — so they are reported even though each page is individually valid.
  for (const [title, owners] of titleOwners) {
    if (owners.length > 1) {
      for (const id of owners) {
        entries.get(id)?.issues.push({
          severity: 'warning',
          message: `Title "${title}" is also used by ${owners.filter((other) => other !== id).join(', ')}.`,
        });
      }
    }
  }
  for (const [chapter, orders] of orderOwners) {
    const collisions = orders.filter((order, index) => orders.indexOf(order) !== index);
    for (const order of new Set(collisions)) {
      for (const id of ids) {
        const entry = entries.get(id);
        if (entry && `${entry.area}/${entry.chapter}` === chapter && String(entry.order) === order) {
          entry.issues.push({
            severity: 'warning',
            message: `Order ${order} is used by more than one page in "${chapter}".`,
          });
        }
      }
    }
  }

  const areas = groupAreas(declaredAreas, entries);
  return { folder, rootUri: folder.uri, registryUri, areas, problems, ...sumCounts(entries) };
}

function groupAreas(
  declared: Record<string, RegistryArea>,
  entries: Map<string, PageEntry>
): AreaGroup[] {
  const grouped = new Map<string, Map<string, PageEntry[]>>();
  for (const entry of entries.values()) {
    const chapters = grouped.get(entry.area) ?? new Map<string, PageEntry[]>();
    const pages = chapters.get(entry.chapter) ?? [];
    pages.push(entry);
    chapters.set(entry.chapter, pages);
    grouped.set(entry.area, chapters);
  }

  const areaNames = new Set([...Object.keys(declared), ...grouped.keys()]);
  const areas: AreaGroup[] = [];

  for (const area of areaNames) {
    const chapters: ChapterGroup[] = [...(grouped.get(area) ?? new Map<string, PageEntry[]>())]
      .map(([chapter, pages]) => ({
        chapter,
        pages: [...pages].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title)),
      }))
      .sort((a, b) => a.pages[0].order - b.pages[0].order || a.chapter.localeCompare(b.chapter));

    const pages = chapters.flatMap((chapter) => chapter.pages);
    areas.push({
      area,
      title: declared[area]?.title ?? area,
      audience: declared[area]?.audience ?? 'user',
      noindex: declared[area]?.noindex === true,
      chapters,
      ...sumCounts(new Map(pages.map((page) => [page.id, page]))),
    });
  }

  return areas.sort((a, b) => a.area.localeCompare(b.area));
}

function sumCounts(entries: Map<string, PageEntry>): Counts {
  const pages = [...entries.values()];
  const errors = pages.reduce((sum, page) => sum + page.issues.filter((i) => i.severity === 'error').length, 0);
  const warnings = pages.reduce((sum, page) => sum + page.issues.filter((i) => i.severity === 'warning').length, 0);
  return {
    pages: pages.length,
    issues: errors + warnings,
    errors,
    warnings,
    neverReviewed: pages.filter((page) => !page.reviewed).length,
    unshipped: pages.filter((page) => !page.ship).length,
  };
}

function append(map: Map<string, string[]>, key: string, value: string): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
