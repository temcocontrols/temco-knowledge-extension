// Building a *project*, as opposed to building an open folder.
//
// `src/builds.ts` answers "build what is open, the way the repository builds it". This answers "build what I
// am managing" — it takes the project's own recipe (the engine and the outputs chosen on the edit page), turns
// it into the repository's own script name, runs that script as a task, and records the files it left behind in
// the catalog so the Builds tab has something to show next time.
//
// Two rules are inherited from `builds.ts` and not re-decided here:
//   * the exit code is printed but never trusted — a file that did not exist before and does now is the verdict
//   * the deploying form of the help build is never invoked. Building is not shipping.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Catalog, CatalogUnavailable } from './catalog/store';
import { slugOf } from './projectPage';

/** The script names, per output. A rename in the product repository is reported, never guessed around. */
const SCRIPTS: Record<string, readonly string[]> = {
  chm: ['build:help:dry'],
  site: ['docs:site', 'docs:build'],
  html: ['docs:site', 'docs:build'],
  pdf: ['build:help:dry', 'docs:pdf'],
};

/**
 * The generator, run first when the repository has one.
 *
 * It is what writes `docs/help/registry.json`'s neighbours — the index, the per-page metadata, the navbar — and
 * therefore what makes headings, provenance and the stale verdict exist at all. Building without it produces a
 * site that is missing whatever has changed since the last time someone ran it, which is the same as producing
 * a wrong one. Invoked, never reimplemented: it is the repository's own script.
 */
const GENERATOR = ['docs:registry'];
const SKIP = new Set(['node_modules', '.git', '.vs', 'out', 'target', '.venv', 'dist_cache']);

export function registerProjectBuildCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('temcoKnowledge.buildProject', (slug?: string) => buildProject(context, output, slug))
  );
}

