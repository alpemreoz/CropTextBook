#!/usr/bin/env node
// Q-Crop options: finds where each answer option (A-E, the letter and
// everything that belongs to it: text, formula, table row or picture) sits in
// question crops, and writes one CSV row per crop.
//
//   node cli/qcrop-options.mjs <crops or folders...> [-o options.csv] [--overlay <dir>]
//
// CSV columns: crop, options, status. `options` is JSON in crop pixels:
//   [{"A": {"X1": 9, "X2": 76, "Y1": 754, "Y2": 791}}, {"B": {...}}, ...]
// `status` is "ok", or says which letters were not found. --overlay writes a
// copy of each crop with its option boxes drawn on it, for checking by eye.
//
// Works on the crop image alone (no PDF needed): option letters are read with
// Tesseract plus a shape pass for letters OCR misses (options beside
// drawings, fractions), then each option's box grows from its letter over the
// ink of its cell in the options grid.

import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { readdir, stat, mkdir, writeFile } from 'fs/promises';
import path from 'path';
import * as core from '../core/qcropCore.mjs';

const args = process.argv.slice(2);
let outFile = 'options.csv';
let overlayDir = null;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o' || args[i] === '--out') outFile = args[++i];
  else if (args[i] === '--overlay') overlayDir = args[++i];
  else inputs.push(args[i]);
}
if (inputs.length === 0) {
  console.error('Usage: node cli/qcrop-options.mjs <crops or folders...> [-o options.csv] [--overlay <dir>]');
  process.exit(1);
}

const IMAGE_RE = /\.(jpe?g|png|webp)$/i;
const LETTERS = ['A', 'B', 'C', 'D', 'E'];

const listImages = async (p) => {
  if ((await stat(p)).isDirectory()) {
    const names = (await readdir(p)).filter(n => IMAGE_RE.test(n)).sort((a, b) => a.localeCompare(b, 'tr', { numeric: true }));
    return names.map(n => path.join(p, n));
  }
  return IMAGE_RE.test(p) ? [p] : [];
};

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

/** 4-connected ink components of the whole map: [{ x0, y0, x1, y1, n }]. */
const components = (map) => {
  const { width: w, height: h, ink } = map;
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || !ink[s]) continue;
    let x0 = w, y0 = h, x1 = 0, y1 = 0, n = 0;
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i - x) / w;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x + 1 < w && !seen[i + 1] && ink[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (x > 0 && !seen[i - 1] && ink[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (y + 1 < h && !seen[i + w] && ink[i + w]) { seen[i + w] = 1; stack.push(i + w); }
      if (y > 0 && !seen[i - w] && ink[i - w]) { seen[i - w] = 1; stack.push(i - w); }
    }
    out.push({ x0, y0, x1: x1 + 1, y1: y1 + 1, n });
  }
  return out;
};

const median = (vals) => {
  if (!vals.length) return NaN;
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// Working size: text scaled so letters are ~24 px tall (what Tesseract reads
// best), whatever resolution the crop was exported at.
const TARGET_TEXT_H = 24;

const loadScaled = async (file) => {
  const meta = await sharp(file).metadata();
  const s0 = Math.min(1, 1600 / meta.width);
  const w0 = Math.round(meta.width * s0), h0 = Math.round(meta.height * s0);
  const g0 = await sharp(file).resize(w0, h0, { fit: 'fill' }).flatten({ background: '#fff' }).grayscale().raw().toBuffer();
  const heights = components(core.buildInkMap(g0, w0, h0, 1))
    .filter(c => c.y1 - c.y0 >= 4 && c.y1 - c.y0 <= h0 * 0.1 && c.x1 - c.x0 <= (c.y1 - c.y0) * 2.5)
    .map(c => c.y1 - c.y0);
  const textH = median(heights);
  const scale = Number.isFinite(textH) ? Math.min(2.5, Math.max(0.1, s0 * TARGET_TEXT_H / textH)) : s0;
  const W = Math.round(meta.width * scale), H = Math.round(meta.height * scale);
  const gray = await sharp(file).resize(W, H, { fit: 'fill' }).flatten({ background: '#fff' }).grayscale().raw().toBuffer();
  return { gray, W, H, scale, ow: meta.width, oh: meta.height };
};

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

let textWorker = null, letterWorker = null;
const getTextWorker = async () => {
  if (!textWorker) {
    textWorker = await createWorker('tur');
    await textWorker.setParameters({ tessedit_pageseg_mode: '11', user_defined_dpi: '300' });
  }
  return textWorker;
};
const getLetterWorker = async () => {
  if (!letterWorker) {
    letterWorker = await createWorker('tur');
    await letterWorker.setParameters({ tessedit_char_whitelist: 'ABCDE', tessedit_pageseg_mode: '10', user_defined_dpi: '300' });
  }
  return letterWorker;
};

const grayPng = (gray, W, H) => sharp(gray, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer();

const ocrWords = async (gray, W, H) => {
  const { data } = await (await getTextWorker()).recognize(await grayPng(gray, W, H), {}, { blocks: true });
  return (data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words.map(w => ({
    text: w.text, conf: w.confidence, bbox: w.bbox,
  })))));
};

