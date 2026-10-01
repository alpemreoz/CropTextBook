// Question-detection core shared by the web app (services/localAnalyzer.ts)
// and the CLI (cli/qcrop.mjs). Everything here is pure computation on a pixel
// buffer plus positioned text lines; callers produce those (canvas or sharp
// for pixels, Tesseract OCR or a PDF text layer for text).
//
// Coordinates are in "analysis space" (the page scaled to ANALYSIS_WIDTH px
// wide) unless noted; question boxes are returned in 0-1000 relative space.

export const ANALYSIS_WIDTH = 2000;
const INK_THRESHOLD = 190; // luminance below this counts as ink
const LIGHT_THRESHOLD = 235; // light gray (column dividers in scans) and darker
const MAX_QUESTION_NUMBER = 120;

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

/** `pixels` is grayscale (channels = 1) or RGBA (channels = 4). */
export const buildInkMap = (pixels, width, height, channels = 1) => {
  const ink = new Uint8Array(width * height);
  const light = new Uint8Array(width * height);
  const rowInk = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    let count = 0;
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      let lum;
      if (channels === 1) lum = pixels[p];
      else {
        const i = p * channels;
        lum = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      }
      if (lum < INK_THRESHOLD) { ink[p] = 1; count++; }
      if (lum < LIGHT_THRESHOLD) light[p] = 1;
    }
    rowInk[y] = count;
  }
  return { width, height, ink, light, rowInk };
};

const colInkInRange = (map, y0, y1) => {
  const out = new Int32Array(map.width);
  for (let y = y0; y < y1; y++) {
    const row = y * map.width;
    for (let x = 0; x < map.width; x++) out[x] += map.ink[row + x];
  }
  return out;
};

/** First y >= from where `rows` consecutive rows have less ink than `max`. */
const findGap = (map, from, to, max, rows) => {
  let run = 0;
  for (let y = from; y < to; y++) {
    if (map.rowInk[y] <= max) { if (++run >= rows) return y - run + 1; }
    else run = 0;
  }
  return -1;
};

/**
 * x of a column divider: the center-band column with the longest unbroken
 * vertical run of (light or dark) ink, if that run is long. Dividers often
 * stop where a full-width section begins, so total ink alone isn't
 * reliable, and in scans they're often too light to count as ink.
 */
const findDivider = (map, lo, hi, y0, y1) => {
  const px = map.light ?? map.ink;
  const W = map.width;
  const cands = [];
  for (let x = lo; x <= hi; x++) {
    let run = 0, longest = 0, end = y0;
    for (let y = y0; y < y1; y++) {
      if (px[y * W + x]) { if (++run > longest) { longest = run; end = y + 1; } }
      else run = 0;
    }
    // Short dividers count too (they stop where a full-width section starts);
    // the gutter check below keeps figure and box edges out.
    if (longest >= (y1 - y0) * 0.15) cands.push({ x, start: end - longest, end, longest });
  }
  cands.sort((a, b) => b.longest - a.longest);
  // A divider stands in a gutter: along it, text rarely comes close on both
  // sides at once. A box edge inside a column has text on both sides.
  const near0 = Math.max(3, Math.round(W * 0.0015)), near1 = Math.round(W * 0.012);
  const inkIn = (row, a, b) => {
    for (let x = Math.max(0, a); x < Math.min(W, b); x++) if (map.ink[row + x]) return true;
    return false;
  };
  for (const c of cands) {
    let both = 0, rows = 0;
    for (let y = c.start; y < c.end; y += 2) {
      const row = y * W;
      rows++;
      if (inkIn(row, c.x - near1, c.x - near0) && inkIn(row, c.x + near0, c.x + near1)) both++;
    }
    if (both / rows < 0.15) return c.x;
  }
  return -1;
};

/**
 * Header/footer bands and the two-column split, from ink projections.
 * `labelBoxes` (question-number label boxes, when a PDF text layer gives
 * them exactly) corrects a split that landed inside the right column.
 */
