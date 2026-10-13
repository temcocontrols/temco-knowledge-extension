// The local inference process.
//
// The catalog puts a `llama-server` binary on disk; this starts it when something actually needs it, keeps
// it on a loopback port, and lets it go once it has been idle. Nothing starts at activation: a maintainer who
// never asks the AI for anything never pays for it, and the extension keeps working with no runtime at all.
//
// No dependency is involved — the server is a normal program the user chose to download, and the extension
// talks to it over HTTP like any other client.

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as vscode from 'vscode';
import { entryById } from './catalog';
import { InstalledArtifact, installedArtifacts } from './install';

const OUTPUT_NAME = 'Temco Knowledge: AI';
/** A cold 7B model on a slow disk takes a while; giving up early would be the wrong answer. */
const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_POLL_MS = 500;
/** How long an answer may be when the caller does not say. An answer is a few sentences. */
const DEFAULT_MAX_TOKENS = 1024;

export interface AiServerInfo {
  baseUrl: string;
  port: number;
  label: string;
  modelPath: string;
}

export interface AiStatus {
  runtime?: InstalledArtifact;
  model?: InstalledArtifact;
  running?: AiServerInfo;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

let child: ChildProcess | undefined;
let info: AiServerInfo | undefined;
let starting: Promise<AiServerInfo> | undefined;
let idleTimer: NodeJS.Timeout | undefined;
let output: vscode.OutputChannel | undefined;

/** What is installed *and* selected — the two things an AI request needs. */
export function aiStatus(context: vscode.ExtensionContext): AiStatus {
  const { runtime, model } = selection(context);
  return { runtime, model, running: info };
}

/**
 * Starts the server if it is not running, and returns where it is. Concurrent callers share one start, and
 * any use pushes the idle timer back.
 */
export async function startAiServer(context: vscode.ExtensionContext): Promise<AiServerInfo> {
  if (info && child && child.exitCode === null) {
    touchIdle();
    return info;
  }
  if (!starting) {
    starting = start(context).finally(() => {
      starting = undefined;
    });
  }
  const server = await starting;
  touchIdle();
  return server;
}

/** Stops the server. Called when idle, when the model is removed, and when the extension goes away. */
export function stopAiServer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  const server = child;
  child = undefined;
  info = undefined;
  if (server && server.exitCode === null) {
    server.kill();
  }
}

/** Stops the server and releases the output channel — the extension's `deactivate`. */
export function disposeAi(): void {
  stopAiServer();
  output?.dispose();
  output = undefined;
}

/** Shows the AI output channel — the only place the local server's output goes. */
export function showAiLog(): void {
  getOutput().show(true);
}

/**
 * One question, one answer — the single call the pipeline is allowed to depend on, so the provider behind it
 * can change without anything else noticing (`12-ai-features.md` §4).
 */
export async function complete(
  context: vscode.ExtensionContext,
  messages: readonly ChatMessage[],
  options: {
    onToken?: (text: string) => void;
    token?: vscode.CancellationToken;
    /** A ceiling on the answer, so one request cannot run to the model's own limits. */
    maxTokens?: number;
  } = {}
): Promise<string> {
  const server = await startAiServer(context);
  const payload = JSON.stringify({
    messages,
    temperature: 0.2,
    stream: options.onToken !== undefined,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
  });
  const response = await post(server.port, '/v1/chat/completions', payload, options.onToken, options.token);
  touchIdle();
  return response;
}

async function start(context: vscode.ExtensionContext): Promise<AiServerInfo> {
  const { runtime, model } = selection(context);
  if (!runtime || !model) {
    throw new Error(
      'No local runtime and model are ready. Run "Temco Knowledge: Models and Runtime" and choose one of each.'
    );
  }
  if (!fs.existsSync(runtime.path) || !fs.existsSync(model.path)) {
    throw new Error(
      'The runtime or the model is not on disk any more. Install it again from "Temco Knowledge: Models and Runtime".'
    );
  }

  const port = await freePort();
  const label = entryById(model.id)?.label ?? model.id;
  const log = getOutput();
  log.appendLine(`[ai] starting ${label} as ${runtime.path} on 127.0.0.1:${port}`);

  const server = spawn(
    runtime.path,
    [
      '--model',
      model.path,
      // Loopback only. The server must never be reachable from the network, and saying so explicitly beats
      // trusting a default to stay a default.
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--ctx-size',
      '8192',
    ],
    { windowsHide: true }
  );
  child = server;
  server.stdout?.on('data', (chunk: Buffer) => log.append(chunk.toString()));
  server.stderr?.on('data', (chunk: Buffer) => log.append(chunk.toString()));
  server.on('error', (error) => {
    log.appendLine(`[ai] could not start the server: ${error.message}`);
    if (child === server) {
      child = undefined;
      info = undefined;
    }
  });
  server.on('exit', (code) => {
    log.appendLine(`[ai] the server exited with ${String(code)}`);
    if (child === server) {
      child = undefined;
      info = undefined;
    }
  });

  try {
    await waitUntilReady(server, port);
  } catch (error) {
    // A server that never became ready is a stray process otherwise, holding the model in memory.
    stopAiServer();
    throw error;
  }

  info = { baseUrl: `http://127.0.0.1:${port}`, port, label, modelPath: model.path };
  return info;
}

