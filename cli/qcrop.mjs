#!/usr/bin/env node
// Q-Crop CLI: headless version of the web app.
//
//   node cli/qcrop.mjs <PDFs, images or folders...> [-o <output dir>] [--dpi 600] [--png] [--week]
//
// Finds the multiple-choice questions on test-book pages and writes one image
// per question (JPEG, or lossless PNG with --png; --week prefixes names with
// the page's "N. HAFTA" week). Detection logic lives in core/qcropCore.mjs
// (shared with the web app); this file supplies pixels (sharp) and text: a
// PDF's own text layer when it has one (exact and fast, via poppler),
// Tesseract OCR otherwise. PDF input needs poppler's pdftoppm/pdftotext on PATH.

import sharp from 'sharp';
import { createWorker, createScheduler } from 'tesseract.js';
import { readdir, mkdir, stat, mkdtemp, rm, writeFile } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import * as core from '../core/qcropCore.mjs';
import { profileOptions, PROFILES } from '../core/profiles.mjs';

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
// Prefix crops with the page's week ("6_hafta_..."), for books whose answer
// keys are listed by week.
let week = false;
// Book profile (core/profiles.mjs): settings for book series the defaults
// don't handle. None = the defaults every earlier book was verified with.
let profileName = '';
// PDF pages to analyze ("10-40,52"); all by default.
let pageSpec = null;
// Analyze and report only; write no crops.
let dryRun = false;
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o' || args[i] === '--out') outDir = args[++i];
  else if (args[i] === '--dpi') dpi = parseInt(args[++i], 10);
  else if (args[i] === '--png') png = true;
  else if (args[i] === '--week') week = true;
  else if (args[i] === '--profile') profileName = args[++i];
  else if (args[i] === '--pages') pageSpec = args[++i];
  else if (args[i] === '--dry-run') dryRun = true;
  else inputs.push(args[i]);
}
let opts;
try { opts = profileOptions(profileName); } catch (err) { console.error(err.message); process.exit(1); }
if (inputs.length === 0 || !(dpi >= 72 && dpi <= 1200)) {
  console.error('Usage: node cli/qcrop.mjs <PDFs, images or folders...> [-o <output dir>] [--dpi <72-1200, default 600>] [--png] [--week] [--profile <name>] [--pages 10-40,52] [--dry-run]');
  console.error(`Profiles: ${Object.keys(PROFILES).join(', ')}`);
  process.exit(1);
}

/** "10-40,52" -> predicate on PDF page numbers (1-based). */
const pageFilter = (spec) => {
  if (!spec) return () => true;
  const ranges = spec.split(',').map(r => r.split('-').map(v => parseInt(v, 10)))
    .map(([a, b]) => [a, Number.isFinite(b) ? b : a]);
  return (p) => ranges.some(([a, b]) => p >= a && p <= b);
};
const wantPage = pageFilter(pageSpec);

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
      // Fonts without a proper Unicode map yield control characters (as in
      // the web app's normalizePdfTextItems).
      const str = decodeEntities(wm[5]).replace(/[\t\n\r]/g, ' ').replace(/[\u0000-\u001f]/g, '');
      if (!str.trim()) continue;
      // Vertical watermarks come out as tall, narrow boxes.
      if (str.length >= 3 && (y1 - y0) > 1.5 * (x1 - x0)) continue;
      items.push({ str, x0: x0 / pw, y0: y0 / ph, x1: x1 / pw, y1: y1 / ph });
    }
    // (page shape, for laying out the text of pages that aren't rendered)
    items.aspect = ph / pw;
    pages.push(items);
  }
  return pages;
};

