import { createWorker, Worker } from 'tesseract.js';
import * as core from '../core/qcropCore.mjs';
import { profileOptions } from '../core/profiles.mjs';
import { AnalysisResult } from './geminiService';
import type { PdfTextItem } from './fileLoader';

// ---------------------------------------------------------------------------
// Local, no-AI page analyzer (browser side).
//
// Detection logic lives in core/qcropCore.mjs, shared with the CLI; this
// file supplies pixels (canvas) and text: the PDF's own text layer when the
// page has a usable one (exact and fast), otherwise Tesseract OCR of the
// header, footer and each column.
// ---------------------------------------------------------------------------

export interface LocalAnalysis extends AnalysisResult {
  /** "TARAMA 1" style badge that names the page on its own. */
  section?: string;
  /** Topic printed in the page's own header. */
  headerTopic?: string;
  /** Topic announced by a unit cover page, inherited by following pages. */
  coverTopic?: string;
  /** Week from the header badge ("10. HAFTA" -> "10"), before resolveWeeks. */
  week?: string;
  /** A badge is there but its number may be misread (scans). */
  weekUnsure?: boolean;
  /** A header line that reads as a topic (profiles naming per test). */
  plainTopic?: string;
  /** Answers printed on the page (profiles with `answerKey`). */
  answers?: { n: number; letter: string }[];
  /** Answers hidden in the text layer, by question number (`answerMarks`). */
  marked?: Record<string, string>;
  /** What the book's contents need from this page (`bookIndex`). */
  contents?: any;
  /** Digit shapes of the badge number, for reading it by shape (scans). */
  weekGlyphs?: { aspect: number; bits: string }[];
  fromTextLayer: boolean;
}

interface Box { x0: number; y0: number; x1: number; y1: number }
interface Word { text: string; conf: number; bbox: Box }
interface Line { text: string; bbox: Box; words: Word[] }

let workerPromise: Promise<Worker> | null = null;
const getWorker = (): Promise<Worker> => {
  if (!workerPromise) workerPromise = createWorker('tur');
  return workerPromise;
};

