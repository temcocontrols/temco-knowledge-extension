// The product repo's own builds, invoked rather than reimplemented.
//
// `docs/architecture.md`: the extension orchestrates the publishing pipeline, it never replaces it. So this
// finds the script in the repository's own `package.json`, runs it as an ordinary VS Code task — visible in the
// terminal, cancellable, and stopped with the same button as any other task — and then judges the *artifact*.
// That last part is not caution for its own sake: the CHM build's exit code has never been trustworthy
// (`07-offline-pdf-chm.md`), and a build that reports success without producing a file has not succeeded.
//
// One thing this deliberately never does: run the deploying form of the help build. That form copies the CHM
// into a product installation, and building is not shipping.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DocsRoot } from './registry';

/** Folders never worth walking: build caches and clones, not artifacts. */
const SKIP = new Set(['node_modules', '.git', '.vs', 'out', 'target', '.venv', 'dist_cache']);

/** The site build, as the product repository names it. A rename there is reported, never guessed around. */
const SITE_SCRIPTS = ['docs:site', 'docs:build'];
/** Only the non-deploying help build is invoked; see the note at the top. */
const HELP_SCRIPTS = ['build:help:dry'];

export function registerBuildCommands(
  context: vscode.ExtensionContext,
  roots: () => readonly DocsRoot[],
  output: vscode.OutputChannel
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.buildSite', async () => {
      const root = await pickRoot(roots(), 'build the site for');
      if (!root) {
        return;
      }
      await build(root, output, {
        label: 'the site build',
        scripts: SITE_SCRIPTS,
        missing: 'This repository has no `docs:site` (or `docs:build`) script, so nothing was run.',
        // docfx.json writes here: the generated project names its destination `../dist/docs`.
        roots: [path.join(root.folder.uri.fsPath, 'dist', 'docs')],
        siblingHelpDocs: false,
        pattern: /\.(html|json)$/i,
      });
    }),

    vscode.commands.registerCommand('temcoKnowledge.buildHelp', async () => {
      const root = await pickRoot(roots(), 'build the offline help for');
      if (!root) {
        return;
      }
      const scripts = scriptsOf(root);
      if (scripts && !scripts['build:help:dry']) {
        void vscode.window.showWarningMessage(
          scripts['build:help']
            ? 'Temco Knowledge: this repository only has the deploying help build (`build:help`), which copies the ' +
              'CHM into a product installation. Nothing was run — that act is not this extension\'s to make.'
            : 'Temco Knowledge: this repository has no `build:help:dry` script, so nothing was run.'
        );
        return;
      }
      await build(root, output, {
        label: 'the offline help build',
        scripts: HELP_SCRIPTS,
        missing: 'This repository has no `build:help:dry` script, so nothing was run.',
        // The CHM lands inside the repository or in a `HelpDocs` folder beside it — the build's own
        // configuration decides which, so both are looked at.
        roots: [root.folder.uri.fsPath],
        siblingHelpDocs: true,
        pattern: /\.chm$/i,
      });
    })
  );
}

interface Recipe {
  label: string;
  scripts: readonly string[];
  missing: string;
  /** Where the build writes, searched deeply. */
  roots: readonly string[];
  /** Whether a `HelpDocs` folder beside the repository may be searched too. */
  siblingHelpDocs: boolean;
  pattern: RegExp;
}

/**
 * Runs one build and reports what it produced.
 *
 * The exit code is printed but never used as the verdict: what counts is a file that did not exist before and
 * does now.
 */