/** Render the given pages to JPEG in parallel page ranges; returns pageNo -> file. */
const renderPdf = async (pdfPath, pageNos, dir) => {
  // Contiguous runs, split so every core gets a share.
  const per = Math.max(1, Math.ceil(pageNos.length / Math.max(1, Math.min(os.cpus().length, 8))));
  const runs = [];
  for (const p of pageNos) {
    const last = runs[runs.length - 1];
    if (last && p === last[1] + 1 && last[1] - last[0] + 1 < per) last[1] = p; else runs.push([p, p]);
  }
  await Promise.all(runs.map(([f, l]) => execFileP('pdftoppm', [
    '-f', String(f), '-l', String(l), '-r', String(ANALYSIS_DPI),
    '-jpeg', '-jpegopt', 'quality=95', pdfPath, path.join(dir, 'p'),
  ])));
  const files = new Map();
  for (const f of await readdir(dir)) {
    const m = /^p-(\d+)\.jpg$/.exec(f);
    if (m) files.set(parseInt(m[1], 10), path.join(dir, f));
  }
  return files;
};

const tmpRoot = await mkdtemp(path.join(os.tmpdir(), 'qcrop-'));
const pages = []; // { file, name, source?, pdfPage?, textItems? } in document order
const bookText = new Map(); // PDF -> text items of every page (contents and answer key)

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
    bookText.set(file, text);
    const dir = await mkdtemp(path.join(tmpRoot, 'pdf-'));
    const rendered = await renderPdf(file, text.map((_, i) => i + 1).filter(wantPage), dir);
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
    console.log(`${path.basename(file)}: ${rendered.size === text.length ? '' : `${rendered.size} of `}${text.length} page(s) rendered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
const getWeekPool = makePool({ tessedit_char_whitelist: '0123456789.', tessedit_pageseg_mode: '7' }, 2);
const getKeyPool = makePool({ tessedit_char_whitelist: '0123456789.-)/ABCDE ', tessedit_pageseg_mode: '11' }, 2);

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
  let words = fromText ? core.wordsFromTextItems(page.textItems, W, H) : [];
  // Hidden answer marks, read before invisible text is dropped.
  const marks = fromText ? core.hiddenAnswerMarks(words) : [];
  if (fromText && opts.mixedColumns) words = core.tidyTextWords(words, W, map);
  let layout = core.detectLayout(map, core.labelBoxesFromWords(words), opts);
  if (fromText && opts.mixedColumns) layout = core.mixedColumns(map, layout, words, marks);

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

  let headerLines, footerLines, columnLines, allLines, marginLabels;
  if (fromText) {
    headerLines = core.linesInRegion(words, 0, 0, W, layout.contentTop);
    footerLines = core.linesInRegion(words, 0, layout.footerTop, W, H);
    columnLines = layout.columns.map(c =>
      core.linesInRegion(words, c.x0 - 5, c.y0 ?? layout.contentTop, c.x1 + 5, c.y1 ?? layout.contentBottom));
    allLines = core.groupLines(words);
  } else {
    // Question numbers read on their own from each column's margin (from
    // near the page top when the profile says the first questions may sit
    // where a header would be).
    const readMargins = (lay) => {
      const stripLayout = opts.headerFromLabels ? { ...lay, contentTop: Math.round(H * 0.015) } : lay;
      return Promise.all(lay.columns.map(async (_, ci) => {
        const strip = core.marginStrip(map, stripLayout, null, ci, { dropTall: opts.headerFromLabels });
        if (!strip) return [];
        const png = await sharp(Buffer.from(strip.gray), { raw: { width: strip.width, height: strip.height, channels: 1 } })
          .png().toBuffer();
        const { data } = await (await getLabelPool()).addJob('recognize', png, {}, { blocks: true });
        const words = (data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)));
        const labelOpts = { edgeTolerance: opts.headerFromLabels ? 0.02 : undefined };
        if (opts.headerFromLabels) {
          // Numbers the whole-strip read missed, read one blob at a time.
          const read = core.marginLabelsFromWords(words, strip, H, labelOpts).map(m => (m.bbox.y0 - strip.y0) * 2 + strip.pad);
          for (const blob of core.marginStripBlobs(strip, H)) {
            if (read.some(y => y >= blob.y0 - 4 && y <= blob.y1)) continue;
            const bpng = await sharp(Buffer.from(blob.image.data), { raw: { width: blob.image.width, height: blob.image.height, channels: 1 } }).png().toBuffer();
            const r = await (await getWeekPool()).addJob('recognize', bpng, {}, { blocks: true });
            for (const w of (r.data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)))) {
              words.push({ ...w, bbox: { ...w.bbox, y0: w.bbox.y0 + blob.y0, y1: w.bbox.y1 + blob.y0 } });
            }
          }
        }
        return core.marginLabelsFromWords(words, strip, H, labelOpts);
      }));
    };
    marginLabels = await readMargins(layout);
    // A column without a single number: the split may have cut its numbers
    // off (a logo or dotted rule in the gutter). The other split strategy
    // wins if it finds more numbers.
    if (opts.headerFromLabels && marginLabels.some(m => m.length === 0)) {
      const alt = core.detectLayout(map, core.labelBoxesFromWords(words), { ...opts, leftmostGutter: !opts.leftmostGutter });
      if (alt.columns[0].x1 !== layout.columns[0].x1) {
        const altLabels = await readMargins(alt);
        if (altLabels.flat().length > marginLabels.flat().length) { layout.columns = alt.columns; marginLabels = altLabels; }
      }
    }
    if (opts.headerFromLabels) layout.contentTop = core.contentTopFromLabels(layout, marginLabels, H);
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
    const params = { map, layout, columnLines, strictLabels: true, pageLines: allLines, passageWithInstruction: opts.passageWithInstruction };
    const pending = core.optionlessStrips(params);
    const extraOptionLines = layout.columns.map(() => []);
    if (pending.length) await readShapeLetters(pending, core.capHeightFromStrips(pending, H, true), extraOptionLines);
    regions = core.findQuestions({ ...params, extraOptionLines });
  } else {
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
    regions = core.findQuestions({ map, layout, columnLines, marginLabels, extraOptionLines, passageLines, answerSheetGuard: opts.answerSheetGuard, numberingRestarts: opts.numberingRestarts });
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

  // Week badge ("10. HAFTA"): exact in a text layer; in scans read on its
  // own (general OCR misses it), with the header OCR as a fallback.
  let pageWeek = core.readWeek(headerLines), weekUnsure = false, weekGlyphs;
  if (week && !fromText) {
    const badge = core.weekBadgeImage(gray, W, H, 1, layout.contentTop);
    weekUnsure = badge.found;
    weekGlyphs = badge.glyphs;
    if (badge.image) {
      const { width, height, data } = badge.image;
      const png = await sharp(Buffer.from(data), { raw: { width, height, channels: 1 } }).png().toBuffer();
      pageWeek = core.weekFromBadgeText((await (await getWeekPool()).addJob('recognize', png)).data.text) ?? pageWeek;
    }
  }

  // Answers hidden in the text layer (profiles with `answerMarks`).
  let marked;
  if (fromText && opts.answerMarks) {
    marked = {};
    for (const r of regions) {
      const letter = core.markedAnswer(r, marks, W, H);
      if (letter) marked[r.questionNumber] = letter;
    }
  }
  // Test number and topic printed together in the header ("1  Metni
  // Görsellerle Yorumlama"; profiles with `titleFromHeader`).
  const title = fromText && opts.titleFromHeader ? core.readNumberedTitle(allLines.filter(l => l.bbox.y1 < H * 0.12)) : {};
  if (title.testNumber) testNumber = title.testNumber;
  // The page's own test within its contents entry (profiles with `headerTest`),
  // from the top of the page (the header band can end above it).
  const testLabel = opts.headerTest
    ? core.readTestLabel((fromText ? allLines : headerLines).filter(l => l.bbox.y1 < H * 0.12), Array.isArray(opts.headerTest) ? opts.headerTest : [])
    : undefined;

  // Printed answers (profiles with `answerKey`), for answers.csv and the
  // self-check: from the text layer, or a few OCR passes over the answer
  // band, merged.
  let answers;
  if (opts.answerKey && fromText) {
    answers = core.answersFromText(allLines, core.answerKeyBand(W, H, opts.answerKey));
  } else if (opts.answerKey) {
    const band = core.answerKeyBand(W, H, opts.answerKey);
    const texts = await Promise.all(core.answerKeyImages(gray, W, H, 1, band, opts.answerKey).map(async ({ width, height, data }) => {
      const png = await sharp(Buffer.from(data), { raw: { width, height, channels: 1 } }).png().toBuffer();
      return (await (await getKeyPool()).addJob('recognize', png)).data.text;
    }));
    answers = core.parseAnswerKey(texts);
  }

  return {
    regions, testNumber, testLabel, pageNumber, pageLabel, ow, oh, fromText, answers, marked,
    // (for the test harness's overlays)
    cells: process.env.QCROP_DUMP ? layout.columns.map(c => ({
      x0: c.x0 / W, x1: c.x1 / W, y0: (c.y0 ?? layout.contentTop) / H, y1: (c.y1 ?? layout.contentBottom) / H,
    })) : undefined,
    section: core.readSection(headerLines),
    week: pageWeek, weekUnsure, weekGlyphs,
    headerTopic: core.readHeaderTopic(headerLines, W),
    // Profiles naming per test: the first header line that reads as a topic.
    plainTopic: opts.namesPerTest
      // (A header title read with its test number is used as printed.)
      ? title.topic ?? [core.readHeaderTopic(headerLines, W), ...headerLines.map(l => l.text)].map(t => core.plausibleTopic(t, opts.topicIgnore)).find(Boolean)
      : undefined,
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
// Weeks likewise: one per cover-to-cover block, by majority (see resolveWeeks).
const weeks = pages.map((p, i) => results[i]?.week);
for (const idxs of bySource.values()) {
  idxs.sort((a, b) => pages[a].order - pages[b].order);
  const resolved = core.resolveTopics(idxs.map(i => results[i]));
  idxs.forEach((i, k) => { topics[i] = resolved[k]; });
  const w = core.resolveWeeks(idxs.map(i => ({ ...results[i], isCover: !!results[i].coverTopic })));
  idxs.forEach((i, k) => { weeks[i] = w[k]; });
  // Profiles naming per test: a test's number and topic come from whichever
  // of its pages read them (the most common reading wins).
  if (opts.namesPerTest) {
    const seg = core.testSegments(idxs.map(i => results[i].regions.map(q => +q.questionNumber)));
    const byTest = new Map();
    idxs.forEach((i, k) => { if (!byTest.has(seg[k])) byTest.set(seg[k], []); byTest.get(seg[k]).push(i); });
    for (const members of byTest.values()) {
      const testNumber = core.majority(members.map(i => results[i].testNumber));
      const topic = core.majority(members.map(i => results[i].plainTopic));
      for (const i of members) { results[i].testNumber = testNumber; topics[i] = topic; }
    }
  }
}

// Answers per crop and the self-check lines (answers.csv, check.txt).
const answerOf = new Map(); // `${pageIndex}:${n}` -> letter
const checkLines = [];
const withAnswers = !!(opts.answerKey || opts.bookIndex || opts.answerMarks);

// Books with a table of contents and an answer key (profiles with
// `bookIndex`): crops are named after their test in the contents and
// checked against the key.
if (opts.bookIndex) {
  let tests = 0, clean = 0, missingTotal = 0, extraTotal = 0;
  for (const [book, idxs] of bySource) {
    const text = bookText.get(book);
    if (!text) continue;
    const contents = core.bookContents(text.map((items, k) => {
      const W = 2000, H = Math.round(2000 * items.aspect);
      return { pdfPage: k + 1, ...core.contentsPageInfo(core.groupLines(core.wordsFromTextItems(items, W, H)), W, H) };
    }), text.length, { entriesHoldTests: !!opts.headerTest });
    if (!contents.tests.length) { console.log(`${path.basename(book)}: no table of contents found`); continue; }
    if (opts.headerTest) {
      const order = [...idxs].sort((a, b) => pages[a].pdfPage - pages[b].pdfPage);
      const labels = core.carryTestLabels(order.map(i => ({ label: results[i].testLabel, entry: contents.testAt(pages[i].pdfPage) })));
      order.forEach((i, k) => { results[i].testLabel = labels[k]; });
    }
    for (const i of idxs) {
      const t = contents.tests[contents.testAt(pages[i].pdfPage)];
      if (!t) continue;
      topics[i] = [core.contentsTestName(t), results[i].testLabel].filter(Boolean).join(' ');
      results[i].testNumber = undefined;
    }
    // (Entries holding several tests: each page's own test is found in the key.)
    const crops = idxs.map(i => ({ pdfPage: pages[i].pdfPage, label: results[i].testLabel, questions: results[i].regions.map(q => +q.questionNumber) }));
    const check = opts.headerTest ? core.checkLabelsAgainstKey(contents, crops) : core.checkAgainstKey(contents, crops);
    for (const i of idxs) for (const q of results[i].regions) {
      const letter = check.answerOf(pages[i].pdfPage, +q.questionNumber);
      if (letter) answerOf.set(`${i}:${q.questionNumber}`, letter);
    }
    // Only tests whose pages were all analyzed (--pages may cover part of the book).
    const analyzed = new Set(idxs.map(i => pages[i].pdfPage));
    for (const r of check.report) {
      const start = r.test?.start ?? r.start, end = r.test?.end ?? r.end;
      let all = true;
      for (let pg = start; pg <= end; pg++) if (!analyzed.has(pg)) all = false;
      if (!all) continue;
      tests++;
      if (!r.missing.length && !r.extra.length && !r.duplicate.length) { clean++; continue; }
      missingTotal += r.missing.length; extraTotal += r.extra.length;
      checkLines.push(`${path.basename(book)} s${start}-s${end} ${r.name ?? core.contentsTestName(r.test)}:` +
        `${r.missing.length ? ` not cropped: ${r.missing.join(',')}` : ''}` +
        `${r.extra.length ? ` | not in the answer key: ${r.extra.join(',')}` : ''}` +
        `${r.duplicate.length ? ` | cropped twice: ${r.duplicate.join(',')}` : ''}`);
    }
  }
  // (Books whose answers are printed on the pages instead are checked below.)
  if (tests || !opts.answerKey) console.log(`Self-check: ${clean}/${tests} tests match the answer key; ${missingTotal} question(s) not cropped, ${extraTotal} not in the key (see check.txt)`);
}
// Answers hidden in the text layer fill in where no key gives one. Where
// both exist and disagree, the printed key wins; check.txt lists them.
if (opts.answerMarks) {
  const disagree = [];
  pages.forEach((p, i) => results[i]?.regions.forEach(q => {
    const letter = results[i].marked?.[q.questionNumber], key = answerOf.get(`${i}:${q.questionNumber}`);
    if (letter && !key) answerOf.set(`${i}:${q.questionNumber}`, letter);
    else if (letter && key !== letter) disagree.push(`${results[i].pageLabel} Q${q.questionNumber}: key ${key}, hidden mark ${letter}`);
  }));
  if (disagree.length) checkLines.push(`Answer key and the question's hidden answer disagree (the key is used): ${disagree.join('; ')}`);
}

