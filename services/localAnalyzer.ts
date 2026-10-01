import { createWorker, Worker } from 'tesseract.js';
import * as core from '../core/qcropCore.mjs';
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
 */
export const analyzeTestPageLocal = async (
  img: HTMLImageElement,
  textItems?: PdfTextItem[],
  { bookPage = false }: { bookPage?: boolean } = {},
): Promise<LocalAnalysis> => {
  const scale = Math.min(1, core.ANALYSIS_WIDTH / img.width);
  const W = Math.round(img.width * scale);
  const H = Math.round(img.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, W, H);
  const map = core.buildInkMap(ctx.getImageData(0, 0, W, H).data, W, H, 4);

  const fromText = core.textLayerUsable(textItems);
  const words: Word[] = fromText ? core.wordsFromTextItems(textItems, W, H) : [];
  const layout = core.detectLayout(map, core.labelBoxesFromWords(words));

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
  if (fromText) {
    headerLines = core.linesInRegion(words, 0, 0, W, layout.contentTop);
    footerLines = core.linesInRegion(words, 0, layout.footerTop, W, H);
    columnLines = layout.columns.map(c =>
      core.linesInRegion(words, c.x0 - 5, layout.contentTop, c.x1 + 5, layout.contentBottom));
    allLines = core.groupLines(words);
  } else {
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
    // Question numbers read on their own from each column's margin.
    const marginLabels = [];
    for (let ci = 0; ci < layout.columns.length; ci++) {
      const strip = core.marginStrip(map, layout, columnLines, ci);
      if (!strip) { marginLabels.push([]); continue; }
      const c = document.createElement('canvas');
      c.width = strip.width; c.height = strip.height;
      const sctx = c.getContext('2d')!;
      const rgba = sctx.createImageData(strip.width, strip.height);
      for (let i = 0; i < strip.gray.length; i++) {
        rgba.data[i * 4] = rgba.data[i * 4 + 1] = rgba.data[i * 4 + 2] = strip.gray[i];
        rgba.data[i * 4 + 3] = 255;
      }
      sctx.putImageData(rgba, 0, 0);
      const { data } = await (await getLabelWorker()).recognize(c, {}, { blocks: true });
      const labelWords = (data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)));
      marginLabels.push(core.marginLabelsFromWords(labelWords, strip, H));
    }
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
    regions = core.findQuestions({ map, layout, columnLines, marginLabels, extraOptionLines, passageLines });
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
  return {
    pageNumber: core.readPageNumber(footerLines, W) ?? 'unknown',
    testNumber,
    topic: section ?? headerTopic,
    section,
    headerTopic,
    coverTopic,
    regions,
    fromTextLayer: fromText,
  };
};
