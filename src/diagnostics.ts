// Problems, reported where they can be acted on.
//
// A page that fails a structural check is marked in the file itself, so the squiggle is where the fix is.
// A page whose *file* is missing cannot be marked that way, so that one is reported on registry.json —
// the file you actually have to edit to fix it. The same goes for problems with the registry as a whole.

import * as vscode from 'vscode';
import { collectPages, DocsRoot, IssueSeverity } from './registry';

const SEVERITY: Record<IssueSeverity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
};

export function publishDiagnostics(collection: vscode.DiagnosticCollection, roots: readonly DocsRoot[]): void {
  const byUri = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();

  const add = (uri: vscode.Uri, message: string, severity: IssueSeverity): void => {
    const key = uri.toString();
    const entry = byUri.get(key) ?? { uri, diagnostics: [] };
    entry.diagnostics.push(new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), message, SEVERITY[severity]));
    byUri.set(key, entry);
  };

  for (const root of roots) {
    for (const problem of root.problems) {
      add(problem.uri ?? root.registryUri, problem.message, problem.severity);
    }
    for (const page of collectPages(root)) {
      for (const issue of page.issues) {
        add(page.exists ? page.uri : root.registryUri, issue.message, issue.severity);
      }
    }
  }

  collection.clear();
  for (const { uri, diagnostics } of byUri.values()) {
    collection.set(uri, diagnostics);
  }
}
