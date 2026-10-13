// The local AI catalog: what can be downloaded, from where, and under which licence.
//
// Nothing here ships a binary or a model. The extension keeps its own weight near zero and fetches both on
// request into a folder of the user's choosing. That is what lets one `.vsix` work on every platform — a
// compiled runtime is per-OS, a downloaded one is not — and it is what keeps a model out of the repository.

export type ArtifactKind = 'runtime' | 'model';

export interface CatalogEntry {
  /** Stable id; also the folder the artifact is unpacked into. */
  id: string;
  kind: ArtifactKind;
  label: string;
  /** What the archive is called upstream — shown so a download can be traced. */
  file: string;
  url: string;
  /** Bytes when known; `0` means the size is not pinned yet. */
  bytes: number;
  /** Lowercase hex sha256 of the archive; empty means the checksum is not pinned yet. */
  sha256: string;
  licence: string;
  /** Runtimes only: the OS and CPU they are built for. */
  platform?: string;
  architecture?: string;
  /** Models only: what has to be installed, and roughly what it costs to run. */
  needs?: string;
  notes?: string;
}

/**
 * The pinned llama.cpp build. Every asset below carries GitHub's own sha256 digest, so an install is
 * verifiable end to end. CPU builds only: they run everywhere, and a GPU build is a 200–600 MB download
 * that a documentation tool has no business making on someone's behalf.
 */
export const RUNTIME_RELEASE = 'b11577';
export const RUNTIME_RELEASE_DATE = '2026-10-12';
const RUNTIME_ROOT = `https://github.com/ggml-org/llama.cpp/releases/download/${RUNTIME_RELEASE}`;

export const RUNTIMES: readonly CatalogEntry[] = [
  {
    id: 'llama-b11577-win-cpu-x64',
    kind: 'runtime',
    label: 'llama.cpp b11577 — Windows x64 (CPU)',
    file: `llama-${RUNTIME_RELEASE}-bin-win-cpu-x64.zip`,
    url: `${RUNTIME_ROOT}/llama-${RUNTIME_RELEASE}-bin-win-cpu-x64.zip`,
    bytes: 19509426,
    sha256: 'c48e5762bb466a2faba1b880ca8b328a152e7f48e738431eb918ac9078f82ef1',
    licence: 'MIT',
    platform: 'win32',
    architecture: 'x64',
  },
  {
    id: 'llama-b11577-win-cpu-arm64',
    kind: 'runtime',
    label: 'llama.cpp b11577 — Windows arm64 (CPU)',
    file: `llama-${RUNTIME_RELEASE}-bin-win-cpu-arm64.zip`,
    url: `${RUNTIME_ROOT}/llama-${RUNTIME_RELEASE}-bin-win-cpu-arm64.zip`,
    bytes: 12380499,
    sha256: 'f6179be0aadde2c73001002e677861810920995b24151a08287cd57c9e1b7d5b',
    licence: 'MIT',
    platform: 'win32',
    architecture: 'arm64',
  },
  {
    id: 'llama-b11577-ubuntu-x64',
    kind: 'runtime',
    label: 'llama.cpp b11577 — Linux x64 (CPU)',
    file: `llama-${RUNTIME_RELEASE}-bin-ubuntu-x64.tar.gz`,
    url: `${RUNTIME_ROOT}/llama-${RUNTIME_RELEASE}-bin-ubuntu-x64.tar.gz`,
    bytes: 17723303,
    sha256: '619d152d8b7cb9ec5b738cec34b2620404c421c16f1ea51fc7a6d8a2b30771b6',
    licence: 'MIT',
    platform: 'linux',
    architecture: 'x64',
  },
  {
    id: 'llama-b11577-ubuntu-arm64',
    kind: 'runtime',
    label: 'llama.cpp b11577 — Linux arm64 (CPU)',
    file: `llama-${RUNTIME_RELEASE}-bin-ubuntu-arm64.tar.gz`,
    url: `${RUNTIME_ROOT}/llama-${RUNTIME_RELEASE}-bin-ubuntu-arm64.tar.gz`,
    bytes: 13838634,
    sha256: 'ea19b3ea15d2ae46ea4066685f41a9aaa2446a80145f6f05650ecdfbf6c86345',
    licence: 'MIT',
    platform: 'linux',
    architecture: 'arm64',
  },
  {
    id: 'llama-b11577-macos-arm64',
    kind: 'runtime',
    label: 'llama.cpp b11577 — macOS arm64 (Apple silicon)',
    file: `llama-${RUNTIME_RELEASE}-bin-macos-arm64.tar.gz`,
    url: `${RUNTIME_ROOT}/llama-${RUNTIME_RELEASE}-bin-macos-arm64.tar.gz`,
    bytes: 12112274,
    sha256: 'fa6526afe087293ac83709fe6529fa087e7070f606e30dd452173c16ccebed8c',
    licence: 'MIT',
    platform: 'darwin',
    architecture: 'arm64',
  },
  {
    id: 'llama-b11577-macos-x64',
    kind: 'runtime',
    label: 'llama.cpp b11577 — macOS x64 (Intel)',
    file: `llama-${RUNTIME_RELEASE}-bin-macos-x64.tar.gz`,
    url: `${RUNTIME_ROOT}/llama-${RUNTIME_RELEASE}-bin-macos-x64.tar.gz`,
    bytes: 11608121,
    sha256: 'a623d9b4a3bf6c4d1c3447b6d7d52b43976ab4b624426158d9ee4ec0a13370ea',
    licence: 'MIT',
    platform: 'darwin',
    architecture: 'x64',
  },
];

