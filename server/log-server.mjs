#!/usr/bin/env node
// Q-Crop log server: receives the web app's edit logs when the app is served
// as static files (nginx), where the dev server's /__qcrop/log isn't there.
// nginx passes /__qcrop/log to it (see deploy/nginx.conf).
//
//   QCROP_LOG_DIR=/var/lib/qcrop/logs QCROP_LOG_PORT=3101 node server/log-server.mjs
//
// Entries go to $QCROP_LOG_DIR/edits-YYYY-MM-DD.jsonl (default ./logs), as
// with `npm run dev`; read them with `npm run logs -- <dir>`. It listens on
// 127.0.0.1 only: nginx is the public side. No dependencies.

import http from 'http';
import path from 'path';
import { logHandler } from './logStore.mjs';

const dir = path.resolve(process.env.QCROP_LOG_DIR || 'logs');
const port = Number(process.env.QCROP_LOG_PORT) || 3101;
const host = process.env.QCROP_LOG_HOST || '127.0.0.1';

// A request budget per client address (nginx sends it in X-Real-IP): the
// app sends a batch every few seconds while someone works, so 120 a minute
// is far above normal use and stops a flood from filling the disk.
const PER_MINUTE = Number(process.env.QCROP_LOG_PER_MINUTE) || 120;
const counts = new Map();
setInterval(() => counts.clear(), 60_000).unref();
const allow = (req) => {
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress || '?';
  const n = (counts.get(ip) ?? 0) + 1;
  counts.set(ip, n);
  return n <= PER_MINUTE;
};

const handle = logHandler({ dir, allow });
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/__qcrop/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok\n');
  }
  handle(req, res);
});
server.listen(port, host, () => console.log(`Q-Crop log server on http://${host}:${port}, writing to ${dir}`));