async function build(root: DocsRoot, output: vscode.OutputChannel, recipe: Recipe): Promise<void> {
  const scripts = scriptsOf(root);
  if (!scripts) {
    void vscode.window.showWarningMessage(
      `Temco Knowledge: ${vscode.workspace.asRelativePath(root.folder.uri)} has no package.json, so there is no build to invoke.`
    );
    return;
  }
  const script = recipe.scripts.find((name) => typeof scripts[name] === 'string');
  if (!script) {
    void vscode.window.showWarningMessage(`Temco Knowledge: ${recipe.missing}`);
    return;
  }

  const started = Date.now();
  output.appendLine('');
  output.appendLine(`Building ${recipe.label} in ${root.folder.name}: npm run ${script}`);
  const exit = await runTask(root, script);
  output.appendLine(`npm run ${script} exited with ${exit === undefined ? 'no code' : exit}`);

  const files = findArtifacts(recipe, started);
  output.appendLine(
    files.length > 0 ? `Produced ${files.length} file(s):` : 'No artifact newer than this run was found.'
  );
  for (const file of files.slice(0, 20)) {
    output.appendLine(`  ${file} · ${describe(file)}`);
  }
  output.show(true);

  const answer =
    files.length > 0
      ? await vscode.window.showInformationMessage(
          `Temco Knowledge: ${recipe.label} left ${files.length} file(s) — ${vscode.workspace.asRelativePath(files[0])}`,
          'Reveal'
        )
      : await vscode.window.showWarningMessage(
          `Temco Knowledge: ${recipe.label} ran but produced no new file. The terminal above says why.`,
          'Show the report'
        );

  if (answer === 'Reveal' && files[0]) {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(files[0]));
  }
  if (answer === 'Show the report') {
    output.show(true);
  }
}

/**
 * Runs the repository's own `docs:owed` check.
 *
 * Invoked, never reimplemented — and never interpreted. What is owed is a *documentation gate* the product
 * repository owns, with its own waivers and its own expiry dates (`11-review-and-cicd.md`), so this runs the
 * script as a task (visible, cancellable, in the terminal) and reports only what a run is: where, when, and the
 * exit code. Reading its output to decide anything here would be the second opinion the design forbids.
 */
export async function runOwed(
  roots: readonly DocsRoot[],
  output: vscode.OutputChannel
): Promise<ScriptRun | undefined> {
  return await runScript(roots, output, 'docs:owed');
}

/**
 * The repository's own maintenance scripts this application is willing to run.
 *
 * An allowlist rather than a parameter, because the caller on the other side of a webview must not be able to
 * name *any* npm script: `build:help` deploys into a product installation, and `docs:clean` rewrites page prose
 * rather than reporting on it. Invoking the generator is in a different class: it writes the files it exists to
 * write, in its own format, and this application never reimplements any of it.
 */
export const OFFERED_SCRIPTS: readonly { id: string; label: string; detail: string }[] = [
  {
    id: 'docs:registry',
    label: 'Regenerate the index',
    detail: 'the generator: index.json · page-meta.json · the navbar · toc.yml · docfx.json · _admin',
  },
  {
    id: 'docs:verify',
    label: 'Run the gates',
    detail: 'registry:check + the blocking audit + the media check — what a pull request has to pass',
  },
  {
    id: 'docs:media:check',
    label: 'The media audit',
    detail: 'image names, reading order, size, duplicates, and files no page references',
  },
  {
    id: 'docs:owed',
    label: 'Documentation owed',
    detail: 'the product repository own gate — a claimed feature changed and its page did not',
  },
];

/** What one run of one script left behind. A run is a fact: where, when, which script, what it exited with. */
export interface ScriptRun {
  folder: string;
  script: string;
  exit: number | undefined;
  at: string;
  /** Files the generator rewrote, by name — only ever filled in for `docs:registry`, whose output is files. */
  rewritten: string[];
}

/**
 * Runs one of the {@link OFFERED_SCRIPTS}, in the first folder being read that has it.
 *
 * One folder, not all of them: a check reports on *a* repository, and running the same check in three clones
 * produces three verdicts that nobody asked to compare.
 */
