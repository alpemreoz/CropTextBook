#!/usr/bin/env node
// Q-Crop CLI: headless version of the web app.
//
//   node cli/qcrop.mjs <PDFs, images or folders...> [-o <output dir>] [--dpi 600] [--png]
//
// Finds the multiple-choice questions on test-book pages and writes one image
// per question (JPEG, or lossless PNG with --png). Detection logic lives in
// core/qcropCore.mjs (shared with the web app); this file supplies pixels (sharp) and text: a PDF's own text
// layer when it has one (exact and fast, via poppler), Tesseract OCR
// otherwise. PDF input needs poppler's pdftoppm/pdftotext on PATH.

import sharp from 'sharp';
import { createWorker, createScheduler } from 'tesseract.js';
import { readdir, mkdir, stat, mkdtemp, rm } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import * as core from '../core/qcropCore.mjs';

const execFileP = promisify(execFile);

const OCR_WORKERS = Math.min(4, Math.max(2, os.cpus().length - 1));
const PAGE_PARALLEL = 4;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let outDir = 'q-crop-out';
// PDF pages are analyzed from a 300 dpi render (detection was tuned on it);
// each crop is then rendered again from the PDF at the crop resolution, so
// crops stay sharp without making every page render huge.
const ANALYSIS_DPI = 300;
let dpi = 600;
let png = false;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o' || args[i] === '--out') outDir = args[++i];
  else if (args[i] === '--dpi') dpi = parseInt(args[++i], 10);
  else if (args[i] === '--png') png = true;
  else inputs.push(args[i]);
}
if (inputs.length === 0 || !(dpi >= 72 && dpi <= 1200)) {
  console.error('Usage: node cli/qcrop.mjs <PDFs, images or folders...> [-o <output dir>] [--dpi <72-1200, default 600>] [--png]');
  process.exit(1);
}

const IMAGE_RE = /\.(jpe?g|png|webp)$/i;
const PDF_RE = /\.pdf$/i;

const inputFiles = [];
for (const input of inputs) {
  const s = await stat(input).catch(() => null);
  if (!s) { console.error(`skip (not found): ${input}`); continue; }
  if (s.isDirectory()) {
    const names = (await readdir(input)).filter(f => IMAGE_RE.test(f) || PDF_RE.test(f)).sort();
    inputFiles.push(...names.map(f => path.join(input, f)));
  } else {
    inputFiles.push(input);
  }
}
if (inputFiles.length === 0) {
  console.error('No PDFs or images found.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// PDF expansion (poppler)
// ---------------------------------------------------------------------------

const decodeEntities = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

/** Per-page text items (fractions of the page) from `pdftotext -bbox`. */
const pdfTextLayer = async (pdfPath) => {
  const { stdout } = await execFileP('pdftotext', ['-bbox', pdfPath, '-'], { maxBuffer: 1 << 28 });
  const pages = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  const wordRe = /<word xMin="([-\d.]+)" yMin="([-\d.]+)" xMax="([-\d.]+)" yMax="([-\d.]+)">([^<]*)<\/word>/g;
  for (const pm of stdout.matchAll(pageRe)) {
    const pw = parseFloat(pm[1]), ph = parseFloat(pm[2]);
    const items = [];
    for (const wm of pm[3].matchAll(wordRe)) {
      const [x0, y0, x1, y1] = [wm[1], wm[2], wm[3], wm[4]].map(parseFloat);
      const str = decodeEntities(wm[5]);
      // Vertical watermarks come out as tall, narrow boxes.
      if (str.length >= 3 && (y1 - y0) > 1.5 * (x1 - x0)) continue;
      items.push({ str, x0: x0 / pw, y0: y0 / ph, x1: x1 / pw, y1: y1 / ph });
    }
    pages.push(items);
  }
  return pages;
};

/** Render every page to JPEG in parallel page ranges; returns pageNo -> file. */
const renderPdf = async (pdfPath, numPages, dir) => {
  const jobs = Math.max(1, Math.min(os.cpus().length, 8, numPages));
  const per = Math.ceil(numPages / jobs);
  const runs = [];
  for (let f = 1; f <= numPages; f += per) {
    const l = Math.min(numPages, f + per - 1);
    runs.push(execFileP('pdftoppm', [
      '-f', String(f), '-l', String(l), '-r', String(ANALYSIS_DPI),
      '-jpeg', '-jpegopt', 'quality=95', pdfPath, path.join(dir, 'p'),
    ]));
  }
  await Promise.all(runs);
  const files = new Map();
  for (const f of await readdir(dir)) {
    const m = /^p-(\d+)\.jpg$/.exec(f);
    if (m) files.set(parseInt(m[1], 10), path.join(dir, f));
  }
  return files;
};

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'qcrop-'));
const pages = []; // { file, name, source?, pdfPage?, textItems? } in document order