async function buildProject(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  wanted?: string
): Promise<void> {
  let catalog: Catalog | undefined;
  try {
    catalog = await Catalog.open(context);
    const projects = catalog.documents();
    if (projects.length === 0) {
      void vscode.window.showInformationMessage('Temco Knowledge: no projects to build yet.');
      return;
    }

    const slug = wanted !== undefined ? slugOf(wanted) : (await pick(projects))?.slug;
    if (!slug) {
      return;
    }
    const detail = catalog.document(slug);
    if (!detail) {
      void vscode.window.showWarningMessage(`Temco Knowledge: ${slug} is not in the Library any more.`);
      return;
    }

    const wanted_ = scriptFor(detail.outputs, detail.engine);
    if (wanted_.length === 0) {
      void vscode.window.showWarningMessage(
        `Temco Knowledge: ${detail.name} has no output chosen, so there is nothing to build. ` +
          'Edit the project and say what it should produce.'
      );
      return;
    }

    // Where it runs: a source of this project that is a folder on this machine, and that has such a script.
    const folder = folderFor(catalog, slug);
    if (!folder) {
      void vscode.window.showWarningMessage(
        `Temco Knowledge: none of ${detail.name}'s sources is a folder on this machine, so its build script ` +
          'cannot be run from here. A source read over the API has to be cloned before it can be built.'
      );
      return;
    }

    const scripts = scriptsOf(folder);
    const script = wanted_.find((name) => scripts[name] !== undefined);
    if (!script) {
      void vscode.window.showWarningMessage(
        `Temco Knowledge: ${path.basename(folder)} has no ${wanted_.map((name) => `\`${name}\``).join(' or ')} ` +
          'script, so nothing was run.'
      );
      return;
    }

    const buildId = catalog.startBuild(slug);
    const started = Date.now();
    output.appendLine('');

    // The generator first, when there is one: it is what the output script reads its structure from.
    const generator = GENERATOR.find((name) => scripts[name] !== undefined);
    if (generator !== undefined) {
      output.appendLine(`Building ${detail.name}: npm run ${generator} in ${folder} (the generator first)`);
      const generated = await runTask(folder, generator);
      output.appendLine(`npm run ${generator} exited with ${generated === undefined ? 'no code' : generated}`);
    } else {
      output.appendLine(
        `Building ${detail.name}: npm run ${script} in ${folder} — no ${GENERATOR.map((name) => `\`${name}\``).join(' or ')} ` +
          'script, so what is built is whatever the last run of the generator left behind.'
      );
    }

    const exit = await runTask(folder, script);
    output.appendLine(`npm run ${script} exited with ${exit === undefined ? 'no code' : exit}`);

    const produced = findArtifacts(folder, detail.outputs, started);
    output.appendLine(
      produced.length > 0 ? `Produced ${produced.length} file(s):` : 'No file newer than this run was found.'
    );
    for (const file of produced.slice(0, 20)) {
      output.appendLine(`  ${file} · ${describe(file)}`);
    }
    output.show(true);

    const kind = detail.outputs[0] ?? 'output';
    for (const file of produced) {
      catalog.recordArtifact(slug, { kind, path: file, bytes: sizeOf(file), buildId });
    }
    catalog.finishBuild(buildId, produced.length > 0 ? 'produced' : 'nothing new');

    if (produced.length > 0) {
      const answer = await vscode.window.showInformationMessage(
        `Temco Knowledge: ${detail.name} left ${produced.length} file(s) — ${path.basename(produced[0])}`,
        'Reveal'
      );
      if (answer === 'Reveal') {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(produced[0]));
      }
    } else {
      void vscode.window.showWarningMessage(
        `Temco Knowledge: ${detail.name} ran but produced no new file. The terminal says why.`
      );
    }
  } catch (error) {
    const message = error instanceof CatalogUnavailable ? error.message : String(error);
    void vscode.window.showErrorMessage(`Temco Knowledge: ${message}`);
  } finally {
    catalog?.close();
  }
}

async function pick(
  projects: { name: string; version?: string; sources: number }[]
): Promise<{ slug: string } | undefined> {
  if (projects.length === 1) {
    return { slug: slugOf(projects[0].name) };
  }
  const chosen = await vscode.window.showQuickPick(
    projects.map((project) => ({
      label: project.name,
      description: [
        project.version ? `v${project.version}` : '',
        `${project.sources} source${project.sources === 1 ? '' : 's'}`,
      ]
        .filter(Boolean)
        .join(' · '),
      slug: slugOf(project.name),
    })),
    { title: 'Build which project?' }
  );
  return chosen ? { slug: chosen.slug } : undefined;
}

/** Which of the repository's scripts produces the outputs this project asked for. */
function scriptFor(outputs: readonly string[], engine: string | undefined): readonly string[] {
  for (const output of outputs) {
    const scripts = SCRIPTS[output.toLowerCase()];
    if (scripts) {
      return scripts;
    }
  }
  // An engine with no output named is still an intention to build something: docfx writes a site.
  if (engine === 'docfx') {
    return SCRIPTS.site;
  }
  return [];
}

/** The folder the script would run in: a source of this project that is on this machine and has a package.json. */
function folderFor(catalog: Catalog, slug: string): string | undefined {
  const cited = catalog.documentSources(slug).map((source) => source.name);
  for (const row of catalog.sources()) {
    if (!cited.includes(row.name)) {
      continue;
    }
    const detail = catalog.source(row.slug);
    if (detail?.path && fs.existsSync(path.join(detail.path, 'package.json'))) {
      return detail.path;
    }
  }
  return undefined;
}

function runTask(cwd: string, script: string): Promise<number | undefined> {
  const folder = vscode.workspace.workspaceFolders?.find((one) => cwd.startsWith(one.uri.fsPath));
  const task = new vscode.Task(
    { type: 'temcoKnowledge', script },
    folder ?? vscode.TaskScope.Global,
    script,
    'temcoKnowledge',
    new vscode.ShellExecution('npm', ['run', script], { cwd })
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

/**
 * What the run left behind.
 *
 * A CHM lands inside the repository or in a `HelpDocs` folder beside it; a site lands in `dist/docs` or
 * `docs/_site`. All four are looked at, and the rule that decides is the same one `builds.ts` uses: newer than
 * this run started.
 */
function findArtifacts(folder: string, outputs: readonly string[], since: number): string[] {
  const patterns = patternsFor(outputs);
  const roots = [
    folder,
    path.join(folder, 'dist', 'docs'),
    path.join(folder, 'docs', '_site'),
    ...siblingHelpDocs(folder),
  ];
  const found: string[] = [];
  for (const root of roots) {
    for (const pattern of patterns) {
      walk(root, since, pattern, found, 8);
    }
  }
  return [...new Set(found)].sort((a, b) => modified(b) - modified(a));
}

function patternsFor(outputs: readonly string[]): RegExp[] {
  const patterns: RegExp[] = [];
  for (const output of outputs) {
    if (output.toLowerCase() === 'chm') {
      patterns.push(/\.chm$/i);
    } else if (output.toLowerCase() === 'pdf') {
      patterns.push(/\.pdf$/i);
    } else {
      patterns.push(/\.html$/i);
    }
  }
  return patterns.length > 0 ? patterns : [/\.(html|chm|pdf)$/i];
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

/** `HelpDocs` folders beside the repository — where the help build writes when it does not deploy. */
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

function scriptsOf(folder: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

function sizeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).size;
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