const readLetter = async (gray, W, H, box) => {
  const pad = Math.round((box.y1 - box.y0) * 0.4);
  const left = Math.max(0, box.x0 - pad), top = Math.max(0, box.y0 - pad);
  const width = Math.min(W, box.x1 + pad) - left, height = Math.min(H, box.y1 + pad) - top;
  const png = await sharp(gray, { raw: { width: W, height: H, channels: 1 } })
    .extract({ left, top, width, height }).resize({ height: height * 2 }).png().toBuffer();
  return (await (await getLetterWorker()).recognize(png)).data.text.trim();
};

// ---------------------------------------------------------------------------
// Option letters
// ---------------------------------------------------------------------------

// "A)", "(A)", and "Cc)" (a letter read twice).
const LABEL_RE = /^\(?([A-E])(?:\s|[a-eç](?=[)\]}]))?[)\]}]/;

/** "A)" labels in OCR words -> [{ letter, box }] (box of the "A)" part only). */
const labelsFromWords = (words) => {
  const out = [];
  words.forEach((w, i) => {
    const t = w.text.trim();
    let m = LABEL_RE.exec(t);
    let box = { ...w.bbox };
    if (m) {
      // "A)13" read as one word: keep the label's share of its width.
      const share = Math.min(1, m[0].length / Math.max(1, t.length));
      box.x1 = box.x0 + Math.max((box.x1 - box.x0) * share, (box.y1 - box.y0) * 0.9);
    } else if (/^\(?[A-E]$/.test(t)) {
      // "A" and ")" read as two words side by side.
      const nx = words[i + 1];
      const hh = w.bbox.y1 - w.bbox.y0;
      if (!nx || !/^[)\]}]/.test(nx.text.trim()) || nx.bbox.x0 - w.bbox.x1 > hh * 0.6) return;
      m = [t, t.replace('(', '')];
      box = { x0: w.bbox.x0, y0: Math.min(w.bbox.y0, nx.bbox.y0), x1: nx.bbox.x0 + hh * 0.4, y1: Math.max(w.bbox.y1, nx.bbox.y1) };
    } else return;
    out.push({ letter: m[1], box, src: 'ocr' });
  });
  return out;
};

const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const cy = (b) => (b.y0 + b.y1) / 2;
const sameRow = (a, b) => Math.abs(cy(a) - cy(b)) < Math.max(a.y1 - a.y0, b.y1 - b.y0) * 0.6;

/**
 * The options' letters among all candidates: the longest chain of rising
 * letters in reading order (each to the right on the same row, or on a later
 * row; a letter OCR missed may be skipped). Ties go to the chain with fewer
 * skips, then to the one further down (options close a question; figure
 * labels "A) B) C)" sit above them).
 */
const chooseChain = (cands) => {
  const after = (a, b) => sameRow(a.box, b.box) ? b.box.x0 > a.box.x1 : cy(b.box) > cy(a.box);
  const sorted = [...cands].sort((a, b) => a.letter.localeCompare(b.letter));
  // best[i]: best chain ending at sorted[i].
  const best = sorted.map(c => [c]);
  const better = (p, q) => p.length > q.length || (p.length === q.length && (
    skips(p) < skips(q) || (skips(p) === skips(q) && cy(p[0].box) > cy(q[0].box))));
  const skips = (ch) => ch[ch.length - 1].letter.charCodeAt(0) - ch[0].letter.charCodeAt(0) + 1 - ch.length;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = 0; j < i; j++) {
      if (sorted[j].letter >= sorted[i].letter || !after(sorted[j], sorted[i])) continue;
      const cand = [...best[j], sorted[i]];
      if (better(cand, best[i])) best[i] = cand;
    }
  }
  return best.reduce((b, ch) => (!b.length || better(ch, b) ? ch : b), []);
};

