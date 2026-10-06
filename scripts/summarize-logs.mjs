#!/usr/bin/env node
// Summarizes the web app's edit logs (logs/edits-*.jsonl, see
// services/editLog.ts): how much users had to correct, per book and per
// kind of correction, and which way corrected boxes moved.
//
//   node scripts/summarize-logs.mjs [log files or folders...] [--pages]
//
// With no arguments it reads ./logs. --pages also lists every corrected
// page with what was done on it. Logs from several users can be passed
// together (each user's folder, or the files themselves).

import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const listPages = args.includes('--pages');
const inputs = args.filter(a => !a.startsWith('--'));
if (!inputs.length) inputs.push('logs');

const files = inputs.flatMap(p => {
  try {
    return statSync(p).isDirectory()
      ? readdirSync(p).filter(f => /\.jsonl$/.test(f)).map(f => path.join(p, f))
      : [p];
  } catch { console.error(`not found: ${p}`); return []; }
});
const entries = [];
for (const f of files) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a cut-off line */ }
  }
}
if (!entries.length) { console.log('No log entries found.'); process.exit(0); }
entries.sort((a, b) => String(a.t).localeCompare(String(b.t)));

const EDITS = ['box_moved', 'box_resized', 'box_added', 'box_deleted', 'number_changed',
  'passage_added', 'passage_moved', 'passage_resized', 'passage_deleted', 'passage_attached', 'passage_detached'];
const pageKey = (e) => `${e.book} | ${typeof e.page === 'number' ? 'p' + e.page : e.page}`;

// Per book (and profile): pages analyzed, crops found, pages corrected.
const books = new Map();
const book = (e) => {
  const k = `${e.book}  [${e.profile || 'default'}]`;
  if (!books.has(k)) books.set(k, { pages: new Set(), crops: 0, edited: new Set(), viewed: new Set(), counts: {} });
  return books.get(k);
};
const counts = {};
const perPage = new Map();
// Each detected box's last correction against what the program found.
const lastFromDetected = new Map();
for (const e of entries) {
  if (e.event === 'page_analyzed') { const b = book(e); b.pages.add(pageKey(e)); b.crops += e.regions?.length ?? 0; }
  if (e.event === 'page_viewed') book(e).viewed.add(pageKey(e));
  if (!EDITS.includes(e.event)) continue;
  counts[e.event] = (counts[e.event] ?? 0) + 1;
  const b = book(e);
  b.edited.add(pageKey(e));
  b.counts[e.event] = (b.counts[e.event] ?? 0) + 1;
  if (!perPage.has(pageKey(e))) perPage.set(pageKey(e), []);
  perPage.get(pageKey(e)).push(e);
  if ((e.event === 'box_moved' || e.event === 'box_resized') && e.fromDetected) {
    lastFromDetected.set(`${e.session}:${e.rid}`, { ...e.fromDetected, n: e.n, page: pageKey(e) });
  }
}

const sessions = new Set(entries.map(e => e.session)), installs = new Set(entries.map(e => e.install));
console.log(`${entries.length} entries from ${files.length} file(s): ${installs.size} computer(s), ${sessions.size} session(s), ${entries[0].t?.slice(0, 10)} to ${entries[entries.length - 1].t?.slice(0, 10)}`);
console.log(`Code versions: ${[...new Set(entries.filter(e => e.version).map(e => e.version))].join(', ') || 'unknown'}\n`);

console.log('Corrections by kind:');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${v}`);

console.log('\nPer book:');
for (const [k, b] of books) {
  const pct = b.pages.size ? Math.round((b.edited.size / b.pages.size) * 100) : 0;
  const detail = Object.entries(b.counts).map(([ev, n]) => `${ev} ${n}`).join(', ');
  console.log(`  ${k}\n    ${b.pages.size} pages analyzed, ${b.crops} crops found, ${b.viewed.size} pages looked at, ${b.edited.size} corrected (${pct}%)${detail ? `\n    ${detail}` : ''}`);
}

// Which way corrected boxes went, per edge, in % of the page (0-1000
// units / 10). A bottom edge pulled up often means crops run into the
// footer; a top edge moved up, that the question's start was missed.
const deltas = [...lastFromDetected.values()];
if (deltas.length) {
  console.log(`\nDetected boxes corrected by dragging: ${deltas.length}. Edge changes against the detection (% of page; + = right/down):`);
  for (const edge of ['top', 'bottom', 'left', 'right']) {
    const vs = deltas.map(d => d[edge]).filter(v => Math.abs(v) >= 3).sort((a, b) => a - b);
    if (!vs.length) { console.log(`  ${edge.padEnd(6)} unchanged`); continue; }
    const med = vs[vs.length >> 1] / 10;
    const grew = vs.filter(v => (edge === 'top' || edge === 'left') ? v < 0 : v > 0).length;
    console.log(`  ${edge.padEnd(6)} changed on ${vs.length} box(es), median ${med > 0 ? '+' : ''}${med.toFixed(1)}%; made bigger ${grew}, smaller ${vs.length - grew}`);
  }
}

if (listPages) {
  console.log('\nCorrected pages:');
  for (const [k, es] of perPage) {
    console.log(`  ${k}`);
    for (const e of es) {
      const what = e.event === 'number_changed' ? `Q${e.from} -> Q${e.to}`
        : e.edges ? `Q${e.n ?? '?'} edges ${JSON.stringify(e.edges)}`
        : e.n ? `Q${e.n}` : e.usedBy ? `passage for Q${e.usedBy.join(',')}` : '';
      console.log(`    ${e.event} ${what}`);
    }
  }
} else if (perPage.size) {
  console.log(`\n(${perPage.size} corrected pages; add --pages to list them)`);
}