// Printed answers vs crops, per book (profiles with `answerKey`).
if (opts.answerKey) {
  const books = new Map();
  pages.forEach((p, i) => { if (results[i]) { const k = p.source ?? p.file; if (!books.has(k)) books.set(k, []); books.get(k).push(i); } });
  let tests = 0, clean = 0, missingTotal = 0, extraTotal = 0;
  for (const [book, idxs] of books) {
    idxs.sort((a, b) => (pages[a].order ?? 0) - (pages[b].order ?? 0));
    const check = core.checkAnswers(idxs.map(i => ({
      page: pages[i].pdfPage, questions: results[i].regions.map(q => +q.questionNumber), answers: results[i].answers,
    })));
    idxs.forEach((i, k) => results[i].regions.forEach(q => {
      const letter = check.answerOf(k, +q.questionNumber);
      if (letter) answerOf.set(`${i}:${q.questionNumber}`, letter);
    }));
    for (const t of check.tests) {
      tests++;
      const [a, b] = t.pages.map(k => results[idxs[k]].pageLabel);
      if (!t.missing.length && !t.extra.length) { clean++; continue; }
      missingTotal += t.missing.length; extraTotal += t.extra.length;
      checkLines.push(`${path.basename(book)} ${a}${b !== a ? '-' + b : ''}: questions ${t.questions.join(',')}` +
        `${t.missing.length ? ` | not cropped: ${t.missing.join(',')}` : ''}${t.extra.length ? ` | beyond printed answers: ${t.extra.join(',')}` : ''}` +
        `${t.answered ? '' : ' | no printed answers read'}`);
    }
  }
  console.log(`Self-check: ${clean}/${tests} tests match their printed answers; ${missingTotal} question(s) not cropped, ${extraTotal} beyond the printed answers (see check.txt)`);
}

