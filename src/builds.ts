// The product repo's own builds, invoked rather than reimplemented.
//
// `docs/architecture.md`: the extension orchestrates the publishing pipeline, it never replaces it. So this
// finds the script in the repository's own `package.json`, runs it as an ordinary VS Code task — visible in the
// terminal, cancellable, and stopped with the same button as any other task — and then judges the *artifact*.
// That last part is not caution for its own sake: the CHM build's exit code has never been trustworthy
// (`07-offline-pdf-chm.md`), and a build that reports success without producing a file has not succeeded.
//
// One thing this deliberately never does: run the deploying form of the help build. That form copies the CHM
// into a T3000 installation, and building is not shipping.

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
              'CHM into a T3000 installation. Nothing was run — that act is not this extension\'s to make.'
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
  const task = new vscode.Task(
    { type: 'temcoKnowledge', script },
    root.folder,
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