export const detectLayout = (map, labelBoxes = []) => {
  const { width: W, height: H } = map;
  const noise = Math.max(2, W * 0.001);
  const gapRows = Math.max(6, Math.round(H * 0.004));

  let headerTop = 0;
  while (headerTop < H * 0.2 && map.rowInk[headerTop] <= noise) headerTop++;
  let headerBottom = findGap(map, headerTop, Math.floor(H * 0.25), noise, gapRows);
  if (headerBottom < 0) headerBottom = headerTop;
  // A badge hanging below the header bar ("TEST 31" circle) can touch the
  // first content row, leaving no blank row between them. Once a wide header
  // row is passed, rows whose ink is one narrow cluster count as blank. That
  // end is used when a question number would otherwise sit in the header
  // (text layers), or, without label hints (OCR), when two-column content
  // follows the badge inside the header band.
  let wideSeen = false, blank = 0, narrowBottom = -1;
  for (let y = headerTop; y < headerBottom; y++) {
    let x0 = -1, x1 = -1;
    for (let x = 0, row = y * W; x < W; x++) if (map.ink[row + x]) { if (x0 < 0) x0 = x; x1 = x; }
    const narrow = x0 < 0 || x1 - x0 <= W * 0.12;
    if (!narrow) { wideSeen = true; blank = 0; continue; }
    if (wideSeen && ++blank >= gapRows) { narrowBottom = y; break; }
  }
  if (narrowBottom > 0) {
    let swallowed;
    if (labelBoxes.length) {
      swallowed = labelBoxes.some(b => b.y0 > narrowBottom && b.y1 < headerBottom);
    } else {
      let bothSides = 0;
      for (let y = narrowBottom; y < headerBottom; y++) {
        let left = false, right = false;
        for (let x = 0, row = y * W; x < W; x++) {
          if (!map.ink[row + x]) continue;
          if (x < W * 0.45) left = true; else if (x > W * 0.55) right = true;
        }
        if (left && right) bothSides++;
      }
      swallowed = headerBottom - narrowBottom > H * 0.03 && bothSides >= H * 0.005;
    }
    if (swallowed) headerBottom = narrowBottom;
  }

  let footerBottom = H - 1;
  while (footerBottom > H * 0.85 && map.rowInk[footerBottom] <= noise) footerBottom--;
  let footerTop = footerBottom;
  let run = 0;
  for (let y = footerBottom; y > H * 0.85; y--) {
    if (map.rowInk[y] <= noise) { if (++run >= gapRows) { footerTop = y + run; break; } }
    else run = 0;
  }

  const contentTop = headerBottom;
  const contentBottom = Math.min(footerTop, footerBottom) - 1;

  // Either a long vertical divider line or the widest low-ink valley near the
  // horizontal center of the content area.
  const colInk = colInkInRange(map, contentTop, contentBottom);
  const contentH = contentBottom - contentTop;
  const lo = Math.floor(W * 0.38), hi = Math.ceil(W * 0.62);

  let splitX = findDivider(map, lo, hi, contentTop, contentBottom);
  if (splitX < 0) {
    for (let x = lo; x <= hi; x++) {
      if (colInk[x] > contentH * 0.55) { splitX = x; break; }
    }
  }
  if (splitX < 0) {
    let bestX = Math.round(W / 2), bestScore = Infinity;
    const win = Math.max(8, Math.round(W * 0.01));
    for (let x = lo; x <= hi - win; x++) {
      let s = 0;
      for (let k = 0; k < win; k++) s += colInk[x + k];
      if (s < bestScore) { bestScore = s; bestX = x + Math.floor(win / 2); }
    }
    splitX = bestX;
  }

  // Right-column labels must start right of the split. Only hints near the
  // split can move it: numbered cells far into the left column ("2. Grup"
  // table headers) aren't right-column labels.
  const rightLabels = labelBoxes
    .filter(b => b.y0 > contentTop && b.y1 < contentBottom)
    .map(b => b.x0)
    .filter(x => x > W * 0.4 && x < W * 0.7 && x > splitX - W * 0.05);
  if (rightLabels.length > 0) {
    const firstRight = Math.min(...rightLabels);
    if (splitX > firstRight - W * 0.01) splitX = Math.round(firstRight - W * 0.012);
  }

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

/**
 * x positions of thin vertical rules (column dividers) inside a window: runs
 * of at most a few px whose ink covers most of the window's height. Crops and
 * whitespace scans ignore them so a divider can't glue regions together.
 */
const verticalRules = (map, x0, y0, x1, y1, minFraction = 0.6, px = map.ink) => {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(map.width, Math.ceil(x1)); y1 = Math.min(map.height, Math.ceil(y1));
  const h = y1 - y0;
  const rules = new Set();
  if (h <= 0) return rules;
  const maxWidth = Math.max(4, Math.round(map.width * 0.003));
  let runStart = -1;
  const flush = (end) => {
    if (runStart >= 0 && end - runStart <= maxWidth) {
      for (let x = runStart; x < end; x++) rules.add(x);
    }
    runStart = -1;
  };
  for (let x = x0; x < x1; x++) {
    let count = 0;
    for (let y = y0; y < y1; y++) count += px[y * map.width + x];
    if (count >= h * minFraction) { if (runStart < 0) runStart = x; }
    else flush(x);
  }
  flush(x1);
  return rules;
};

/** Ink bounding box within a window (skipping `ignore` x positions), or null. */
export const inkBounds = (map, x0, y0, x1, y1, ignore) => {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(map.width, Math.ceil(x1)); y1 = Math.min(map.height, Math.ceil(y1));
  let minX = -1, maxX = -1, minY = -1, maxY = -1;
  for (let y = y0; y < y1; y++) {
    const row = y * map.width;
    for (let x = x0; x < x1; x++) {
      if (map.ink[row + x] && !(ignore && ignore.has(x))) {
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

/**
 * Last inked row reachable from `fromY` without crossing `gapRows` blank rows.
 * Used to carry a question box past its options through anything hanging
 * below them (stacked fractions, option tables) but not across the
 * whitespace that separates it from the next section. `margin` is the strip
 * left of the options: below `margin.fromY`, ink there means a new block
 * starts at the column margin (a label, a section icon), so extension stops.
 */
const extendThroughInk = (map, x0, x1, fromY, toY, gapRows, ignore, margin) => {
  x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(map.width, Math.ceil(x1));
  toY = Math.min(map.height, Math.ceil(toY));
  const mx0 = Math.max(0, Math.floor(margin.x0)), mx1 = Math.min(map.width, Math.ceil(margin.x1));
  let last = Math.floor(fromY), empty = 0;
  for (let y = Math.max(0, Math.floor(fromY)); y < toY; y++) {
    const row = y * map.width;
    if (y > margin.fromY) {
      let marginInk = false;
      for (let x = mx0; x < mx1; x++) {
        if (map.ink[row + x] && !ignore.has(x)) { marginInk = true; break; }
      }
      if (marginInk) break;
    }
    let hasInk = false;
    for (let x = x0; x < x1; x++) {
      if (map.ink[row + x] && !ignore.has(x)) { hasInk = true; break; }
    }
    if (hasInk) { last = y; empty = 0; }
    else if (++empty >= gapRows) break;
  }
  return last + 1;
};

// ---------------------------------------------------------------------------
// Text: words and lines
//
// A word is { text, conf, bbox: { x0, y0, x1, y1 } }; a line is
// { text, bbox, words }. OCR returns lines directly; PDF text layers are
// converted to words and grouped with groupLines().
// ---------------------------------------------------------------------------

const mulMatrix = (m1, m2) => [
  m1[0] * m2[0] + m1[2] * m2[1],
  m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3],
  m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
  m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];

/**
 * pdf.js getTextContent() items -> { str, x0, y0, x1, y1 } with coordinates
 * as fractions of the page. `viewport` is page.getViewport({ scale: 1 }).
 * Non-horizontal text (rotated watermarks) is dropped.
 */
export const normalizePdfTextItems = (items, viewport) => {
  const out = [];
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    // Fonts without a proper Unicode map yield control characters.
    const str = it.str.replace(/[\u0000-\u001f]/g, '');
    if (!str.trim()) continue;
    const [a, b, c, d, e, f] = mulMatrix(viewport.transform, it.transform);
    if (Math.abs(b) > Math.abs(a) * 0.1 || a <= 0) continue;
    const fontH = Math.hypot(c, d);
    if (!(fontH > 0)) continue;
    // Some producers emit width 0; estimate from the font size instead.
    const w = it.width > 0 ? it.width * viewport.scale : fontH * 0.55 * str.length;
    out.push({
      str,
      x0: e / viewport.width,
      x1: (e + w) / viewport.width,
      y0: (f - fontH * 0.85) / viewport.height,
      y1: (f + fontH * 0.2) / viewport.height,
    });
  }
  return out;
};

/** Whether a page's text layer is real text (not empty or garbage glyph codes). */
export const textLayerUsable = (items) => {
  if (!items || items.length === 0) return false;
  const chars = items.map(i => i.str).join('').replace(/\s+/g, '');
  if (chars.length < 40) return false;
  const good = (chars.match(/[0-9A-Za-zÇĞİÖŞÜÂÎÛçğıöşüâîû.,:;()\-–]/g) || []).length;
  return good / chars.length > 0.8;
};

/** Normalized text items -> words in analysis space (items split on spaces). */
export const wordsFromTextItems = (items, W, H) => {
  const words = [];
  for (const it of items) {
    const n = it.str.length;
    let offset = 0;
    for (const part of it.str.split(/(\s+)/)) {
      if (part && !/^\s+$/.test(part)) {
        const fx0 = it.x0 + (it.x1 - it.x0) * (offset / n);
        const fx1 = it.x0 + (it.x1 - it.x0) * ((offset + part.length) / n);
        words.push({
          text: part,
          conf: 100,
          bbox: { x0: fx0 * W, y0: it.y0 * H, x1: fx1 * W, y1: it.y1 * H },
        });
      }
      offset += part.length;
    }
  }
  return words;
};

/** Cluster words into reading-order lines by vertical overlap. */
export const groupLines = (words) => {
  const sorted = [...words].sort((a, b) =>
    (a.bbox.y0 + a.bbox.y1) - (b.bbox.y0 + b.bbox.y1));
  const lines = [];
  for (const w of sorted) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    const h = w.bbox.y1 - w.bbox.y0;
    let target = null;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 4; i--) {
      const l = lines[i];
      if (Math.abs(l.cy - cy) < Math.max(h, l.h) * 0.5) { target = l; break; }
    }
    if (!target) {
      target = { cy, h, words: [] };
      lines.push(target);
    }
    target.words.push(w);
  }
  return lines.map(l => {
    // Text layers often split one visual word into touching pieces ("10"
    // + "." or kerned fragments); glue those back together.
    const ws = [];
    for (const w of l.words.sort((a, b) => a.bbox.x0 - b.bbox.x0)) {
      const prev = ws[ws.length - 1];
      const h = Math.max(w.bbox.y1 - w.bbox.y0, prev ? prev.bbox.y1 - prev.bbox.y0 : 0);
      if (prev && w.bbox.x0 - prev.bbox.x1 < h * 0.12) {
        ws[ws.length - 1] = {
          text: prev.text + w.text,
          conf: Math.min(prev.conf, w.conf),
          bbox: {
            x0: prev.bbox.x0, y0: Math.min(prev.bbox.y0, w.bbox.y0),
            x1: Math.max(prev.bbox.x1, w.bbox.x1), y1: Math.max(prev.bbox.y1, w.bbox.y1),
          },
        };
      } else {
        ws.push(w);
      }
    }
    return {
      text: ws.map(w => w.text).join(' '),
      words: ws,
      bbox: {
        x0: Math.min(...ws.map(w => w.bbox.x0)),
        y0: Math.min(...ws.map(w => w.bbox.y0)),
        x1: Math.max(...ws.map(w => w.bbox.x1)),
        y1: Math.max(...ws.map(w => w.bbox.y1)),
      },
    };
  });
};

/**
 * Boxes of "N." words that begin their line: the question-label hints
 * detectLayout() accepts. "19." in "…in 19. yüzyıl" has a word a space
 * before it; a right-column label only has the left column's text, across
 * the gutter.
 */
export const labelBoxesFromWords = (words) => words
  .filter(w => /^\d{1,3}\.$/.test(w.text))
  .filter(w => {
    const h = w.bbox.y1 - w.bbox.y0;
    return !words.some(o => o !== w &&
      o.bbox.y0 < w.bbox.y1 && o.bbox.y1 > w.bbox.y0 &&
      o.bbox.x1 <= w.bbox.x0 + 1 && w.bbox.x0 - o.bbox.x1 < h);
  })
  .map(w => w.bbox);

/** Lines built from the words whose center lies inside a region. */
export const linesInRegion = (words, x0, y0, x1, y1) => groupLines(words.filter(w => {
  const cx = (w.bbox.x0 + w.bbox.x1) / 2, cy = (w.bbox.y0 + w.bbox.y1) / 2;
  return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
}));

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

// "A)" at the start of a line or after a space. Letters in parentheses —
// "doğru (D) ya da yanlış (Y)", element symbols "(H)", "(F)" — are text.
const OPTION_RE = /(?:^|\s)([A-H])\s?\)/g;