let total = 0;
const used = new Set();
const cropJobs = [];
const csvRows = [];
for (let i = 0; i < pages.length; i++) {
  const r = results[i];
  if (!r) continue;
  for (const region of r.regions) {
    let name = core.cropFileName({
      week: week ? weeks[i] : undefined,
      testNumber: r.testNumber, topic: topics[i],
      questionNumber: region.questionNumber, pageLabel: r.pageLabel,
    });
    if (png) name = name.replace(/\.jpg$/, '.png');
    for (let k = 2; used.has(name); k++) name = name.replace(/(_\d+)?\.(jpg|png)$/, `_${k}.$2`);
    used.add(name);
    cropJobs.push(() => cropRegion(pages[i], r.ow, r.oh, region, path.join(outDir, name)));
    if (withAnswers) csvRows.push([name, r.pageLabel, region.questionNumber, answerOf.get(`${i}:${region.questionNumber}`) ?? '']);
    total++;
  }
  if (r.regions.length > 0 || !pages[i].source) {
    const meta = [
      `page ${r.pageNumber}`,
      weeks[i] && `week ${weeks[i]}`,
      r.testNumber && `test ${r.testNumber}`,
      topics[i] && `"${topics[i]}"`,
      r.fromText ? 'text layer' : 'OCR',
    ].filter(Boolean).join(', ');
    console.log(`  ${pages[i].name}: ${meta} -> ${r.regions.map(q => 'Q' + q.questionNumber).join(' ') || 'no test questions'}`);
    const shared = r.regions.filter(q => q.contextBox);
    if (shared.length) console.log(`    with shared passage: ${shared.map(q => 'Q' + q.questionNumber).join(' ')}`);
  }
}
if (dryRun) cropJobs.length = 0;
// Test harness: the analysis as JSON.
if (process.env.QCROP_DUMP) {
  await writeFile(process.env.QCROP_DUMP, JSON.stringify(pages.map((p, i) => results[i] && {
    source: p.source && path.basename(p.source), pdfPage: p.pdfPage, file: path.basename(p.file),
    topic: topics[i], testNumber: results[i].testNumber, cells: results[i].cells,
    regions: results[i].regions.map(r => ({ n: r.questionNumber, box: r.box, contextBox: r.contextBox, answer: answerOf.get(`${i}:${r.questionNumber}`) })),
  })));
}
let nextJob = 0;
await Promise.all(Array.from({ length: Math.max(2, os.cpus().length) }, async () => {
  while (nextJob < cropJobs.length) await cropJobs[nextJob++]();
}));

if (withAnswers) {
  const q = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  await writeFile(path.join(outDir, 'answers.csv'), ['file,page,question,answer', ...csvRows.map(r => r.map(q).join(','))].join('\n') + '\n');
  await writeFile(path.join(outDir, 'check.txt'), (checkLines.join('\n') || (opts.answerKey || opts.bookIndex ? 'All tests match their answers.' : 'No answer key to check against.')) + '\n');
}
console.log(`Done: ${total} ${dryRun ? 'question(s) found (dry run, nothing written)' : 'crop(s)'} in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${outDir}/`);
if (schedulerPromise) await (await schedulerPromise).terminate();
if (digitWorkerPromise) await (await digitWorkerPromise).terminate();
await rm(tmpRoot, { recursive: true, force: true });
process.exit(0);
