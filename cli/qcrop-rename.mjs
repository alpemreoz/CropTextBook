#!/usr/bin/env node
// Renames a folder of crops after the book's table of contents (İçindekiler):
// each crop is named after the contents entry its page falls under (an
// entry runs until the page before the next one starts).
//
//   node cli/qcrop-rename.mjs <crop folder> --book <PDF or page-image folder> [options]
//   node cli/qcrop-rename.mjs <crop folder> --undo
//
//   --contents <file>         use this contents list instead of reading the book
//   --contents-pages 2-4      where the contents pages are (default: searched in
//                             the first pages of the book)
//   --offset <n>              PDF page = printed page + n (default: found from the crops)
//   --reread                  read the book again even if the folder has a contents.txt
//   --dry-run                 show what would be renamed, change nothing
//
// The contents read from the book are saved as <crop folder>/contents.txt.
// If they're wrong or missing, fix (or write) that file and run again: a
// contents.txt in the crop folder is used instead of reading the book.
// The renames are recorded in renames.csv (for --undo); answers.csv is
// updated to the new names.

import { readdir, readFile, writeFile, rename, stat, mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import * as core from '../core/qcropCore.mjs';

const execFileP = promisify(execFile);

const args = process.argv.slice(2);
let folder = null, book = null, contentsFile = null, contentsPages = null, offsetArg = null;
let dryRun = false, undo = false, reread = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--book') book = args[++i];
  else if (a === '--contents') contentsFile = args[++i];
  else if (a === '--contents-pages') contentsPages = args[++i];
  else if (a === '--offset') offsetArg = parseInt(args[++i], 10);
  else if (a === '--dry-run') dryRun = true;
  else if (a === '--undo') undo = true;
  else if (a === '--reread') reread = true;
  else if (!folder) folder = a;
}
const usage = () => {
  console.error('Usage: node cli/qcrop-rename.mjs <crop folder> --book <PDF or page-image folder> [--contents <file>] [--contents-pages 2-4] [--offset <n>] [--reread] [--dry-run]');
  console.error('       node cli/qcrop-rename.mjs <crop folder> --undo');
  process.exit(1);
};
if (!folder || !existsSync(folder)) usage();

const RENAMES = path.join(folder, 'renames.csv');
const ANSWERS = path.join(folder, 'answers.csv');
const CONTENTS = path.join(folder, 'contents.txt');

const csvCell = (v) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
const csvRows = (text) => text.split(/\r?\n/).filter(Boolean).map(line => {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
});

/** Renames old -> new in two steps (names may swap), and fixes answers.csv. */
const applyRenames = async (pairs) => {
  const tmp = pairs.map(([from], i) => [from, `.qcrop-rename-${i}-${path.extname(from)}`]);
  for (const [from, t] of tmp) await rename(path.join(folder, from), path.join(folder, t));
  for (let i = 0; i < pairs.length; i++) await rename(path.join(folder, tmp[i][1]), path.join(folder, pairs[i][1]));
  if (existsSync(ANSWERS)) {
    const map = new Map(pairs);
    const rows = csvRows(await readFile(ANSWERS, 'utf8'));
    await writeFile(ANSWERS, rows.map((r, i) => (i && map.has(r[0]) ? [map.get(r[0]), ...r.slice(1)] : r).map(csvCell).join(',')).join('\n') + '\n');
  }
};

