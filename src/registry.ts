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

/**
 * The chapter that is the area folder itself.
 *
 * A page whose id has two segments — `t3000/index` — sits directly in `docs/t3000`, and the registry spells its
 * chapter `(root)`. That is the generator's own spelling, not a choice made here; it is named once so that
 * creating a page and pointing at one agree about where the files are.
 */
export const ROOT_CHAPTER = '(root)';

/** The generated neighbours the product repo's generator writes beside the registry. */
const INDEX_RELATIVE_PATH = ['docs', 'help', 'index.json'];
const PAGE_META_RELATIVE_PATH = ['docs', 'help', 'page-meta.json'];

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

/** A problem that belongs to a whole file; `registry.json` unless the generator's file is at fault. */
export interface RootProblem extends Issue {
  uri?: vscode.Uri;
}

/** The last commit that touched a page, as the generator recorded it. */
export interface GitInfo {
  author?: string;
  sha?: string;
  date?: string;
}

/**
 * What the generator knows about a page and the registry does not: when it last changed, the headings it
 * carries, and whether its `code` moved on since the page was last reviewed.
 *
 * `stale` is the product repo's verdict, computed there from the page's `code` globs. It is read, never
 * recomputed here — a second answer to that question would be worse than no answer.
 */
export interface Provenance {
  git: GitInfo | null;
  updated: string | null;
  stale: boolean;
  headings: string[];
  /** The code globs the page claims — what its staleness is judged against, and what a draft reads history for. */
  code: string[];
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
  /** Search facets from the registry: what the page is about, in the maintainer's own words. */
  tags: string[];
  keywords: string[];
  uri: vscode.Uri;
  exists: boolean;
  issues: Issue[];
  /** What the generator knows about this page; undefined when neither neighbour file could be read. */
  provenance?: Provenance;
  /**
   * Where this entry came from.
   *
   * `workspace` (the default) is a registry read from a folder, with the working tree behind it, so the checks
   * and the provenance are real. `catalog` is what a *read* recorded of a source that is not on this machine:
   * the page and its owner are known, and nothing else is knowable — so nothing else may be claimed.
   */
  origin?: 'workspace' | 'catalog';
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
  /** Problems that belong to one whole file — `registry.json` unless the generator's file is at fault. */
  problems: RootProblem[];
  /** Where this root came from: a folder read here, or what a read recorded in the catalog. */
  origin?: 'workspace' | 'catalog';
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

  /** Page id (`area/chapter/page`) to the Markdown file that must exist for it. */
export function pageUri(rootUri: vscode.Uri, id: string): vscode.Uri {
  const segments = id.split('/');
  const file = segments.pop() ?? id;
  return vscode.Uri.joinPath(contentUri(rootUri, ...segments), `${file}.md`);
}

/** A folder under a repository's `docs/` — the one path rule the platform owns, named in one place. */
export function contentUri(rootUri: vscode.Uri, ...path: string[]): vscode.Uri {
  return vscode.Uri.joinPath(rootUri, ...CONTENT_RELATIVE_PATH, ...path);
}

export function registryUriFor(folder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(folder.uri, ...REGISTRY_RELATIVE_PATH);
}

export function collectPages(root: DocsRoot): PageEntry[] {
  return root.areas.flatMap((area) => area.chapters.flatMap((chapter) => chapter.pages));
}

/** The registered page a document belongs to, when it is one of them. */
export function pageForUri(roots: readonly DocsRoot[], uri: vscode.Uri): PageEntry | undefined {
  const wanted = uri.toString();
  for (const root of roots) {
    const page = collectPages(root).find((entry) => entry.uri.toString() === wanted);
    if (page) {
      return page;
    }
  }
  return undefined;
}

/**
 * A folder that is not open in the window, as a workspace folder.
 *
 * `loadDocsRoot` needs a `uri` and a `name`, which is all a `WorkspaceFolder` is — so a path a **project**
 * cites is read with the full checks even when the window has that folder closed. That is what lets the
 * Workspace view follow the project instead of the window.
 */
export function folderForPath(path: string, name: string): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file(path), name, index: 0 };
}

