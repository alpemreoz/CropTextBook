import { createWorker, Worker } from 'tesseract.js';
import { BoundingBox } from '../types';
import { AnalysisResult } from './geminiService';

// ---------------------------------------------------------------------------
// Local, no-AI page analyzer.
//
// Pipeline (all in-browser, no network calls except Tesseract's cached
// language data on first run):
//   1. Downscale the scan to a working canvas and binarize it.
//   2. Find header/footer bands and the two-column split via ink projections.
//   3. OCR the page once (Tesseract.js, Turkish) to locate question-number
//      labels ("1.", "2.", ...) at each column's left margin, plus page
//      number / TEST number / topic from the header and footer bands.
//   4. Each question box spans from its label to the next label, trimmed to
//      actual ink extents; the label itself is excluded via the x offset.
// Coordinates are returned in the same 0-1000 relative space Gemini used, so
// the rest of the app (cropping, stitching, export) is unchanged.
// ---------------------------------------------------------------------------

const ANALYSIS_WIDTH = 2000;   // px; scans are ~9500px wide, OCR needs far less
const INK_THRESHOLD = 190;     // luminance below this counts as ink

let workerPromise: Promise<Worker> | null = null;
const getWorker = (): Promise<Worker> => {
  if (!workerPromise) workerPromise = createWorker('tur');
  return workerPromise;
};

// Separate worker for digit-only passes (TEST badge). Keeping the whitelist
// on its own worker avoids parameter leakage into the main OCR passes.
let digitWorkerPromise: Promise<Worker> | null = null;
const getDigitWorker = (): Promise<Worker> => {
  if (!digitWorkerPromise) {
    digitWorkerPromise = (async () => {
      const w = await createWorker('tur');
      await w.setParameters({
        tessedit_char_whitelist: '0123456789',
        tessedit_pageseg_mode: '7' as any, // single line
      });
      return w;
    })();
  }
  return digitWorkerPromise;
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

interface InkMap {
  width: number;
  height: number;
  ink: Uint8Array; // 1 = ink, 0 = paper
  rowInk: Int32Array;
}

const buildInkMap = (canvas: HTMLCanvasElement): InkMap => {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const ink = new Uint8Array(width * height);
  const rowInk = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum < INK_THRESHOLD) {
        ink[y * width + x] = 1;
        count++;
      }
    }
    rowInk[y] = count;
  }
  return { width, height, ink, rowInk };
};

const colInkInRange = (map: InkMap, y0: number, y1: number): Int32Array => {
  const out = new Int32Array(map.width);
  for (let y = y0; y < y1; y++) {
    const row = y * map.width;
    for (let x = 0; x < map.width; x++) out[x] += map.ink[row + x];
  }
  return out;
};

/** First y >= from where `rows` consecutive rows have less ink than `max`. */
const findGap = (map: InkMap, from: number, to: number, max: number, rows: number): number => {
  let run = 0;
  for (let y = from; y < to; y++) {
    if (map.rowInk[y] <= max) {
      if (++run >= rows) return y - run + 1;
    } else run = 0;
  }
  return -1;
};

interface PageLayout {
  contentTop: number;
  contentBottom: number;
  headerBottom: number;
  footerTop: number;
  columns: { x0: number; x1: number }[];
}

const detectLayout = (map: InkMap): PageLayout => {
  const { width: W, height: H } = map;
  const noise = Math.max(2, W * 0.001);
  const gapRows = Math.max(6, Math.round(H * 0.004));

  // Header: first ink block from the top, ended by a clear whitespace gap.
  let headerTop = 0;
  while (headerTop < H * 0.2 && map.rowInk[headerTop] <= noise) headerTop++;
  let headerBottom = findGap(map, headerTop, Math.floor(H * 0.25), noise, gapRows);
  if (headerBottom < 0) headerBottom = headerTop;

  // Footer: first ink block from the bottom.
  let footerBottom = H - 1;
  while (footerBottom > H * 0.85 && map.rowInk[footerBottom] <= noise) footerBottom--;
  let footerTop = footerBottom;
  let run = 0;
  for (let y = footerBottom; y > H * 0.85; y--) {
    if (map.rowInk[y] <= noise) {
      if (++run >= gapRows) { footerTop = y + run; break; }
    } else run = 0;
  }

  const contentTop = headerBottom;
  const contentBottom = Math.min(footerTop, footerBottom) - 1;

  // Column split: look for either a long vertical divider line or the widest
  // low-ink valley near the horizontal center of the content area.
  const colInk = colInkInRange(map, contentTop, contentBottom);
  const contentH = contentBottom - contentTop;
  const lo = Math.floor(W * 0.38), hi = Math.ceil(W * 0.62);

  let splitX = -1;
  for (let x = lo; x <= hi; x++) {
    if (colInk[x] > contentH * 0.55) { splitX = x; break; } // divider line
  }
  if (splitX < 0) {
    // widest whitespace window
    let bestX = Math.round(W / 2), bestScore = Infinity;
    const win = Math.max(8, Math.round(W * 0.01));
    for (let x = lo; x <= hi - win; x++) {
      let s = 0;
      for (let k = 0; k < win; k++) s += colInk[x + k];
      if (s < bestScore) { bestScore = s; bestX = x + Math.floor(win / 2); }
    }
    splitX = bestX;
  }

  // Trim page margins to actual ink.
  let left = 0;
  while (left < W * 0.2 && colInk[left] <= noise) left++;
  let right = W - 1;
  while (right > W * 0.8 && colInk[right] <= noise) right--;

  const pad = Math.round(W * 0.006);
  return {
    contentTop,
    contentBottom,
    headerBottom,
    footerTop: Math.min(footerTop, footerBottom),
    columns: [
      { x0: left, x1: splitX - pad },
      { x0: splitX + pad, x1: right },
    ],
  };
};

