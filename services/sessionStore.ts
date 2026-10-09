// Saved work: the books a user opened and everything found and corrected on
// their pages, kept in the browser's IndexedDB so a reload (the computer
// waking from sleep, a crash, a closed tab) doesn't lose it. The app offers
// to continue from it on the next start.
//
// Two stores: `files` holds each opened PDF or image once (as the File
// itself, kept on disk by the browser), `session` one snapshot of the page
// results, rewritten as the user works. Nothing leaves the computer.

const DB_NAME = 'qcrop';
const FILES = 'files';
const SESSION = 'session';
const KEY = 'current';

let dbPromise: Promise<IDBDatabase> | null = null;
const db = () => {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(FILES);
        req.result.createObjectStore(SESSION);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
};

/** Runs `fn` in one transaction and resolves when it has been written. */
const tx = async <T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void) => {
  const d = await db();
  return new Promise<T | undefined>((resolve, reject) => {
    const t = d.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
};

// Writes run one after another, so a "start over" can't be overtaken by a
// save of the session it discards.
let chain: Promise<unknown> = Promise.resolve();
const queued = <T>(fn: () => Promise<T>) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

/** The key a file is saved under (two different files rarely share all three). */
export const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

/** Saves opened files that aren't saved yet. */
export const saveFiles = (files: File[]) => queued(async () => {
  const have = new Set((await tx<IDBValidKey[]>([FILES], 'readonly', t => t.objectStore(FILES).getAllKeys())) ?? []);
  const add = files.filter(f => !have.has(fileKey(f)));
  if (!add.length) return;
  await tx([FILES], 'readwrite', t => { for (const f of add) t.objectStore(FILES).put(f, fileKey(f)); });
  // Asks the browser not to clear saved books when the disk runs low.
  try { await navigator.storage?.persist?.(); } catch { /* not supported */ }
});

export const saveSession = <S>(snapshot: S) => queued(() =>
  tx([SESSION], 'readwrite', t => { t.objectStore(SESSION).put(snapshot, KEY); }));

/** The saved snapshot and its files by key, or null when nothing is saved. */
export const loadSession = async <S>(): Promise<{ snapshot: S; files: Map<string, File> } | null> => {
  try {
    const snapshot = await tx<S>([SESSION], 'readonly', t => t.objectStore(SESSION).get(KEY));
    if (!snapshot) return null;
    const files = new Map<string, File>();
    const d = await db();
    await new Promise<void>((resolve, reject) => {
      const req = d.transaction([FILES], 'readonly').objectStore(FILES).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve();
        files.set(String(c.key), c.value as File);
        c.continue();
      };
      req.onerror = () => reject(req.error);
    });
    return { snapshot, files };
  } catch { return null; }
};

/** Forgets the saved work and its files. */
export const clearSession = () => queued(() =>
  tx([FILES, SESSION], 'readwrite', t => { t.objectStore(FILES).clear(); t.objectStore(SESSION).clear(); }));
