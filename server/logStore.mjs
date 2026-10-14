// Edit-log storage, shared by the dev/preview server (vite.config.ts) and the
// standalone log server for nginx deployments (server/log-server.mjs).
//
// The web app POSTs batches of entries (a JSON array of objects, see
// services/editLog.ts) to /__qcrop/log; each batch is appended to
// <dir>/edits-YYYY-MM-DD.jsonl, one JSON entry per line.

import fs from 'fs';
import path from 'path';

/** Largest request body accepted, in bytes (the app sends at most 5000 entries at once). */
export const MAX_BODY = 5 * 1024 * 1024;
/** Largest single entry kept, in bytes (a page's detected boxes stay well under it). */
const MAX_ENTRY = 256 * 1024;

/**
 * Appends a batch to the day's file. Only plain objects are kept, and only
 * entries of a reasonable size. -> number of entries written.
 */
export const appendEntries = (dir, entries) => {
  if (!Array.isArray(entries)) throw new Error('expected an array of entries');
  const lines = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const line = JSON.stringify(e);
    if (line.length <= MAX_ENTRY) lines.push(line);
  }
  if (!lines.length) return 0;
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(path.join(dir, `edits-${day}.jsonl`), lines.join('\n') + '\n');
  return lines.length;
};

/**
 * Request handler for POST /__qcrop/log (Node http / connect style). Other
 * requests go to `next`, or get a 404 when there is none. `allow(req)` may
 * refuse a request (rate limits): it then gets a 429.
 */
export const logHandler = ({ dir, allow = () => true }) => (req, res, next) => {
  const url = (req.url ?? '').split('?')[0];
  if (url !== '/__qcrop/log' || req.method !== 'POST') {
    if (next) return next();
    res.statusCode = 404;
    return res.end();
  }
  if (!allow(req)) {
    res.statusCode = 429;
    return res.end();
  }
  let body = '';
  let tooBig = false;
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    if (tooBig) return;
    body += chunk;
    if (body.length > MAX_BODY) {
      tooBig = true;
      res.statusCode = 413;
      res.end();
      req.destroy();
    }
  });
  req.on('end', () => {
    if (tooBig) return;
    try {
      appendEntries(dir, JSON.parse(body));
      res.statusCode = 204;
    } catch {
      res.statusCode = 400;
    }
    res.end();
  });
};