if (undo) {
  if (!existsSync(RENAMES)) { console.error(`Nothing to undo: no ${RENAMES}`); process.exit(1); }
  const pairs = csvRows(await readFile(RENAMES, 'utf8')).slice(1).map(([from, to]) => [to, from])
    .filter(([cur]) => existsSync(path.join(folder, cur)));
  await applyRenames(pairs);
  await rm(RENAMES);
  console.log(`Undone: ${pairs.length} crop(s) have their previous names again.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The crops: "<anything>_<page>_q<N>.jpg" (page "s12" for PDFs, "12" for
// scans), or "<anything>_q<N>_<page>.jpg" as earlier versions named them.
// Either way they get the current order.
// ---------------------------------------------------------------------------

const PAGE_FIRST_RE = /^(?:(.*?)_)?(s?)(\d+)_q(\d+)((?:_\d+)?)\.(jpe?g|png)$/i;
const Q_FIRST_RE = /^(?:(.*?)_)?q(\d+)_(s?)(\d+)((?:_\d+)?)\.(jpe?g|png)$/i;
// ("x_1_q3_33.jpg" reads both ways: the folder's order comes from the names
// that read only one way.)
const files = await readdir(folder);
const pageFirstVotes = files.filter(f => PAGE_FIRST_RE.test(f) && !Q_FIRST_RE.test(f)).length;
const qFirstVotes = files.filter(f => Q_FIRST_RE.test(f) && !PAGE_FIRST_RE.test(f)).length;
const order = qFirstVotes > pageFirstVotes ? [Q_FIRST_RE, PAGE_FIRST_RE] : [PAGE_FIRST_RE, Q_FIRST_RE];
const crops = files.map(file => {
  for (const re of order) {
    const m = re.exec(file);
    if (!m) continue;
    return re === PAGE_FIRST_RE
      ? { file, q: +m[4], s: m[2], page: +m[3], dup: m[5], ext: m[6] }
      : { file, q: +m[2], s: m[3], page: +m[4], dup: m[5], ext: m[6] };
  }
  return null;
}).filter(Boolean);
if (!crops.length) { console.error(`No crops (…_<page>_q<N>.jpg) in ${folder}`); process.exit(1); }

// ---------------------------------------------------------------------------
// The contents: contents.txt in the folder, --contents, or read from the book
// ---------------------------------------------------------------------------

let items, offset = Number.isFinite(offsetArg) ? offsetArg : null, source;
const fromFile = contentsFile ?? (!reread && existsSync(CONTENTS) ? CONTENTS : null);
if (fromFile) {
  const parsed = core.parseContentsFile(await readFile(fromFile, 'utf8'));
  items = parsed.items;
  if (offset === null) offset = parsed.offset;
  source = fromFile;
} else {
  if (!book || !existsSync(book)) {
    console.error('Give the book (--book <PDF or page-image folder>) to read its contents from, or a contents list (--contents <file>).');
    process.exit(1);
  }
  ({ items, source } = await readContentsFromBook(book));
  await writeFile(CONTENTS, core.contentsFileText(items, { book: path.basename(book), source }));
  if (!items.length) {
    console.log(`No contents page found in ${path.basename(book)}.`);
    console.log(`Write the contents into ${CONTENTS} (the file explains the format) and run this again.`);
    process.exit(1);
  }
  console.log(`Contents read from ${source}: ${items.filter(it => it.page !== undefined).length} entries, saved to ${CONTENTS}`);
}

// Printed page numbers in a text layer's footers give the offset directly
// (crop runs that missed many question 1s leave little to align on).
if (offset === null && book && /\.pdf$/i.test(book) && existsSync(book)) {
  const footerOffset = await offsetFromFooters(book);
  if (footerOffset !== null) { offset = footerOffset; console.log(`Offset read from the page footers: ${offset >= 0 ? '+' : ''}${offset}`); }
}
const testStarts = crops.filter(c => c.q === 1).map(c => c.page);
const aligned = core.alignContents(items, testStarts, offset);
if (!aligned.entries.length) { console.error(`No entries with page numbers in ${source}.`); process.exit(1); }
if (aligned.dropped.length) {
  console.log(`Left out (page number out of order, probably misread; fix it in ${fromFile ?? CONTENTS}):`);
  for (const d of aligned.dropped) console.log(`  ${d.page} ; ${d.name}`);
}
console.log(`Offset ${aligned.offset >= 0 ? '+' : ''}${aligned.offset} (page in the crop names = printed page ${aligned.offset >= 0 ? '+' : '-'} ${Math.abs(aligned.offset)})${offset === null ? ', found from the crops' : ''}`);

// ---------------------------------------------------------------------------
// New names
// ---------------------------------------------------------------------------

const taken = new Set((await readdir(folder)).filter(f => !crops.some(c => c.file === f)));
const pairs = [];
let before = 0;
for (const c of crops.sort((a, b) => a.page - b.page || a.q - b.q)) {
  const entry = core.contentsEntryAt(aligned.entries, c.page);
  if (!entry) { before++; continue; }
  const base = `${core.sanitizeName(entry.name)}_${c.s}${c.page}_q${c.q}`;
  let name = `${base}${c.dup}.${c.ext.toLowerCase()}`;
  for (let k = 2; taken.has(name); k++) name = `${base}_${k}.${c.ext.toLowerCase()}`;
  taken.add(name);
  if (name !== c.file) pairs.push([c.file, name]);
}

const used = new Set(pairs.map(([, n]) => n.replace(/_s?\d+_q\d+(_\d+)?\.\w+$/, '')));
console.log(`${pairs.length} of ${crops.length} crop(s) get new names from ${used.size} contents entr${used.size === 1 ? 'y' : 'ies'}` +
  `${before ? `; ${before} crop(s) before the first entry keep theirs` : ''}.`);
for (const [from, to] of pairs.slice(0, 12)) console.log(`  ${from}  ->  ${to}`);
if (pairs.length > 12) console.log(`  … ${pairs.length - 12} more`);

if (dryRun) { console.log('Dry run: nothing renamed.'); process.exit(0); }
await applyRenames(pairs);
await writeFile(RENAMES, ['old,new', ...pairs.map(p => p.map(csvCell).join(','))].join('\n') + '\n');
console.log(`Done. To go back: node cli/qcrop-rename.mjs "${folder}" --undo`);
process.exit(0);

// ---------------------------------------------------------------------------
// Reading the contents pages of a book (text layer, or OCR for scans)
// ---------------------------------------------------------------------------

/** PDF page - printed page, from the footers of the text layer, or null. */
async function offsetFromFooters(pdf) {
  let stdout;
  try { ({ stdout } = await execFileP('pdftotext', ['-bbox', pdf, '-'], { maxBuffer: 1 << 29 })); } catch { return null; }
  const votes = new Map();
  let k = 0, n = 0;
  for (const pm of stdout.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)) {
    k++;
    const pw = +pm[1], ph = +pm[2], W = 2000, H = Math.round(2000 * ph / pw);
    const items = [...pm[3].matchAll(/<word xMin="([-\d.]+)" yMin="([-\d.]+)" xMax="([-\d.]+)" yMax="([-\d.]+)">([^<]*)<\/word>/g)]
      .map(m => ({ str: m[5], x0: m[1] / pw, y0: m[2] / ph, x1: m[3] / pw, y1: m[4] / ph })).filter(it => it.y0 > 0.9);
    if (!items.length) continue;
    const printed = core.readPageNumber(core.groupLines(core.wordsFromTextItems(items, W, H)), W);
    if (!printed) continue;
    n++;
    votes.set(k - +printed, (votes.get(k - +printed) ?? 0) + 1);
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && n >= 10 && best[1] >= n * 0.6 ? best[0] : null;
}

async function readContentsFromBook(bookPath) {
  const isPdf = /\.pdf$/i.test(bookPath);
  let pageCount, pageImage;
  if (isPdf) {
    const { stdout } = await execFileP('pdfinfo', [bookPath]);
    pageCount = parseInt(/Pages:\s+(\d+)/.exec(stdout)?.[1] ?? '0', 10);
  } else {
    const files = (await readdir(bookPath)).filter(f => /\.(jpe?g|png|webp)$/i.test(f))
      .map(f => ({ f, seq: core.imageSequence(f) })).filter(x => x.seq).sort((a, b) => a.seq.index - b.seq.index);
    pageCount = files.length;
    pageImage = (k) => path.join(bookPath, files[k - 1].f);
  }
  let pages;
  if (contentsPages) {
    const [a, b] = contentsPages.split('-').map(v => parseInt(v, 10));
    pages = []; for (let p = a; p <= (b || a); p++) pages.push(p);
  } else {
    pages = []; for (let p = 1; p <= Math.min(pageCount, Math.max(12, Math.ceil(pageCount * 0.08))); p++) pages.push(p);
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'qcrop-contents-'));
  let worker = null;
  const ocrWords = async (file) => {
    if (!worker) {
      const { createWorker } = await import('tesseract.js');
      worker = await createWorker('tur');
      await worker.setParameters({ user_defined_dpi: '300' });
    }
    // Colored headings (red "BÖLÜM - 1") read as well as black text when each
    // pixel takes its darkest channel.
    const { default: sharp } = await import('sharp');
    const { data: px, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const gray = Buffer.alloc(info.width * info.height);
    for (let i = 0; i < gray.length; i++) gray[i] = Math.min(px[i * 3], px[i * 3 + 1], px[i * 3 + 2]);
    const png = await sharp(gray, { raw: { width: info.width, height: info.height, channels: 1 } }).normalize().png().toBuffer();
    const { data } = await worker.recognize(png, {}, { blocks: true });
    return (data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)))
      .filter(w => w.confidence >= 30 && w.text.trim())
      .map(w => ({ text: w.text.trim(), conf: w.confidence, bbox: w.bbox }));
  };

  const found = [];
  try {
    for (const p of pages) {
      let words = [], W = 2000, how = 'text layer';
      if (isPdf) {
        const { stdout } = await execFileP('pdftotext', ['-bbox', '-f', String(p), '-l', String(p), bookPath, '-'], { maxBuffer: 1 << 26 });
        const pm = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/.exec(stdout);
        const pw = +pm[1], ph = +pm[2];
        const items = [...pm[3].matchAll(/<word xMin="([-\d.]+)" yMin="([-\d.]+)" xMax="([-\d.]+)" yMax="([-\d.]+)">([^<]*)<\/word>/g)]
          .map(m => ({ str: m[5].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/[\u0000-\u001f]/g, ''), x0: m[1] / pw, y0: m[2] / ph, x1: m[3] / pw, y1: m[4] / ph }))
          .filter(it => it.str.trim());
        if (core.textLayerUsable(items)) words = core.wordsFromTextItems(items, W, Math.round(W * ph / pw));
      }
      if (!words.length) {
        how = 'OCR';
        let file = pageImage?.(p);
        if (isPdf) {
          await execFileP('pdftoppm', ['-r', '300', '-f', String(p), '-l', String(p), '-png', '-singlefile', bookPath, path.join(tmp, 'p')]);
          file = path.join(tmp, 'p.png');
        }
        words = await ocrWords(file);
        W = Math.max(1, ...words.map(w => w.bbox.x1));
      }
      const pieces = core.contentsPieces(words, W);
      const items = core.contentsItems(pieces);
      const isContents = core.looksLikeContents(items, pieces.join(' '));
      if (isContents || contentsPages) found.push({ p, items, how });
      else if (found.length) break; // contents pages come together
    }
  } finally {
    if (worker) await worker.terminate();
    await rm(tmp, { recursive: true, force: true });
  }
  return {
    items: found.flatMap(f => f.items),
    source: found.length ? `page${found.length > 1 ? 's' : ''} ${found.map(f => f.p).join(', ')} of the book, ${found[0].how}` : 'no contents page found',
  };
}