// Headings that open a non-test section ("Yazılı Sınav", "Etkinlik", ...).
// They span the page, so no question box may run past one. Whole-line,
// title- or upper-case matches only: "yazılı" also occurs inside questions.
const SECTION_TITLES = [
  'Yazılı Sınav', 'Yazılı', 'Yazılı Sorular', 'Etkinlik', 'Etkinlikler',
  'Açık Uçlu Sorular', 'Doğru Yanlış', 'Boşluk Doldurma', 'Eşleştirme',
];
const isSectionHeading = (line) => {
  const t = line.text.replace(/[-–/:]/g, ' ').replace(/\s+/g, ' ').trim();
  return SECTION_TITLES.some(s => t === s || t === s.toLocaleUpperCase('tr'));
};

/**
 * The multiple-choice option block ("A) ... E)") inside a vertical strip of a
 * column, or null when the strip has fewer than three distinct option
 * letters — i.e. it isn't a test question (written-exam and activity
 * questions have no options).
 */
const findOptionBlock = (lines, top, bottom) => {
  const high = new Set();
  const blocks = [];
  let cur = null;
  const sorted = [...lines].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  for (const line of sorted) {
    const cy = (line.bbox.y0 + line.bbox.y1) / 2;
    if (cy < top || cy >= bottom) continue;
    const all = [...line.text.matchAll(OPTION_RE)].map(m => m[1]);
    all.filter(l => l > 'E').forEach(l => high.add(l));
    const letters = all.filter(l => l <= 'E');
    if (letters.length === 0) continue;
    // A fresh "A)" after a run of three or more letters starts a new run.
    if (!cur || (letters.includes('A') && cur.seen.size >= 3)) {
      cur = { seen: new Set(), first: line, last: line, x0: Infinity };
      blocks.push(cur);
    }
    letters.forEach(l => cur.seen.add(l));
    cur.last = line;
    for (const w of line.words) {
      if (/^\(?[A-E]\s?\)/.test(w.text)) cur.x0 = Math.min(cur.x0, w.bbox.x0);
    }
  }
  // Lettered lists running on to F), G) are statement lists in written
  // exercises. It takes two such letters: a lone "H)" is as likely a split
  // chemical formula or an OCR misread.
  if (high.size >= 2) return null;
  // The first run of letters is the options — unless it stops short of E and
  // a complete A-E run follows (figure labels "A) B) C)" beside a question's
  // statements, with the real options further down). A later run is
  // otherwise something past the question.
  let block = blocks.find(b => b.seen.size >= 3);
  if (!block) return null;
  if (!block.seen.has('E')) {
    const complete = blocks.find(b => b !== block && blocks.indexOf(b) > blocks.indexOf(block) && b.seen.size === 5);
    if (complete) block = complete;
  }
  return { top: block.first.bbox.y0, lastTop: block.last.bbox.y0, bottom: block.last.bbox.y1, x0: block.x0 };
};

/**
 * Longest increasing subsequence by question number, to drop OCR noise.
 * A candidate may carry alternative readings (`alts`, preferred first); the
 * chosen reading becomes its `n`. Among equally long chains, the one with
 * the smallest gaps wins (questions on a page are consecutive).
 */
const filterSequence = (cands) => {
  if (cands.length === 0) return cands;
  const opts = cands.map(c => c.alts ?? [c.n]);
  const len = opts.map(a => a.map(() => 1));
  const gaps = opts.map(a => a.map(() => 0));
  const prev = opts.map(a => a.map(() => null));
  const better = (l1, g1, l2, g2) => l1 > l2 || (l1 === l2 && g1 < g2);
  for (let i = 0; i < cands.length; i++) {
    for (let k = 0; k < opts[i].length; k++) {
      for (let j = 0; j < i; j++) {
        for (let kk = 0; kk < opts[j].length; kk++) {
          if (opts[j][kk] >= opts[i][k]) continue;
          const l = len[j][kk] + 1, g = gaps[j][kk] + (opts[i][k] - opts[j][kk] - 1);
          if (better(l, g, len[i][k], gaps[i][k])) {
            len[i][k] = l; gaps[i][k] = g; prev[i][k] = [j, kk];
          }
        }
      }
    }
  }
  let end = null;
  for (let i = 0; i < cands.length; i++) {
    for (let k = 0; k < opts[i].length; k++) {
      if (!end || better(len[i][k], gaps[i][k], len[end[0]][end[1]], gaps[end[0]][end[1]]) ||
        (len[i][k] === len[end[0]][end[1]] && gaps[i][k] === gaps[end[0]][end[1]] && i > end[0])) end = [i, k];
    }
  }
  const keep = [];
  for (let at = end; at; at = prev[at[0]][at[1]]) {
    keep.unshift({ ...cands[at[0]], n: opts[at[0]][at[1]] });
  }
  return keep;
};

// Digits Tesseract confuses in bold numerals (5/9 in particular).
const DIGIT_CONFUSIONS = { 0: '8', 1: '7', 3: '8', 5: '96', 6: '58', 7: '1', 8: '63', 9: '5' };

/** A label reading plus its single-digit OCR confusions, reading first. */
const labelReadings = (n) => {
  const s = String(n), out = [n];
  for (let i = 0; i < s.length; i++) {
    for (const d of DIGIT_CONFUSIONS[s[i]] ?? '') {
      const v = parseInt(s.slice(0, i) + d + s.slice(i + 1), 10);
      if (v >= 1 && v <= MAX_QUESTION_NUMBER && !out.includes(v)) out.push(v);
    }
  }
  return out;
};

const scale1000 = (v, total) => Math.max(0, Math.min(1000, Math.round((v / total) * 1000)));

/**
 * Every numbered label on the page with the vertical strip it owns (down to
 * the next label in its column, a section heading, or the content bottom).
 * `marginLabels[col]` ({ n, bbox } read from the column margin by
 * readMarginLabels' OCR pass) fill in labels the line OCR missed.
 */