/**
 * The models on offer. Permissive licences only, and the licence is shown before anything is downloaded.
 *
 * **These entries are not pinned yet**: no checksum and no size, because the machine this list was written
 * on cannot reach the file host. An unpinned entry is refused unless `temcoKnowledge.ai.allowUnpinned` is
 * on, and it always asks for confirmation first — after which the checksum the download actually had is
 * recorded, so a later change is detected. Filling in `sha256` and `bytes` is a data task, not a code one.
 */
export const MODELS: readonly CatalogEntry[] = [
  {
    id: 'qwen2.5-1.5b-instruct-q4_k_m',
    kind: 'model',
    label: 'Qwen2.5 1.5B Instruct (Q4_K_M)',
    file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    bytes: 0,
    sha256: '',
    licence: 'Apache-2.0',
    needs: 'about 1.5 GB of RAM — the smallest that is still worth asking a question',
    notes: 'checksum and size not pinned yet',
  },
  {
    id: 'qwen2.5-3b-instruct-q4_k_m',
    kind: 'model',
    label: 'Qwen2.5 3B Instruct (Q4_K_M)',
    file: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    bytes: 0,
    sha256: '',
    licence: 'Apache-2.0',
    needs: 'about 3 GB of RAM — the model the application layout shows',
    notes: 'checksum and size not pinned yet',
  },
  {
    id: 'qwen2.5-7b-instruct-q4_k_m',
    kind: 'model',
    label: 'Qwen2.5 7B Instruct (Q4_K_M)',
    file: 'qwen2.5-7b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf',
    bytes: 0,
    sha256: '',
    licence: 'Apache-2.0',
    needs: 'about 6 GB of RAM — noticeably better prose, slower to load',
    notes: 'checksum and size not pinned yet',
  },
];

/** The runtime built for this machine, or `undefined` when the catalog has none for it. */
export function runtimeFor(platform: string, architecture: string): CatalogEntry | undefined {
  return RUNTIMES.find((entry) => entry.platform === platform && entry.architecture === architecture);
}

export function entryById(id: string): CatalogEntry | undefined {
  return [...RUNTIMES, ...MODELS].find((entry) => entry.id === id);
}

/** Sizes as a person reads them; an unknown size says so instead of guessing. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) {
    return 'size unknown';
  }
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