/** `llama-server` answers 503 while the model is loading and 200 once it can take requests. */
async function waitUntilReady(server: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    if (server.exitCode !== null || child !== server) {
      throw new Error('the local server stopped before it was ready — see the "Temco Knowledge: AI" output');
    }
    try {
      const status = await request(port, 'GET', '/health');
      if (status.status === 200) {
        return;
      }
      last = `answered ${status.status}`;
    } catch (error) {
      last = messageOf(error);
    }
    await delay(HEALTH_POLL_MS);
  }
  throw new Error(
    `the local server did not become ready within ${Math.round(HEALTH_TIMEOUT_MS / 1000)}s (${last})`
  );
}

/** Posts a chat completion, streaming tokens through `onToken` when the caller wants them. */
function post(
  port: number,
  path: string,
  payload: string,
  onToken: ((text: string) => void) | undefined,
  token: vscode.CancellationToken | undefined
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Node's http does not consult the system proxy, so loopback stays loopback even on a machine that has
    // one configured — which this environment does.
    const call = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.setEncoding('utf8');
        if (status !== 200) {
          let body = '';
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.on('end', () =>
            reject(new Error(`the local server answered ${status}: ${body.slice(0, 400)}`))
          );
          return;
        }
        if (!onToken) {
          let body = '';
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.on('end', () => {
            try {
              resolve(contentOf(body));
            } catch (error) {
              reject(error);
            }
          });
          return;
        }
        let buffered = '';
        let text = '';
        response.on('data', (chunk: string) => {
          buffered += chunk;
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';
          for (const line of lines) {
            const piece = tokenOf(line);
            if (piece) {
              text += piece;
              onToken(piece);
            }
          }
        });
        response.on('end', () => resolve(text));
        response.on('error', reject);
      }
    );
    call.on('error', reject);
    const cancelled = token?.onCancellationRequested(() => {
      call.destroy();
      reject(new Error('the request was cancelled'));
    });
    call.on('close', () => cancelled?.dispose());
    call.end(payload);
  });
}

/** The assistant's text out of a non-streaming OpenAI-shaped reply. */
function contentOf(body: string): string {
  const parsed = JSON.parse(body) as { choices?: { message?: { content?: string } }[] };
  const text = parsed.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new Error('the local server answered without any text');
  }
  return text;
}

/** One server-sent event line, when it carries an assistant token. */
function tokenOf(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return undefined;
  }
  const data = trimmed.slice(5).trim();
  if (data.length === 0 || data === '[DONE]') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
    const piece = parsed.choices?.[0]?.delta?.content;
    return typeof piece === 'string' ? piece : undefined;
  } catch {
    // A line split across two chunks is not an error: the next read completes it.
    return undefined;
  }
}

function request(port: number, method: string, path: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const call = http.request({ host: '127.0.0.1', port, path, method }, (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0 });
    });
    call.on('error', reject);
    call.setTimeout(5_000, () => {
      call.destroy(new Error('the health check timed out'));
    });
    call.end();
  });
}

/** Asks the OS for a port nobody is using, so two windows of the editor never collide. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => {
        if (port > 0) {
          resolve(port);
        } else {
          reject(new Error('no free port could be found'));
        }
      });
    });
  });
}

function touchIdle(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  const minutes = vscode.workspace
    .getConfiguration('temcoKnowledge')
    .get<number>('ai.idleMinutes', 10);
  if (minutes <= 0) {
    return;
  }
  idleTimer = setTimeout(
    () => {
      getOutput().appendLine(`[ai] idle for ${minutes} minute(s) — stopping the server`);
      stopAiServer();
    },
    minutes * 60_000
  );
}

function selection(context: vscode.ExtensionContext): {
  runtime?: InstalledArtifact;
  model?: InstalledArtifact;
} {
  const installed = installedArtifacts(context);
  const configuration = vscode.workspace.getConfiguration('temcoKnowledge');
  const chosen = (kind: string, setting: string): InstalledArtifact | undefined => {
    const wanted = configuration.get<string>(setting, '');
    return installed.find((artifact) => artifact.id === wanted) ?? installed.find((a) => a.kind === kind);
  };
  // One runtime and one model is the normal case, so an empty setting means "the only one installed".
  return { runtime: chosen('runtime', 'ai.runtime'), model: chosen('model', 'ai.model') };
}

function getOutput(): vscode.OutputChannel {
  output ??= vscode.window.createOutputChannel(OUTPUT_NAME);
  return output;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