const labelStrips = ({ map, layout, columnLines, strictLabels = false, pageLines, marginLabels }) => {
  const H = map.height, W = map.width;
  // Section banners start at the page's left margin (after their icon); an
  // "ETKİNLİK" title inside a question's box sits mid-column and isn't one.
  const marginX = layout.columns[0].x0 + W * 0.06;
  const headingTops = (pageLines ?? columnLines.flat())
    .filter(l => isSectionHeading(l) && l.bbox.x0 <= marginX)
    .map(l => l.bbox.y0);
  // Text layers: "N." — or a bare "N" where the period is drawn as a graphic,
  // accepted below only when it lines up with dotted labels.
  const labelRe = strictLabels ? /^\s*(\d{1,3})(\.)?(?:\s|$)/ : /^\s*(\d{1,3})\s*([.,])/;

  const candidates = [];
  layout.columns.forEach((col, colIdx) => {
    const colW = col.x1 - col.x0;
    let colCands = [];
    for (const line of columnLines[colIdx]) {
      if (line.bbox.x0 > col.x0 + colW * 0.25) continue;
      const m = labelRe.exec(line.text);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (n < 1 || n > MAX_QUESTION_NUMBER) continue;
      const first = line.words[0];
      let labelRight = line.bbox.x0 + colW * 0.055;
      if (first && /^\d{1,3}\s*[.,]?$/.test(first.text.trim())) labelRight = first.bbox.x1;
      const labelBottom = first && first.bbox.x1 === labelRight ? first.bbox.y1 : line.bbox.y1;
      // A period drawn as a graphic sits just past the text-layer number.
      if (strictLabels && !m[2]) labelRight += (labelBottom - line.bbox.y0) * 0.45;
      colCands.push({ n, dotted: !!m[2], col: colIdx, x0: line.bbox.x0, y0: line.bbox.y0, y1: labelBottom, labelRight });
    }
    if (strictLabels) {
      const dottedXs = colCands.filter(c => c.dotted).map(c => c.x0);
      colCands = colCands.filter(c => c.dotted || dottedXs.some(x => Math.abs(x - c.x0) < W * 0.006));
    }
    // Labels hang at the column's margin; body lines that merely start with
    // a number ("2,5 m/s ...") are indented relative to the labels above
    // them. (Judged against those, not the column's leftmost candidate: a
    // numbered table further down may start left of the labels.)
    colCands.sort((a, b) => a.y0 - b.y0);
    const kept = [];
    let minAbove = Infinity;
    for (const c of colCands) {
      if (c.x0 > minAbove + colW * 0.03) continue;
      kept.push(c);
      minAbove = Math.min(minAbove, c.x0);
    }
    // OCR readings are uncertain: each label keeps its alternatives (the
    // margin read first, it's the most reliable, then the line read, then
    // digit confusions) and filterSequence picks the ones that run in order.
    if (!strictLabels) kept.forEach(c => { c.alts = labelReadings(c.n); });
    const tol = H * 0.012;
    for (const m of marginLabels?.[colIdx] ?? []) {
      if (m.n < 1 || m.n > MAX_QUESTION_NUMBER) continue;
      const same = kept.find(c => Math.abs(c.y0 - m.bbox.y0) < tol);
      if (same) {
        same.alts = [...new Set([m.n, ...same.alts, ...labelReadings(m.n)])];
        continue;
      }
      kept.push({ n: m.n, alts: labelReadings(m.n), col: colIdx, x0: m.bbox.x0, y0: m.bbox.y0, y1: m.bbox.y1, labelRight: m.bbox.x1 });
    }
    candidates.push(...kept);
  });
  candidates.sort((a, b) => a.col - b.col || a.y0 - b.y0);

  const labelPad = Math.round(H * 0.003);
  return candidates.map((c, i) => {
    const next = candidates[i + 1];
    const stripTop = c.y0 - labelPad;
    let stripBottom = (next && next.col === c.col) ? next.y0 - labelPad : layout.contentBottom;
    const heading = Math.min(...headingTops.filter(y => y > c.y0));
    if (heading < stripBottom) stripBottom = heading - labelPad;
    // Items below an "Etkinlik"/"Yazılı Sınav" heading belong to that
    // section; they still bound the strips above them, but aren't tests.
    const inSection = headingTops.some(y => y < c.y0);
    return { ...c, stripTop, stripBottom, inSection };
  });
};

/**
 * Left edge of a column's text: the leftmost ink, measured only on rows away
 * from full-width sections (they run through the column edge). Full-width
 * rows are found on the light-ink map, so pale answer boxes count, and
 * widened by about a line so word gaps over the gutter don't hide them.
 * Question numbers sit on this edge.
 */
const columnTextEdge = (map, layout, colIdx) => {
  const W = map.width, H = map.height;
  const [c0, c1] = layout.columns;
  const y0 = layout.contentTop, y1 = layout.contentBottom;
  const light = map.light ?? map.ink;
  const gutterRules = verticalRules(map, c0.x1, y0, c1.x0, y1, 0.2, light);
  const near = Math.round(H * 0.01);
  const fullWidth = new Uint8Array(H);
  for (let y = y0; y < y1; y++) {
    const row = y * map.width;
    for (let x = c0.x1; x < c1.x0; x++) {
      if (light[row + x] && !gutterRules.has(x)) {
        for (let k = Math.max(y0, y - near); k < Math.min(y1, y + near); k++) fullWidth[k] = 1;
        break;
      }
    }
  }
  const col = layout.columns[colIdx];
  const lo = Math.max(0, Math.round(col.x0 - W * 0.005));
  const hi = Math.round(col.x0 + (col.x1 - col.x0) * 0.3);
  const colRules = verticalRules(map, lo, y0, hi, y1, 0.2);
  const counts = new Int32Array(hi - lo);
  for (let y = y0; y < y1; y++) {
    if (fullWidth[y]) continue;
    const row = y * map.width;
    for (let x = lo; x < hi; x++) if (map.ink[row + x] && !colRules.has(x)) counts[x - lo]++;
  }
  for (let i = 0; i < counts.length; i++) if (counts[i] >= 3) return lo + i;
  return col.x0;
};

/**
 * A column's number margin (the strip at its text edge where question
 * numbers sit) as a clean black-on-white image for a digits-only OCR pass:
 * numbers read alone are far more reliable than inside full lines. Vertical
 * rules (the column divider) are dropped and the strip is upscaled 2x with a
 * white border. Returns { x0, y0, pad, edge, width, height, gray } or null.
 */
export const marginStrip = (map, layout, columnLines, colIdx) => {
  const W = map.width;
  const edge = columnTextEdge(map, layout, colIdx);
  const x0 = Math.max(0, Math.round(edge - W * 0.004));
  const x1 = Math.min(W, Math.round(edge + W * 0.034));
  const y0 = layout.contentTop, y1 = layout.contentBottom;
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  const rules = verticalRules(map, x0, y0, x1, y1, 0.2);
  const pad = 16, sw = x1 - x0, sh = y1 - y0;
  const width = sw * 2 + pad * 2, height = sh * 2 + pad * 2;
  const gray = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < sh; y++) {
    const row = (y0 + y) * map.width;
    for (let x = 0; x < sw; x++) {
      if (!map.ink[row + x0 + x] || rules.has(x0 + x)) continue;
      const o = (pad + y * 2) * width + pad + x * 2;
      gray[o] = gray[o + 1] = gray[o + width] = gray[o + width + 1] = 0;
    }
  }
  return { x0, y0, pad, edge, width, height, gray };
};

/** OCR words from a marginStrip() image -> [{ n, bbox }] in page coordinates. */
export const marginLabelsFromWords = (words, strip, H) => {
  const out = [];
  for (const w of words) {
    // "5."; "5.4" is "5." merged with the first letter of the text. Bare
    // digits are answer-sheet row numbers or noise, not labels.
    const m = /^(\d{1,3})\.\d?$/.exec(w.text.trim());
    if (!m) continue;
    const bbox = {
      x0: strip.x0 + (w.bbox.x0 - strip.pad) / 2, y0: strip.y0 + (w.bbox.y0 - strip.pad) / 2,
      x1: strip.x0 + (w.bbox.x1 - strip.pad) / 2, y1: strip.y0 + (w.bbox.y1 - strip.pad) / 2,
    };
    // Text-sized only: icons and rule fragments misread as digits are not.
    const h = bbox.y1 - bbox.y0;
    if (h < H * 0.005 || h > H * 0.03) continue;
    // Numbers start at the text edge; anything further in is a cut-off
    // piece of body text.
    if (bbox.x0 > strip.edge + H * 0.008) continue;
    out.push({ n: parseInt(m[1], 10), bbox });
  }
  return out;
};

/** Connected ink components (4-neighbour) inside a window: [{ x0, y0, x1, y1, n }]. */
const components = (map, x0, y0, x1, y1) => {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(map.width, Math.ceil(x1)); y1 = Math.min(map.height, Math.ceil(y1));
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return [];
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = [];
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const si = sy * w + sx;
      if (seen[si] || !map.ink[(y0 + sy) * map.width + x0 + sx]) continue;
      let bx0 = sx, by0 = sy, bx1 = sx, by1 = sy, n = 0;
      seen[si] = 1; stack.push(si);
      while (stack.length) {
        const i = stack.pop();
        const x = i % w, y = (i - x) / w;
        n++;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (seen[ni] || !map.ink[(y0 + ny) * map.width + x0 + nx]) continue;
          seen[ni] = 1; stack.push(ni);
        }
      }
      out.push({ x0: x0 + bx0, y0: y0 + by0, x1: x0 + bx1 + 1, y1: y0 + by1 + 1, n });
    }
  }
  return out;
};

/**
 * Shape-based option letters for strips where OCR found none (letters set
 * beside drawings): a capital-sized glyph with a ")" right after it. Returns
 * [{ letterBox, pairBox }] for the caller to read each letter with a
 * single-character OCR pass (A-E only). `capH` is the capital height, e.g.
 * the height of the page's question numbers.
 */
