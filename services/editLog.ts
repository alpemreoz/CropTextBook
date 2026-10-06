// Edit log: what the program detected on each page and how the user
// corrected it (boxes moved or resized, added, deleted, renumbered, passages
// drawn or dropped), kept as training data for improving detection.
//
// Entries are sent in small batches to the local server, which appends them
// to logs/edits-YYYY-MM-DD.jsonl in the project folder (vite.config.ts).
// Boxes are in the app's 0-1000 page space: x as thousandths of the page
// width, y as thousandths of its height.

import type { BoundingBox } from '../types';

declare const __QCROP_COMMIT__: string;

const ENDPOINT = '/__qcrop/log';
const MAX_QUEUE = 5000;

const randomId = () => Math.random().toString(36).slice(2, 10);

/** One id per browser (this computer), one per app load. */
const install = (() => {
  try {
    let id = localStorage.getItem('qcrop.install');
    if (!id) { id = randomId(); localStorage.setItem('qcrop.install', id); }
    return id;
  } catch { return 'unknown'; }
})();
const session = randomId();

let queue: Record<string, unknown>[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let failures = 0;

const flush = async () => {
  timer = null;
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  try {
    const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
    if (!res.ok) throw new Error(String(res.status));
    failures = 0;
  } catch {
    // Server not reachable (e.g. the app served as static files): keep the
    // entries and try again later, slower each time.
    queue = [...batch, ...queue].slice(-MAX_QUEUE);
    failures++;
    schedule(Math.min(60000, 2000 * 2 ** failures));
  }
};

const schedule = (ms = 1500) => {
  if (!timer) timer = setTimeout(flush, ms);
};

// Whatever is still queued goes out when the tab closes.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (queue.length && navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([JSON.stringify(queue)], { type: 'application/json' }));
      queue = [];
    }
  });
}

/** Adds one entry: { t, session, install, event, ...data }. */
export const logEvent = (event: string, data: Record<string, unknown> = {}) => {
  queue.push({ t: new Date().toISOString(), session, install, event, ...data });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
  schedule();
};

/** A box rounded to 0.1 (drags produce long fractions). */
export const roundBox = (b?: BoundingBox) => b && ({
  xmin: Math.round(b.xmin * 10) / 10, ymin: Math.round(b.ymin * 10) / 10,
  xmax: Math.round(b.xmax * 10) / 10, ymax: Math.round(b.ymax * 10) / 10,
});

/**
 * How far each edge moved, in 0-1000 page units (positive = right/down):
 * { left, top, right, bottom }. A bottom of -25 means the box was cut 2.5%
 * of the page height shorter.
 */
export const edgeDelta = (from: BoundingBox, to: BoundingBox) => ({
  left: Math.round((to.xmin - from.xmin) * 10) / 10,
  top: Math.round((to.ymin - from.ymin) * 10) / 10,
  right: Math.round((to.xmax - from.xmax) * 10) / 10,
  bottom: Math.round((to.ymax - from.ymax) * 10) / 10,
});

export const sameBox = (a?: BoundingBox, b?: BoundingBox) =>
  !!a && !!b && a.xmin === b.xmin && a.ymin === b.ymin && a.xmax === b.xmax && a.ymax === b.ymax;

export const appVersion = typeof __QCROP_COMMIT__ === 'string' ? __QCROP_COMMIT__ : 'unknown';

let started = false;
/** The session's first entry, once per app load (React may run effects twice). */
export const logSessionStart = (data: Record<string, unknown>) => {
  if (started) return;
  started = true;
  logEvent('session_start', { version: appVersion, ...data });
};
