/**
 * Gives Monaco a real worker for its core editor service (diff computation,
 * word-based suggestions, link detection). The worker is Monaco's own
 * pre-bundled script, copied to `public/monaco-workers/` by
 * `scripts/copy-monaco-workers.mjs`. Every other worker label returns
 * `undefined`, which keeps Monaco's default behaviour for it (the language
 * service workers are a later milestone's business).
 */
const EDITOR_WORKER_LABEL = "editorWorkerService";

export function editorWorkerUrl(baseUrl: string): string {
  return `${baseUrl}monaco-workers/editor.worker.js`;
}

export function installMonacoEnvironment(
  target: { MonacoEnvironment?: unknown },
  baseUrl: string,
): void {
  target.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker | undefined {
      return label === EDITOR_WORKER_LABEL
        ? new Worker(editorWorkerUrl(baseUrl), { name: label })
        : undefined;
    },
  };
}