export const optionLetterCandidates = (map, strip, capH, textWords = []) => {
  const comps = components(map, strip.x0, strip.y0, strip.x1, strip.y1)
    .filter(c => c.y1 - c.y0 >= capH * 0.5 && c.y1 - c.y0 <= capH * 1.9);
  // Mean ink x over a band of a component's rows (fractions of its height).
  const meanX = (c, f0, f1) => {
    let sum = 0, n = 0;
    const ya = Math.floor(c.y0 + (c.y1 - c.y0) * f0), yb = Math.ceil(c.y0 + (c.y1 - c.y0) * f1);
    for (let y = ya; y < yb; y++) {
      for (let x = c.x0; x < c.x1; x++) if (map.ink[y * map.width + x]) { sum += x; n++; }
    }
    return n ? sum / n : NaN;
  };
  // ")" bulges right: its middle sits right of its ends. "(" is the mirror
  // ("A(2, 3)" point labels are not options).
  const closing = (c) => meanX(c, 0.4, 0.6) > (meanX(c, 0, 0.15) + meanX(c, 0.85, 1)) / 2 + (c.x1 - c.x0) * 0.1;
  // On text-layer pages, picture options have no text under them.
  const onText = (b) => textWords.some(w =>
    w.bbox.x0 < b.x1 && w.bbox.x1 > b.x0 && w.bbox.y0 < b.y1 && w.bbox.y1 > b.y0);
  const out = [];
  for (const letter of comps) {
    const lh = letter.y1 - letter.y0, lw = letter.x1 - letter.x0;
    // Capitals only: lowercase items ("a) b) c)") have shorter bodies.
    if (lh < capH * 0.8 || lh > capH * 1.25 || lw < capH * 0.4 || lw > capH * 1.3) continue;
    const paren = comps.find(c => {
      const ph = c.y1 - c.y0, pw = c.x1 - c.x0;
      return c !== letter && ph >= lh * 1.05 && ph <= lh * 1.7 && pw <= ph * 0.45 &&
        c.x0 >= letter.x1 - 1 && c.x0 - letter.x1 <= capH * 0.5 &&
        c.y0 <= letter.y0 + lh * 0.2 && c.y1 >= letter.y1 - lh * 0.1 && closing(c);
    });
    if (!paren) continue;
    // Nothing else may touch the pair from the left: option letters start a
    // cell ("A)"), text like "(K)" or "5A)" doesn't.
    const crowded = comps.some(c => c !== letter && c !== paren &&
      c.x1 > letter.x0 - capH * 0.35 && c.x1 <= letter.x0 + 1 &&
      c.y1 > letter.y0 && c.y0 < letter.y1);
    if (crowded) continue;
    if (onText({ x0: letter.x0, y0: letter.y0, x1: paren.x1, y1: letter.y1 })) continue;
    out.push({
      letterBox: { x0: letter.x0, y0: letter.y0, x1: letter.x1, y1: letter.y1 },
      pairBox: { x0: letter.x0, y0: Math.min(letter.y0, paren.y0), x1: paren.x1, y1: Math.max(letter.y1, paren.y1) },
    });
  }
  return out;
};

/** Read letters for optionLetterCandidates() -> pseudo text lines for findQuestions. */
export const optionLinesFromLetters = (candidates, letters) => candidates
  .map((c, i) => ({ c, t: (letters[i] ?? '').trim() }))
  .filter(({ t }) => /^[A-E]$/.test(t))
  .map(({ c, t }) => ({ text: `${t})`, bbox: c.pairBox, words: [{ text: `${t})`, conf: 90, bbox: c.pairBox }] }));

const optionLinesFor = (columnLines, extraOptionLines, col) =>
  extraOptionLines?.[col]?.length ? [...columnLines[col], ...extraOptionLines[col]] : columnLines[col];

/**
 * Label strips in which no option block was found: worth a second OCR pass
 * in sparse-text mode, which reads option letters scattered between
 * graphics (answer diagrams, tick grids) that line OCR turns into noise.
 * Returns [{ col, x0, y0, x1, y1 }] in analysis coordinates.
 */
export const optionlessStrips = (params) => labelStrips(params)
  .filter(s => !s.inSection)
  .filter(s => !findOptionBlock(optionLinesFor(params.columnLines, params.extraOptionLines, s.col), s.stripTop, s.stripBottom))
  .map(s => {
    const col = params.layout.columns[s.col];
    return { col: s.col, x0: col.x0, y0: s.stripTop, x1: col.x1, y1: s.stripBottom, labelH: (s.y1 ?? s.y0) - s.y0 };
  });

/**
 * Capital-letter height for optionLetterCandidates(), from the label heights
 * of optionlessStrips() results. Text-layer word boxes span the whole font
 * (ascender to descender), about 1.6x a capital; OCR boxes hug the glyphs.
 */
export const capHeightFromStrips = (strips, H, fromTextLayer) => {
  const hs = strips.map(s => s.labelH).filter(h => h > 0).sort((a, b) => a - b);
  if (!hs.length) return H * 0.0105;
  return hs[hs.length >> 1] * (fromTextLayer ? 0.62 : 1);
};

/**
 * Multiple-choice questions on a page: numbered labels at a column's left
 * margin whose strip contains an A)-E) option block. Every label (test or
 * not) bounds the strip of the one above it; only test questions are kept.
 *
 * `strictLabels` (PDF text layers) requires "N." exactly; OCR input also
 * accepts "N," since Tesseract often misreads the period. `pageLines` (all
 * text lines on the page, defaults to the columns') are scanned for section
 * headings. OCR input may add `marginLabels` (see labelStrips),
 * `extraOptionLines[col]` (sparse re-reads of optionless strips) and
 * `passageLines[col]` (instructions read from unreadBands()). Questions that
 * share a passage get a `contextBox` (see attachPassages).
 */
export const findQuestions = (params) => {
  const { map, layout, columnLines, extraOptionLines } = params;
  const W = map.width, H = map.height;
  const tests = [];
  const allLines = params.pageLines ?? columnLines.flat();
  for (const s of labelStrips(params)) {
    if (s.inSection) continue;
    // Statement lists (A) ... G)) may span both columns; F), G), H) anywhere
    // across the strip's band mark it as a written exercise.
    const high = new Set();
    for (const l of allLines) {
      const cy = (l.bbox.y0 + l.bbox.y1) / 2;
      if (cy < s.stripTop || cy >= s.stripBottom) continue;
      for (const m of l.text.matchAll(OPTION_RE)) if (m[1] > 'E') high.add(m[1]);
    }
    if (high.size >= 2) continue;
    const lines = optionLinesFor(columnLines, extraOptionLines, s.col);
    // Written-exam questions come in lettered parts, "a)", "b)", ..., set at
    // the number's margin; one of them may itself be multiple choice. (Mid-
    // column "a) Absorbsiyon" labels in a figure don't count.)
    const col = layout.columns[s.col];
    const parts = new Set();
    for (const l of lines) {
      const cy = (l.bbox.y0 + l.bbox.y1) / 2;
      const m = /^\s*([a-e])\)/.exec(l.text);
      if (m && cy >= s.stripTop && cy < s.stripBottom &&
        Math.abs(l.bbox.x0 - s.x0) < (col.x1 - col.x0) * 0.05) parts.add(m[1]);
    }
    if (parts.size >= 2) continue;
    const options = findOptionBlock(lines, s.stripTop, s.stripBottom);
    if (!options) continue;
    // A question has text between its number and its options; answer-sheet
    // rows ("18 Ⓐ Ⓑ Ⓒ Ⓓ Ⓔ") in scans put them on one line. (Text layers
    // don't need the guard, and some questions set options beside their
    // first statement.)
    if (!params.strictLabels && options.top <= s.y0 + H * 0.012) continue;
    tests.push({ ...s, options });
  }

  const gapRows = Math.round(H * 0.022);
  const regions = [];
  for (const q of filterSequence(tests)) {
    const col = layout.columns[q.col];
    const bodyX0 = q.labelRight + Math.round(W * 0.004);
    const rules = verticalRules(map, col.x0, q.stripTop, col.x1 + 1, q.options.bottom);
    // Margin strip: from the question's own label to just left of the option
    // letters (empty when options sit at the margin themselves).
    const optX0 = Number.isFinite(q.options.x0) ? q.options.x0 : bodyX0;
    const margin = { x0: q.x0 - W * 0.005, x1: Math.min(optX0, bodyX0) - W * 0.004, fromY: q.options.bottom };
    const endY = extendThroughInk(map, bodyX0, col.x1 + 1, q.options.lastTop, q.stripBottom, gapRows, rules, margin);
    const bounds = inkBounds(map, bodyX0, q.stripTop, col.x1 + 1, endY, rules);
    if (!bounds) continue;
    // Lines below the number line may start left of the number's right edge
    // (unindented poems, options at the margin); the box widens to keep them,
    // and the number itself is masked out instead of cropped out.
    const labelBottom = Math.max(q.y1 ?? q.y0, q.y0 + H * 0.008);
    const below = inkBounds(map, q.x0 - W * 0.004, labelBottom + 2, col.x1 + 1, endY, rules);
    let mask;
    if (below && below.x0 < bounds.x0) {
      bounds.x0 = below.x0;
      if (bounds.x0 < q.labelRight) {
        const p = H * 0.003;
        mask = {
          xmin: scale1000(q.x0 - p, W), ymin: scale1000(q.y0 - p, H),
          xmax: scale1000(q.labelRight + p, W), ymax: scale1000(labelBottom + p, H),
        };
      }
    }
    regions.push({
      questionNumber: String(q.n),
      box: {
        xmin: scale1000(bounds.x0, W),
        ymin: scale1000(Math.min(bounds.y0, q.y0), H),
        xmax: scale1000(bounds.x1, W),
        ymax: scale1000(bounds.y1, H),
      },
      ...(mask && { mask }),
      q: { col: q.col, y0: q.stripTop, y1: bounds.y1 },
    });
  }
  attachPassages(params, regions);
  return regions.map(({ q, ...r }) => r);
};