export async function runScript(
  roots: readonly DocsRoot[],
  output: vscode.OutputChannel,
  id: string
): Promise<ScriptRun | undefined> {
  const offered = OFFERED_SCRIPTS.find((script) => script.id === id);
  if (!offered) {
    return undefined;
  }

  const candidates = roots.filter((root) => root.origin !== 'catalog');
  if (candidates.length === 0) {
    void vscode.window.showInformationMessage(
      'Temco Knowledge: nothing on this machine is being read, so there is no repository to run that in. ' +
        'A source read over the API has no working tree to check in.'
    );
    return undefined;
  }

  output.appendLine('');
  for (const root of candidates) {
    const scripts = scriptsOf(root);
    if (typeof scripts?.[id] !== 'string') {
      output.appendLine(`  ${root.folder.name}: no \`${id}\` script — nothing was run there.`);
      continue;
    }

    // The generator's output *is* files, so the honest report of a regeneration is which of them it rewrote.
    const before = generated(root);
    output.appendLine(`${offered.label} in ${root.folder.name}: npm run ${id}`);
    const exit = await runTask(root, id);
    output.appendLine(`npm run ${id} exited with ${exit === undefined ? 'no code' : exit}`);

    const rewritten =
      id === 'docs:registry'
        ? [...generated(root)]
            .filter(([name, stamp]) => before.get(name) !== stamp)
            .map(([name]) => name)
        : [];
    for (const name of rewritten) {
      output.appendLine(`  rewritten: ${name}`);
    }
    output.show(true);

    return {
      folder: root.folder.name,
      script: id,
      exit,
      at: new Date().toISOString().slice(0, 16).replace('T', ' '),
      rewritten,
    };
  }

  output.appendLine(`  No repository being read has a \`${id}\` script.`);
  output.show(true);
  void vscode.window.showInformationMessage(
    `Temco Knowledge: no repository being read has a \`${id}\` script, so there is nothing to run.`
  );
  return undefined;
}

/** The files the generator owns, with a stamp that changes exactly when one of them is rewritten. */
const GENERATED = [
  'docs/help/index.json',
  'docs/help/page-meta.json',
  'docs/help/registry.json',
  'docs/docfx.json',
  'docs/toc.yml',
  'docs/_admin/index.md',
];

function generated(root: DocsRoot): Map<string, string> {
  const stamps = new Map<string, string>();
  for (const name of GENERATED) {
    const file = path.join(root.folder.uri.fsPath, ...name.split('/'));
    try {
      const stat = fs.statSync(file);
      stamps.set(name, `${stat.mtimeMs}:${stat.size}`);
    } catch {
      stamps.set(name, 'missing');
    }
  }
  return stamps;
}

/** The offered scripts the folders being read actually have — what may be offered to run, and nothing else. */
export function scriptsIn(roots: readonly DocsRoot[]): Set<string> {
  const names = new Set<string>();
  for (const root of roots) {
    if (root.origin === 'catalog') {
      continue;
    }
    for (const name of Object.keys(scriptsOf(root) ?? {})) {
      names.add(name);
    }
  }
  return names;
}

/** The commands a person reaches for without opening a page: the generator, and the palette's list of all four. */
export function registerScriptCommands(
  context: vscode.ExtensionContext,
  roots: () => readonly DocsRoot[],
  output: vscode.OutputChannel,
  refresh: () => void
): void {
  const run = async (id: string): Promise<void> => {
    const result = await runScript(roots(), output, id);
    // The generator rewrites what the tree reads — index.json carries the headings, the provenance and the
    // stale verdict — so a regeneration that is not followed by a re-read would leave the view stale.
    if (result !== undefined || id !== 'docs:registry') {
      refresh();
    }

    if (result === undefined) {
      return;
    }
    const exit = result.exit === undefined ? 'no exit code' : `exit ${result.exit}`;
    void vscode.window.showInformationMessage(
      `Temco Knowledge: npm run ${id} in ${result.folder} — ${exit}` +
        (result.rewritten.length > 0 ? `, rewrote ${result.rewritten.length} file(s)` : '') +
        '. Its own output is the verdict.'
    );
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.runScript', async (target?: unknown) => {
      const wanted = typeof target === 'string' ? target : (target as { id?: string } | undefined)?.id;
      if (wanted !== undefined && wanted.length > 0) {
        await run(wanted);
        return;
      }

      // No argument — from the palette or the Library's title bar: offer only what this repository actually has.
      const names = scriptsIn(roots());
      const offered = OFFERED_SCRIPTS.filter((script) => names.has(script.id));
      if (offered.length === 0) {
        void vscode.window.showInformationMessage(
          'Temco Knowledge: the repository being read has none of these scripts — ' +
            OFFERED_SCRIPTS.map((script) => `\`${script.id}\``).join(', ') +
            '.'
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        offered.map((script) => ({ label: script.label, detail: script.detail, description: script.id, id: script.id })),
        { title: 'Run one of the repository’s own scripts' }
      );
      if (picked) {
        await run(picked.id);
      }
    }),
    vscode.commands.registerCommand('temcoKnowledge.runOwed', async () => run('docs:owed'))
  );
}