/**
 * Letters the chain skipped, placed from their neighbours when the grid
 * makes the spot clear: between two letters of one row, or between/after
 * letters stacked in one column. The guess snaps to the capital-sized glyph
 * nearest to it. -> new chain entries (src 'inferred').
 */
const inferMissing = (chain, comps, capH, width) => {
  const out = [];
  const byLetter = Object.fromEntries(chain.map(o => [o.letter, o]));
  const first = chain[0].letter, last = chain[chain.length - 1].letter;
  const letterLike = comps.filter(c => c.y1 - c.y0 >= capH * 0.6 && c.y1 - c.y0 <= capH * 1.4 && c.x1 - c.x0 <= capH * 1.4);
  const place = (letter, x, y) => {
    const near = letterLike.filter(c => Math.abs(c.x0 - x) < capH * 1.5 && Math.abs(cy(c) - y) < capH)
      .sort((a, b) => Math.hypot(a.x0 - x, cy(a) - y) - Math.hypot(b.x0 - x, cy(b) - y))[0];
    const box = near
      ? { x0: near.x0, y0: near.y0, x1: near.x0 + capH * 1.2, y1: near.y1 }
      : { x0: x, y0: y - capH / 2, x1: x + capH * 1.2, y1: y + capH / 2 };
    out.push({ letter, box, src: 'inferred' });
  };
  for (const L of LETTERS) {
    if (byLetter[L] || L < first || L > last) continue;
    const prev = [...chain].reverse().find(o => o.letter < L), next = chain.find(o => o.letter > L);
    const steps = next.letter.charCodeAt(0) - prev.letter.charCodeAt(0);
    const f = (L.charCodeAt(0) - prev.letter.charCodeAt(0)) / steps;
    const sameCol = Math.abs(prev.box.x0 - next.box.x0) < capH;
    if (sameRow(prev.box, next.box) || sameCol) {
      place(L, prev.box.x0 + (next.box.x0 - prev.box.x0) * f, cy(prev.box) + (cy(next.box) - cy(prev.box)) * f);
      continue;
    }
    // Rows of a grid ("A B C / D E"): one letter short at the end of the
    // previous row or the start of the next, a column step away.
    if (steps !== 2) continue;
    const rowOf = (o) => chain.filter(c => sameRow(c.box, o.box)).sort((a, b) => a.box.x0 - b.box.x0);
    const pr = rowOf(prev), nr = rowOf(next);
    const step = (r) => r.length >= 2 ? (r[r.length - 1].box.x0 - r[0].box.x0) / (r.length - 1) : NaN;
    const pStep = step(pr), nStep = step(nr);
    if (pr[pr.length - 1] === prev && prev.box.x0 + pStep + capH * 2 < width) place(L, prev.box.x0 + pStep, cy(prev.box));
    else if (nr[0] === next && next.box.x0 - nStep >= -capH * 0.5) place(L, Math.max(0, next.box.x0 - nStep), cy(next.box));
  }
  return out;
};

// ---------------------------------------------------------------------------
// Option boxes
// ---------------------------------------------------------------------------

/**
 * Page furniture the crop caught at its sides (a vertical publisher tab, a
 * dotted column rule): a narrow strip of ink at the left or right edge, cut
 * off from the content by a blank gutter running the crop's full height.
 * -> { left, right }: the x range options may use.
 */
const edgeFurniture = (map, chain, capH) => {
  const { width: W, height: H, ink } = map;
  const colInk = new Int32Array(W);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ink[y * W + x]) colInk[x]++;
  const labels = chain.map(o => o.box);
  // From an edge inward (dir +1 from the left, -1 from the right): margin,
  // a strip of ink at most 2 capitals wide, then a blank gutter >= 1 capital.
  const scan = (start, dir) => {
    let x = start;
    while (x >= 0 && x < W && !colInk[x]) x += dir;
    const s0 = x;
    while (x >= 0 && x < W && colInk[x]) x += dir;
    const s1 = x;
    if (Math.abs(s1 - s0) > capH * 2) return start;
    while (x >= 0 && x < W && !colInk[x]) x += dir;
    if (x < 0 || x >= W || Math.abs(x - s1) < capH) return start;
    const strip = { x0: Math.min(s0, s1), x1: Math.max(s0, s1) };
    if (labels.some(b => b.x0 < strip.x1 && b.x1 > strip.x0)) return start;
    return s1;
  };
  return { left: scan(0, 1), right: scan(W - 1, -1) + 1 };
};