// ---------------------------------------------------------------------------
// Shared passages ("2. ve 3. soruları aşağıdaki metne göre cevaplayınız.")
// ---------------------------------------------------------------------------

// "2. ve 3.", "1. - 2.", "4 - 5.", "1 - 5.", "1, 2, 3, 4 ve 5." followed by
// "soru...": the questions that share the passage. A dash is a range.
const PASSAGE_NUMS_RE = /(\d{1,3})\s*[.,]?\s*((?:(?:ve|-|–|—|,)\s*\d{1,3}\s*[.,]?\s*)+)soru/i;
const PASSAGE_VERB_RE = /cevapla|yanıtla|yanitla|çözünüz|cozunuz/i;

const passageNumbers = (text) => {
  const m = PASSAGE_NUMS_RE.exec(text);
  if (!m) return null;
  const nums = [parseInt(m[1], 10)];
  for (const p of m[2].matchAll(/(ve|-|–|—|,)\s*(\d{1,3})/g)) {
    const n = parseInt(p[2], 10), last = nums[nums.length - 1];
    if (p[1] !== 've' && p[1] !== ',' && n > last && n - last <= 10) {
      for (let k = last + 1; k <= n; k++) nums.push(k);
    } else nums.push(n);
  }
  if (nums.length < 2 || nums.some((n, i) => i && n <= nums[i - 1])) return null;
  return nums;
};

/**
 * OCR pages: line-sized bands of ink inside a column that no OCR line
 * covers. Tesseract can skip text set in a shaded box, which is where
 * shared-passage instructions usually sit. Only wide bands (a line of text,
 * not a figure fragment) are returned: [{ col, x0, y0, x1, y1 }].
 */
export const unreadBands = (map, layout, columnLines) => {
  const W = map.width, H = map.height;
  const out = [];
  layout.columns.forEach((col, colIdx) => {
    const covered = new Uint8Array(H);
    for (const l of columnLines[colIdx]) {
      for (let y = Math.max(0, Math.floor(l.bbox.y0)); y < Math.min(H, Math.ceil(l.bbox.y1)); y++) covered[y] = 1;
    }
    const rules = verticalRules(map, col.x0, layout.contentTop, col.x1 + 1, layout.contentBottom);
    let start = -1, last = -1, minX = Infinity, maxX = -1;
    const flush = () => {
      const h = last - start + 1;
      if (start >= 0 && h >= H * 0.006 && h <= H * 0.045 && maxX - minX > (col.x1 - col.x0) * 0.4) {
        out.push({ col: colIdx, x0: col.x0, y0: Math.max(0, start - 4), x1: col.x1, y1: Math.min(H, last + 5) });
      }
      start = -1; minX = Infinity; maxX = -1;
    };
    for (let y = layout.contentTop; y < layout.contentBottom; y++) {
      let x0 = -1, x1 = -1;
      if (!covered[y]) {
        for (let x = col.x0, row = y * W; x <= col.x1; x++) {
          if (map.ink[row + x] && !rules.has(x)) { if (x0 < 0) x0 = x; x1 = x; }
        }
      }
      if (x0 >= 0) {
        if (start < 0) start = y;
        last = y; minX = Math.min(minX, x0); maxX = Math.max(maxX, x1);
      } else if (start >= 0 && y - last > 3) flush();
    }
    flush();
  });
  return out;
};

/**
 * OCR lines read from one unreadBands() band -> a single instruction line
 * when they name shared-passage questions, else null.
 */
export const instructionFromBand = (lines, band) => {
  const text = lines.map(l => l.text.trim()).join(' ');
  if (!passageNumbers(text) || !PASSAGE_VERB_RE.test(text)) return null;
  return { text, bbox: { x0: band.x0, y0: band.y0, x1: band.x1, y1: band.y1 }, words: [] };
};

/**
 * Instruction lines naming the questions that share a passage, and the
 * passage itself: the content between the instruction and the first of
 * those questions (down to the column's end when the questions start in the
 * next column), or, when nothing sits there, the content above the
 * instruction ("Yukarıdaki test özetini inceleyerek 6. ve 7. soruları
 * cevaplandırınız."). Wording ("aşağıdaki"/"yukarıdaki") isn't trusted:
 * books use both for either layout. Adds `contextBox` to those regions.
 */