/** A page as a read recorded it — the four facts a tree can honestly show. */
export interface DeclaredPage {
  id: string;
  title?: string;
  owner?: string;
}

/**
 * A root built from what a read recorded, for a source that is not a folder on this machine.
 *
 * The tree's shape is the registry's shape, so a source read over the API gets the same
 * areas → chapters → pages as a local one, from the same `PageEntry` type. What it cannot have is the *checks*:
 * those need the working tree. So `issues` is empty, `exists` is true because nothing here can prove
 * otherwise, and every page carries `origin: 'catalog'` — the view says where a page came from rather than
 * letting an unchecked page look like a checked one.
 */
export function rootFromDeclared(name: string, pages: readonly DeclaredPage[]): DocsRoot {
  const areas = new Map<string, Map<string, PageEntry[]>>();

  for (const page of pages) {
    const segments = page.id.split('/');
    const area = segments[0] ?? '';
    const chapter = segments.length > 2 ? segments[1] ?? '' : '';
    const entry: PageEntry = {
      id: page.id,
      title: page.title ?? page.id,
      area,
      chapter,
      order: 0,
      audience: '',
      ship: true,
      owner: page.owner ?? '',
      reviewed: null,
      tags: [],
      keywords: [],
      // Not a file uri: these pages are not on this machine, and nothing may try to open them as if they were.
      uri: vscode.Uri.from({ scheme: 'temco-source', path: `/${page.id}` }),
      exists: true,
      issues: [],
      origin: 'catalog',
    };
    const chapters = areas.get(area) ?? new Map<string, PageEntry[]>();
    chapters.set(chapter, [...(chapters.get(chapter) ?? []), entry]);
    areas.set(area, chapters);
  }

  const groups: AreaGroup[] = [...areas].map(([area, chapters]) => {
    const grouped: ChapterGroup[] = [...chapters].map(([chapter, entries]) => ({
      chapter: chapter || area,
      pages: entries.sort((a, b) => a.id.localeCompare(b.id)),
    }));
    return {
      area,
      title: area,
      audience: '',
      noindex: false,
      chapters: grouped,
      ...countEntries(grouped.flatMap((group) => group.pages)),
    };
  });

  const folderUri = vscode.Uri.from({ scheme: 'temco-source', path: `/${name}` });
  return {
    folder: { uri: folderUri, name, index: 0 },
    rootUri: folderUri,
    registryUri: vscode.Uri.from({ scheme: 'temco-source', path: `/${name}/docs/help/registry.json` }),
    areas: groups.sort((a, b) => a.area.localeCompare(b.area)),
    problems: [],
    ...countEntries(pages.map(() => ({ exists: true, issues: [] as Issue[] }))),
    origin: 'catalog',
  };
}

