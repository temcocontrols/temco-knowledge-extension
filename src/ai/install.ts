// Getting a runtime and a model onto this machine.
//
// Everything lands in one folder — the extension's global storage unless a setting points elsewhere — and
// nothing is ever written into a repository. A download resumes if it was interrupted, and it is verified
// against the catalog's checksum whenever the catalog pins one.

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as vscode from 'vscode';
import { CatalogEntry, formatBytes } from './catalog';

const MANIFEST_NAME = 'temco-knowledge-models.json';

/** What an installed artifact is, where it is, and which bytes it was. */
export interface InstalledArtifact {
  id: string;
  kind: string;
  file: string;
  /** The checksum the installed file actually had — the catalog's when it pins one. */
  sha256: string;
  bytes: number;
  url: string;
  /** The model file, or the runtime's server executable. */
  path: string;
  installedAt: string;
}

interface Manifest {
  version: number;
  artifacts: Record<string, InstalledArtifact>;
}

/**
 * The folder everything is kept in. A setting may move it — a model folder on a small system drive is a
 * bad idea — but the default is the extension's own storage, which no repository can see.
 */
export function modelRoot(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace
    .getConfiguration('temcoKnowledge')
    .get<string>('ai.modelFolder', '')
    .trim();
  const root = configured.length > 0 ? configured : context.globalStorageUri.fsPath;
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function installedArtifacts(context: vscode.ExtensionContext): InstalledArtifact[] {
  const manifest = readManifest(modelRoot(context));
  return Object.values(manifest.artifacts).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Downloads, verifies and unpacks one catalog entry.
 *
 * An entry the catalog has not pinned is refused unless the user has allowed it *and* confirms here: the
 * first download is the one chance to notice a wrong URL, so it is never silent.
 */
export async function install(
  context: vscode.ExtensionContext,
  entry: CatalogEntry
): Promise<InstalledArtifact> {
  const root = modelRoot(context);
  const manifest = readManifest(root);
  const existing = manifest.artifacts[entry.id];
  if (existing && fs.existsSync(existing.path)) {
    return existing;
  }

  if (!entry.sha256) {
    const allowed = vscode.workspace
      .getConfiguration('temcoKnowledge')
      .get<boolean>('ai.allowUnpinned', false);
    if (!allowed) {
      throw new Error(
        `"${entry.label}" has no pinned checksum yet, so the download could not be verified. ` +
          'Turn on "Temco Knowledge › Ai: Allow Unpinned" to download it anyway — the checksum it turns ' +
          'out to have is recorded, so a later change is still noticed.'
      );
    }
    const answer = await vscode.window.showWarningMessage(
      `"${entry.label}" has no pinned checksum yet.`,
      {
        modal: true,
        detail: `The download cannot be verified against the catalog. It comes from:\n${entry.url}\n\nContinue?`,
      },
      'Download anyway'
    );
    if (answer !== 'Download anyway') {
      throw new Error('the download was cancelled');
    }
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Temco Knowledge: ${entry.label}`,
      cancellable: true,
    },
    async (progress, token) => {
      const archive = path.join(root, entry.file);
      progress.report({ message: `downloading (${formatBytes(entry.bytes)})` });
      const { sha256, bytes } = await download(entry.url, archive, entry.sha256, progress, token);
      token.throwIfCancellationRequested();

      let installedPath = archive;
      if (entry.kind === 'runtime') {
        const destination = path.join(root, entry.id);
        progress.report({ message: 'unpacking…' });
        await extract(archive, destination);
        const binary = findFile(destination, 'llama-server');
        if (!binary) {
          throw new Error(`no llama-server executable was found after unpacking ${entry.file}`);
        }
        if (process.platform !== 'win32') {
          fs.chmodSync(binary, 0o755);
        }
        installedPath = binary;
      }

      const artifact: InstalledArtifact = {
        id: entry.id,
        kind: entry.kind,
        file: entry.file,
        sha256,
        bytes,
        url: entry.url,
        path: installedPath,
        installedAt: new Date().toISOString(),
      };
      manifest.artifacts[entry.id] = artifact;
      writeManifest(root, manifest);
      return artifact;
    }
  );
}

/** Removes an installed artifact and everything it left on disk. */
export function uninstall(context: vscode.ExtensionContext, id: string): boolean {
  const root = modelRoot(context);
  const manifest = readManifest(root);
  const artifact = manifest.artifacts[id];
  if (!artifact) {
    return false;
  }
  fs.rmSync(path.join(root, artifact.file), { force: true });
  fs.rmSync(path.join(root, artifact.id), { recursive: true, force: true });
  delete manifest.artifacts[id];
  writeManifest(root, manifest);
  return true;
}

/**
 * Streams one file, resuming from a partial download when the server allows it, and hashing as it goes.
 *
 * A resumed transfer is hashed from the bytes already on disk, in 1 MB reads, so a 4 GB model never sits
 * in memory. A checksum mismatch deletes the partial file instead of keeping it: resuming from bytes that
 * are known to be wrong would only make the next attempt wrong too.
 */
async function download(
  url: string,
  destination: string,
  expected: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken
): Promise<{ sha256: string; bytes: number }> {
  const part = `${destination}.part`;
  const onDisk = fs.existsSync(part) ? fs.statSync(part).size : 0;

  const response = await open(url, onDisk);
  const resuming = onDisk > 0 && response.statusCode === 206;
  const already = resuming ? onDisk : 0;
  const announced = Number(response.headers['content-length'] ?? 0);
  const total = already + (Number.isFinite(announced) ? announced : 0);

  const hash = createHash('sha256');
  if (resuming) {
    hashPartial(part, hash);
  }

  let received = already;
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(part, { flags: resuming ? 'a' : 'w' });
    const cancelled = token.onCancellationRequested(() => {
      response.destroy();
      file.destroy();
      reject(new Error('the download was cancelled'));
    });
    response.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      received += chunk.length;
      const percent = total > 0 ? Math.round((received / total) * 100) : 0;
      const of = total > 0 ? ` of ${formatBytes(total)}` : '';
      progress.report({ message: `${formatBytes(received)}${of} · ${percent}%` });
    });
    response.on('error', reject);
    file.on('error', reject);
    file.on('finish', () => {
      cancelled.dispose();
      resolve();
    });
    response.pipe(file);
  });

  const sha256 = hash.digest('hex');
  if (expected && sha256 !== expected) {
    fs.rmSync(part, { force: true });
    throw new Error(
      `the checksum does not match: the catalog says ${expected}, the file has ${sha256}. Nothing was installed.`
    );
  }
  fs.rmSync(destination, { force: true });
  fs.renameSync(part, destination);
  return { sha256, bytes: received };
}

/** Follows redirects (the release host redirects to its own storage) and reports a usable response. */
function open(url: string, from: number, redirects = 0): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`too many redirects for ${url}`));
      return;
    }
    const transport = url.startsWith('https:') ? https : http;
    const request = transport.get(
      url,
      { headers: from > 0 ? { Range: `bytes=${from}-` } : {} },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          resolve(open(new URL(location, url).toString(), from, redirects + 1));
          return;
        }
        if (status !== 200 && status !== 206) {
          response.resume();
          reject(new Error(`${url} answered ${status} ${response.statusMessage ?? ''}`.trim()));
          return;
        }
        resolve(response);
      }
    );
    request.on('error', reject);
  });
}

/** Feeds an unfinished download back into the hash, a megabyte at a time. */
function hashPartial(file: string, hash: ReturnType<typeof createHash>): void {
  const size = 1 << 20;
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(size);
    let read = 0;
    while ((read = fs.readSync(descriptor, buffer, 0, size, null)) > 0) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Unpacks an archive with the platform's own `tar`, which reads both formats the catalog pins: Windows and
 * macOS ship bsdtar, and GNU tar detects gzip by itself. Nothing to bundle, nothing to inherit.
 */
function extract(archive: string, destination: string): Promise<void> {
  fs.mkdirSync(destination, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', destination], { windowsHide: true });
    let errors = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`unpacking failed (tar exited with ${code}${errors ? `: ${errors.trim()}` : ''})`));
    });
  });
}

/** The executable by that exact name, wherever the archive put it. */
function findFile(directory: string, name: string): string | undefined {
  const wanted = new Set([name.toLowerCase(), `${name.toLowerCase()}.exe`]);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(full, name);
      if (nested) {
        return nested;
      }
    } else if (wanted.has(entry.name.toLowerCase())) {
      return full;
    }
  }
  return undefined;
}

function manifestPath(root: string): string {
  return path.join(root, MANIFEST_NAME);
}

function readManifest(root: string): Manifest {
  const file = manifestPath(root);
  if (!fs.existsSync(file)) {
    return { version: 1, artifacts: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
    return { version: 1, artifacts: parsed.artifacts ?? {} };
  } catch {
    // A manifest that cannot be read is not a reason to refuse to work: the files are still on disk, and
    // the next install rewrites it.
    return { version: 1, artifacts: {} };
  }
}

function writeManifest(root: string, manifest: Manifest): void {
  fs.writeFileSync(manifestPath(root), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