for (const file of inputFiles) {
  if (PDF_RE.test(file)) {
    const t0 = Date.now();
    let text;
    try {
      text = await pdfTextLayer(file);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.error('PDF input needs poppler (pdftotext/pdftoppm). Install it with: brew install poppler');
        process.exit(1);
      }
      throw err;
    }
    const dir = await mkdtemp(path.join(tmpRoot, 'pdf-'));
    const rendered = await renderPdf(file, text.length, dir);
    for (let i = 1; i <= text.length; i++) {
      if (!rendered.has(i)) continue;
      pages.push({
        file: rendered.get(i),
        name: `${path.basename(file)} p${i}`,
        source: file,
        order: i,
        pdfPage: i,
        textItems: text[i - 1],
      });
    }
    console.log(`${path.basename(file)}: ${text.length} page(s) rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else if (IMAGE_RE.test(file)) {
    // Numbered page images ("Book_Sayfa_012.jpg") are read as one book in
    // page order, like a PDF.
    const seq = core.imageSequence(path.basename(file));
    pages.push({
      file, name: path.basename(file),
      ...(seq && { source: path.join(path.dirname(file), seq.key), order: seq.index, sequence: true }),
    });
  }
}

// ---------------------------------------------------------------------------
// OCR (lazy: text-layer PDFs usually need none)
// ---------------------------------------------------------------------------

let schedulerPromise = null;
const getScheduler = () => {
  if (!schedulerPromise) {
    schedulerPromise = (async () => {
      const s = createScheduler();
      for (let i = 0; i < OCR_WORKERS; i++) s.addWorker(await createWorker('tur'));
      return s;
    })();
  }
  return schedulerPromise;
};

// Pools with fixed Tesseract settings: question numbers read from the column
// margin (digits only, sparse layout) and second-chance option reads of
// strips around graphics (sparse layout).
const makePool = (params, n) => {
  let p = null;
  return () => {
    if (!p) {
      p = (async () => {
        const s = createScheduler();
        for (let i = 0; i < n; i++) {
          const w = await createWorker('tur');
          await w.setParameters(params);
          s.addWorker(w);
        }
        return s;
      })();
    }
    return p;
  };
};
const getLabelPool = makePool({ tessedit_char_whitelist: '0123456789.', tessedit_pageseg_mode: '6' }, 2);
const getSparsePool = makePool({ tessedit_pageseg_mode: '11' }, 2);
const getLetterPool = makePool({ tessedit_char_whitelist: 'ABCDE', tessedit_pageseg_mode: '10' }, 2);

let digitWorkerPromise = null;
const getDigitWorker = () => {
  if (!digitWorkerPromise) {
    digitWorkerPromise = (async () => {
      const w = await createWorker('tur');
      await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
      return w;
    })();
  }
  return digitWorkerPromise;
};

const shiftBox = (b, sx, sy, up) =>
  ({ x0: b.x0 / up + sx, y0: b.y0 / up + sy, x1: b.x1 / up + sx, y1: b.y1 / up + sy });

const linesOf = (data, sx, sy, up) =>
  (data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines.map(l => ({
    text: l.text,
    bbox: shiftBox(l.bbox, sx, sy, up),
    words: l.words.map(w => ({ text: w.text, conf: w.confidence, bbox: shiftBox(w.bbox, sx, sy, up) })),
  }))));

// CSS blur(px) (what the web app tuned against) ~ gaussian sigma px/2.
const blurSigma = (px) => Math.max(0.3, px / 2);

// ---------------------------------------------------------------------------
// Per-page analysis
// ---------------------------------------------------------------------------

const analyzePage = async (page) => {
  const { file } = page;
  const meta = await sharp(file).metadata();
  const ow = meta.width, oh = meta.height;
  const scale = Math.min(1, core.ANALYSIS_WIDTH / ow);
  const W = Math.round(ow * scale), H = Math.round(oh * scale);

  const gray = await sharp(file).resize(W, H, { fit: 'fill' }).grayscale().raw().toBuffer();
  const map = core.buildInkMap(gray, W, H, 1);
  const fromText = core.textLayerUsable(page.textItems);
  const words = fromText ? core.wordsFromTextItems(page.textItems, W, H) : [];
  const layout = core.detectLayout(map, core.labelBoxesFromWords(words));

  // A region (analysis coords) cut from the full-resolution original.
  const regionPng = async (x0, y0, x1, y1, upscale = 1, blur = 0) => {
    const w = Math.round(x1 - x0), h = Math.round(y1 - y0);
    if (w < 8 || h < 8) return null;
    const left = Math.max(0, Math.round(x0 / scale));
    const top = Math.max(0, Math.round(y0 / scale));
    const width = Math.min(ow - left, Math.round(w / scale));
    const height = Math.min(oh - top, Math.round(h / scale));
    let pipe = sharp(file)
      .extract({ left, top, width, height })
      .resize(Math.round(w * upscale), Math.round(h * upscale), { fit: 'fill' })
      .flatten({ background: '#fff' });
    if (blur > 0) pipe = pipe.blur(blurSigma(blur));
    return pipe.png().toBuffer();
  };

  const ocrRegion = async (x0, y0, x1, y1, upscale = 1, blur = 0, pool = getScheduler) => {
    const png = await regionPng(x0, y0, x1, y1, upscale, blur);
    if (!png) return [];
    const { data } = await (await pool()).addJob('recognize', png, {}, { blocks: true });
    return linesOf(data, x0, y0, upscale);
  };

  let headerLines, footerLines, columnLines, allLines;
  if (fromText) {
    headerLines = core.linesInRegion(words, 0, 0, W, layout.contentTop);
    footerLines = core.linesInRegion(words, 0, layout.footerTop, W, H);
    columnLines = layout.columns.map(c =>
      core.linesInRegion(words, c.x0 - 5, layout.contentTop, c.x1 + 5, layout.contentBottom));
    allLines = core.groupLines(words);
  } else {
    [headerLines, footerLines, ...columnLines] = await Promise.all([
      ocrRegion(0, 0, W, layout.contentTop, 2),
      ocrRegion(0, layout.footerTop, W, H, 2.5, 2.5),
      ...layout.columns.map(c => ocrRegion(c.x0, layout.contentTop, c.x1, layout.contentBottom)),
    ]);
  }

  // Options drawn as pictures ("A)" inside an image) have no text: find the
  // "X)" shapes in the ink and read each letter on its own.
  const readShapeLetters = async (strips, capH, extraOptionLines) => {
    await Promise.all(strips.map(async s => {
      const cands = core.optionLetterCandidates(map, s, capH, words);
      if (cands.length < 3) return;
      const letters = await Promise.all(cands.map(async ({ letterBox: b }) => {
        const pad = capH * 0.4;
        const png = await regionPng(b.x0 - pad, b.y0 - pad, b.x1 + pad, b.y1 + pad, 64 / capH);
        if (!png) return '';
        return (await (await getLetterPool()).addJob('recognize', png)).data.text;
      }));
      extraOptionLines[s.col].push(...core.optionLinesFromLetters(cands, letters));
    }));
  };

  let regions;
  if (fromText) {
    const params = { map, layout, columnLines, strictLabels: true, pageLines: allLines };
    const pending = core.optionlessStrips(params);
    const extraOptionLines = layout.columns.map(() => []);
    if (pending.length) await readShapeLetters(pending, core.capHeightFromStrips(pending, H, true), extraOptionLines);
    regions = core.findQuestions({ ...params, extraOptionLines });
  } else {
    // Question numbers read on their own from each column's margin.
    const marginLabels = await Promise.all(layout.columns.map(async (_, ci) => {
      const strip = core.marginStrip(map, layout, columnLines, ci);
      if (!strip) return [];
      const png = await sharp(Buffer.from(strip.gray), { raw: { width: strip.width, height: strip.height, channels: 1 } })
        .png().toBuffer();
      const { data } = await (await getLabelPool()).addJob('recognize', png, {}, { blocks: true });
      const words = (data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)));
      return core.marginLabelsFromWords(words, strip, H);
    }));
    // Second chance for numbered strips without options: sparse-text OCR.
    const extraOptionLines = layout.columns.map(() => []);
    await Promise.all(core.optionlessStrips({ map, layout, columnLines, marginLabels }).map(async s => {
      extraOptionLines[s.col].push(...await ocrRegion(s.x0, s.y0, s.x1, s.y1, 2, 0, getSparsePool));
    }));
    // Third chance: find "X)" shapes beside drawings and read each letter.
    const labelHeights = marginLabels.flat().map(m => m.bbox.y1 - m.bbox.y0).sort((a, b) => a - b);
    const capH = labelHeights.length ? labelHeights[labelHeights.length >> 1] : H * 0.0105;
    const still = core.optionlessStrips({ map, layout, columnLines, marginLabels, extraOptionLines });
    await readShapeLetters(still, capH, extraOptionLines);
    // Text the column OCR skipped (shaded instruction boxes), read on its
    // own; used only to find shared-passage instructions.
    const passageLines = layout.columns.map(() => []);
    for (const band of core.unreadBands(map, layout, columnLines)) {
      const line = core.instructionFromBand(await ocrRegion(band.x0, band.y0, band.x1, band.y1, 2), band);
      if (line) passageLines[band.col].push(line);
    }
    regions = core.findQuestions({ map, layout, columnLines, marginLabels, extraOptionLines, passageLines });
  }

  let testNumber = core.readTestNumber(headerLines);
  if (!testNumber && !fromText) {
    // Corner badge: "TEST" above a seven-segment number (blur 4 -> sigma 2
    // is the sweet spot for sharp's gaussian on these badges).
    const badgeBottom = H * 0.09;
    const png = await regionPng(W * 0.7, 0, W, badgeBottom, 4, 4);
    if (png) {
      const { data } = await (await getScheduler()).addJob('recognize', png, {}, { blocks: true });
      const words = (data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)));
      const badge = core.testNumberFromBadgeWords(words);
      testNumber = badge.testNumber;
      if (!testNumber && badge.testWord) {
        // Digits-only re-OCR just below the TEST word (badge coords are in
        // the 4x-upscaled corner; map back to page space).
        const up = 4, cx0 = W * 0.7, tw = badge.testWord;
        const th = (tw.bbox.y1 - tw.bbox.y0) / up;
        const gx0 = cx0 + tw.bbox.x0 / up - th, gx1 = cx0 + tw.bbox.x1 / up + th;
        const gy0 = tw.bbox.y1 / up, gy1 = Math.min(badgeBottom, gy0 + th * 3.5);
        for (const blur of [2, 3]) {
          const crop = await regionPng(gx0, gy0, gx1, gy1, 8, blur);
          if (!crop) break;
          const t = (await (await getDigitWorker()).recognize(crop)).data.text.trim();
          if (/^\d{1,2}$/.test(t)) { testNumber = t.padStart(2, '0'); break; }
        }
      }
    }
  }

  // Unit covers name the topic for the pages that follow them in a book.
  let coverTopic;
  if ((page.pdfPage || page.sequence) && regions.length === 0) {
    if (fromText) coverTopic = core.readCoverTopic(allLines);
    if (!coverTopic && (!fromText || core.findFormLine(allLines))) {
      const pageLines = fromText ? allLines : await ocrRegion(0, 0, W, H);
      const form = core.findFormLine(pageLines);
      if (form) {
        const band = core.coverTopicBand(form, W, H);
        const bandLines = await ocrRegion(band.x0, band.y0, band.x1, band.y1, 2);
        coverTopic = core.readCoverTopic([...bandLines, form]) ?? core.readCoverTopic(pageLines);
      }
    }
  }

  let pageNumber, pageLabel;
  if (page.pdfPage) {
    pageNumber = String(page.pdfPage);
    pageLabel = `s${page.pdfPage}`;
  } else {
    // Scan filenames ("..._Page_033.jpg") beat footer OCR, which can misread
    // stylized digits to a wrong-but-plausible number.
    const fm = /(?:page|sayfa)[_\s-]*(\d{1,4})/i.exec(path.basename(file));
    pageNumber = fm ? String(parseInt(fm[1], 10)) : (core.readPageNumber(footerLines, W) ?? 'unknown');
    pageLabel = pageNumber;
  }

  return {
    regions, testNumber, pageNumber, pageLabel, ow, oh, fromText,
    section: core.readSection(headerLines),
    headerTopic: core.readHeaderTopic(headerLines, W),
    coverTopic,
  };
};

// ---------------------------------------------------------------------------
// Cropping (same geometry as App.tsx, via core.cropRect)
// ---------------------------------------------------------------------------

const encode = (img, outPath) => (png
  ? img.png({ compressionLevel: 9 })
  // 4:4:4 keeps colored figure lines crisp; 4:2:0 smears them.
  : img.jpeg({ quality: 95, chromaSubsampling: '4:4:4' })
).toFile(outPath);

/**
 * PDF pages: render just the crop area straight from the PDF at the crop
 * resolution (vector text stays sharp at any dpi). Images: cut from the
 * original file, which is as sharp as the source allows.
 */
const renderRect = async (page, r) => {
  const img = page.pdfPage
    ? sharp((await execFileP('pdftoppm', [
      '-f', String(page.pdfPage), '-l', String(page.pdfPage), '-r', String(dpi),
      '-x', String(r.sx), '-y', String(r.sy), '-W', String(r.sw), '-H', String(r.sh),
      '-png', '-singlefile', page.source,
    ], { encoding: 'buffer', maxBuffer: 1 << 30 })).stdout)
    : sharp(page.file).extract({ left: r.sx, top: r.sy, width: r.sw, height: r.sh });
  // Lossless in-between step (a JPEG source would otherwise be re-encoded twice).
  return img.flatten({ background: '#fff' }).removeAlpha().png({ compressionLevel: 1 }).toBuffer();
};

/**
 * One question's image. With a shared passage (`contextBox`), the passage
 * goes on top and the question below it.
 */
const cropRegion = async (page, ow, oh, region, outPath) => {
  const k = page.pdfPage ? dpi / ANALYSIS_DPI : 1;
  const W = Math.round(ow * k), H = Math.round(oh * k);
  const r = core.cropRect(region.box, W, H);
  // White out the question number when it falls inside the box.
  const m = core.maskRect(region.mask, r, W, H);
  const white = (w, h) => ({ create: { width: w, height: h, channels: 3, background: '#fff' } });
  let q = await renderRect(page, r);
  if (m) q = await sharp(q).composite([{ input: white(m.w, m.h), left: m.x, top: m.y }]).png({ compressionLevel: 1 }).toBuffer();
  if (!region.contextBox) return encode(sharp(q), outPath);
  const c = core.cropRect(region.contextBox, W, H);
  const at = core.stackLayout(c, r, Math.round(H * 0.012));
  await encode(sharp(white(at.width, at.height)).composite([
    { input: await renderRect(page, c), left: at.ctxAt.x, top: at.ctxAt.y },
    { input: q, left: at.qAt.x, top: at.qAt.y },
  ]), outPath);
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const t0 = Date.now();
console.log(`Q-Crop CLI: ${pages.length} page(s)`);
await mkdir(outDir, { recursive: true });

const results = new Array(pages.length);
let next = 0;
const worker = async () => {
  while (next < pages.length) {
    const i = next++;
    try {
      results[i] = await analyzePage(pages[i]);
    } catch (err) {
      console.error(`  ${pages[i].name}: FAILED: ${err.message}`);
      results[i] = null;
    }
  }
};
await Promise.all(Array.from({ length: PAGE_PARALLEL }, worker));

// Topics: pages of one book (a PDF or a numbered image sequence) inherit
// from unit covers in page order; other images stand alone.
const topics = new Array(pages.length);
const bySource = new Map();
pages.forEach((p, i) => {
  if (!results[i]) return;
  if (!p.source) { topics[i] = results[i].section ?? results[i].headerTopic; return; }
  if (!bySource.has(p.source)) bySource.set(p.source, []);
  bySource.get(p.source).push(i);
});
for (const idxs of bySource.values()) {
  idxs.sort((a, b) => pages[a].order - pages[b].order);
  const resolved = core.resolveTopics(idxs.map(i => results[i]));
  idxs.forEach((i, k) => { topics[i] = resolved[k]; });
}

let total = 0;
const used = new Set();
const cropJobs = [];
for (let i = 0; i < pages.length; i++) {
  const r = results[i];
  if (!r) continue;
  for (const region of r.regions) {
    let name = core.cropFileName({
      testNumber: r.testNumber, topic: topics[i],
      questionNumber: region.questionNumber, pageLabel: r.pageLabel,
    });
    if (png) name = name.replace(/\.jpg$/, '.png');
    for (let k = 2; used.has(name); k++) name = name.replace(/(_\d+)?\.(jpg|png)$/, `_${k}.$2`);
    used.add(name);
    cropJobs.push(() => cropRegion(pages[i], r.ow, r.oh, region, path.join(outDir, name)));
    total++;
  }
  if (r.regions.length > 0 || !pages[i].source) {
    const meta = [
      `page ${r.pageNumber}`,
      r.testNumber && `test ${r.testNumber}`,
      topics[i] && `"${topics[i]}"`,
      r.fromText ? 'text layer' : 'OCR',
    ].filter(Boolean).join(', ');
    console.log(`  ${pages[i].name}: ${meta} -> ${r.regions.map(q => 'Q' + q.questionNumber).join(' ') || 'no test questions'}`);
    const shared = r.regions.filter(q => q.contextBox);
    if (shared.length) console.log(`    with shared passage: ${shared.map(q => 'Q' + q.questionNumber).join(' ')}`);
  }
}
let nextJob = 0;
await Promise.all(Array.from({ length: Math.max(2, os.cpus().length) }, async () => {
  while (nextJob < cropJobs.length) await cropJobs[nextJob++]();
}));

console.log(`Done: ${total} crop(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${outDir}/`);
if (schedulerPromise) await (await schedulerPromise).terminate();
if (digitWorkerPromise) await (await digitWorkerPromise).terminate();
await rm(tmpRoot, { recursive: true, force: true });
process.exit(0);