/** Every file the run produced: newer than it started, and matching the recipe. */
function findArtifacts(recipe: Recipe, since: number): string[] {
  const found: string[] = [];
  for (const directory of recipe.roots) {
    walk(directory, since, recipe.pattern, found, 8);
  }
  if (recipe.siblingHelpDocs) {
    for (const directory of siblingHelpDocs(recipe.roots[0] ?? '')) {
      walk(directory, since, recipe.pattern, found, 6);
    }
  }
  return found.sort((a, b) => modified(b) - modified(a));
}

function walk(directory: string, since: number, pattern: RegExp, found: string[], depth: number): void {
  if (depth < 0) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) {
        continue;
      }
      walk(full, since, pattern, found, depth - 1);
    } else if (pattern.test(entry.name) && modified(full) >= since) {
      found.push(full);
    }
  }
}

/**
 * `HelpDocs` folders beside the repository — where the help build writes when it does not deploy.
 *
 * Found by name rather than by naming another repository: this must not know the layout of the product's
 * other repositories, only that the convention exists.
 */
function siblingHelpDocs(folder: string): string[] {
  const parent = path.dirname(folder);
  const found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(parent, entry.name, 'HelpDocs');
    if (fs.existsSync(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

function runTask(root: DocsRoot, script: string): Promise<number | undefined> {
  // The scope is the workspace folder when it is one: a source of a project can be a path this window has
  // closed, and a task must still be runnable there, so anything else runs unscoped rather than being refused.
  const folder = (vscode.workspace.workspaceFolders ?? []).find(
    (one) => one.uri.toString() === root.rootUri.toString()
  );
  const task = new vscode.Task(
    { type: 'temcoKnowledge', script },
    folder ?? vscode.TaskScope.Global,
    `${root.folder.name}: ${script}`,
    'temcoKnowledge',
    new vscode.ShellExecution('npm', ['run', script], { cwd: root.folder.uri.fsPath })
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Shared,
    clear: false,
  };
  return new Promise<number | undefined>((resolve) => {
    vscode.tasks.executeTask(task).then(
      (execution) => {
        const ended = vscode.tasks.onDidEndTaskProcess((event) => {
          if (event.execution === execution) {
            ended.dispose();
            resolve(event.exitCode);
          }
        });
      },
      () => resolve(undefined)
    );
  });
}

async function pickRoot(roots: readonly DocsRoot[], what: string): Promise<DocsRoot | undefined> {
  if (roots.length === 0) {
    void vscode.window.showWarningMessage(
      `Temco Knowledge: open the repository you want to ${what} — none of the open folders has docs/help/registry.json.`
    );
    return undefined;
  }
  if (roots.length === 1) {
    return roots[0];
  }
  const picked = await vscode.window.showQuickPick(
    roots.map((root) => ({ label: root.folder.name, description: `${root.pages} pages`, root })),
    { title: `Temco Knowledge: which repository do you want to ${what}?` }
  );
  return picked?.root;
}

/** The repository's own scripts — the only commands this extension is willing to run. */
function scriptsOf(root: DocsRoot): Record<string, string> | undefined {
  const file = path.join(root.folder.uri.fsPath, 'package.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return undefined;
  }
}

function describe(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${Math.round(stat.size / 1024)} KB · ${stat.mtime.toLocaleTimeString()}`;
  } catch {
    return 'size unknown';
  }
}

function modified(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