const attachPassages = ({ map, layout, columnLines, passageLines }, regions) => {
  if (!regions.length) return;
  const W = map.width, H = map.height;
  const pad = Math.round(H * 0.004);
  columnLines.forEach((colLines, colIdx) => {
    const lines = passageLines?.[colIdx]?.length
      ? [...colLines, ...passageLines[colIdx]].sort((a, b) => a.bbox.y0 - b.bbox.y0)
      : colLines;
    const col = layout.columns[colIdx];
    lines.forEach((line, li) => {
      const nums = passageNumbers(line.text);
      if (!nums) return;
      const tail = line.text + ' ' + (lines[li + 1]?.text ?? '');
      if (!PASSAGE_VERB_RE.test(tail)) return;
      // The questions it names, after it in reading order.
      const after = (r) => r.q.col > colIdx || (r.q.col === colIdx && r.q.y0 >= line.bbox.y0);
      const targets = regions.filter(r => nums.includes(+r.questionNumber) && after(r));
      if (!targets.length) return;
      const first = [...targets].sort((a, b) => a.q.col - b.q.col || a.q.y0 - b.q.y0)[0];
      // The instruction's own text may wrap onto the next line.
      let instrBottom = line.bbox.y1;
      const next = lines[li + 1];
      if (next && !PASSAGE_VERB_RE.test(line.text) && PASSAGE_VERB_RE.test(next.text) &&
        next.bbox.y0 - line.bbox.y1 < (line.bbox.y1 - line.bbox.y0) * 1.2) instrBottom = next.bbox.y1;
      const x0 = col.x0, x1 = col.x1 + 1;
      // Skip the rest of the instruction box: its sides (vertical rules
      // beside the instruction text) don't count as ink, and a thin run
      // right below the text is its bottom border.
      const sides = verticalRules(map, x0, Math.round(line.bbox.y0), x1, Math.round(instrBottom), 0.9);
      const rowInk = (yy) => {
        for (let x = x0; x < x1; x++) if (map.ink[yy * W + x] && !sides.has(x)) return true;
        return false;
      };
      let y = Math.round(instrBottom) + 1;
      while (y < H && y < instrBottom + H * 0.004 && rowInk(y)) y++; // descenders
      let blank = y;
      while (blank < H && blank < y + H * 0.01 && !rowInk(blank)) blank++;
      let run = blank;
      while (run < H && rowInk(run)) run++;
      if (run - blank <= H * 0.004 && blank < y + H * 0.01) y = run;
      // Boxes whose sides don't line up with the text box are caught by
      // their bottom edge instead: a long unbroken horizontal run (text
      // never has one) just under the instruction with white space below
      // it. (A figure starting right away, a grid, has more ink below.)
      const longRun = (yy) => {
        let best = 0, cur = 0;
        for (let x = x0; x < x1; x++) { cur = map.ink[yy * W + x] ? cur + 1 : 0; if (cur > best) best = cur; }
        return best > (x1 - x0) * 0.25;
      };
      const clearBelow = (yy) => {
        for (let k = 1; k <= H * 0.004; k++) if (yy + k < H && rowInk(yy + k)) return false;
        return true;
      };
      for (let yy = Math.round((line.bbox.y0 + instrBottom) / 2); yy < Math.min(H, instrBottom + H * 0.02); yy++) {
        if (!longRun(yy)) continue;
        let end = yy;
        while (end + 1 < H && longRun(end + 1)) end++; // a border can be a few px thick
        if (clearBelow(end) && end + 1 > y) y = end + 1;
        yy = end;
      }
      // Passage below: up to the first question (same column) or column end.
      // (Any other question further down this column also ends it.)
      const below = first.q.col === colIdx ? first.q.y0 - pad : Math.min(layout.contentBottom,
        ...regions.filter(r => r.q.col === colIdx && r.q.y0 > line.bbox.y1).map(r => r.q.y0 - pad));
      const rules = verticalRules(map, col.x0, y, x1, Math.max(y + 1, below));
      let bounds = below - y > H * 0.02 ? inkBounds(map, x0, y, x1, below, rules) : null;
      if (!bounds || bounds.y1 - bounds.y0 < H * 0.02) {
        // Passage above: from the end of the previous question in this
        // column (or the column top) to the instruction.
        const prevEnd = Math.max(layout.contentTop, ...regions
          .filter(r => r.q.col === colIdx && r.q.y1 <= line.bbox.y0)
          .map(r => r.q.y1 + pad));
        const top = line.bbox.y0 - pad;
        if (top - prevEnd < H * 0.02) return;
        bounds = inkBounds(map, x0, prevEnd, x1, top, verticalRules(map, col.x0, prevEnd, x1, top));
        if (!bounds || bounds.y1 - bounds.y0 < H * 0.02) return;
      }
      const contextBox = {
        xmin: scale1000(bounds.x0, W), ymin: scale1000(bounds.y0, H),
        xmax: scale1000(bounds.x1, W), ymax: scale1000(bounds.y1, H),
      };
      for (const r of targets) r.contextBox = contextBox;
    });
  });
};

/**
 * Where the passage and the question go in a combined crop: passage on top,
 * question below a small gap, both left-aligned. Sizes in pixels.
 */
export const stackLayout = (ctx, q, gap) => ({
  width: Math.max(ctx.sw, q.sw),
  height: ctx.sh + gap + q.sh,
  ctxAt: { x: 0, y: 0 },
  qAt: { x: 0, y: ctx.sh + gap },
});

// ---------------------------------------------------------------------------
// Page metadata
// ---------------------------------------------------------------------------

const PAGE_LOOKALIKE = {
  O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', '|': '1', Z: '2',
  E: '3', A: '4', S: '5', s: '5', G: '6', g: '9', T: '7', B: '8',
};

/** Printed page number: the digit token nearest the footer's center. */
export const readPageNumber = (footerLines, W) => {
  // Seven-segment footer digits sometimes read as lookalike letters
  // ("91" -> "g1"); the centered footer token can only be the page number.
  let pageNumber, bestDist = Infinity;
  for (const line of footerLines) {
    for (const w of line.words) {
      const t = w.text.trim();
      if (w.conf < 40) continue;
      if (!/^[0-9OoDQIlZEASsGgTB|]{1,3}$/.test(t)) continue;
      const mapped = t.split('').map(ch => PAGE_LOOKALIKE[ch] ?? ch).join('');
      if (!/^\d{1,3}$/.test(mapped)) continue;
      const dist = Math.abs((w.bbox.x0 + w.bbox.x1) / 2 - W / 2);
      if (dist < W * 0.25 && dist < bestDist) { bestDist = dist; pageNumber = mapped; }
    }
  }
  return pageNumber;
};

/** "TEST 04" written out in the header text, if present. */
export const readTestNumber = (headerLines) => {
  for (const line of headerLines) {
    const m = /TEST[^0-9A-Za-z]{0,4}(\d{1,2})/i.exec(line.text);
    if (m) return m[1].padStart(2, '0');
  }
  return undefined;
};

const BADGE_LOOKALIKE = {
  O: '0', D: '0', Q: '0', I: '1', l: '1', '|': '1', Z: '2',
  E: '3', A: '4', S: '5', G: '6', T: '7', B: '8',
};

/**
 * Test number from OCR words of the corner badge ("TEST" above a
 * seven-segment number). Returns { testNumber, testWord }; testWord lets the
 * caller retry with a digits-only OCR pass below it when testNumber is unset.
 */
export const testNumberFromBadgeWords = (words) => {
  const testWord = words.find(w => /TEST/i.test(w.text));
  if (!testWord) return {};
  const digitWord = words.find(w =>
    w !== testWord && /^\d{1,2}$/.test(w.text.trim()) && w.bbox.y1 > testWord.bbox.y0);
  if (digitWord) return { testNumber: digitWord.text.trim().padStart(2, '0'), testWord };
  // Directly under a confident "TEST" only digits can occur, so map
  // lookalike letters ("01" -> "DI").
  const under = words.find(w =>
    w !== testWord && (w.confidence ?? w.conf) >= 50 &&
    w.bbox.y0 >= testWord.bbox.y1 - 10 &&
    w.bbox.x0 < testWord.bbox.x1 && w.bbox.x1 > testWord.bbox.x0 &&
    /^[0-9ODQIlZEASGTB|]{1,2}$/.test(w.text.trim()));
  if (under) {
    const mapped = under.text.trim().split('').map(ch => BADGE_LOOKALIKE[ch] ?? ch).join('');
    if (/^\d{1,2}$/.test(mapped)) return { testNumber: mapped.padStart(2, '0'), testWord };
  }
  return { testWord };
};

/** Section badge that names a group of pages on its own ("TARAMA - 1"). */
export const readSection = (headerLines) => {
  for (const line of headerLines) {
    const m = /TARAMA\s*[-–]?\s*(\d{1,2})/i.exec(line.text);
    if (m) return `TARAMA ${m[1]}`;
  }
  return undefined;
};

const upperTr = (s) => s.toLocaleUpperCase('tr');
// Whole words only: "SINIF" is boilerplate, "SINIFLANDIRMA" is a topic.
const BOILERPLATE = new Set(['SINIF', 'KİTABI', 'KİTAP', 'İZLEME', 'HAFTA', 'TARAMA', 'ÜNİTE', 'UNİTE', 'TEST']);
const isBoilerplate = (text) => upperTr(text).split(/[^\p{L}]+/u).some(w => BOILERPLATE.has(w));

/**
 * Topic printed in the page header (e.g. "Kütle Merkezi"). Filtering is per
 * word: decorative header patterns leak garbage tokens, OCR sometimes merges
 * the unit box into the same line, and subject banners repeat one word
 * ("BİYOLOJİ - BİYOLOJİ - BİYOLOJİ"), which is never a topic.
 */
