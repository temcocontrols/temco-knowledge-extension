// Writing `docs/help/registry.json`, one named value at a time.
//
// The file is *generated*: the product repository's own `scripts/docs-registry.mjs` walks the Markdown tree,
// builds an entry for every page it finds, merges the entries already in the file over the top — and writes the
// whole thing with `JSON.stringify(registry, null, 2) + '\n'`. Three consequences shape everything here, and
// each one was read out of that script rather than assumed from the design package:
//
//   * **existing values win**, field by field, so a `title`, `order`, `chapter` or `owner` written here survives
//     the next generation rather than being recomputed — which is the only reason writing one is worth doing;
//   * it is plain JSON, so there are no comments to lose, and the format is two spaces and a trailing newline;
//   * a value nobody curated is filled in by the generator: a new page's title comes from its first `#`, its
//     `area` and `chapter` from its path, and its `order` from 10, 20, 30… inside the chapter. **So creating a
//     page needs no entry written by us at all** — the repository's own script adds it.
//
// What this never does: rewrite the file for a change nobody asked for, touch an entry it was not pointed at,
// or write a value that was not named in the confirmation before it. `save()` writes only when something
// changed, and the rendered text is the same shape the generator itself writes, so an edit is the lines that
// changed and nothing else.
//
// Two things it deliberately does not do: renumber a chapter (that is the generator's job, and it does it for
// every entry nobody curated) and touch `docs:registry` — running the generator is a command, not a side effect.

import * as vscode from 'vscode';

interface RegistryEntry {
  [key: string]: unknown;
}

/** One value this edit will change, kept so a confirmation can name it before anything is written. */
export interface RegistryChange {
  id: string;
  field: string;
  from: unknown;
  to: unknown;
}

function isEntry(value: unknown): value is RegistryEntry {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class RegistryEdit {
  private readonly changes: RegistryChange[] = [];
  /** True when the file on disk uses CRLF — a clone on Windows usually does, and that is kept. */
  private readonly crlf: boolean;

  private constructor(
    private readonly uri: vscode.Uri,
    private readonly data: RegistryEntry,
    private readonly text: string
  ) {
    this.crlf = text.includes('\r\n');
  }

  /**
   * Opens a registry for editing: reads it, parses it, and holds the text it came from.
   *
   * A registry that does not parse is refused in words rather than repaired: it is the repository's file, its
   * own generator wrote it, and a tool that "fixes" JSON in a product repository is a tool nobody can trust.
   */
  static async open(uri: vscode.Uri): Promise<RegistryEdit | undefined> {
    try {
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      const data: unknown = JSON.parse(text);
      if (!isEntry(data)) {
        throw new Error('the file is not a JSON object');
      }
      return new RegistryEdit(uri, data, text);
    } catch (error) {
      void vscode.window.showWarningMessage(
        `Temco Knowledge: ${vscode.workspace.asRelativePath(uri)} could not be read, so nothing was changed. (${String(error)})`
      );
      return undefined;
    }
  }

  get file(): vscode.Uri {
    return this.uri;
  }

  /** The text as it was read — kept so a caller can show what a write would touch. */
  get original(): string {
    return this.text;
  }

  entry(id: string): RegistryEntry | undefined {
    const pages = this.pages();
    const entry = pages?.[id];
    return isEntry(entry) ? entry : undefined;
  }

  /** Sets one field, and remembers the value it replaced. Returns false when there is nothing to write. */
  set(id: string, field: string, value: unknown): boolean {
    const entry = this.entry(id);
    if (!entry) {
      return false;
    }
    const from = entry[field];
    if (JSON.stringify(from) === JSON.stringify(value)) {
      return false;
    }
    entry[field] = value;
    this.changes.push({ id, field, from, to: value });
    return true;
  }

  get changed(): readonly RegistryChange[] {
    return this.changes;
  }

  /**
   * The pages of one chapter, in the order the registry puts them.
   *
   * `chapter` and `area` are read from the entry when they are there — that is the curated value, and it is what
   * the tree shows — and from the id when they are not, because the generator derives both from the path.
   */
  chapterPages(area: string, chapter: string): { id: string; order: number }[] {
    const pages = this.pages() ?? {};
    const rows: { id: string; order: number }[] = [];
    for (const [id, value] of Object.entries(pages)) {
      if (!isEntry(value)) {
        continue;
      }
      const parts = id.split('/');
      const ownArea = typeof value['area'] === 'string' ? value['area'] : parts[0];
      const ownChapter = typeof value['chapter'] === 'string' ? value['chapter'] : parts[1] ?? '(root)';
      if (ownArea === area && ownChapter === chapter) {
        rows.push({ id, order: typeof value['order'] === 'number' ? value['order'] : 0 });
      }
    }
    return rows.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  }

  /**
   * The text this edit would write.
   *
   * The same shape the repository's generator writes — two-space indentation, one trailing newline — **and the
   * file's own line endings**. That second half is not a detail: a clone checked out on Windows has CRLF in the
   * file, the generator writes LF, and git normalises between them — so writing LF into a CRLF file changes
   * every line in the working tree for a change to one number, which is exactly the diff this class exists to
   * avoid. With both halves right, a read-and-write of an unchanged registry is byte-for-byte the file it came
   * from; `docs/editor-design.md` records the check that proves it on the real 318-page registry.
   */
  render(): string {
    const text = `${JSON.stringify(this.data, null, 2)}\n`;
    return this.crlf ? text.replace(/\n/g, '\r\n') : text;
  }

  async save(): Promise<void> {
    if (this.changes.length === 0) {
      return;
    }
    await vscode.workspace.fs.writeFile(this.uri, Buffer.from(this.render(), 'utf8'));
  }

  private pages(): Record<string, unknown> | undefined {
    const pages = this.data['pages'];
    return isEntry(pages) ? pages : undefined;
  }
}

/** Names a change the way a person reads it: `pages["a/b"].order 20 → 30`. */
export function describeChange(change: RegistryChange): string {
  const from = change.from === undefined ? '(not set)' : JSON.stringify(change.from);
  return `pages["${change.id}"].${change.field}  ${from} → ${JSON.stringify(change.to)}`;
}