function countEntries(entries: readonly Pick<PageEntry, 'exists' | 'issues'>[]): Counts {
  let errors = 0;
  let warnings = 0;
  for (const entry of entries) {
    for (const issue of entry.issues) {
      if (issue.severity === 'error') {
        errors += 1;
      } else {
        warnings += 1;
      }
    }
  }
  return {
    pages: entries.length,
    issues: errors + warnings,
    errors,
    warnings,
    // Nothing recorded a review date, so claiming "never reviewed" would be inventing a fault.
    neverReviewed: 0,
    unshipped: 0,
  };
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
  const problems: RootProblem[] = [];
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
      tags: raw.tags ?? [],
      keywords: raw.keywords ?? [],
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

  // The generated neighbours are optional: without them every check above still runs on its own, only the
  // provenance the items display goes missing.
  for (const [id, provenance] of await loadProvenance(folder.uri, problems)) {
    const entry = entries.get(id);
    if (entry) {
      entry.provenance = provenance;
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

/**
 * Counts the pages the generator marked stale: commits touched the code they claim, after the last review.
 * Reported as a count, never as a problem — staleness is the product repo's own gate, not a fault here.
 */
export function countStale(pages: readonly PageEntry[]): number {
  return pages.filter((page) => page.provenance?.stale === true).length;
}

/** The age past which a page's last change is worth mentioning, in the words the site's own pages use. */
export const STALE_DAYS = 180;

/** How old a date is, in whole days. An absent or unreadable date is `undefined`, never zero. */
export function ageInDays(date: string | null | undefined): number | undefined {
  if (!date) {
    return undefined;
  }
  const at = Date.parse(date);
  return Number.isNaN(at) ? undefined : Math.round((Date.now() - at) / 86_400_000);
}

/** How long ago, in the words the design's mock uses. `undefined` is a fact, not a failure. */
export function ageText(days: number | undefined): string {
  if (days === undefined) {
    return 'unknown';
  }
  if (days < 1) {
    return 'today';
  }
  if (days < 14) {
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (days < 60) {
    return `${Math.round(days / 7)} weeks`;
  }
  if (days < 730) {
    return `${Math.round(days / 30)} months`;
  }
  return `${Math.round(days / 365)} years`;
}

/** `docs/help/index.json` as the generator writes it — only the parts read here. */
interface IndexJson {
  pages?: {
    id?: string;
    git?: GitInfo | null;
    stale?: boolean;
    headings?: unknown[];
    code?: unknown[];
  }[];
}

/** One page's row in `docs/help/page-meta.json`. */
interface PageMetaEntry {
  updated?: string | null;
  sha?: string | null;
  stale?: boolean;
}

/**
 * Reads the two generated neighbours, page id by page id.
 *
 * `index.json` is the richer file: headings, the last commit and the stale verdict. `page-meta.json` is the
 * small one the published page reads, and it can stand in for provenance when `index.json` is not there.
 * Neither is required — a repository that has never run the generator simply has no provenance to show.
 */
async function loadProvenance(rootUri: vscode.Uri, problems: RootProblem[]): Promise<Map<string, Provenance>> {
  const byId = new Map<string, Provenance>();
  const entryFor = (id: string): Provenance => {
    const existing = byId.get(id);
    if (existing) {
      return existing;
    }
    const created: Provenance = { git: null, updated: null, stale: false, headings: [], code: [] };
    byId.set(id, created);
    return created;
  };

  const index = await readNeighbour<IndexJson>(vscode.Uri.joinPath(rootUri, ...INDEX_RELATIVE_PATH), problems);
  for (const page of index?.pages ?? []) {
    if (!page.id) {
      continue;
    }
    const entry = entryFor(page.id);
    entry.git = page.git ?? null;
    entry.updated = page.git?.date ?? null;
    entry.stale = page.stale === true;
    entry.headings = (page.headings ?? []).map(String).filter((heading) => heading.length > 0);
    entry.code = (page.code ?? []).map(String).filter((glob) => glob.length > 0);
  }

  const meta = await readNeighbour<Record<string, PageMetaEntry | undefined>>(
    vscode.Uri.joinPath(rootUri, ...PAGE_META_RELATIVE_PATH),
    problems
  );
  for (const [id, page] of Object.entries(meta ?? {})) {
    if (!page) {
      continue;
    }
    const entry = entryFor(id);
    entry.updated = entry.updated ?? page.updated ?? null;
    entry.git = entry.git ?? (page.sha ? { sha: page.sha } : null);
    entry.stale = entry.stale || page.stale === true;
  }

  return byId;
}

/**
 * Reads one generated neighbour.
 *
 * Absent is a normal state, not a problem. Unreadable is a warning **on that file**, because the fix is to
 * regenerate it in the product repo — and it never becomes an error, since it hides nothing else.
 */
async function readNeighbour<T>(uri: vscode.Uri, problems: RootProblem[]): Promise<T | undefined> {
  if (!(await fileExists(uri))) {
    return undefined;
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as T;
  } catch (error) {
    problems.push({
      severity: 'warning',
      message:
        `${vscode.workspace.asRelativePath(uri)} could not be read (${describe(error)}). ` +
        'Regenerating the documentation files fixes it; everything except provenance still works.',
      uri,
    });
    return undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