export const readHeaderTopic = (headerLines, W) => {
  let topic, topicScore = 0;
  for (const line of headerLines) {
    const key = (w) => upperTr(w.text).replace(/[^\p{L}\p{N}]/gu, '');
    const counts = new Map();
    for (const w of line.words) counts.set(key(w), (counts.get(key(w)) || 0) + 1);
    // Boilerplate phrases ("TAM İZLEME KİTABI") are dropped as a whole: any
    // word set tight against a boilerplate word goes with it.
    const dropped = new Set(line.words.filter(w => isBoilerplate(w.text)));
    for (let grew = true; grew;) {
      grew = false;
      for (const w of line.words) {
        if (dropped.has(w)) continue;
        const gap = w.bbox.y1 - w.bbox.y0;
        for (const d of dropped) {
          const dx = Math.max(d.bbox.x0 - w.bbox.x1, w.bbox.x0 - d.bbox.x1);
          if (dx < gap * 1.2) { dropped.add(w); grew = true; break; }
        }
      }
    }
    const good = line.words.filter(w => {
      const cx = (w.bbox.x0 + w.bbox.x1) / 2;
      const t = w.text.trim();
      if (dropped.has(w)) return false;
      if (/^\d{1,2}[.,]?$/.test(t)) return false;
      if (counts.get(key(w)) > 1) return false;
      return w.conf >= 55 && cx > W * 0.22 && cx < W * 0.82 &&
        /[0-9a-zçğıöşü.,()-]{2,}/i.test(t);
    });
    const t = good.map(w => w.text).join(' ').trim();
    if (t.length < 3) continue;
    const score = good.reduce((s, w) => s + w.conf * w.text.length, 0);
    if (score > topicScore) { topicScore = score; topic = t; }
  }
  return topic;
};

/** "YAŞAM - YAŞAM - YAŞAM" -> "YAŞAM"; "- X -" -> "X". */
const undecorate = (text) => {
  const segs = text.split(/\s*[-–]\s*/).map(s => s.trim()).filter(Boolean);
  if (segs.length >= 2) {
    const counts = new Map();
    segs.forEach(s => counts.set(s, (counts.get(s) || 0) + 1));
    const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n >= 2) return top;
  }
  const m = /^\s*[-–]\s*(.+?)\s*[-–]\s*$/.exec(text);
  return (m ? m[1] : text).trim();
};

/**
 * The band just above a cover's student form, where the unit and topic lines
 * sit. Full-page OCR tends to drop the topic line (colored text among faded
 * repeats); an enlarged read of this band gets it.
 */
export const coverTopicBand = (formLine, W, H) => ({
  x0: 0, y0: Math.max(0, formLine.bbox.y0 - H * 0.13), x1: W, y1: formLine.bbox.y0,
});

/** Whether the page carries a student form ("Adı :"), i.e. is a unit cover. */
export const findFormLine = (lines) => lines
  .filter(l => /^\s*Ad[ıi]\s*:?(\s|$)/.test(l.text))
  .sort((a, b) => a.bbox.y0 - b.bbox.y0)[0];

/**
 * Topic on a unit cover page: the lowest all-caps line above the student
 * form, e.g. "- BİYOLOJİ BİLİMİ VE ÖNEMİ -" or "KARBOHİDRATLAR". Book and
 * unit titles sit higher up, so the lowest one is the topic.
 */
export const readCoverTopic = (lines) => {
  const form = findFormLine(lines);
  if (!form) return undefined;
  let best;
  for (const l of lines) {
    if (l.bbox.y1 > form.bbox.y0) continue;
    const text = l.text.trim();
    const letters = text.match(/\p{L}/gu) || [];
    if (letters.length < 3) continue;
    const upper = letters.filter(ch => ch === upperTr(ch) && ch !== ch.toLocaleLowerCase('tr')).length;
    if (upper / letters.length < 0.9) continue;
    if (isBoilerplate(text) || /YANITLAR|ÖĞRENC/.test(upperTr(text))) continue;
    if (!best || l.bbox.y0 > best.bbox.y0) best = l;
  }
  return best ? undecorate(best.text) : undefined;
};

/**
 * Topic per page for a run of pages from one document, in order: a section
 * badge ("TARAMA 1") names its pages; in a book with unit covers, pages take
 * the most recent cover's topic (headers there are running banners, and
 * OCR'd ones are noisy); otherwise the page's own header topic.
 * `pages` items: { section?, headerTopic?, coverTopic? }.
 */
export const resolveTopics = (pages) => {
  const hasCovers = pages.some(p => p.coverTopic);
  // A page between two pages of the same section (no cover in between)
  // belongs to it too: OCR sometimes misses the badge.
  const section = pages.map(p => p.section);
  for (let i = 0; i < pages.length; i++) {
    if (section[i] || pages[i].coverTopic) continue;
    let before, after;
    for (let j = i - 1; j >= 0 && !pages[j].coverTopic; j--) if (pages[j].section) { before = pages[j].section; break; }
    for (let j = i + 1; j < pages.length && !pages[j].coverTopic; j++) if (pages[j].section) { after = pages[j].section; break; }
    if (before && before === after) section[i] = before;
  }
  // Separate runs of pages can't be the same numbered section: when they
  // read alike (template text left under the printed badge, e.g. "TARAMA 1"
  // on every review block), number them in order from the first run's.
  const runs = [];
  for (let i = 0; i < pages.length; i++) {
    if (!section[i]) continue;
    if (i > 0 && section[i - 1]) runs[runs.length - 1].push(i);
    else runs.push([i]);
  }
  const labels = runs.map(r => section[r[0]]);
  const numbered = labels.map(l => /^TARAMA (\d+)$/.exec(l));
  if (numbered.every(Boolean) && new Set(labels).size < labels.length) {
    const first = parseInt(numbered[0][1], 10);
    runs.forEach((r, k) => r.forEach(i => { section[i] = `TARAMA ${first + k}`; }));
  }
  let carried;
  return pages.map((p, i) => {
    if (p.coverTopic) carried = p.coverTopic;
    if (section[i]) return section[i];
    return hasCovers ? (carried ?? p.headerTopic) : p.headerTopic;
  });
};

/**
 * Numbered page images ("Book_Sayfa_012.jpg") -> { key, index }: images with
 * the same key are pages of one book, in index order. Null for other names.
 */
export const imageSequence = (name) => {
  const m = /^(.*?)(\d{1,4})\.(?:jpe?g|png|webp)$/i.exec(name);
  return m ? { key: m[1], index: parseInt(m[2], 10) } : null;
};

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/** Filename-safe, lowercase, Turkish letters kept (İ->i, I->ı). */
export const sanitizeName = (str) => str
  .toLocaleLowerCase('tr')
  .replace(/â/g, 'a').replace(/î/g, 'i').replace(/û/g, 'u')
  .replace(/[^a-z0-9çğıöşü]/g, '_')
  .replace(/_+/g, '_')
  .replace(/^_|_$/g, '');

/**
 * Pixel rectangle of a crop (0-1000 box plus a little padding) on a W×H
 * page image. Padding is proportional, so the same box gives the same area
 * at any render resolution.
 */
export const cropRect = (box, W, H) => {
  const pX = W * 0.005, pY = H * 0.005, lP = W * 0.002;
  const sx = Math.round(Math.max(0, (box.xmin / 1000) * W - lP));
  const sy = Math.round(Math.max(0, (box.ymin / 1000) * H - pY));
  const sw = Math.round(Math.min(W - sx, ((box.xmax - box.xmin) / 1000) * W + lP + pX));
  const sh = Math.round(Math.min(H - sy, ((box.ymax - box.ymin) / 1000) * H + pY * 2));
  return { sx, sy, sw, sh };
};

/** The mask (0-1000 page box) inside a crop rectangle, or null if outside. */
export const maskRect = (mask, rect, W, H) => {
  if (!mask) return null;
  const x0 = Math.max(0, Math.round((mask.xmin / 1000) * W) - rect.sx);
  const y0 = Math.max(0, Math.round((mask.ymin / 1000) * H) - rect.sy);
  const x1 = Math.min(rect.sw, Math.round((mask.xmax / 1000) * W) - rect.sx);
  const y1 = Math.min(rect.sh, Math.round((mask.ymax / 1000) * H) - rect.sy);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
};

/** test04_kütle_merkezi_q1_33.jpg / karbohidratlar_q5_s104.jpg */
export const cropFileName = ({ testNumber, topic, questionNumber, pageLabel }) => {
  const parts = [];
  if (testNumber) parts.push(`test${sanitizeName(testNumber)}`);
  if (topic) parts.push(sanitizeName(topic));
  parts.push(`q${questionNumber}`);
  if (pageLabel) parts.push(pageLabel);
  return parts.filter(Boolean).join('_') + '.jpg';
};
