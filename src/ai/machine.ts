// What this computer is, and which offer it should be pointed at.
//
// A runtime is compiled per OS and CPU, so which one fits is not a taste — it is a fact about the machine. A
// model is a memory question: a four-bit build needs roughly its own size again to run well, and a machine that
// cannot hold one does not answer slowly, it swaps. So nothing is hidden: the whole list stays on the page and
// the machine's verdict is written beside each entry, because the numbers are the user's to weigh — and the
// sentence that says *why* is worth more than a shorter list.

import * as os from 'os';
import { CatalogEntry, MODELS } from './catalog';

export interface Machine {
  /** `process.platform`: `win32`, `darwin`, `linux`. */
  platform: string;
  /** `process.arch`: `x64`, `arm64`. */
  architecture: string;
  cpu: string;
  cores: number;
  /** Total memory in whole GB; `0` when it cannot be read, which is the one case where nothing is claimed. */
  memoryGB: number;
}

export function machine(): Machine {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    architecture: process.arch,
    cpu: (cpus[0]?.model ?? '').trim(),
    cores: cpus.length,
    memoryGB: Math.floor(os.totalmem() / 1024 ** 3),
  };
}

/** The machine in one line, for the page's own facts. */
export function describeMachine(machine: Machine): string {
  return [
    `${machine.platform} ${machine.architecture}`,
    machine.cores > 0 ? `${machine.cores} cores` : '',
    machine.memoryGB > 0 ? `${machine.memoryGB} GB` : '',
    machine.cpu,
  ]
    .filter((part) => part.length > 0)
    .join(' · ');
}

/**
 * Whether the largest model that fits is this one, and what to say about it either way.
 *
 * `suggested` is only ever true for one entry — the page marks a single model, because "suggested" that is said
 * three times suggests nothing. The rest keep their size, and the ones this machine cannot hold say so.
 */
export function fitsModel(entry: CatalogEntry, machine: Machine): { suggested: boolean; why?: string } {
  const needs = entry.needsGB;
  if (needs === undefined || machine.memoryGB <= 0) {
    return { suggested: false };
  }
  if (machine.memoryGB < needs) {
    return {
      suggested: false,
      why: `needs about ${needs} GB of memory — this machine reports ${machine.memoryGB} GB`,
    };
  }
  const best = bestModel(machine);
  return best?.id === entry.id
    ? { suggested: true, why: `the largest that fits this machine's ${machine.memoryGB} GB` }
    : { suggested: false, why: `fits this machine's ${machine.memoryGB} GB` };
}

/** The largest model the machine can hold by the memory it reports; the smallest when none can be said to fit. */
export function bestModel(machine: Machine): CatalogEntry | undefined {
  const sized = MODELS.filter((entry) => entry.needsGB !== undefined);
  if (sized.length === 0) {
    return MODELS[0];
  }
  if (machine.memoryGB <= 0) {
    return [...sized].sort((a, b) => (a.needsGB ?? 0) - (b.needsGB ?? 0))[0];
  }
  const fits = sized
    .filter((entry) => (entry.needsGB ?? 0) <= machine.memoryGB)
    .sort((a, b) => (b.needsGB ?? 0) - (a.needsGB ?? 0));
  return (
    fits[0] ??
    [...sized].sort((a, b) => (a.needsGB ?? 0) - (b.needsGB ?? 0))[0]
  );
}