/**
 * Each option's box: the cell of the options grid its letter starts (to the
 * next letter on its row, down to the gap before the next row) and the ink in
 * it. The first row also takes what overlaps its letters' line (fractions,
 * pictures centered beside their letter).
 */
const optionBoxes = (map, comps, chain, capH) => {
  const { width: W, height: H } = map;
  const edges = edgeFurniture(map, chain, capH);
  const rows = [];
  for (const o of chain) {
    const row = rows.find(r => sameRow(r[0].box, o.box));
    if (row) row.push(o); else rows.push([o]);
  }
  rows.forEach(r => r.sort((a, b) => a.box.x0 - b.box.x0));
  rows.sort((a, b) => cy(a[0].box) - cy(b[0].box));
  const rowTop = (r) => Math.min(...r.map(o => o.box.y0));
  const rowBottom = (r) => Math.max(...r.map(o => o.box.y1));
  const optX0 = Math.min(...chain.map(o => o.box.x0)) - capH * 0.3;

  // Row splits: the middle of the widest blank band between two label rows.
  const blankRow = (y) => {
    for (let x = Math.max(0, Math.floor(optX0)); x < W; x++) if (map.ink[y * W + x]) return false;
    return true;
  };
  const splits = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = Math.ceil(rowBottom(rows[i])), b = Math.floor(rowTop(rows[i + 1]));
    let best = null, run = null;
    for (let y = a; y <= b; y++) {
      if (y < b && blankRow(y)) { run ??= y; continue; }
      if (run !== null && (!best || y - run > best[1] - best[0])) best = [run, y];
      run = null;
    }
    splits.push(best ? (best[0] + best[1]) / 2 : (a + b) / 2);
  }

  const specks = (c) => c.y1 - c.y0 < capH * 0.12 && c.x1 - c.x0 < capH * 0.12;
  const boxes = [];
  rows.forEach((row, ri) => {
    let top = ri === 0 ? rowTop(row) : splits[ri - 1];
    const bottom = ri + 1 < rows.length ? splits[ri] : H;
    row.forEach((o, ci) => {
      const x0 = Math.max(edges.left, ci === 0 ? optX0 : o.box.x0 - capH * 0.3);
      const x1 = Math.min(edges.right, ci + 1 < row.length ? row[ci + 1].box.x0 - capH * 0.3 : W);
      let cellTop = top;
      if (ri === 0) {
        // Ink sharing the letter's line may reach above it.
        for (const c of comps) {
          const mx = (c.x0 + c.x1) / 2;
          if (mx >= x0 && mx < x1 && c.y0 < o.box.y1 && c.y1 > o.box.y0 && !specks(c)) cellTop = Math.min(cellTop, c.y0);
        }
      }
      const inCell = comps.filter(c => {
        if (specks(c)) return false;
        const mx = (c.x0 + c.x1) / 2, my = (c.y0 + c.y1) / 2;
        if (mx < x0 || mx >= x1 || my < cellTop || my >= bottom) return false;
        // Page furniture running far outside the cell (rules, frames).
        return !(c.y0 < cellTop - capH * 2 || c.y1 > bottom + capH * 2 || c.x1 > x1 + capH * 2);
      });
      // Grow from the letter through the cell's ink, line by line: a table
      // row's far cells belong to it, a stray mark well below doesn't.
      const box = { ...o.box };
      for (let grown = true; grown;) {
        grown = false;
        for (let i = inCell.length - 1; i >= 0; i--) {
          const c = inCell[i];
          if (c.y0 - box.y1 > capH * 2 || box.y0 - c.y1 > capH * 2) continue;
          box.x0 = Math.min(box.x0, c.x0); box.y0 = Math.min(box.y0, c.y0);
          box.x1 = Math.max(box.x1, c.x1); box.y1 = Math.max(box.y1, c.y1);
          inCell.splice(i, 1);
          grown = true;
        }
      }
      boxes.push({ letter: o.letter, box });
    });
  });
  return boxes.sort((a, b) => a.letter.localeCompare(b.letter));
};

// ---------------------------------------------------------------------------
// Per crop
// ---------------------------------------------------------------------------