// Workers with fixed settings, kept apart so parameters never leak into the
// main OCR passes.
const makeWorker = (params: Record<string, string>) => {
  let p: Promise<Worker> | null = null;
  return (): Promise<Worker> => {
    if (!p) {
      p = (async () => {
        const w = await createWorker('tur');
        await w.setParameters(params as any);
        return w;
      })();
    }
    return p;
  };
};
// TEST badge digits (single line).
const getDigitWorker = makeWorker({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
// Question numbers read from a column's margin strip.
const getLabelWorker = makeWorker({ tessedit_char_whitelist: '0123456789.', tessedit_pageseg_mode: '6' });
// Second-chance option reads: sparse text between graphics.
const getSparseWorker = makeWorker({ tessedit_pageseg_mode: '11' });
// Single option letters found by shape.
const getLetterWorker = makeWorker({ tessedit_char_whitelist: 'ABCDE', tessedit_pageseg_mode: '10' });
// The number of a header week badge ("10." of "10. HAFTA").
const getWeekWorker = makeWorker({ tessedit_char_whitelist: '0123456789.', tessedit_pageseg_mode: '7' });
// Printed answer keys ("1.C 2.B"), for profiles that have them.
const getKeyWorker = makeWorker({ tessedit_char_whitelist: '0123456789.-)/ABCDE ', tessedit_pageseg_mode: '11' });

/** A 1-channel image (core output) as a canvas Tesseract can read. */
const grayCanvas = ({ width, height, data }: { width: number; height: number; data: Uint8Array }): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const cx = c.getContext('2d')!;
  const img = cx.createImageData(width, height);
  for (let i = 0; i < data.length; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = data[i];
    img.data[i * 4 + 3] = 255;
  }
  cx.putImageData(img, 0, 0);
  return c;
};

/** Copy of `src` blurred at 1:1 scale. Canvas `filter: blur()` is applied to
 * the source *before* scaling, so blurring must happen in a separate pass
 * after resizing or downscales neutralize it. */
const blurCanvas = (src: HTMLCanvasElement, blur: number): HTMLCanvasElement => {
  const out = document.createElement('canvas');
  out.width = src.width; out.height = src.height;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(src, 0, 0);
  return out;
};

/**
 * `bookPage`: the page belongs to a book (a PDF, or a numbered image
 * sequence), so a page without questions is checked for a unit cover topic.
 * `profile`: a book profile name (core/profiles.mjs), '' for the defaults.
 */
export const analyzeTestPageLocal = async (
  img: HTMLImageElement,
  textItems?: PdfTextItem[],
  { bookPage = false, profile = '' }: { bookPage?: boolean; profile?: string } = {},
): Promise<LocalAnalysis> => {
  const opts = profileOptions(profile);
  const scale = Math.min(1, core.ANALYSIS_WIDTH / img.width);
  const W = Math.round(img.width * scale);
  const H = Math.round(img.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, W, H);
  const rgba = ctx.getImageData(0, 0, W, H).data;
  const map = core.buildInkMap(rgba, W, H, 4);

  const fromText = core.textLayerUsable(textItems);
  let words: Word[] = fromText ? core.wordsFromTextItems(textItems, W, H) : [];
  // Hidden answer marks, read before invisible text is dropped.
  const marks = fromText ? core.hiddenAnswerMarks(words) : [];
  if (fromText && opts.mixedColumns) words = core.tidyTextWords(words, W, map);
  let layout = core.detectLayout(map, core.labelBoxesFromWords(words), opts);
  if (fromText && opts.mixedColumns) layout = core.mixedColumns(map, layout, words, marks);

  // OCR one region of the page in isolation (columns would otherwise merge
  // into single lines spanning the whole page) and offset boxes back into
  // page coordinates. Regions are sampled from the original full-resolution
  // image so upscaled strips stay sharp; `blur` softens gaps in stylized
  // fonts like seven-segment digits so they read as solid strokes.
  const regionCanvas = (x0: number, y0: number, w: number, h: number, upscale: number): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = Math.round(w * upscale); c.height = Math.round(h * upscale);
    c.getContext('2d')!.drawImage(img, x0 / scale, y0 / scale, w / scale, h / scale, 0, 0, c.width, c.height);
    return c;
  };

  const ocrRegion = async (
    x0: number, y0: number, x1: number, y1: number, upscale = 1, blur = 0, worker = getWorker
  ): Promise<Line[]> => {
    const w = Math.round(x1 - x0), h = Math.round(y1 - y0);
    if (w < 8 || h < 8) return [];
    let c = regionCanvas(x0, y0, w, h, upscale);
    if (blur > 0) c = blurCanvas(c, blur);
    const { data } = await (await worker()).recognize(c, {}, { blocks: true });
    const shift = (b: Box) =>
      ({ x0: b.x0 / upscale + x0, y0: b.y0 / upscale + y0, x1: b.x1 / upscale + x0, y1: b.y1 / upscale + y0 });
    return (data.blocks ?? []).flatMap(b =>
      b.paragraphs.flatMap(p => p.lines.map(l => ({
        text: l.text,
        bbox: shift(l.bbox),
        words: l.words.map(wd => ({ text: wd.text, conf: wd.confidence, bbox: shift(wd.bbox) })),
      })))
    );
  };

  let headerLines: Line[], footerLines: Line[], columnLines: Line[][], allLines: Line[] = [];
  let marginLabels: any[] = [];
  if (fromText) {
    headerLines = core.linesInRegion(words, 0, 0, W, layout.contentTop);
    footerLines = core.linesInRegion(words, 0, layout.footerTop, W, H);
    columnLines = layout.columns.map((c: any) =>
      core.linesInRegion(words, c.x0 - 5, c.y0 ?? layout.contentTop, c.x1 + 5, c.y1 ?? layout.contentBottom));
    allLines = core.groupLines(words);
  } else {
    // Question numbers read on their own from each column's margin (from
    // near the page top when the profile says the first questions may sit
    // where a header would be).
    const readMargins = async (lay: any) => {
      const stripLayout = opts.headerFromLabels ? { ...lay, contentTop: Math.round(H * 0.015) } : lay;
      const out: any[] = [];
      for (let ci = 0; ci < lay.columns.length; ci++) {
        const strip = core.marginStrip(map, stripLayout, null, ci, { dropTall: opts.headerFromLabels });
        if (!strip) { out.push([]); continue; }
        const c = grayCanvas({ width: strip.width, height: strip.height, data: strip.gray });
        const { data } = await (await getLabelWorker()).recognize(c, {}, { blocks: true });
        const labelWords: any[] = (data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)));
        const labelOpts = { edgeTolerance: opts.headerFromLabels ? 0.02 : undefined };
        if (opts.headerFromLabels) {
          // Numbers the whole-strip read missed, read one blob at a time.
          const read = core.marginLabelsFromWords(labelWords, strip, H, labelOpts).map((m: any) => (m.bbox.y0 - strip.y0) * 2 + strip.pad);
          for (const blob of core.marginStripBlobs(strip, H)) {
            if (read.some((y: number) => y >= blob.y0 - 4 && y <= blob.y1)) continue;
            const r = await (await getWeekWorker()).recognize(grayCanvas(blob.image), {}, { blocks: true });
            for (const w of (r.data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)))) {
              labelWords.push({ ...w, bbox: { ...w.bbox, y0: w.bbox.y0 + blob.y0, y1: w.bbox.y1 + blob.y0 } });
            }
          }
        }
        out.push(core.marginLabelsFromWords(labelWords, strip, H, labelOpts));
      }
      return out;
    };
    marginLabels = await readMargins(layout);
    // A column without a single number: the split may have cut its numbers
    // off (a logo or dotted rule in the gutter). The other split strategy
    // wins if it finds more numbers.
    if (opts.headerFromLabels && marginLabels.some((m: any[]) => m.length === 0)) {
      const alt = core.detectLayout(map, core.labelBoxesFromWords(words), { ...opts, leftmostGutter: !opts.leftmostGutter });
      if (alt.columns[0].x1 !== layout.columns[0].x1) {
        const altLabels = await readMargins(alt);
        if (altLabels.flat().length > marginLabels.flat().length) { layout.columns = alt.columns; marginLabels = altLabels; }
      }
    }
    if (opts.headerFromLabels) layout.contentTop = core.contentTopFromLabels(layout, marginLabels, H);
    [headerLines, footerLines, ...columnLines] = await Promise.all([
      ocrRegion(0, 0, W, layout.contentTop, 2),
      // Footer page numbers use a seven-segment style font; blur merges the
      // segment gaps so they read as normal digits.
      ocrRegion(0, layout.footerTop, W, H, 2.5, 2.5),
      ...layout.columns.map(col => ocrRegion(col.x0, layout.contentTop, col.x1, layout.contentBottom)),
    ]);
  }

  // Options drawn as pictures ("A)" inside an image) have no text: find the
  // "X)" shapes in the ink and read each letter on its own.
  const readShapeLetters = async (strips: any[], capH: number, extraOptionLines: Line[][]) => {
    for (const s of strips) {
      const cands = core.optionLetterCandidates(map, s, capH, words);
      if (cands.length < 3) continue;
      const letters: string[] = [];
      for (const { letterBox: b } of cands) {
        const pad = capH * 0.4;
        const crop = regionCanvas(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2, 64 / capH);
        letters.push((await (await getLetterWorker()).recognize(crop)).data.text);
      }
      extraOptionLines[s.col].push(...core.optionLinesFromLetters(cands, letters));
    }
  };

  let regions;
  if (fromText) {
    const params = { map, layout, columnLines, strictLabels: true, pageLines: allLines };
    const pending = core.optionlessStrips(params);
    const extraOptionLines: Line[][] = layout.columns.map(() => []);
    if (pending.length) await readShapeLetters(pending, core.capHeightFromStrips(pending, H, true), extraOptionLines);
    regions = core.findQuestions({ ...params, extraOptionLines });
  } else {
    // Second chance for numbered strips without options: sparse-text OCR.
    const extraOptionLines: Line[][] = layout.columns.map(() => []);
    for (const s of core.optionlessStrips({ map, layout, columnLines, marginLabels })) {
      extraOptionLines[s.col].push(...await ocrRegion(s.x0, s.y0, s.x1, s.y1, 2, 0, getSparseWorker));
    }
    // Third chance: find "X)" shapes beside drawings and read each letter.
    const labelHeights = marginLabels.flat().map(m => m.bbox.y1 - m.bbox.y0).sort((a, b) => a - b);
    const capH = labelHeights.length ? labelHeights[labelHeights.length >> 1] : H * 0.0105;
    await readShapeLetters(core.optionlessStrips({ map, layout, columnLines, marginLabels, extraOptionLines }), capH, extraOptionLines);
    // Text the column OCR skipped (shaded instruction boxes), read on its
    // own; used only to find shared-passage instructions.
    const passageLines: Line[][] = layout.columns.map(() => []);
    for (const band of core.unreadBands(map, layout, columnLines)) {
      const line = core.instructionFromBand(await ocrRegion(band.x0, band.y0, band.x1, band.y1, 2), band);
      if (line) passageLines[band.col].push(line);
    }
    regions = core.findQuestions({
      map, layout, columnLines, marginLabels, extraOptionLines, passageLines,
      answerSheetGuard: opts.answerSheetGuard, numberingRestarts: opts.numberingRestarts,
    });
  }

  let testNumber: string | undefined = core.readTestNumber(headerLines);
  if (!testNumber && !fromText) {
    // Corner badge: "TEST" above a seven-segment number. The circle hangs
    // below the header bar but empty space below it derails Tesseract's
    // segmentation, so use a fixed 9% strip.
    const up = 4;
    const badgeBottom = H * 0.09;
    const base = regionCanvas(W * 0.7, 0, W * 0.3, badgeBottom, up);
    const { data } = await (await getWorker()).recognize(blurCanvas(base, 2), {}, { blocks: true });
    const badgeWords = (data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)));
    const badge = core.testNumberFromBadgeWords(badgeWords);
    testNumber = badge.testNumber;
    if (!testNumber && badge.testWord) {
      // Digits misread as letters: re-OCR the area just below the TEST word
      // with a digits-only worker.
      const tw = badge.testWord;
      const th = tw.bbox.y1 - tw.bbox.y0;
      const gx0 = Math.max(0, tw.bbox.x0 - th);
      const gx1 = Math.min(base.width, tw.bbox.x1 + th);
      const gy0 = tw.bbox.y1;
      const gy1 = Math.min(base.height, tw.bbox.y1 + th * 3.5);
      if (gy1 - gy0 > 8) {
        const crop = document.createElement('canvas');
        crop.width = (gx1 - gx0) * 2; crop.height = (gy1 - gy0) * 2;
        const cctx = crop.getContext('2d')!;
        cctx.fillStyle = '#fff'; cctx.fillRect(0, 0, crop.width, crop.height);
        cctx.drawImage(base, gx0, gy0, gx1 - gx0, gy1 - gy0, 0, 0, crop.width, crop.height);
        const digitWorker = await getDigitWorker();
        for (const blur of [2, 3]) {
          const t = (await digitWorker.recognize(blurCanvas(crop, blur))).data.text.trim();
          if (/^\d{1,2}$/.test(t)) { testNumber = t.padStart(2, '0'); break; }
        }
      }
    }
  }

  // Unit covers name the topic for the pages after them in a book.
  let coverTopic: string | undefined;
  if ((textItems || bookPage) && regions.length === 0) {
    if (fromText) coverTopic = core.readCoverTopic(allLines);
    if (!coverTopic && (!fromText || core.findFormLine(allLines))) {
      const pageLines = fromText ? allLines : await ocrRegion(0, 0, W, H);
      const form = core.findFormLine(pageLines);
      if (form) {
        // Full-page OCR tends to drop the topic line; read its band enlarged.
        const band = core.coverTopicBand(form, W, H);
        const bandLines = await ocrRegion(band.x0, band.y0, band.x1, band.y1, 2);
        coverTopic = core.readCoverTopic([...bandLines, form]) ?? core.readCoverTopic(pageLines);
      }
    }
  }

  const section = core.readSection(headerLines);
  const headerTopic = core.readHeaderTopic(headerLines, W);

  // Week badge ("10. HAFTA"): exact in a text layer; in scans read on its
  // own (general OCR misses it), with the header OCR as a fallback.
  let week: string | undefined = core.readWeek(headerLines);
  let weekUnsure = false;
  let weekGlyphs: { aspect: number; bits: string }[] | undefined;
  if (!fromText) {
    const badge = core.weekBadgeImage(rgba, W, H, 4, layout.contentTop);
    weekUnsure = badge.found;
    weekGlyphs = badge.glyphs;
    if (badge.image) {
      const { width, height, data } = badge.image;
      const c = document.createElement('canvas');
      c.width = width; c.height = height;
      const bctx = c.getContext('2d')!;
      const out = bctx.createImageData(width, height);
      for (let i = 0; i < data.length; i++) {
        out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = data[i];
        out.data[i * 4 + 3] = 255;
      }
      bctx.putImageData(out, 0, 0);
      week = core.weekFromBadgeText((await (await getWeekWorker()).recognize(c)).data.text) ?? week;
    }
  }

  // Printed answers (profiles with `answerKey`), for answers.csv and the
  // self-check: a few OCR passes over the answer band, merged.
  let answers: { n: number; letter: string }[] | undefined;
  if (opts.answerKey) {
    const band = core.answerKeyBand(W, H, opts.answerKey);
    const texts: string[] = [];
    for (const pass of core.answerKeyImages(rgba, W, H, 4, band, opts.answerKey)) {
      texts.push((await (await getKeyWorker()).recognize(grayCanvas(pass))).data.text);
    }
    answers = core.parseAnswerKey(texts);
  }

  // Answers hidden in the text layer (profiles with `answerMarks`), per
  // question number.
  let marked: Record<string, string> | undefined;
  if (fromText && opts.answerMarks) {
    marked = {};
    for (const r of regions) {
      const letter = core.markedAnswer(r, marks, W, H);
      if (letter) marked[r.questionNumber] = letter;
    }
  }
  // Contents and answer-key pages, and what the book-level contents need
  // from every page (profiles with `bookIndex`).
  const contents = fromText && opts.bookIndex ? core.contentsPageInfo(allLines, W, H) : undefined;
  // Test number and topic printed together in the header ("1  Metni
  // Görsellerle Yorumlama"), for profiles with `titleFromHeader`.
  const title = fromText && opts.titleFromHeader
    ? core.readNumberedTitle(allLines.filter(l => l.bbox.y1 < H * 0.12))
    : {};

  return {
    answers,
    marked,
    contents,
    pageNumber: core.readPageNumber(footerLines, W) ?? 'unknown',
    testNumber: title.testNumber ?? testNumber,
    topic: section ?? headerTopic,
    section,
    headerTopic,
    // Profiles naming per test: the first header line that reads as a topic.
    plainTopic: opts.namesPerTest
      // (A header title read with its test number is used as printed.)
      ? title.topic ?? [headerTopic, ...headerLines.map(l => l.text)].map(t => core.plausibleTopic(t, opts.topicIgnore)).find(Boolean)
      : undefined,
    coverTopic,
    week,
    weekUnsure,
    weekGlyphs,
    regions,
    fromTextLayer: fromText,
  };
};