/** Ink bounding box within a window; returns null if empty. */
const inkBounds = (
  map: InkMap, x0: number, y0: number, x1: number, y1: number
): { x0: number; y0: number; x1: number; y1: number } | null => {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(map.width, Math.ceil(x1)); y1 = Math.min(map.height, Math.ceil(y1));
  let minX = -1, maxX = -1, minY = -1, maxY = -1;
  for (let y = y0; y < y1; y++) {
    const row = y * map.width;
    for (let x = x0; x < x1; x++) {
      if (map.ink[row + x]) {
        if (minY < 0) minY = y;
        maxY = y;
        if (minX < 0 || x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  if (minY < 0) return null;
  return { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
};

interface LabelCandidate {
  n: number;
  col: number;
  y0: number;       // top of the label line
  labelRight: number; // right edge of the "N." token
  lineX0: number;
}

const LABEL_RE = /^\s*(\d{1,2})\s*[.,]/;

/** Longest increasing subsequence (by question number) to drop OCR noise. */
const filterSequence = (cands: LabelCandidate[]): LabelCandidate[] => {
  if (cands.length <= 1) return cands;
  const n = cands.length;
  const best = new Array<number>(n).fill(1);
  const prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (cands[j].n < cands[i].n && best[j] + 1 > best[i]) {
        best[i] = best[j] + 1;
        prev[i] = j;
      }
    }
  }
  let end = 0;
  for (let i = 1; i < n; i++) if (best[i] >= best[end]) end = i;
  const keep: LabelCandidate[] = [];
  for (let i = end; i >= 0; i = prev[i]) {
    keep.unshift(cands[i]);
    if (prev[i] < 0) break;
  }
  return keep;
};

const scale1000 = (v: number, total: number) =>
  Math.max(0, Math.min(1000, Math.round((v / total) * 1000)));

export const analyzeTestPageLocal = async (img: HTMLImageElement): Promise<AnalysisResult> => {
  const scale = Math.min(1, ANALYSIS_WIDTH / img.width);
  const W = Math.round(img.width * scale);
  const H = Math.round(img.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.getContext('2d')!.drawImage(img, 0, 0, W, H);

  const map = buildInkMap(canvas);
  const layout = detectLayout(map);

  const worker = await getWorker();

  interface OcrWord { text: string; conf: number; bbox: { x0: number; y0: number; x1: number; y1: number } }
  interface OcrLine { text: string; bbox: { x0: number; y0: number; x1: number; y1: number }; words: OcrWord[] }

  // OCR one region of the page in isolation (columns would otherwise merge
  // into single lines spanning the whole page) and offset boxes back into
  // page coordinates. Regions are sampled from the original full-resolution
  // image (not the downscaled analysis canvas) so upscaled strips stay sharp;
  // `blur` softens gaps in stylized fonts like the seven-segment digits in
  // the TEST badge so they read as solid strokes.
  const regionCanvas = (x0: number, y0: number, w: number, h: number, upscale: number): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = Math.round(w * upscale); c.height = Math.round(h * upscale);
    c.getContext('2d')!.drawImage(img, x0 / scale, y0 / scale, w / scale, h / scale, 0, 0, c.width, c.height);
    return c;
  };

  const ocrRegion = async (
    x0: number, y0: number, x1: number, y1: number, upscale = 1, blur = 0
  ): Promise<OcrLine[]> => {
    const w = Math.round(x1 - x0), h = Math.round(y1 - y0);
    if (w < 8 || h < 8) return [];
    let c = regionCanvas(x0, y0, w, h, upscale);
    if (blur > 0) c = blurCanvas(c, blur);
    const { data } = await worker.recognize(c, {}, { blocks: true });
    const shift = (b: { x0: number; y0: number; x1: number; y1: number }) =>
      ({ x0: b.x0 / upscale + x0, y0: b.y0 / upscale + y0, x1: b.x1 / upscale + x0, y1: b.y1 / upscale + y0 });
    return (data.blocks ?? []).flatMap(b =>
      b.paragraphs.flatMap(p => p.lines.map(l => ({
        text: l.text,
        bbox: shift(l.bbox),
        words: l.words.map(wd => ({ text: wd.text, conf: wd.confidence, bbox: shift(wd.bbox) })),
      })))
    );
  };

  const [headerLines, footerLines, ...columnLines] = await Promise.all([
    ocrRegion(0, 0, W, layout.contentTop, 2),
    // Footer page numbers use a seven-segment style font; blur merges the
    // segment gaps so they read as normal digits.
    ocrRegion(0, layout.footerTop, W, H, 2.5, 2.5),
    ...layout.columns.map(col => ocrRegion(col.x0, layout.contentTop, col.x1, layout.contentBottom)),
  ]);

  // --- Question labels ------------------------------------------------------
  const candidates: LabelCandidate[] = [];
  layout.columns.forEach((col, colIdx) => {
    const colW = col.x1 - col.x0;
    for (const line of columnLines[colIdx]) {
      if (line.bbox.x0 > col.x0 + colW * 0.12) continue;
      const m = LABEL_RE.exec(line.text);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (n < 1 || n > 60) continue;
      // Right edge of the label token: first word if it is just the number.
      const first = line.words[0];
      let labelRight = line.bbox.x0 + colW * 0.055;
      if (first && /^\d{1,2}\s*[.,]?$/.test(first.text.trim())) {
        labelRight = first.bbox.x1;
      }
      candidates.push({ n, col: colIdx, y0: line.bbox.y0, labelRight, lineX0: line.bbox.x0 });
    }
  });

  candidates.sort((a, b) => a.col - b.col || a.y0 - b.y0);
  const labels = filterSequence(candidates);

  // --- Question boxes -------------------------------------------------------
  const labelPad = Math.round(H * 0.003);
  const regions: { questionNumber: string; box: BoundingBox }[] = [];

  for (let i = 0; i < labels.length; i++) {
    const lab = labels[i];
    const col = layout.columns[lab.col];
    const next = labels[i + 1];
    const stripTop = lab.y0 - labelPad;
    const stripBottom = (next && next.col === lab.col)
      ? next.y0 - labelPad
      : layout.contentBottom;

    const bodyX0 = lab.labelRight + Math.round(W * 0.004);
    const bounds = inkBounds(map, bodyX0, stripTop, col.x1 + 1, stripBottom);
    if (!bounds) continue;

    regions.push({
      questionNumber: String(lab.n),
      box: {
        xmin: scale1000(bounds.x0, W),
        ymin: scale1000(Math.min(bounds.y0, lab.y0), H),
        xmax: scale1000(bounds.x1, W),
        ymax: scale1000(bounds.y1, H),
      },
    });
  }

  // --- Metadata from header / footer ---------------------------------------
  // Page number: the digit token closest to the footer's horizontal center.
  let pageNumber = 'unknown';
  let bestPageDist = Infinity;
  // Seven-segment footer digits sometimes read as lookalike letters
  // ("91" -> "g1"); the centered footer token can only be the page number.
  const PAGE_LOOKALIKE: Record<string, string> = {
    O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', '|': '1', Z: '2',
    E: '3', A: '4', S: '5', s: '5', G: '6', g: '9', T: '7', B: '8',
  };
  for (const line of footerLines) {
    for (const w of line.words) {
      const t = w.text.trim();
      if (w.conf < 40) continue;
      if (!/^[0-9OoDQIlZEASsGgTB|]{1,3}$/.test(t)) continue;
      const mapped = t.split('').map(ch => PAGE_LOOKALIKE[ch] ?? ch).join('');
      if (!/^\d{1,3}$/.test(mapped)) continue;
      const dist = Math.abs((w.bbox.x0 + w.bbox.x1) / 2 - W / 2);
      if (dist < W * 0.25 && dist < bestPageDist) {
        bestPageDist = dist;
        pageNumber = mapped;
      }
    }
  }

  // Test number: from the corner badge ("TEST" above a seven-segment number).
  let testNumber: string | undefined;
  for (const line of headerLines) {
    const m = /TEST[^0-9A-Za-z]{0,4}(\d{1,2})/i.exec(line.text);
    if (m) { testNumber = m[1]; break; }
  }
  if (!testNumber) {
    // The badge circle hangs below the header bar but adding empty space
    // below it derails Tesseract's segmentation, so use a fixed 9% strip.
    // Blur merges the seven-segment digit gaps into solid strokes.
    const up = 4;
    const badgeBottom = H * 0.09;
    const base = regionCanvas(W * 0.7, 0, W * 0.3, badgeBottom, up);
    const { data } = await worker.recognize(blurCanvas(base, 2), {}, { blocks: true });
    const words = (data.blocks ?? []).flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)));
    const testWord = words.find(w => /TEST/i.test(w.text));
    if (testWord) {
      const digitWord = words.find(w =>
        w !== testWord && /^\d{1,2}$/.test(w.text.trim()) && w.bbox.y1 > testWord.bbox.y0
      );
      if (digitWord) {
        testNumber = digitWord.text.trim().padStart(2, '0');
      }
      if (!testNumber) {
        // Seven-segment digits often read as lookalike letters ("01" -> "DI").
        // Directly under a confident "TEST" only digits can occur, so map them.
        const LOOKALIKE: Record<string, string> = {
          O: '0', D: '0', Q: '0', I: '1', l: '1', '|': '1', Z: '2',
          E: '3', A: '4', S: '5', G: '6', T: '7', B: '8',
        };
        const under = words.find(w =>
          w !== testWord && w.confidence >= 50 &&
          w.bbox.y0 >= testWord.bbox.y1 - 10 &&
          w.bbox.x0 < testWord.bbox.x1 && w.bbox.x1 > testWord.bbox.x0 &&
          /^[0-9ODQIlZEASGTB|]{1,2}$/.test(w.text.trim())
        );
        if (under) {
          const mapped = under.text.trim().split('').map(ch => LOOKALIKE[ch] ?? ch).join('');
          if (/^\d{1,2}$/.test(mapped)) testNumber = mapped.padStart(2, '0');
        }
      }
      if (!testNumber) {
        // Digits misread as letters (e.g. seven-segment "01" -> "DI"): re-OCR
        // the area just below the TEST word with a digits-only worker.
        const th = testWord.bbox.y1 - testWord.bbox.y0;
        const gx0 = Math.max(0, testWord.bbox.x0 - th);
        const gx1 = Math.min(base.width, testWord.bbox.x1 + th);
        const gy0 = testWord.bbox.y1;
        const gy1 = Math.min(base.height, testWord.bbox.y1 + th * 3.5);
        if (gy1 - gy0 > 8) {
          const crop = document.createElement('canvas');
          crop.width = (gx1 - gx0) * 2; crop.height = (gy1 - gy0) * 2;
          const cctx = crop.getContext('2d')!;
          cctx.fillStyle = '#fff'; cctx.fillRect(0, 0, crop.width, crop.height);
          cctx.drawImage(base, gx0, gy0, gx1 - gx0, gy1 - gy0, 0, 0, crop.width, crop.height);
          const digitWorker = await getDigitWorker();
          for (const blur of [2, 3]) {
            const res = await digitWorker.recognize(blurCanvas(crop, blur));
            const t = res.data.text.trim();
            if (/^\d{1,2}$/.test(t)) { testNumber = t.padStart(2, '0'); break; }
          }
        }
      }
    }
  }

  // Topic: confident words from the centered header line; the decorative
  // pattern of the header bar otherwise leaks garbage tokens into the text,
  // and OCR sometimes merges the "N. Ünite" box into the same line, so the
  // filtering has to happen per word rather than per line.
  let topic: string | undefined;
  let topicScore = 0;
  for (const line of headerLines) {
    const good = line.words.filter(w => {
      const cx = (w.bbox.x0 + w.bbox.x1) / 2;
      const t = w.text.trim();
      if (/ünite|unite|^test$/i.test(t)) return false;
      if (/^\d{1,2}[.,]?$/.test(t)) return false;
      return w.conf >= 55 && cx > W * 0.22 && cx < W * 0.82 &&
        /[0-9a-zçğıöşü.,()-]{2,}/i.test(t);
    });
    const t = good.map(w => w.text).join(' ').trim();
    if (t.length < 3) continue;
    const score = good.reduce((s, w) => s + w.conf * w.text.length, 0);
    if (score > topicScore) { topicScore = score; topic = t; }
  }

  return { pageNumber, testNumber, topic, regions };
};
