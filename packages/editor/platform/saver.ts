/**
 * Debounced writer with an in-flight guard.
 *
 * This is the piece that protects half an hour of alignment, and it used to be
 * three module-level booleans tangled with the File System Access calls — which
 * meant it could not be tested at all. As a factory over an injected `write` it
 * is exercised in milliseconds with a fake writer, and `project-folder.ts` keeps
 * only the part that genuinely needs a browser.
 *
 * Two rules it exists to keep:
 * - A write already in flight must not swallow a newer state: queue exactly one
 *   more pass, with the content as of the moment it runs.
 * - A failed write must report and must not wedge the saver.
 */
export interface Saver {
  /** Writes after the quiet period. Calling again restarts the clock. */
  schedule(): void;
  /** Writes now, bypassing the clock. Resolves when the write settles. */
  flush(): Promise<void>;
  /** Drops a pending write. For teardown. */
  cancel(): void;
}

export interface SaverOptions {
  /** Produces the content to write, read at write time and not before. */
  read: () => string;
  write: (contents: string) => Promise<void>;
  onSaved?: () => void;
  onError?: (error: unknown) => void;
  /** Quiet period in milliseconds. */
  delay?: number;
}

export function createSaver({ read, write, onSaved, onError, delay = 400 }: SaverOptions): Saver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing = false;
  let queued = false;

  async function run(): Promise<void> {
    if (writing) {
      queued = true;
      return;
    }
    writing = true;
    try {
      await write(read());
      onSaved?.();
    } catch (error) {
      onError?.(error);
    } finally {
      writing = false;
      if (queued) {
        queued = false;
        await run();
      }
    }
  }

  return {
    schedule(): void {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void run(); }, delay);
    },
    flush(): Promise<void> {
      if (timer) { clearTimeout(timer); timer = null; }
      return run();
    },
    cancel(): void {
      if (timer) { clearTimeout(timer); timer = null; }
      queued = false;
    },
  };
}

/**
 * Turns a dropped file's name into something safe to write next to
 * `project.json` — no directory traversal, no characters a filesystem argues
 * about, and never empty.
 */
export function safeName(name: string): string {
  // Take the basename first: `../../etc/passwd` is a path, and the only part of
  // it we ever wanted is `passwd`. Sanitising in place would keep the `..`
  // segments as literal characters — harmless but nonsense as a file name.
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^\w.\-]+/g, '_').replace(/^[.\s]+/, '');
  return cleaned === '' ? 'file' : cleaned;
}