const analyzeCrop = async (file) => {
  const { gray, W, H, scale } = await loadScaled(file);
  const map = core.buildInkMap(gray, W, H, 1);
  const comps = components(map);
  const words = await ocrWords(gray, W, H);
  let cands = labelsFromWords(words);

  // Capital height: from the labels read, else from the text size we scaled to.
  const capH = median(cands.map(c => c.box.y1 - c.box.y0)) || TARGET_TEXT_H;
  // Shape pass: a capital with ")" after it that OCR didn't read as a label.
  // OCR boxes of "A)" span the parenthesis, a little taller than the letter.
  const letterH = capH * 0.85;
  const shapes = core.optionLetterCandidates(map, { x0: 0, y0: 0, x1: W, y1: H }, letterH)
    .filter(s => !cands.some(c => overlaps(c.box, s.pairBox)));
  for (const s of shapes) {
    const t = await readLetter(gray, W, H, s.letterBox);
    if (/^[A-E]$/.test(t)) cands.push({ letter: t, box: s.pairBox, src: 'shape' });
  }

  let chain = chooseChain(cands);
  if (chain.length >= 2) chain = [...chain, ...inferMissing(chain, comps, letterH, W)];
  const boxes = chain.length >= 2 ? optionBoxes(map, comps, chain, capH) : [];
  const found = boxes.map(b => b.letter);
  // Books with four options stop at D, so a missing E can't be told apart.
  const missing = LETTERS.filter(l => !found.includes(l) && l <= (found.includes('E') ? 'E' : 'D'));
  const inferred = chain.filter(o => o.src === 'inferred').map(o => o.letter);
  const status = !found.length ? 'no options found'
    : missing.length ? `missing ${missing.join('')}`
    : inferred.length ? `inferred ${inferred.join('')}` : 'ok';
  const toCrop = (v) => Math.round(v / scale);
  const options = boxes.map(b => ({
    [b.letter]: {
      X1: Math.max(0, toCrop(b.box.x0)), X2: toCrop(b.box.x1),
      Y1: Math.max(0, toCrop(b.box.y0)), Y2: toCrop(b.box.y1),
    },
  }));
  return { options, status };
};

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4'];

const drawOverlay = async (file, options, out) => {
  const meta = await sharp(file).metadata();
  const sw = Math.max(2, Math.round(meta.width / 400));
  const rects = options.map((o, i) => {
    const [letter, b] = Object.entries(o)[0];
    const c = COLORS[i % COLORS.length];
    // Stroke drawn just outside the box, so it never hides the box's edge ink.
    return `<rect x="${b.X1 - sw / 2}" y="${b.Y1 - sw / 2}" width="${b.X2 - b.X1 + sw}" height="${b.Y2 - b.Y1 + sw}" fill="${c}" fill-opacity="0.12" stroke="${c}" stroke-width="${sw}"/>` +
      `<text x="${b.X2 + sw}" y="${b.Y1 + sw * 3}" font-size="${sw * 7}" font-weight="bold" font-family="sans-serif" fill="${c}">${letter}</text>`;
  }).join('');
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}">${rects}</svg>`);
  await sharp(file).composite([{ input: svg }]).jpeg({ quality: 85 }).toFile(out);
};

const csvField = (v) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

const files = (await Promise.all(inputs.map(listImages))).flat();
if (overlayDir) await mkdir(overlayDir, { recursive: true });
const rows = ['crop,options,status'];
let ok = 0;
for (const file of files) {
  let result;
  try {
    result = await analyzeCrop(file);
  } catch (err) {
    result = { options: [], status: `error: ${err.message}` };
  }
  if (result.status === 'ok' || result.status.startsWith('inferred')) ok++;
  rows.push([path.basename(file), JSON.stringify(result.options), result.status].map(csvField).join(','));
  console.log(`  ${path.basename(file)}: ${result.status}${result.status === 'ok' ? '' : ` (${result.options.map(o => Object.keys(o)[0]).join('') || '-'})`}`);
  if (overlayDir) await drawOverlay(file, result.options, path.join(overlayDir, path.basename(file).replace(IMAGE_RE, '.jpg')));
}
await writeFile(outFile, rows.join('\n') + '\n');
console.log(`Done: ${ok}/${files.length} crop(s) with all options -> ${outFile}`);
await textWorker?.terminate();
await letterWorker?.terminate();
