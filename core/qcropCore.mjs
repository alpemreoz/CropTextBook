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
export const detectLayout = (map, labelBoxes = [], opts = {}) => {
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

  // Profiles with `footerZone`: a footer starts in the bottom part of the
  // page; a "footer" reaching higher is the last block of questions on a
  // page without one (page number on a side tab).
  if (opts.footerZone && footerTop < H * opts.footerZone) footerTop = footerBottom + 1;

  const contentTop = headerBottom;
  const contentBottom = Math.min(footerTop, footerBottom) - 1;

  // Either a long vertical divider line or the widest low-ink valley near the
  // horizontal center of the content area.
  const colInk = colInkInRange(map, contentTop, contentBottom);
  // Profiles with `ignoreGutterLogo`: for finding the gutter, a column whose
  // ink sits in one short stretch of the page (a vertical publisher logo in
  // the gutter) counts as blank; text and question numbers run the page.
  const splitInk = opts.ignoreGutterLogo ? Int32Array.from(colInk) : colInk;
  if (opts.ignoreGutterLogo) {
    const span = H * 0.15, gap = H * 0.03;
    for (let x = Math.floor(W * 0.38); x <= Math.ceil(W * 0.62); x++) {
      let first = -1, last = -1, broken = false;
      for (let y = contentTop; y < contentBottom && !broken; y++) {
        if (!map.ink[y * W + x]) continue;
        if (first < 0) first = y;
        else if (y - last > gap) broken = true;
        last = y;
      }
      if (first >= 0 && !broken && last - first < span) splitInk[x] = 0;
    }
  }
  const contentH = contentBottom - contentTop;
  const lo = Math.floor(W * 0.38), hi = Math.ceil(W * 0.62);

  let splitX = findDivider(map, lo, hi, contentTop, contentBottom);
  if (splitX < 0) {
    for (let x = lo; x <= hi; x++) {
      if (splitInk[x] > contentH * 0.55) { splitX = x; break; }
    }
  }
  if (splitX < 0 && opts.leftmostGutter) {
    // Profiles: question numbers hang right of the gutter, and the gap
    // between them and their text can be as blank as the gutter itself
    // (or blanker, with a logo or pale rule in the gutter). The gutter is
    // the leftmost blank run, split at its middle.
    const win = Math.max(6, Math.round(W * 0.005));
    const scores = [];
    for (let x = lo; x <= hi - win; x++) {
      let s = 0;
      for (let k = 0; k < win; k++) s += splitInk[x + k];
      scores.push(s);
    }
    const min = Math.min(...scores);
    const blank = (i) => scores[i] <= min + Math.max(win * 2, min * 0.5);
    for (let i = 0; i < scores.length; i++) {
      if (!blank(i)) continue;
      let j = i;
      while (j + 1 < scores.length && blank(j + 1)) j++;
      splitX = lo + Math.round((i + j + win) / 2);
      break;
    }
  }
  if (splitX < 0) {
    let bestX = Math.round(W / 2), bestScore = Infinity;
    const win = Math.max(8, Math.round(W * 0.01));
    for (let x = lo; x <= hi - win; x++) {
      let s = 0;
      for (let k = 0; k < win; k++) s += splitInk[x + k];
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
  // Profiles with `trimEdgeText`: a thin band of ink at the page edge set
  // apart by a gap, running down the page without a break (vertical "TYT
  // MATEMATİK SORU BANKASI" spine text, a scan's shadow), isn't part of the
  // first or last column. A column of question numbers hanging left of
  // indented text is thin too, but its items have long gaps between them.
  if (opts.trimEdgeText) {
    const gapMin = W * 0.012, bandMax = W * 0.035;
    const continuous = (bx0, bx1) => {
      let best = 0, run = 0, blank = 0;
      for (let y = contentTop; y < contentBottom; y++) {
        let ink = false;
        for (let x = bx0; x < bx1 && !ink; x++) ink = map.ink[y * W + x] === 1;
        if (ink) { run += blank + 1; blank = 0; if (run > best) best = run; }
        else if (++blank > H * 0.02) { run = 0; blank = 0; }
      }
      return best >= H * 0.1;
    };
    // Scan borders and specks at the very edge go too: nothing printed
    // sits within 1% of the page edge.
    const trimmable = (bx0, bx1) => {
      if (Math.min(bx0, W - bx1) <= W * 0.01 && bx1 - bx0 <= W * 0.01) return true;
      let most = 0;
      for (let x = bx0; x < bx1; x++) most = Math.max(most, colInk[x]);
      return (Math.min(bx0, W - bx1) <= W * 0.01 && most < (contentBottom - contentTop) * 0.03) || continuous(bx0, bx1);
    };
    // A band ends where a real gap starts (single faint columns inside
    // letters don't split it).
    const blankRun = (x, dir) => { for (let k = 0; k < gapMin; k++) if (colInk[x + dir * k] > noise) return false; return true; };
    for (let k = 0; k < 3; k++) {
      let end = left;
      while (end < W * 0.25 && !(colInk[end] <= noise && blankRun(end, 1))) end++;
      let next = end;
      while (next < W * 0.25 && colInk[next] <= noise) next++;
      if (end - left <= bandMax && next - end >= gapMin && next < W * 0.25 && trimmable(left, end)) left = next; else break;
    }
    for (let k = 0; k < 3; k++) {
      let start = right;
      while (start > W * 0.75 && !(colInk[start] <= noise && blankRun(start, -1))) start--;
      let prev = start;
      while (prev > W * 0.75 && colInk[prev] <= noise) prev--;
      if (right - start <= bandMax && start - prev >= gapMin && prev > W * 0.75 && trimmable(start + 1, right + 1)) right = prev; else break;
    }
  }
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
 * Profiles with `mixedColumns`: a text layer's words tidied before the
 * layout. Invisible text goes (clipped away — a full periodic table behind
 * a picture showing three of its rows — or hidden on purpose), and so does
 * text outside the page's margins: side tabs ("DENE TESTİ - 3" set letter
 * by letter along the page edge) whose pieces could join a question
 * number's line. The left margin is where the leftmost question number
 * sits; the right one mirrors it. Options lettered in boxes without ")" (a
 * row of nothing but "A B C D", spread out) read as "A) B) C) D)".
 */
export const tidyTextWords = (words, W, map) => {
  if (map) {
    words = words.filter(w => {
      const x0 = Math.max(0, Math.floor(w.bbox.x0)), x1 = Math.min(map.width, Math.ceil(w.bbox.x1));
      const y0 = Math.max(0, Math.floor(w.bbox.y0)), y1 = Math.min(map.height, Math.ceil(w.bbox.y1));
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0, row = y * map.width; x < x1; x++) n += map.ink[row + x];
      return n >= Math.max(3, (x1 - x0) * (y1 - y0) * 0.01);
    });
  }
  // A question number stored as two pieces ("2" and ".") is one word.
  {
    const dots = words.filter(w => w.text === '.');
    if (dots.length) {
      const drop = new Set(), joined = new Map();
      for (const d of dots) {
        const h = d.bbox.y1 - d.bbox.y0;
        const p = words.find(o => /^\d{1,3}$/.test(o.text) && !joined.has(o) && Math.abs(o.bbox.y1 - d.bbox.y1) < h * 0.3 &&
          d.bbox.x0 - o.bbox.x1 < h * 0.15 && d.bbox.x0 >= o.bbox.x1 - 2);
        if (!p) continue;
        drop.add(d);
        joined.set(p, { ...p, text: `${p.text}.`, bbox: { ...p.bbox, x1: d.bbox.x1, y1: Math.max(p.bbox.y1, d.bbox.y1) } });
      }
      if (drop.size) words = words.filter(w => !drop.has(w)).map(w => joined.get(w) ?? w);
    }
  }
  const xs = labelBoxesFromWords(words).filter(b => b.x0 < W * 0.4).map(b => b.x0);
  if (xs.length) {
    const lm = Math.min(...xs);
    const rightEdge = Math.max(W * 0.9, W - lm + W * 0.02);
    words = words.filter(w => w.bbox.x0 > lm - W * 0.015 && w.bbox.x0 < rightEdge);
  }
  for (const line of groupLines(words)) {
    const ls = line.words.map(w => w.text);
    if (ls.length < 3 || ls.some((t, i) => t !== 'ABCDE'[i])) continue;
    if (line.bbox.x1 - line.bbox.x0 < W * 0.3) continue;
    const set = new Set(line.words);
    words = words.map(w => set.has(w) ? { ...w, text: `${w.text})` } : w);
  }
  return words;
};

/**
 * Profiles with `mixedColumns` (text layers): pages that mix full-width
 * questions and passages with two-column stretches. The page is cut into
 * horizontal bands. A question numbered at the left margin is full width
 * when no right-column number sits beside it and its text runs across the
 * gutter (or its options spread across it); a run of lines crossing the
 * gutter without a number is a full-width passage. Full-width bands get one
 * column spanning the page, the rest keep both columns. `columns` becomes
 * the list of cells in reading order, each with its own y0/y1.
 */
export const mixedColumns = (map, layout, words, marks = hiddenAnswerMarks(words)) => {
  const W = map.width, H = map.height;
  const [c0, c1] = layout.columns;
  const top = layout.contentTop;
  // The footer ("8. SINIF - Türkçe   120   SORU BANKASI", "KONU TESTİ") from
  // its text: decorative bands around it can hide it from the ink layout.
  // The lowest lines of the page holding a page number or set in capitals,
  // below 90% of the page height.
  let bottom = layout.contentBottom;
  {
    const footerLike = (r) => {
      const t = r.text.trim();
      const letters = (t.match(/\p{L}/gu) ?? []).length, caps = (t.match(/\p{Lu}/gu) ?? []).length;
      return !/^[A-E]\)/.test(t) && (/(^|\s)\d{1,3}(\s|$)/.test(t) || (letters >= 4 && caps / letters >= 0.6) ||
        /(^|\s)\p{Lu}{4,}(\s|$)/u.test(t));
    };
    const rows = groupLines(words).sort((a, b) => b.bbox.y0 - a.bbox.y0);
    let prevTop = null;
    const footerRows = [];
    // (A strip of the page's answers, "1-D 2-C 3-C …", is page furniture
    // however far above the footer it sits.)
    const answerStrip = (r) => (r.text.match(/\d{1,2}\s*-\s*[A-E](?![\p{L}])/gu) ?? []).length >= 3;
    for (const r of rows) {
      // (The footer is the bottom line and any line right above it; a
      // question's last options sit further up.)
      const ends = r.bbox.y0 < H * 0.88 || (r.bbox.y0 < H * 0.9 && !answerStrip(r)) ||
        (prevTop !== null && prevTop - r.bbox.y1 > H * 0.008 && !answerStrip(r)) || !footerLike(r);
      if (ends) {
        // Lines overlapping the content line above them are part of it
        // (the denominators of fractions in a last row of options).
        while (footerRows.length && footerRows[footerRows.length - 1].bbox.y0 < r.bbox.y1 - 2) footerRows.pop();
        break;
      }
      prevTop = r.bbox.y0;
      footerRows.push(r);
    }
    const footerTop = footerRows.length ? footerRows[footerRows.length - 1].bbox.y0 : null;
    if (footerTop !== null) {
      bottom = Math.min(bottom, Math.round(footerTop - H * 0.006));
      layout = { ...layout, contentBottom: bottom, footerTop: Math.min(layout.footerTop ?? footerTop, Math.round(footerTop)) };
    }
    // Decorations running from the last options down into the footer (corner
    // dot patterns, a per-page answer strip) hide the gap above the footer
    // from the ink layout, which then cuts the last line off. A line the
    // bottom cuts through, or an option line right below it, that isn't
    // footer text belongs to the content.
    // (Never into an answer strip's own ink: its frame can sit a few pixels
    // under the last line. Its top is the first blank row above the strip's
    // text, the gutter aside.)
    let footInk = Infinity;
    if (footerTop !== null && footerRows.some(answerStrip)) {
      const g = (c0.x1 + c1.x0) / 2;
      const inked = (yy) => { for (let x = c0.x0, row = yy * W; x <= c1.x1; x++) if (Math.abs(x - g) > W * 0.02 && map.ink[row + x]) return true; return false; };
      let yy = Math.round(footerTop) - 1;
      while (yy > footerTop - H * 0.02 && inked(yy)) yy--;
      if (yy > footerTop - H * 0.02) footInk = yy;
    }
    let grown = bottom;
    for (const r of rows.slice().reverse()) {
      if (r.bbox.y1 <= grown + 2 || r.bbox.y0 < top) continue;
      if (footerTop !== null && r.bbox.y1 > footerTop) break;
      const crosses = r.bbox.y0 < grown - 2;
      const optionBelow = /^[A-E]\)/.test(r.text.trim()) && r.bbox.y0 < grown + H * 0.03;
      if (!(crosses || optionBelow) || footerLike(r)) break;
      grown = Math.min(Math.round(r.bbox.y1 + H * 0.002), footInk);
    }
    if (grown > bottom) {
      bottom = grown;
      layout = { ...layout, contentBottom: bottom };
    }
    // A thin rule across the page just above the footer, below the last line
    // of text, ends the content: crops don't run down to it. (Thin: blank
    // rows close above and below it; a row of pictures is no rule. One
    // unbroken line, standing free: the bottom edges of framed pictures or
    // tables side by side aren't one, nor is a table's bottom border, its
    // sides rising from its ends.)
    const freeRule = (yy) => {
      let best = 0, start = 0, run = 0;
      for (let x = 0, row = yy * W; x < W; x++) { if (map.ink[row + x]) { if (++run > best) { best = run; start = x - run + 1; } } else run = 0; }
      if (best < W * 0.5) return false;
      for (const x0 of [start, start + best - 4]) {
        for (let y = yy - 8; y <= yy - 2; y++) for (let x = x0; x < x0 + 4; x++) if (map.ink[y * W + x]) return false;
      }
      return true;
    };
    if (footerTop !== null) {
      const lastText = Math.max(top, ...rows.filter(r => r.bbox.y1 <= bottom + 2 && r.bbox.y0 >= top).map(r => r.bbox.y1));
      for (let yy = Math.max(Math.ceil(lastText) + 2, Math.round(footerTop - H * 0.03)); yy < bottom; yy++) {
        if (map.rowInk[yy] < W * 0.5 || map.rowInk[yy - 3] > W * 0.05 || map.rowInk[yy + 3] > W * 0.05 || !freeRule(yy)) continue;
        bottom = yy - 2;
        layout = { ...layout, contentBottom: bottom };
        break;
      }
    }
  }
  const inContent = (b) => b.y0 >= top - 2 && b.y1 <= bottom + 2;
  // (A footer's "8. SINIF" is no question number.)
  // (Nor is a numbered entry of an options table, "1. D   1. Y": a single
  // letter after it, then a gap or the next entry. "3. K noktasından" is a
  // question.)
  const after = (b) => {
    const h = b.y1 - b.y0;
    return words.filter(o => o.bbox.x0 >= b.x1 - 1 && o.bbox.x0 - b.x1 < h * 1.5 &&
      o.bbox.y0 < b.y1 && o.bbox.y1 > b.y0).sort((p, q) => p.bbox.x0 - q.bbox.x0)[0];
  };
  const tableEntry = (b) => {
    const next = after(b);
    if (!next || !/^\p{L}$/u.test(next.text)) return false;
    const then = after(next.bbox);
    return !then || /^\d{1,3}\.$/.test(then.text);
  };
  // (Nor are the numbered captions of a picture panel, set smaller than the
  // page's option letters.)
  const optHs = words.filter(w => /^[A-E]\)$/.test(w.text)).map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
  const minLabelH = optHs.length >= 4 ? optHs[optHs.length >> 1] * 0.85 : 0;
  const labels = labelBoxesFromWords(words).filter(b => inContent(b) && b.y0 < H * 0.93 && !tableEntry(b) && b.y1 - b.y0 >= minLabelH);
  // (with their numbers)
  const numOf = new Map(words.filter(w => /^\d{1,3}\.$/.test(w.text)).map(w => [w.bbox, parseInt(w.text, 10)]));
  const tol = W * 0.012;
  const byY = (a, b) => a.y0 - b.y0;
  // The left margin is the page's: nothing numbered sits left of it, while
  // a numbered table can line up more numbers further in.
  const lxs = labels.filter(b => b.x0 < W * 0.4).map(b => b.x0);
  const lm = lxs.length ? Math.min(...lxs) : null;
  const maxLeft = Math.max(0, ...labels.filter(b => lm !== null && Math.abs(b.x0 - lm) < tol).map(b => numOf.get(b) ?? 0));
  // The right margin: where hidden answer marks sit (books that have them
  // put one at every question's margin), else where numbers line up that
  // continue the left column's (numbered captions, "2. Şekil", and lists
  // can line up too), then where most line up, then the leftmost.
  // (Marks only at the left margin: no right-column questions.)
  const allMarks = marks.filter(m => inContent(m.bbox));
  // (Only marks with a question number at their x: a question laid out
  // picture-left, text-right can put its mark mid-column.)
  const rightMarks = allMarks.filter(m => m.bbox.x0 > W * 0.4 && m.bbox.x0 < W * 0.7 &&
    labels.some(b => Math.abs(b.x0 - m.bbox.x0) < tol));
  let rm = null;
  if (rightMarks.length) rm = Math.min(...rightMarks.map(m => m.bbox.x0));
  else if (!allMarks.length) {
    const rs = labels.filter(b => b.x0 > W * 0.4 && b.x0 < W * 0.7);
    let best = null;
    for (const b of [...rs].sort((p, q) => p.x0 - q.x0)) {
      const same = rs.filter(o => Math.abs(o.x0 - b.x0) < tol);
      // (Fewer numbers that don't continue them: a numbered list inside a
      // right-column question restarts at 1.)
      const cont = same.filter(o => (numOf.get(o) ?? 0) > maxLeft).length;
      const score = [cont, cont - same.length, same.length];
      const k = best ? score.findIndex((v, i) => v !== best.score[i]) : -1;
      if (!best || (k >= 0 && score[k] > best.score[k])) best = { x: b.x0, score };
    }
    // With numbers on the left, the right column's continue them.
    rm = best && (best.score[0] > 0 || maxLeft === 0) ? best.x : null;
  }
  const left = lm === null ? [] : labels.filter(b => Math.abs(b.x0 - lm) < tol).sort(byY);
  const right = rm === null ? [] : labels.filter(b => Math.abs(b.x0 - rm) < tol).sort(byY);
  // With right-column numbers the gutter is just left of them (a picture
  // in the left column can pull the ink valley elsewhere).
  // Without right-column numbers the gutter is the page's middle (a side
  // tab or a picture can pull the ink valley elsewhere).
  let gc = lm !== null ? (lm + W - lm) / 2 : (c0.x1 + c1.x0) / 2;
  if (rm !== null) {
    gc = rm - W * 0.017;
    const cpad = Math.round(W * 0.006);
    layout = { ...layout, columns: [{ ...c0, x1: Math.round(gc) - cpad }, { ...c1, x0: Math.round(gc) + cpad }] };
  }
  // Cells stay within the text's margins: a side tab at the page edge
  // ("CHALLENGE! - 2") never joins a full-width crop.
  // (Ordinary horizontal words only: tabs and logos set rotated aren't the
  // text block.)
  // Lines of three words or more: a tab's few letters aren't one.
  // (Rows split where a wide gap separates columns or a stray mark.)
  const textLines = [];
  for (const l of groupLines(words.filter(w => inContent(w.bbox) && (w.bbox.x1 - w.bbox.x0) > (w.bbox.y1 - w.bbox.y0) * 0.8))) {
    const h = l.bbox.y1 - l.bbox.y0;
    let seg = null;
    const flush = () => { if (seg && seg.n >= 3) textLines.push({ bbox: seg.bbox }); };
    for (const w of l.words) {
      if (seg && w.bbox.x0 - seg.bbox.x1 <= h * 3) { seg.n++; seg.bbox = { ...seg.bbox, x1: w.bbox.x1 }; }
      else { flush(); seg = { n: 1, bbox: { ...w.bbox } }; }
    }
    flush();
  }
  // (The 5th widest line: a stray letter from a tab can stretch one or two.)
  const rights = textLines.map(l => l.bbox.x1).sort((a, b) => b - a);
  const textRight = rights[Math.min(4, rights.length - 1)] ?? 0;
  const xl = lm !== null ? Math.max(layout.columns[0].x0, Math.round(lm - W * 0.012)) : layout.columns[0].x0;
  // (On the right, as far from the edge as the question numbers are on the
  // left: figures can reach past the text.)
  const xr = lm !== null ? Math.min(layout.columns[1].x1, Math.round(Math.max(textRight + W * 0.01, W - lm + W * 0.02))) : layout.columns[1].x1;
  layout = { ...layout, columns: [{ ...layout.columns[0], x0: xl }, { ...layout.columns[1], x1: xr }] };
  const [k0, k1] = layout.columns;

  const lines = groupLines(words.filter(w => inContent(w.bbox)));
  const inkFilled = (xa, xb, b) => {
    let cols = 0;
    for (let x = Math.ceil(xa); x < xb; x++) {
      for (let y = Math.round(b.y0); y < b.y1; y++) if (map.ink[y * W + x]) { cols++; break; }
    }
    return xb - xa > 0 && cols >= (xb - xa) * 0.6;
  };
  // A line crosses the gutter when one run of words (ordinary word spacing,
  // ordinary height: no logo glyphs) reaches well past it on both sides.
  const crossing = (line) => {
    const hs = line.words.map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
    const mh = hs[hs.length >> 1];
    const ws = line.words.filter(w => Math.abs(w.bbox.y1 - w.bbox.y0 - mh) < mh * 0.35);
    let x0 = null, x1 = null;
    for (const w of ws) {
      // Across the gutter itself only an ordinary word space counts (a
      // left-column line ending at the gutter and a right-column caption
      // starting there aren't one line).
      const gap = w.bbox.x0 - (x1 ?? 0), atGutter = x1 !== null && x1 <= gc + 2 && w.bbox.x0 >= gc - 2;
      // A symbol-sized gap that ink fills (a symbol with no text, "√")
      // isn't one.
      if (x1 !== null && (gap > mh * 1.2 || (atGutter && gap > mh * 0.6)) && !(gap < mh * 1.6 && inkFilled(x1, w.bbox.x0, line.bbox))) {
        if (x0 < gc - W * 0.04 && x1 > gc + W * 0.04) return true;
        x0 = null;
      }
      if (x0 === null) x0 = w.bbox.x0;
      x1 = w.bbox.x1;
    }
    return x0 !== null && x0 < gc - W * 0.04 && x1 > gc + W * 0.04;
  };
  // Options of one question spread over both halves: letters running on in
  // order ("A) B) | C) D)"; two questions' options side by side repeat or
  // restart theirs) over a span wider than a column. (The second half's
  // letters can start at the page's middle or a little left of it.)
  const half = rm !== null ? rm - W * 0.03 : gc;
  const spread = (line) => {
    const ls = line.words.map(w => ({ m: /^\(?([A-E])\)/.exec(w.text), x: w.bbox.x0 })).filter(o => o.m);
    if (ls.length < 2) return false;
    const letters = ls.map(o => o.m[1]), xs = ls.map(o => o.x);
    // (Reaching the right half: three options across a wide left column
    // don't.)
    return Math.min(...xs) < half - W * 0.05 && Math.max(...xs) - Math.min(...xs) > W * 0.3 && Math.max(...xs) > half - W * 0.06 &&
      letters.every((l, i) => !i || l.charCodeAt(0) === letters[i - 1].charCodeAt(0) + 1);
  };
  // (Unless the right half's letters continue options running down the
  // right half just above: a right-column question's, printed beside the
  // left one's.)
  const rightContinues = (line) => {
    const first = line.words.find(w => w.bbox.x0 >= half && /^\(?[A-E]\)/.test(w.text));
    const c = first && /^\(?([A-E])\)/.exec(first.text)[1];
    if (!c || c === 'A') return false;
    const prev = new RegExp(`^\\(?${String.fromCharCode(c.charCodeAt(0) - 1)}\\)`);
    // (Two letters before them on the line: one run, "A) B) | C) D)".)
    if (line.words.filter(w => w.bbox.x0 < first.bbox.x0 && /^\(?[A-E]\)/.test(w.text)).length >= 2) return false;
    // (Set straight above it: a list of options running down the right
    // column, not another question's "A) | B)" grid.)
    return words.some(w => Math.abs(w.bbox.x0 - first.bbox.x0) < W * 0.02 && w.bbox.y1 <= line.bbox.y0 + 2 &&
      w.bbox.y0 > line.bbox.y0 - H * 0.15 && prev.test(w.text));
  };
  // Where a full-width question's ink ends: the first blank stretch after
  // its options (the gutter strip, where a vertical logo can sit, aside).
  // (The same gap that ends a question box: options set above their
  // pictures, "C) Milyon Ton" over a chart, can leave a line's height free.)
  const blankRows = Math.round(H * 0.022);
  const endAfter = (y, limit) => {
    let last = Math.round(y), blank = 0;
    for (let yy = Math.round(y); yy < limit; yy++) {
      let ink = false;
      for (let x = k0.x0, row = yy * W; x <= k1.x1 && !ink; x++) {
        if (Math.abs(x - gc) > W * 0.015 && map.ink[row + x]) ink = true;
      }
      if (ink) { last = yy; blank = 0; } else if (++blank >= blankRows) break;
    }
    return last + 1;
  };

  // Options set as pictures with their letters drawn too ("A)" shapes, no
  // text): a row of them over both halves, with nothing in the right half
  // between the question's number and that row (a right-column question
  // beside it would have its text there).
  const hs = [...left, ...right].map(b => b.y1 - b.y0).sort((a, b) => a - b);
  const capH = hs.length ? hs[hs.length >> 1] * 0.62 : H * 0.01;
  const pictureRow = (L, until) => {
    const cands = optionLetterCandidates(map, { x0: k0.x0, y0: L.y0, x1: k1.x1, y1: until }, capH, words);
    for (const c of cands) {
      const xs = cands.filter(o => Math.abs(o.letterBox.y0 - c.letterBox.y0) < capH).map(o => o.letterBox.x0);
      if (xs.length < 2 || Math.min(...xs) >= half || Math.max(...xs) <= half || Math.max(...xs) - Math.min(...xs) < W * 0.3) continue;
      let inkRows = 0;
      for (let y = Math.round(L.y1 + capH); y < c.letterBox.y0 - capH; y++) {
        for (let x = Math.round(half + W * 0.02), row = y * W; x < k1.x1; x++) if (map.ink[row + x]) { inkRows++; break; }
      }
      if (inkRows < H * 0.01) return true;
    }
    return false;
  };

  // A picture spanning the gutter: rows where ink fills most of a strip
  // around it (a logo or a dotted divider fills a small part of it).
  const pictureAcross = (ya, yb) => {
    const xa = Math.round(gc - W * 0.015), xb = Math.round(gc + W * 0.015);
    let rows = 0;
    for (let y = Math.round(ya); y < Math.round(yb); y++) {
      let n = 0;
      for (let x = xa, row = y * W; x < xb; x++) n += map.ink[row + x];
      if (n >= (xb - xa) * 0.6) rows++;
    }
    return rows >= H * 0.03;
  };

  const pad = Math.round(H * 0.004);
  const full = [];
  left.forEach((L, i) => {
    const next = left[i + 1]?.y0 ?? bottom;
    // A right-column number beside it: two columns. One further down ends
    // the stretch whose lines decide (numbered figure captions, "2. Şekil",
    // can look like right-column numbers too).
    if (right.some(R => Math.abs(R.y0 - L.y0) < H * 0.025)) return;
    const rightBelow = Math.min(next, ...right.filter(R => R.y0 > L.y0).map(R => R.y0));
    const own = lines.filter(l => l.bbox.y0 >= L.y0 - 2 && l.bbox.y0 < next);
    // Options already complete in the left half: a left-column question
    // (a line of its options can line up with the right column's next one).
    const leftOwn = groupLines(words.filter(w => inContent(w.bbox) && w.bbox.x1 < half && w.bbox.y0 >= L.y0 - 2 && w.bbox.y0 < rightBelow));
    const leftBlock = right.length && findOptionBlock(leftOwn, L.y0, rightBelow);
    const halfOptions = leftBlock && ['A', 'B', 'C', 'D'].every(c => leftOwn.some(l => new RegExp(`(?:^|\\s)${c}\\s?\\)`).test(l.text)));
    // A picture on the left and the question with its options on the right,
    // under the one number: options only in the right half, and no
    // right-column number above them that they could belong to.
    const prevLeft = (left[i - 1]?.y0 ?? top) - H * 0.025;
    const rightOwn = groupLines(words.filter(w => inContent(w.bbox) && w.bbox.x0 > half && w.bbox.y0 >= L.y0 - 2 && w.bbox.y0 < rightBelow));
    const rightBlock = !leftBlock && findOptionBlock(rightOwn, L.y0, rightBelow);
    // (A right-column question counts from its number down to the next
    // full-width band: it may have started beside an earlier left one.)
    const sideBySide = rightBlock && !right.some(R => R.y0 < rightBlock.top &&
      (R.y0 > prevLeft || !full.some(r => r.y0 > R.y0 && r.y0 < L.y0))) &&
      !findOptionBlock(leftOwn, L.y0, rightBelow);
    if (!sideBySide && !own.some(l => l.bbox.y0 < rightBelow && (crossing(l) || (!halfOptions && spread(l) && !rightContinues(l)))) &&
      !pictureRow(L, rightBelow) && !(right.length === 0 || !leftBlock ? pictureAcross(L.y0, Math.min(rightBelow, next)) : false)) return;
    const block = findOptionBlock(own, L.y0, next);
    const end = Math.min(rightBelow - pad, block ? Math.min(next - pad, endAfter(block.bottom, next)) : next - pad);
    full.push({ y0: L.y0 - pad, y1: end });
  });
  // Unnumbered full-width runs (a passage shared by the questions below),
  // with a passage instruction just above them.
  const inFull = (l) => full.some(r => l.bbox.y0 >= r.y0 && l.bbox.y1 <= r.y1 + pad);
  let run = null;
  const runs = [];
  for (const l of [...lines].sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
    if (inFull(l) || !crossing(l)) { if (run && l.bbox.y0 - run.y1 > H * 0.03) run = null; continue; }
    if (run && l.bbox.y0 - run.y1 <= H * 0.03) run.y1 = l.bbox.y1;
    else { run = { y0: l.bbox.y0, y1: l.bbox.y1 }; runs.push(run); }
  }
  for (const r of runs) {
    // (The instruction may sit in its own box a little above the passage.)
    const instr = lines.find(l => l.bbox.y1 <= r.y0 + 2 && r.y0 - l.bbox.y1 < H * 0.06 &&
      passageNumbers(l.text) && PASSAGE_VERB_RE.test(l.text));
    full.push({ y0: (instr ? instr.bbox.y0 : r.y0) - pad, y1: r.y1 + pad });
  }
  if (globalThis.__qdbg) console.log('DBG left', left.map(b => Math.round(b.y0)), 'right', right.map(b => Math.round(b.y0)), 'gc', Math.round(gc), 'full', JSON.stringify(full.map(r => [Math.round(r.y0), Math.round(r.y1)])));
  // Vertical logos ("4D Serisi ®" standing in the gutter or the margin):
  // a narrow, upright, isolated run of ink columns within a two-column
  // stretch of the page. Crops leave them out.
  // (Ordinary horizontal text only: a logo's letters stand upright, a
  // rotated tab's box is taller than a line.)
  const textXs = textLines.map(l => l.bbox);
  const textLeft = textXs.length ? Math.min(...textXs.map(b => b.x0)) : 0;
  const textRightEdge = textXs.length ? textRight : W;
  // Only in the gutter and the outer margins (narrow upright marks inside a
  // column are a figure's).
  // (The outer margins: left of the question numbers, right of where the
  // page's text would end opposite them.)
  const marginLeft = Math.min(textLeft, (lm ?? textLeft) - W * 0.005);
  const marginRight = Math.max(textRightEdge, W - (lm ?? W * 0.08) - W * 0.03);
  const inMargin = (x) => x < marginLeft || x > marginRight;
  const inZone = (x) => Math.abs(x - gc) <= W * 0.016 || inMargin(x);
  // (From the first question number down to the last line of text: a
  // header band and a band above the footer span every column.)
  const scanFrom = Math.round(Math.max(top, Math.min(...[...left, ...right].map(b => b.y0), bottom) - pad));
  const scanTo = Math.min(bottom, Math.max(scanFrom, ...words.filter(w => w.bbox.y1 < bottom).map(w => Math.ceil(w.bbox.y1))));
  const textWords = words.filter(w => /\p{L}{2,}/u.test(w.text) && (w.bbox.x1 - w.bbox.x0) > (w.bbox.y1 - w.bbox.y0) * 1.2);
  const logoColumns = (ya, yb, marginsOnly = false) => {
    // (Margins: a little past the band, a logo can stand across its edge.)
    const ext = marginsOnly ? H * 0.06 : 0;
    const from = Math.max(marginsOnly ? top : scanFrom, Math.round(ya - ext)), to = Math.min(scanTo, Math.round(yb + ext));
    const out = [];
    if (to - from < H * 0.05) return out;
    const colTop = new Int32Array(W).fill(-1), colBot = new Int32Array(W).fill(-1), colN = new Int32Array(W);
    for (let y = from; y < to; y++) {
      for (let x = 0, row = y * W; x < W; x++) {
        if (!map.ink[row + x]) continue;
        if (colTop[x] < 0) colTop[x] = y;
        colBot[x] = y;
        colN[x]++;
      }
    }
    // A divider line (a long column whose neighbours a few px away are not
    // long, solid or dotted) counts as empty: the logo can stand on it.
    const long = (x) => x >= 0 && x < W && colTop[x] >= 0 && colBot[x] - colTop[x] > (to - from) * 0.5;
    // (A line, not text: one of its columns inked along a good part of its
    // length, mostly outside words. Letters of lines one above the other,
    // or a letter under a picture, aren't one.)
    const bandWords = textWords.filter(t => t.bbox.y1 > from && t.bbox.y0 < to);
    const inWords = (x) => {
      let n = 0;
      for (const t of bandWords) {
        if (x < t.bbox.x0 || x > t.bbox.x1) continue;
        for (let y = Math.max(from, Math.floor(t.bbox.y0)); y < Math.min(to, Math.ceil(t.bbox.y1)); y++) n += map.ink[y * W + x];
      }
      return n;
    };
    const lineLike = (k) => colN[k] >= (colBot[k] - colTop[k]) * 0.25 && inWords(k) < colN[k] * 0.5;
    // (Up to 6 neighbouring long columns. A solid line, inked along nearly
    // all its length, takes the faint columns of its anti-aliased edges with
    // it, and a logo standing on it is one piece across it.)
    const rule = [], solid = new Set();
    for (let x = 0; x < W; x++) {
      if (!long(x) || long(x - 1)) continue;
      let x1 = x;
      while (long(x1 + 1)) x1++;
      if (x1 - x >= 6) continue;
      let line = false, isSolid = false;
      for (let k = x; k <= x1; k++) {
        if (lineLike(k)) line = true;
        if (colN[k] >= (colBot[k] - colTop[k]) * 0.9) isSolid = true;
      }
      if (!line) continue;
      const pad = isSolid ? 2 : 0;
      for (let k = Math.max(0, x - pad); k <= Math.min(W - 1, x1 + pad); k++) { rule.push(k); if (isSolid) solid.add(k); }
    }
    for (const x of rule) colTop[x] = -1;
    const zone = (x) => marginsOnly ? inMargin(x) : inZone(x);
    // (Divider lines in the gutter or a margin stay out of crops too.)
    for (const x of rule) if (zone(x)) out.push(x);
    // Runs of inked columns, bridging the divider's empty columns.
    const blankGap = Math.round(W * 0.006);
    const runs = [];
    for (let x = 0; x < W; x++) {
      if (colTop[x] < 0) continue;
      const r = runs[runs.length - 1];
      let bridged = r && x - r.x1 <= 3;
      if (r && !bridged) { bridged = true; for (let k = r.x1 + 1; k < x; k++) if (!solid.has(k)) { bridged = false; break; } }
      if (bridged) r.x1 = x; else runs.push({ x0: x, x1: x });
    }
    runs.forEach((r, i) => {
      const w = r.x1 - r.x0 + 1;
      let y0 = Infinity, y1 = -1;
      for (let k = r.x0; k <= r.x1; k++) if (colTop[k] >= 0) { y0 = Math.min(y0, colTop[k]); y1 = Math.max(y1, colBot[k]); }
      const h = y1 - y0 + 1;
      const isolated = (!runs[i - 1] || r.x0 - runs[i - 1].x1 > blankGap) && (!runs[i + 1] || runs[i + 1].x0 - r.x1 > blankGap);
      // (Letters of a word set in the text, "oluşturul-" reaching into the
      // margin, are no logo: a word wider than tall covers them. A logo's
      // own letters are set upright.)
      const inWord = textWords.some(t => t.bbox.x0 <= r.x1 && t.bbox.x1 >= r.x0 && t.bbox.y0 <= y1 && t.bbox.y1 >= y0);
      if (w <= W * 0.02 && h <= H * 0.15 && h >= w * 3 && isolated && !inWord && zone(r.x0) && zone(r.x1)) {
        for (let k = r.x0; k <= r.x1; k++) out.push(k);
      }
    });
    return out;
  };
  let ignoreX = [];
  if (!full.length) return { ...layout, ignoreX: [...new Set([...logoColumns(top, bottom), ...logoColumns(top, bottom, true)])] };

  full.sort(byY);
  const merged = [];
  for (const r of full) {
    const m = merged[merged.length - 1];
    if (m && r.y0 <= m.y1 + pad) m.y1 = Math.max(m.y1, r.y1); else merged.push({ ...r });
  }
  const columns = [];
  let y = top;
  const twoCol = (y0, y1) => {
    if (y1 - y0 <= H * 0.01) return;
    columns.push({ ...k0, y0, y1 }, { ...k1, y0, y1 });
    ignoreX.push(...logoColumns(y0, y1), ...logoColumns(y0, y1, true));
  };
  for (const r of merged) {
    twoCol(y, r.y0);
    columns.push({ x0: k0.x0, x1: k1.x1, y0: Math.max(top, r.y0), y1: Math.min(bottom, r.y1), full: true });
    ignoreX.push(...logoColumns(r.y0, r.y1, true));
    y = r.y1;
  }
  twoCol(y, bottom);
  return { ...layout, columns, ignoreX: [...new Set(ignoreX)] };
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
    // (Tabs become spaces: an item "\t\tDoğrula" keeps its word where it is.)
    const str = it.str.replace(/[\t\n\r]/g, ' ').replace(/[\u0000-\u001f]/g, '');
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
  // Blanks to fill ("______") and ordinary punctuation are neither good nor
  // bad: an English page full of answer lines is still real text.
  const chars = items.map(i => i.str).join('').replace(/[\s_?!’'"“”…%/]+/g, '');
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
      // (Not an option letter drawn over a picture's label: "B)" on "cam"
      // are two words that overlap, not pieces of one.)
      const overlapsLetter = prev && w.bbox.x0 < prev.bbox.x1 - 1 && (/^[A-E]\)/.test(w.text) || /^[A-E]\)$/.test(prev.text));
      if (prev && w.bbox.x0 - prev.bbox.x1 < h * 0.12 && !overlapsLetter) {
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
  // ("2.In my opinion": a period followed straight by a capital is a label
  // too; text layers can set the number that tight.)
  const labelRe = strictLabels ? /^\s*(\d{1,3})(\.)?(?:\s|$|(?<=\.)(?=\p{Lu}))/u : /^\s*(\d{1,3})\s*([.,])/;

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
    let stripBottom = (next && next.col === c.col) ? next.y0 - labelPad : (layout.columns[c.col].y1 ?? layout.contentBottom);
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
const columnTextEdge = (map, layout, colIdx, minCount = 3, strictGutter = false) => {
  const W = map.width, H = map.height;
  const [c0, c1] = layout.columns;
  const y0 = layout.contentTop, y1 = layout.contentBottom;
  const light = map.light ?? map.ink;
  const gutterRules = verticalRules(map, c0.x1, y0, c1.x0, y1, 0.2, light);
  const near = Math.round(H * 0.01);
  const fullWidth = new Uint8Array(H);
  for (let y = y0; y < y1; y++) {
    const row = y * map.width;
    // `strictGutter` (profiles): a full-width row fills the whole gutter;
    // vertical text set in the gutter ("ORİJİNAL YAYINLARI") doesn't.
    let hit = false;
    if (strictGutter) {
      hit = true;
      for (let x = c0.x1; x < c1.x0 && hit; x++) if (!light[row + x] && !gutterRules.has(x)) hit = false;
    } else {
      for (let x = c0.x1; x < c1.x0 && !hit; x++) hit = light[row + x] && !gutterRules.has(x);
    }
    if (hit) for (let k = Math.max(y0, y - near); k < Math.min(y1, y + near); k++) fullWidth[k] = 1;
  }
  const col = layout.columns[colIdx];
  const lo = Math.max(0, Math.round(col.x0 - W * 0.005));
  const hi = Math.round(col.x0 + (col.x1 - col.x0) * 0.3);
  const colRules = verticalRules(map, lo, y0, hi, y1, 0.2);
  // (`strictGutter` profiles: tall connected shapes — a divider line,
  // crooked or coloured, a banner — don't set the edge either.)
  const skip = new Uint8Array((hi - lo) * (y1 - y0));
  if (strictGutter) {
    for (const c of components(map, lo, y0, hi, y1)) {
      if (c.y1 - c.y0 <= H * 0.025) continue;
      for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) skip[(y - y0) * (hi - lo) + x - lo] = 1;
    }
  }
  const counts = new Int32Array(hi - lo);
  for (let y = y0; y < y1; y++) {
    if (fullWidth[y]) continue;
    const row = y * map.width;
    for (let x = lo; x < hi; x++) if (map.ink[row + x] && !colRules.has(x) && !skip[(y - y0) * (hi - lo) + x - lo]) counts[x - lo]++;
  }
  // (`strictGutter` profiles: the edge must be wider than a dotted or
  // crooked rule, which a few-pixel-wide column of ink can be.)
  const span = strictGutter ? Math.round(W * 0.0035) : 0;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] < minCount) continue;
    let wide = true;
    for (let k = 1; k <= span && wide; k++) wide = i + k < counts.length && counts[i + k] >= minCount;
    if (wide) return lo + i;
  }
  return col.x0;
};

/**
 * A column's number margin (the strip at its text edge where question
 * numbers sit) as a clean black-on-white image for a digits-only OCR pass:
 * numbers read alone are far more reliable than inside full lines. Vertical
 * rules (the column divider) are dropped and the strip is upscaled 2x with a
 * white border. Returns { x0, y0, pad, edge, width, height, gray } or null.
 */
export const marginStrip = (map, layout, columnLines, colIdx, opts = {}) => {
  const W = map.width;
  // (`dropTall` also means: a few-pixel horizontal rule doesn't set the edge.)
  const edge = columnTextEdge(map, layout, colIdx, opts.dropTall ? Math.round(map.height * 0.004) : 3, !!opts.dropTall);
  const x0 = Math.max(0, Math.round(edge - W * 0.004));
  const x1 = Math.min(W, Math.round(edge + W * 0.034));
  const y0 = layout.contentTop, y1 = layout.contentBottom;
  if (x1 - x0 < 8 || y1 - y0 < 8) return null;
  const rules = verticalRules(map, x0, y0, x1, y1, 0.2);
  // `dropTall`: connected shapes much taller than a line (a crooked scan's
  // divider, header banners, QR codes, figures) are left out; they derail
  // the OCR of the whole strip. Question numbers are text-sized.
  const tall = new Uint8Array((x1 - x0) * (y1 - y0));
  if (opts.dropTall) {
    for (const c of components(map, x0, y0, x1, y1)) {
      if (c.y1 - c.y0 <= map.height * 0.025) continue;
      for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) tall[(y - y0) * (x1 - x0) + x - x0] = 1;
    }
  }
  const pad = 16, sw = x1 - x0, sh = y1 - y0;
  const width = sw * 2 + pad * 2, height = sh * 2 + pad * 2;
  const gray = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < sh; y++) {
    const row = (y0 + y) * map.width;
    for (let x = 0; x < sw; x++) {
      if (!map.ink[row + x0 + x] || rules.has(x0 + x) || tall[y * sw + x]) continue;
      const o = (pad + y * 2) * width + pad + x * 2;
      gray[o] = gray[o + 1] = gray[o + width] = gray[o + width + 1] = 0;
    }
  }
  return { x0, y0, pad, edge, width, height, gray };
};

/**
 * Profiles with `headerFromLabels`: where content really starts when the
 * header band holds the first questions (pages without a banner). Margin
 * labels read from near the top of the page; the first one above the
 * detected content top moves it up.
 */
export const contentTopFromLabels = (layout, marginLabels, H) => {
  const ys = marginLabels.flat().map(m => m.bbox.y0);
  if (!ys.length) return layout.contentTop;
  const first = Math.min(...ys);
  return first < layout.contentTop ? Math.max(0, Math.round(first - H * 0.006)) : layout.contentTop;
};

/**
 * Text-sized blobs of a marginStrip() image (each a candidate question
 * number), as images to read one at a time: OCR of a whole strip can drop
 * a number it reads fine on its own. Profiles re-read the blobs the strip
 * read missed. -> [{ y0, y1, image: { width, height, data } }] (strip px).
 */
export const marginStripBlobs = (strip, H) => {
  const { width, height, gray } = strip;
  const minH = H * 0.005 * 2, maxH = H * 0.03 * 2, pad = 12;
  const out = [];
  let start = -1, last = -1;
  const flush = () => {
    if (start >= 0 && last - start + 1 >= minH && last - start + 1 <= maxH) {
      const y0 = Math.max(0, start - pad), y1 = Math.min(height, last + 1 + pad);
      const data = gray.slice(y0 * width, y1 * width);
      out.push({ y0, y1, image: { width, height: y1 - y0, data } });
    }
    start = -1;
  };
  for (let y = 0; y < height; y++) {
    let ink = false;
    for (let x = 0, row = y * width; x < width && !ink; x++) ink = gray[row + x] === 0;
    if (ink) { if (start < 0) start = y; last = y; } else if (start >= 0 && y - last > 8) flush();
  }
  flush();
  return out;
};

/** OCR words from a marginStrip() image -> [{ n, bbox }] in page coordinates. */
export const marginLabelsFromWords = (words, strip, H, opts = {}) => {
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
    // (Profiles allow more room: on crooked scans the measured edge can
    // land a little left of the numbers.)
    if (bbox.x0 > strip.edge + H * (opts.edgeTolerance ?? 0.008)) continue;
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
  // (The lower middle: a header badge's big number can be among them.)
  return hs[(hs.length - 1) >> 1] * (fromTextLayer ? 0.62 : 1);
};

/**
 * Multiple-choice questions on a page: numbered labels at a column's left
 * margin whose strip contains an A)-E) option block. Every label (test or
 * not) bounds the strip of the one above it; only test questions are kept.
 *
 * `strictLabels` (PDF text layers) requires "N." exactly; OCR input also
 * accepts "N," since Tesseract often misreads the period. `pageLines` (all
 * text lines on the page, defaults to the columns') are scanned for section
 * headings. `answerSheetGuard: false` (profiles) keeps one-line questions
 * whose options start right under the number. OCR input may add `marginLabels` (see labelStrips),
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
    if (!params.strictLabels && params.answerSheetGuard !== false && options.top <= s.y0 + H * 0.012) continue;
    tests.push({ ...s, options });
  }

  const gapRows = Math.round(H * 0.022);
  const regions = [];
  // `numberingRestarts` (profiles): numbering starts over under each
  // sub-heading of a learning page, so the sequence check runs per group:
  // a group ends where a number drops below the one before it.
  const inSequence = (ts) => {
    if (!params.numberingRestarts) return filterSequence(ts);
    const groups = [];
    for (const t of ts) {
      const g = groups[groups.length - 1];
      if (!g || t.n < g[g.length - 1].n) groups.push([t]); else g.push(t);
    }
    return groups.flatMap(filterSequence);
  };
  let sequence = inSequence(tests);
  // Mixed layouts (cells with their own y range): a two-column band may be
  // numbered across its rows (1 left, 2 right, 3 left) instead of down each
  // column; the reading order that keeps more questions wins.
  if (layout.columns.some(c => c.y0 !== undefined)) {
    const band = (t) => layout.columns[t.col].y0;
    // (Numbers side by side sit at about the same height.)
    const rows = [...tests].sort((a, b) => band(a) - band(b) ||
      (Math.abs(a.y0 - b.y0) < H * 0.01 ? a.col - b.col : a.y0 - b.y0));
    const alt = inSequence(rows);
    if (alt.length > sequence.length) sequence = alt;
    // Or down the left column and the full-width bands first, then the
    // right column (1 left, 2 full width below, 3 right beside 1).
    const right = (t) => layout.columns[t.col].x0 > W * 0.4;
    const down = inSequence([...tests].sort((a, b) => right(a) - right(b) || band(a) - band(b) || a.y0 - b.y0));
    if (down.length > sequence.length) sequence = down;
  }
  for (const q of sequence) {
    const col = layout.columns[q.col];
    const bodyX0 = q.labelRight + Math.round(W * 0.004);
    const rules = verticalRules(map, col.x0, q.stripTop, col.x1 + 1, q.options.bottom);
    for (const x of layout.ignoreX ?? []) rules.add(x);
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
    // The crop's left margin (see cropRect) can reach the number's edge.
    if (q.labelRight > bounds.x0 - W * 0.006) {
      const p = H * 0.003;
      mask = {
        xmin: scale1000(q.x0 - p, W), ymin: scale1000(q.y0 - p, H),
        xmax: scale1000(q.labelRight + p, W), ymax: scale1000(labelBottom + p, H),
      };
    }
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
// English books: "9 – 10: FOR THESE QUESTIONS, CHOOSE THE BEST OPTION
// ACCORDING TO THE PASSAGE BELOW."
const PASSAGE_NUMS_RE = /(\d{1,3})\s*[.,]?\s*((?:(?:ve|-|–|—|,)\s*\d{1,3}\s*[.,:]?\s*)+)(?:soru|for these question)/i;
const PASSAGE_VERB_RE = /cevapla|yanıtla|yanitla|çözünüz|cozunuz|according to|answer the/i;

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
const attachPassages = ({ map, layout, columnLines, passageLines, passageWithInstruction }, regions) => {
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
      // (From a full-width cell, everything down to the first question.)
      const below = first.q.col === colIdx ? first.q.y0 - pad : col.full ? first.q.y0 - pad : Math.min(col.y1 ?? layout.contentBottom,
        ...regions.filter(r => r.q.col === colIdx && r.q.y0 > line.bbox.y1).map(r => r.q.y0 - pad));
      const rules = verticalRules(map, col.x0, y, x1, Math.max(y + 1, below));
      for (const x of layout.ignoreX ?? []) rules.add(x);
      let bounds = below - y > H * 0.02 ? inkBounds(map, x0, y, x1, below, rules) : null;
      // Mixed layouts: an instruction ending its column with the questions
      // further down, under a full-width passage: the passage is whatever
      // spans the page between them.
      if ((!bounds || bounds.y1 - bounds.y0 < H * 0.02) && col.y0 !== undefined && first.q.col !== colIdx) {
        const wx0 = Math.min(...layout.columns.map(c => c.x0)), wx1 = Math.max(...layout.columns.map(c => c.x1)) + 1;
        const end = first.q.y0 - pad;
        if (end - y > H * 0.02) {
          const wide = verticalRules(map, wx0, y, wx1, end);
          for (const x of layout.ignoreX ?? []) wide.add(x);
          const b = inkBounds(map, wx0, y, wx1, end, wide);
          if (b && b.y1 - b.y0 >= H * 0.02) bounds = b;
        }
      }
      if (!bounds || bounds.y1 - bounds.y0 < H * 0.02) {
        // Passage above: from the end of the previous question in this
        // column (or the column top) to the instruction.
        const prevEnd = Math.max(col.y0 ?? layout.contentTop, ...regions
          .filter(r => r.q.col === colIdx && r.q.y1 <= line.bbox.y0)
          .map(r => r.q.y1 + pad));
        const top = line.bbox.y0 - pad;
        if (top - prevEnd < H * 0.02) return;
        const above = verticalRules(map, col.x0, prevEnd, x1, top);
        for (const x of layout.ignoreX ?? []) above.add(x);
        bounds = inkBounds(map, x0, prevEnd, x1, top, above);
        if (!bounds || bounds.y1 - bounds.y0 < H * 0.02) return;
      }
      // Profiles with `passageWithInstruction`: the instruction (and the
      // banner it's printed on) opens the passage crop.
      // (Only an instruction printed on a filled banner: a plain line of
      // instruction stays out, as in the books' other passages.)
      const onBanner = () => {
        let n = 0, all = 0;
        for (let yy = Math.round(line.bbox.y0); yy < Math.round(line.bbox.y1); yy++) {
          for (let xx = Math.round(line.bbox.x0); xx < Math.round(line.bbox.x1); xx += 2) { all++; n += (map.light ?? map.ink)[yy * W + xx]; }
        }
        return all > 0 && n / all > 0.4;
      };
      if (passageWithInstruction && bounds.y0 > line.bbox.y0 && onBanner()) {
        let ytop = Math.floor(line.bbox.y0);
        while (ytop > 0 && line.bbox.y0 - ytop < H * 0.03 && rowInk(ytop - 1)) ytop--;
        const lx0 = Math.min(x0, Math.floor(line.bbox.x0)), lx1 = Math.max(x1, Math.ceil(line.bbox.x1));
        const band = inkBounds(map, lx0, ytop, lx1, Math.ceil(instrBottom) + 2, new Set(layout.ignoreX ?? []));
        if (band) bounds = { x0: Math.min(bounds.x0, band.x0), y0: band.y0, x1: Math.max(bounds.x1, band.x1), y1: bounds.y1 };
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

/**
 * A page number set at the outer edge beside the book's title ("Biyoloji
 * Soru Bankası 25", "160 Biyoloji Soru Bankası"): the number that starts or
 * ends the one footer line with words in it (text layers).
 */
const sidePageNumber = (footerLines) => {
  const found = footerLines.flatMap(l => {
    const ws = l.text.trim().split(/\s+/);
    if (ws.filter(t => /^\p{L}{3,}$/u.test(t)).length < 2) return [];
    return [ws[0], ws[ws.length - 1]].filter(t => /^\d{1,3}$/.test(t));
  });
  return found.length === 1 ? found[0] : undefined;
};

/** "TEST 04" written out in the header text, if present. */
export const readTestNumber = (headerLines) => {
  for (const line of headerLines) {
    const m = /TEST[^0-9A-Za-z]{0,4}(\d{1,2})/i.exec(line.text);
    if (m) return m[1].padStart(2, '0');
  }
  return undefined;
};

/**
 * The page's own test, for books whose contents entries hold several
 * (profiles with `headerTest`): "TEST-1" -> "test 01"; a number heading the
 * page with one of the profile's words under it ("01" / "Pekiştir") ->
 * "pekiştir 01".
 */
export const readTestLabel = (headerLines, testWords = []) => {
  const n = readTestNumber(headerLines);
  if (n) return `test ${n}`;
  const firsts = headerLines.map(l => l.text.trim().split(/\s+/)[0] ?? '');
  const num = firsts.find(t => /^\d{1,2}$/.test(t));
  const word = firsts.find(t => testWords.some(w => lowerTr(w) === lowerTr(t)));
  return num && word ? `${word.toLocaleLowerCase('tr')} ${num.padStart(2, '0')}` : undefined;
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

/**
 * The week badge in a page header ("6. HAFTA", "14.HAFTA") -> "6". Only the
 * header counts: unit covers carry a stray hidden "1. HAFTA" mid-page.
 * Review pages (TARAMA, ARA TATİL, YARIYIL TATİLİ) have none.
 */
export const readWeek = (headerLines) => {
  for (const line of headerLines) {
    const m = /(\d{1,2})\s*[.,]?\s*HAFTA/i.exec(line.text);
    if (m && +m[1] > 0) return String(parseInt(m[1], 10));
  }
  return undefined;
};

/**
 * OCR pages: the header's week badge (light "10. HAFTA" in a dark box at the
 * right) as a clean black-on-white image of just its number, for a
 * digits-only read; general OCR misses most of these (light text on colour,
 * a heavy display font). `pixels` is the page at analysis size (1 or 4
 * channels); the badge is looked for above `bandBottom` (the header's end).
 * Returns { found, image, glyphs } — `found` when a badge box is there at all
 * (its number may still be unreadable), `image` = { width, height, data } or
 * null, `glyphs` the number's digit shapes (see GLYPH_W) for resolveWeeks.
 */
export const weekBadgeImage = (pixels, W, H, channels, bandBottom) => {
  const band = Math.round(Math.min(H * 0.12, Math.max(bandBottom, H * 0.05)));
  const lum = channels === 1
    ? (x, y) => pixels[y * W + x]
    : (x, y) => { const i = (y * W + x) * channels; return 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2]; };
  // The box: the widest run of mostly dark columns in the right half.
  const dark = (x, y) => lum(x, y) < 110;
  let bx0 = -1, bx1 = -1, start = -1;
  for (let x = Math.round(W * 0.5); x <= W; x++) {
    let n = 0;
    if (x < W) for (let y = 0; y < band; y++) if (dark(x, y)) n++;
    const on = x < W && n >= band * 0.3;
    if (on && start < 0) start = x;
    if (!on && start >= 0) { if (x - start > bx1 - bx0) { bx0 = start; bx1 = x; } start = -1; }
  }
  if (bx1 - bx0 < W * 0.03) return { found: false, image: null, glyphs: [] };
  let y0 = band, y1 = -1;
  for (let y = 0; y < band; y++) {
    let n = 0;
    for (let x = bx0; x < bx1; x++) if (dark(x, y)) n++;
    if (n >= (bx1 - bx0) * 0.5) { if (y < y0) y0 = y; y1 = y; }
  }
  if (y1 - y0 < H * 0.01) return { found: false, image: null, glyphs: [] };
  // Inside the box (its edge blends with the background): light text.
  const inset = Math.round((y1 - y0) * 0.12);
  const x0 = bx0 + inset, x1 = bx1 - inset, iy0 = y0 + inset, iy1 = y1 - inset;
  const lit = (x, y) => lum(x, y) > 170;
  const cols = [];
  let ty0 = iy1, ty1 = iy0;
  for (let x = x0; x < x1; x++) {
    let n = 0;
    for (let y = iy0; y < iy1; y++) if (lit(x, y)) { n++; if (y < ty0) ty0 = y; if (y > ty1) ty1 = y; }
    cols.push(n);
  }
  const first = cols.findIndex(n => n > 0);
  let last = cols.length - 1;
  while (last > 0 && cols[last] === 0) last--;
  if (first < 0 || ty1 <= ty0) return { found: true, image: null, glyphs: [] };
  // The number ends at the widest blank run: the space before "HAFTA".
  let gap = [0, 0];
  for (let i = first, run = 0; i <= last; i++) {
    if (cols[i] === 0) { run++; if (run > gap[1] - gap[0]) gap = [i - run + 1, i + 1]; } else run = 0;
  }
  const th = ty1 - ty0;
  // "32." is about two text heights wide; a word ("TARAMA") is far wider.
  if (gap[1] <= gap[0] || gap[0] - first > th * 3) return { found: true, image: null, glyphs: [] };
  const pad = Math.round(th * 0.3);
  const sx = x0 + first - pad, sy = ty0 - pad, sw = gap[0] - first + pad * 2, sh = th + pad * 2;
  // 4x upscale (bilinear), then text black on white with a white border.
  const S = 4, border = 30;
  const width = sw * S + border * 2, height = sh * S + border * 2;
  const data = new Uint8Array(width * height).fill(255);
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : lum(x, y));
  for (let oy = 0; oy < sh * S; oy++) {
    const fy = sy + (oy + 0.5) / S - 0.5, ya = Math.floor(fy), wy = fy - ya;
    for (let ox = 0; ox < sw * S; ox++) {
      const fx = sx + (ox + 0.5) / S - 0.5, xa = Math.floor(fx), wx = fx - xa;
      const v = (at(xa, ya) * (1 - wx) + at(xa + 1, ya) * wx) * (1 - wy) + (at(xa, ya + 1) * (1 - wx) + at(xa + 1, ya + 1) * wx) * wy;
      if (v > 170) data[(oy + border) * width + ox + border] = 0;
    }
  }
  // Digit shapes: connected light areas of the number taller than half the
  // text (the period is a separate, shorter one), left to right. Digits
  // that touch stay one shape and simply don't match later.
  const glyphs = [];
  const gx0 = x0 + first, gx1 = x0 + gap[0], gw = gx1 - gx0, gh = ty1 - ty0 + 1;
  const seen = new Uint8Array(gw * gh);
  const stack = [];
  for (let sy = 0; sy < gh; sy++) {
    for (let sx = 0; sx < gw; sx++) {
      if (seen[sy * gw + sx] || !lit(gx0 + sx, ty0 + sy)) continue;
      let cx0 = sx, cx1 = sx, cy0 = sy, cy1 = sy;
      seen[sy * gw + sx] = 1; stack.push(sy * gw + sx);
      while (stack.length) {
        const i = stack.pop(), x = i % gw, y = (i - x) / gw;
        if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y;
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh || seen[ny * gw + nx] || !lit(gx0 + nx, ty0 + ny)) continue;
          seen[ny * gw + nx] = 1; stack.push(ny * gw + nx);
        }
      }
      if (cy1 - cy0 >= th * 0.6) glyphs.push({ x: cx0, shape: glyphShape(lit, gx0 + cx0, ty0 + cy0, gx0 + cx1, ty0 + cy1) });
    }
  }
  glyphs.sort((a, b) => a.x - b.x);
  return { found: true, image: { width, height, data }, glyphs: glyphs.map(g => g.shape) };
};

const GLYPH_W = 10, GLYPH_H = 14;
/** A glyph as { aspect, bits } (lit samples on a GLYPH_W x GLYPH_H grid). */
const glyphShape = (lit, gx0, gy0, gx1, gy1) => {
  let bits = '';
  for (let gy = 0; gy < GLYPH_H; gy++) {
    for (let gx = 0; gx < GLYPH_W; gx++) {
      const x = Math.round(gx0 + (gx + 0.5) * (gx1 - gx0 + 1) / GLYPH_W - 0.5);
      const y = Math.round(gy0 + (gy + 0.5) * (gy1 - gy0 + 1) / GLYPH_H - 0.5);
      bits += lit(x, y) ? '1' : '0';
    }
  }
  return { aspect: (gx1 - gx0 + 1) / (gy1 - gy0 + 1), bits };
};

const glyphDistance = (a, b) => {
  let d = 0;
  for (let i = 0; i < a.bits.length; i++) if (a.bits[i] !== b.bits[i]) d++;
  return d / a.bits.length + Math.abs(a.aspect - b.aspect);
};

/**
 * Week numbers the OCR missed, read by shape: digit shapes from badges whose
 * number was read (one shape per digit) become this book's templates, and an
 * unread badge whose digits all match a template closely is read with them.
 * pages: [{ week, weekGlyphs }] -> [week | undefined] (only new reads).
 */
export const readWeeksByShape = (pages) => {
  let templates = [];
  for (const p of pages) {
    if (!p.week || !p.weekGlyphs || p.weekGlyphs.length !== p.week.length) continue;
    [...p.week].forEach((d, i) => templates.push({ d, g: p.weekGlyphs[i] }));
  }
  // A digit's odd one out (its period touched it in a blurry scan) is no
  // template: it must look like most others of that digit.
  templates = templates.filter((t, i) => {
    const same = templates.filter((u, j) => j !== i && u.d === t.d).map(u => glyphDistance(t.g, u.g)).sort((a, b) => a - b);
    return same.length < 2 || same[same.length >> 1] <= 0.3;
  });
  return pages.map(p => {
    if (p.week || !p.weekGlyphs?.length || !templates.length) return undefined;
    let out = '';
    for (const g of p.weekGlyphs) {
      // Nearest template per digit; the winner must be close and clear.
      const byDigit = new Map();
      for (const t of templates) {
        const d = glyphDistance(g, t.g);
        if (d < (byDigit.get(t.d) ?? Infinity)) byDigit.set(t.d, d);
      }
      const [best, second] = [...byDigit.entries()].sort((a, b) => a[1] - b[1]);
      if (!best || best[1] > 0.12 || (second && second[1] < best[1] + 0.04)) return undefined;
      out += best[0];
    }
    return +out >= 1 && +out <= 60 ? String(+out) : undefined;
  });
};

/** Digits read from weekBadgeImage() -> week number string, or undefined. */
export const weekFromBadgeText = (text) => {
  const m = /^\s*(\d{1,2})\s*\.?\s*$/.exec(text ?? '');
  return m && +m[1] >= 1 && +m[1] <= 60 ? String(+m[1]) : undefined;
};

/**
 * Weeks for the pages of one book, in page order. Every week starts with a
 * cover page, so pages from one cover to the next are one week: its number
 * is the majority of what the pages read (a stray "21. HAFTA" or an OCR
 * slip is outvoted). A block with no usable read between weeks w and w + 2
 * is w + 1; a review block sits between w and w + 1 and stays unnumbered.
 * Pages whose read is reliably absent (`weekUnsure` false: a text layer, or
 * no badge in a scan) never get one; section pages (TARAMA) neither.
 * Badges the OCR couldn't read are first read by shape (readWeeksByShape).
 * pages: [{ week, weekUnsure, weekGlyphs, isCover, section }] -> [week | undefined]
 */
export const resolveWeeks = (pages) => {
  const byShape = readWeeksByShape(pages);
  pages = pages.map((p, i) => (byShape[i] ? { ...p, week: byShape[i] } : p));
  const runs = [];
  let cur = null;
  pages.forEach((p, i) => {
    if (p.section) { cur = null; return; }
    if (p.isCover || !cur) { cur = { idx: [] }; runs.push(cur); }
    cur.idx.push(i);
  });
  for (const run of runs) {
    const counts = new Map();
    for (const i of run.idx) if (pages[i].week) counts.set(pages[i].week, (counts.get(pages[i].week) ?? 0) + 1);
    run.cands = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }
  // Majority first; a tie goes to the week that continues the previous one.
  let prev;
  for (const run of runs) {
    const [best, second] = run.cands;
    if (best) {
      const tied = run.cands.filter(c => c[1] === best[1]).map(c => c[0]);
      run.week = second && second[1] === best[1] && prev && tied.includes(String(+prev + 1)) ? String(+prev + 1) : best[0];
      run.votes = best[1];
      prev = run.week;
    }
  }
  // A block between weeks w and w + 2 is w + 1, whatever it read: no read,
  // or a misread ("5" for 15) that several of its pages agree on.
  const voted = runs.map(r => r.week);
  runs.forEach((run, k) => {
    const before = voted.slice(0, k).reverse().find(Boolean);
    const after = voted.slice(k + 1).find(Boolean);
    if (before && after && +after - +before === 2) run.week = String(+before + 1);
  });
  const out = new Array(pages.length).fill(undefined);
  for (const run of runs) {
    if (!run.week) continue;
    for (const i of run.idx) if (pages[i].week || pages[i].weekUnsure) out[i] = run.week;
  }
  return out;
};

// ---------------------------------------------------------------------------
// Printed answer keys ("1.C 2.B 3.D", "1-B 2-B") — profiles with `answerKey`
// ---------------------------------------------------------------------------

/** The band of the page holding the printed answers (analysis coordinates). */
export const answerKeyBand = (W, H, spec) => (spec?.band === 'top'
  ? { x0: 0, y0: Math.round(H * 0.02), x1: W, y1: Math.round(H * 0.14) }
  : { x0: 0, y0: Math.round(H * 0.88), x1: W, y1: H });

/** Printed answers from a text layer: the lines inside the answer band. */
export const answersFromText = (lines, band) => parseAnswerKey([lines
  .filter(l => l.bbox.y0 >= band.y0 && l.bbox.y1 <= band.y1).map(l => l.text).join('\n')]);

/**
 * Images of the answer band for OCR, one per pass: long horizontal and
 * vertical strokes (the capsule frames some books draw around the answers,
 * column rules) erased, then upscaled and thresholded. Small grey answer
 * text reads very differently per setting, so callers OCR each pass and
 * merge with parseAnswerKey. -> [{ width, height, data }] (1 channel).
 */
export const answerKeyImages = (pixels, W, H, channels, band, spec = {}) => {
  const bw = band.x1 - band.x0, bh = band.y1 - band.y0;
  const g = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = ((band.y0 + y) * W + band.x0 + x) * channels;
      g[y * bw + x] = channels === 1 ? pixels[i] : 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    }
  }
  const dark = (v) => v < 200;
  const hLen = Math.round(bw * 0.03), vLen = Math.round(bh * 0.25);
  for (let y = 0; y < bh; y++) {
    let run = 0;
    for (let x = 0; x <= bw; x++) {
      if (x < bw && dark(g[y * bw + x])) { run++; continue; }
      if (run > hLen) for (let k = x - run; k < x; k++) g[y * bw + k] = 255;
      run = 0;
    }
  }
  for (let x = 0; x < bw; x++) {
    let run = 0;
    for (let y = 0; y <= bh; y++) {
      if (y < bh && dark(g[y * bw + x])) { run++; continue; }
      if (run > vLen) for (let k = y - run; k < y; k++) g[k * bw + x] = 255;
      run = 0;
    }
  }
  // Keep only the answer line: the band also catches option lines and
  // figure labels above it ("12 . A", "86.B"). Answers sit on the last two
  // text lines of a bottom band (beside or above the page number), the
  // first two of a top band (beside or below the test title).
  const lines = [];
  for (let y = 0, start = -1, blank = 0; y <= bh; y++) {
    let ink = false;
    if (y < bh) for (let x = 0; x < bw && !ink; x++) ink = dark(g[y * bw + x]);
    if (ink) { if (start < 0) start = y; blank = 0; continue; }
    if (start >= 0 && (++blank > 3 || y === bh)) { lines.push([start, y - blank + 1]); start = -1; blank = 0; }
  }
  const textLines = lines.filter(([a, b]) => b - a >= 4);
  const keep = spec.band === 'top' ? textLines.slice(0, 2) : textLines.slice(-2);
  if (keep.length && spec.lines) {
    const top = Math.max(0, keep[0][0] - 4), bottom = Math.min(bh, keep[keep.length - 1][1] + 4);
    for (let y = 0; y < bh; y++) if (y < top || y >= bottom) g.fill(255, y * bw, (y + 1) * bw);
  }
  // Stretch contrast (grey print on a scanned page).
  let lo = 255, hi = 0;
  for (const v of g) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < g.length; i++) g[i] = Math.round(((g[i] - lo) * 255) / span);
  const pass = (up, thr) => {
    const width = bw * up, height = bh * up, data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const fy = (y + 0.5) / up - 0.5, ya = Math.max(0, Math.floor(fy)), yb = Math.min(bh - 1, ya + 1), wy = Math.max(0, fy - ya);
      for (let x = 0; x < width; x++) {
        const fx = (x + 0.5) / up - 0.5, xa = Math.max(0, Math.floor(fx)), xb = Math.min(bw - 1, xa + 1), wx = Math.max(0, fx - xa);
        const v = (g[ya * bw + xa] * (1 - wx) + g[ya * bw + xb] * wx) * (1 - wy) + (g[yb * bw + xa] * (1 - wx) + g[yb * bw + xb] * wx) * wy;
        data[y * width + x] = thr ? (v > thr ? 255 : 0) : Math.round(v);
      }
    }
    return { width, height, data };
  };
  return [pass(2, 170), pass(3, 170), pass(1, 0)];
};

/**
 * OCR texts of the answer-band passes -> [{ n, letter }] sorted by n: each
 * "N.X" / "N-X" / "N)X" reading counted once per pass, the most-read letter
 * winning for each number.
 */
export const parseAnswerKey = (texts) => {
  const votes = new Map();
  for (const t of texts) {
    const seen = new Set();
    for (const m of (t ?? '').matchAll(/(\d{1,2})\s*[.\-)]\s*([A-E])\b/g)) {
      const n = +m[1], key = `${n}${m[2]}`;
      if (n < 1 || n > MAX_QUESTION_NUMBER || seen.has(key)) continue;
      seen.add(key);
      const v = votes.get(n) ?? new Map();
      v.set(m[2], (v.get(m[2]) ?? 0) + 1);
      votes.set(n, v);
    }
  }
  const found = [...votes.entries()]
    .map(([n, v]) => ({ n, letter: [...v.entries()].sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => a.n - b.n);
  // A page's answers are consecutive numbers; one with no neighbour within
  // two is a misread (a figure label, "86.B" for "8.B").
  if (found.length <= 2) return found;
  return found.filter(a => found.some(b => b !== a && Math.abs(b.n - a.n) <= 2));
};

/**
 * A book's crops against its printed answers. Tests are found from the
 * crops: question numbers run up within a test and start over in the next
 * one. A test's answers may be printed on any of its pages (every page, its
 * last page, or its first), so each answer joins the test whose pages it
 * was read on — or the nearest test before it.
 * pages (book order): [{ page, questions: [n], answers: [{ n, letter }] }]
 * -> { tests: [{ pages: [p0, p1], questions, answered, missing, extra }],
 *      answerOf: (pageIndex, n) => letter | undefined }
 */
export const checkAnswers = (pages) => {
  const tests = [];
  let cur = null;
  pages.forEach((p, i) => {
    for (const n of [...p.questions].sort((a, b) => a - b)) {
      if (!cur || n <= cur.last) { cur = { first: i, lastPage: i, last: n, questions: [], answers: new Map() }; tests.push(cur); }
      cur.questions.push(n); cur.last = n; cur.lastPage = i;
    }
  });
  const testAt = (i) => {
    let best = null;
    for (const t of tests) {
      if (i >= t.first && i <= t.lastPage) return t;
      if (t.first <= i) best = t;
    }
    return best;
  };
  pages.forEach((p, i) => {
    for (const a of p.answers ?? []) {
      // Answers printed on a test's first page can belong to the questions
      // of a page further on, still inside the same numbering run.
      const t = testAt(i);
      if (t && !t.answers.has(a.n)) t.answers.set(a.n, a.letter);
    }
  });
  const out = tests.map(t => {
    const have = new Set(t.questions);
    const keys = [...t.answers.keys()].sort((a, b) => a - b);
    // Printed numbers run on without holes: within a run of answers (no gap
    // over two) a number OCR missed still counts as printed. A lone number
    // far from the rest is a stray read, unless it fits the questions found.
    const printed = new Set();
    const maxQ = Math.max(0, ...t.questions);
    for (let i = 0; i < keys.length;) {
      let j = i;
      while (j + 1 < keys.length && keys[j + 1] - keys[j] <= 2) j++;
      if (j > i) { for (let n = keys[i]; n <= keys[j]; n++) printed.add(n); }
      else if (keys[i] <= maxQ + 1) printed.add(keys[i]);
      i = j + 1;
    }
    // Tests start at 1: answers 3..12 mean 1 and 2 were printed too.
    const top = Math.max(0, ...printed);
    if (printed.size && Math.min(...printed) <= 3) for (let n = 1; n <= top; n++) printed.add(n);
    return {
      pages: [t.first, t.lastPage],
      questions: t.questions,
      answered: keys.length,
      missing: [...printed].filter(n => !have.has(n)).sort((a, b) => a - b),
      extra: top ? t.questions.filter(n => n > top) : [],
      answers: t.answers,
    };
  });
  const answerOf = (i, n) => {
    const t = tests.find(t => i >= t.first && i <= t.lastPage && t.questions.includes(n));
    return t ? t.answers.get(n) : undefined;
  };
  return { tests: out, answerOf };
};

/**
 * Tests in a book from its crops' question numbers (book order): numbers
 * run up within a test and start over in the next one. Pages without
 * questions join the test before them. -> test index per page (-1 before
 * the first test).
 */
export const testSegments = (questionsPerPage) => {
  const out = [];
  let idx = -1, last = Infinity;
  for (const qs of questionsPerPage) {
    const sorted = [...qs].sort((a, b) => a - b);
    if (sorted.length && sorted[0] <= last) idx++;
    if (sorted.length) last = sorted[sorted.length - 1];
    out.push(idx);
  }
  return out;
};

/**
 * A header line worth using as a topic, or undefined: mostly letters, at
 * least one real word, and not on the profile's ignore list (series
 * banners like "ÖSYM TARZI SORULAR", difficulty gauges). Scanned banners
 * otherwise OCR to junk like "EK. DD" or "KR > KC Vibe".
 */
export const plausibleTopic = (text, ignore = []) => {
  // OCR debris at either end ("> SAğ MUTLAK DEĞER Ce)") goes first: end
  // words must be real words of four letters or more.
  // A topic stops at the first number ("Çarpanlara Ayırma BÖLÜM 01 Test");
  // section words aren't part of it.
  const all = (text ?? '').replace(/\s+/g, ' ').trim().split(' ');
  const cut = all.findIndex(w => /\d/.test(w));
  const tokens = (cut >= 0 ? all.slice(0, cut) : all).filter(w => !/^(BÖLÜM|BOLUM|TEST|ÜNİTE|UNITE)$/i.test(w));
  const word = (w) => /^\p{L}{4,}$/u.test((w ?? '').replace(/[.,:;'’]+$/, ''));
  while (tokens.length && !word(tokens[0])) tokens.shift();
  while (tokens.length && !word(tokens[tokens.length - 1])) tokens.pop();
  const t = tokens.join(' ');
  if (!t) return undefined;
  // (Turkish-aware case folding: "ACİL" matches "acil".)
  const folded = t.toLocaleLowerCase('tr');
  if (ignore.some(re => new RegExp(re, 'i').test(folded))) return undefined;
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  const words = t.split(' ').filter(w => /^\p{L}{4,}$/u.test(w.replace(/[.,:;'’-]/g, '')));
  if (letters < 6 || letters / t.replace(/ /g, '').length < 0.85 || !words.length) return undefined;
  return t;
};

/** The most common non-empty value (first one on ties), or undefined. */
export const majority = (values) => {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best, n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
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
// Book contents: the table of contents and the answer key (text-layer books,
// profiles with `bookIndex`)
// ---------------------------------------------------------------------------

// "Doğrula - 1 : . ......... 10", "n Düşün - 2 (Olasılık) ...... 118"
// (Leader dots can come out as unknown glyphs, "���".)
const TOC_ENTRY_RE = /^(.*?)[\s.:…\uFFFD]*[.\uFFFD]{4,}[\s.:…\uFFFD]*(\d{1,3})$/u;
// "ÜNİTE 1 : ÇARPANLAR VE KATLAR" (contents), "1. ÜNİTE: ..." (answer key),
// "UNIT 5: THE INTERNET", "Ünite - 1 Sinir Sistemi", "1. ÜNİTE / BASINÇ".
// Matched on Turkish-lowercased text.
const UNIT_RE = /^(?:(\d{1,2})\s*\.\s*)?(ünite|unit)\s*(?:[-–]\s*)?(\d{1,2})?\s*(?:[-–:/]\s*|\s(?=\D)|$)(.*)$/u;
// For matching only: Turkish lowercase, with dotless ı folded (English text
// lowercased the Turkish way turns "UNIT" into "unıt").
const KEY_ANSWER_RE = /(\d{1,3})\s*-\s*([A-E])(?!\p{L})/gu;
const lowerTr = (s) => s.toLocaleLowerCase('tr').replace(/ı/g, 'i');

/**
 * A table-of-contents page -> its items in order, or null when the page
 * isn't one (fewer than four "name ..... page" lines):
 *   { kind: 'unit', unit, word, x }       "ÜNİTE 1 : ..." heading
 *   { kind: 'topic', text, x }            "n Çarpanlar ve Katlar" (bulleted, no page)
 *   { kind: 'test', name, paren, page, bullet, x }
 * x is the line's left edge as a fraction of the page width.
 */
export const readContentsPage = (lines, W) => {
  // Rows are cut where a wide gap separates columns, and the columns are
  // read one after another (two-column contents pages). A page number set
  // far right of its name (no leader dots) joins it.
  const pieces = [];
  for (const l of lines) {
    const runs = [];
    for (const w of [...(l.words ?? [])].sort((a, b) => a.bbox.x0 - b.bbox.x0)) {
      const r = runs[runs.length - 1];
      // (An entry ends at its page number after the leader dots, even when
      // the dots run up to the next column.)
      const ended = r && r.length >= 2 && /^\d{1,3}$/.test(r[r.length - 1].text) && /[.\uFFFD…]{3,}$/u.test(r[r.length - 2].text);
      if (r && !ended && w.bbox.x0 - r[r.length - 1].bbox.x1 <= W * 0.04) r.push(w); else runs.push([w]);
    }
    if (!runs.length) { pieces.push({ ...l, col: 0 }); continue; }
    const joined = [];
    for (const r of runs) {
      const prev = joined[joined.length - 1];
      if (prev && r.length === 1 && /^\d{1,3}$/.test(r[0].text)) { prev.words.push({ ...r[0], text: `.... ${r[0].text}` }); continue; }
      joined.push({ words: [...r] });
    }
    for (const j of joined) {
      const g = groupLines(j.words)[0];
      pieces.push({ ...g, col: g.bbox.x0 >= W * 0.45 ? 1 : 0 });
    }
  }
  // (A page number alone on its row, right of the middle, isn't a column.)
  const worded = pieces.filter(p => /\p{L}/u.test(p.text));
  const twoCols = worded.some(p => p.col === 1) && worded.some(p => p.col === 0);
  const sorted = pieces.sort((a, b) => (twoCols ? a.col - b.col : 0) || a.bbox.y0 - b.bbox.y0);
  const clean = (l) => l.text.replace(/\s+/g, ' ').trim();
  // (Entries without leader dots only on a page titled as contents: any
  // page has lines ending in a number far right.)
  const leadered = lines.filter(l => TOC_ENTRY_RE.test(clean(l))).length;
  const titled = lines.some(l => /^(içindekiler|contents)$/.test(lowerTr(clean(l))));
  // (Or on a page that is mostly entries and unit headings: a contents
  // page continued without its title.)
  const entries = sorted.filter(l => TOC_ENTRY_RE.test(clean(l))).length;
  const units = sorted.filter(l => { const u = UNIT_RE.exec(lowerTr(clean(l))); return u && (u[1] || u[3]); }).length;
  const mostly = units > 0 && entries + units >= sorted.filter(l => /\p{L}/u.test(l.text)).length * 0.8;
  if (leadered < 4 && !((titled || mostly) && entries >= 4)) return null;
  const items = [];
  let pending = null, lastText = null;
  for (const l of sorted) {
    const text = clean(l), x = l.bbox.x0 / W;
    const unmatched = lastText;
    lastText = null;
    const u = UNIT_RE.exec(lowerTr(text));
    if (u && (u[1] || u[3]) && !TOC_ENTRY_RE.test(text)) {
      items.push({ kind: 'unit', unit: +(u[1] ?? u[3]), word: u[2], x });
      pending = null;
      continue;
    }
    // An entry can wrap: "n Düşün - 6 (Doğrusal Denklemler -" / "Eşitsizlikler) ..... 182".
    const full = pending ? `${pending.text} ${text}` : text;
    const m = TOC_ENTRY_RE.exec(full);
    if (m) {
      // The bullet is a dingbat that comes out as "n".
      let name = m[1].replace(/^n\s+/, '').replace(/[\s.:]+$/, '');
      let paren;
      const pm = /^(.*?)\s*\(([^)]*)\)?$/.exec(name);
      if (pm) { name = pm[1].trim(); paren = pm[2].replace(/\s*-\s*$/, '').trim(); }
      items.push({ kind: 'test', name, paren, page: +m[2], bullet: /^n\s/.test(full), x: pending ? pending.x : x });
      pending = null;
    } else if (/^(?:\.{4} )?\d{1,3}$/.test(text) && unmatched) {
      // An entry whose name wraps around its page number ("Basıncın Günlük
      // Yaşam ve Teknolojideki" / "83" / "Uygulamaları").
      items.push({ kind: 'test', name: unmatched.text, page: +text.replace(/\D/g, ''), bullet: false, x: unmatched.x });
      pending = null;
    } else if (/\([^)]*$/.test(full)) {
      pending = { text: full, x: pending ? pending.x : x };
    } else if (/^n\s+\S/.test(text)) {
      items.push({ kind: 'topic', text: text.replace(/^n\s+/, ''), x });
      pending = null;
    } else {
      // A topic wrapping onto a second line ("n Hz. Muhammed’in (s.a.v.)
      // Doğruluğu ve" / "Güvenilirliği").
      const prev = items[items.length - 1];
      if (prev?.kind === 'topic' && !prev.wrapped) { prev.text = `${prev.text} ${text}`.replace(/\s+-\s+(?=\S)/, ' - '); prev.wrapped = true; }
      else lastText = { text, x };
      pending = null;
    }
  }
  return items;
};

/**
 * An answer-key page ("CEVAP ANAHTARI" / "ANSWER KEY") -> its items in
 * order, or null: { kind: 'unit', unit } headings and
 * { kind: 'test', name, answers: Map(n -> letter) } rows ("Doğrula Testi - 1
 * 1-D 2-C ..."; a row of answers alone continues the test above).
 */
export const readAnswerKeyPage = (lines, W) => {
  const sorted = [...lines].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
  // The title may be set in pieces ("CEVAP" / "ANAHTARI" on lines of their own).
  const raw = sorted.map(l => l.text).join(' '), all = lowerTr(raw);
  const titled = /cevap|answer/.test(all) && /anahtar|key/.test(all);
  const pairs = (raw.match(KEY_ANSWER_RE) ?? []).length;
  if (!titled && pairs < 30) return null;
  // (Answers set as grids of numbers and letters instead of "1-D 2-C".)
  if (pairs < 5 && W) return readAnswerGrid(lines, W);
  const items = [];
  let cur = null;
  for (const l of sorted) {
    const text = l.text.replace(/\s+/g, ' ').trim();
    const u = UNIT_RE.exec(lowerTr(text));
    if (u && (u[1] || u[3])) { items.push({ kind: 'unit', unit: +(u[1] ?? u[3]) }); cur = null; continue; }
    const tokens = text.replace(KEY_ANSWER_RE, ' $1-$2 ').trim().split(/\s+/);
    let name = [];
    for (const t of tokens) {
      const a = /^(\d{1,3})-([A-E])$/.exec(t);
      if (!a) { name.push(t); continue; }
      if (name.length) { cur = { kind: 'test', name: name.join(' '), answers: new Map() }; items.push(cur); name = []; }
      if (cur) cur.answers.set(+a[1], a[2]);
    }
  }
  return items.filter(it => it.kind === 'unit' || it.answers.size);
};

/**
 * An answer key set as grids (Yeniyorum): a test's name ("Pekiştir 1"),
 * the question numbers in a row beside it, a little higher, and the letters
 * in a row under them; two columns of these, read one after the other.
 * -> items as readAnswerKeyPage's, or null when there are none.
 */
const readAnswerGrid = (lines, W) => {
  const words = lines.flatMap(l => l.words ?? []);
  const items = [];
  // (Unit headings of both columns can share a row: rows are cut at wide gaps.)
  for (const l of lines) {
    const runs = [];
    for (const w of [...(l.words ?? [])].sort((a, b) => a.bbox.x0 - b.bbox.x0)) {
      const r = runs[runs.length - 1];
      if (r && w.bbox.x0 - r[r.length - 1].bbox.x1 <= W * 0.04) r.push(w); else runs.push([w]);
    }
    for (const r of runs) {
      const u = UNIT_RE.exec(lowerTr(r.map(w => w.text).join(' ')));
      if (u && (u[1] || u[3])) items.push({ kind: 'unit', unit: +(u[1] ?? u[3]), x: r[0].bbox.x0, y: r[0].bbox.y0 });
    }
  }
  for (const L of words) {
    if (!/^\p{L}{3,}$/u.test(L.text)) continue;
    const h = L.bbox.y1 - L.bbox.y0;
    const N = words.find(w => /^\d{1,2}$/.test(w.text) && w.bbox.x0 > L.bbox.x1 && w.bbox.x0 - L.bbox.x1 < h * 1.2 &&
      Math.abs(w.bbox.y0 - L.bbox.y0) < h * 0.3);
    if (!N) continue;
    const xa = N.bbox.x1 + h, xb = N.bbox.x1 + W * 0.35;
    const inRow = (w, ya, yb) => w.bbox.x0 > xa && w.bbox.x0 < xb && (w.bbox.y0 + w.bbox.y1) / 2 > ya && (w.bbox.y0 + w.bbox.y1) / 2 < yb;
    const nums = words.filter(w => /^\d{1,2}$/.test(w.text) && inRow(w, L.bbox.y0 - h * 1.2, L.bbox.y0 + h * 0.3));
    if (nums.length < 4) continue;
    const answers = new Map();
    for (const a of words.filter(w => /^[A-E]$/.test(w.text) && inRow(w, L.bbox.y0 + h * 0.2, L.bbox.y1 + h * 1.2))) {
      const cx = (a.bbox.x0 + a.bbox.x1) / 2;
      const n = nums.reduce((best, w) => Math.abs((w.bbox.x0 + w.bbox.x1) / 2 - cx) < Math.abs((best.bbox.x0 + best.bbox.x1) / 2 - cx) ? w : best);
      if (Math.abs((n.bbox.x0 + n.bbox.x1) / 2 - cx) < h) answers.set(+n.text, a.text);
    }
    if (answers.size) items.push({ kind: 'test', name: `${L.text} ${N.text}`, answers, x: L.bbox.x0, y: L.bbox.y0 });
  }
  if (!items.some(it => it.kind === 'test')) return null;
  const col = (it) => (it.x < W * 0.45 ? 0 : 1);
  return items.sort((a, b) => col(a) - col(b) || a.y - b.y).map(({ x, y, ...it }) => it);
};

/** "Doğrula Testi - 1" and "Doğrula - 1" -> "doğrula1". */
const testKey = (name) => lowerTr(name).replace(/testi?/g, '').replace(/[^\p{L}\p{N}]/gu, '');

/**
 * What bookContents() needs from one page of a text-layer book: its
 * contents items, answer-key items, printed page number, and whether a
 * question 1 starts on it. Small enough to keep per page in the web app.
 */
export const contentsPageInfo = (lines, W, H) => ({
  toc: readContentsPage(lines, W),
  key: readAnswerKeyPage(lines, W),
  printed: readPageNumber(lines.filter(l => l.bbox.y0 > H * 0.92), W) ?? sidePageNumber(lines.filter(l => l.bbox.y0 > H * 0.92)),
  head: lines.filter(l => l.bbox.y1 < H * 0.12).map(l => l.text).join(' ').slice(0, 300),
  startsTest: lines.some(l => /^1\.(\s|$)/.test(l.text.trim()) && l.bbox.x0 < W * 0.6),
});

/**
 * A book's tests from its table of contents, with their answers from the
 * answer key. pages: contentsPageInfo() of the book's pages plus their
 * pdfPage, in any order; pageCount: the book's length. Contents pages give
 * printed page numbers; the footers' page numbers map them to PDF pages.
 * -> { tests: [{ label, unit, unitWord, topic, start, end, answers? }],
 *      testAt(pdfPage) -> index | -1, keyPages: [pdfPage] }
 */
export const bookContents = (pages, pageCount = pages.length, { entriesHoldTests = false } = {}) => {
  const align = !entriesHoldTests;
  const toc = [], key = [], keyPages = [], offsets = [];
  const n = pageCount;
  pages = [...pages].sort((a, b) => a.pdfPage - b.pdfPage);
  for (const p of pages) {
    if (p.toc && p.pdfPage <= Math.max(20, n * 0.1)) toc.push(...p.toc);
    if (p.key?.length && p.pdfPage > n * 0.6) { key.push(...p.key); keyPages.push(p.pdfPage); }
    if (p.printed) offsets.push(String(p.pdfPage - +p.printed));
  }
  // Tests start with question 1. The footers' offset is checked against
  // that (some contents pages are off by a page or two).
  const startsTest = new Set(pages.filter(p => p.startsTest).map(p => p.pdfPage));
  const listed = toc.filter(it => it.kind === 'test').map(it => it.page);
  const fits = (k) => listed.filter(pg => startsTest.has(pg + k)).length;
  let offset = +(majority(offsets) ?? 0);
  // (Not when the entries hold several tests, each starting over at
  // question 1: the footers decide.)
  if (align) for (let k = -4; k <= 4; k++) if (fits(k) > fits(offset)) offset = k;

  // (Only in contents that indent their entries under the unit headings.)
  let nested = false;
  { let u = null; for (const it of toc) { if (it.kind === 'unit') u = it; else if (it.kind === 'test' && u && it.x > u.x + 0.01) nested = true; } }
  const tests = [];
  let unit = null, topic;
  for (const it of toc) {
    if (it.kind === 'unit') { unit = it; topic = undefined; continue; }
    if (it.kind === 'topic') { topic = it.text; continue; }
    if (/cevap|anahtar|answer key/.test(lowerTr(it.name))) continue;
    // Tests set at the unit heading's margin, or for a range of units
    // ("DENE TESTİ - 1 (1 - 3. Üniteler)"), stand on their own.
    const own = (nested && unit && !it.bullet && it.x <= unit.x + 0.01) || /ünite|unit/.test(lowerTr(it.paren ?? ''));
    tests.push({
      label: it.name,
      unit: own ? undefined : unit?.unit,
      unitWord: unit?.word,
      topic: own ? undefined : (it.paren || topic),
      start: it.page + offset,
    });
  }
  // Contents pages can be off locally too (a test listed on the page of the
  // one before it, an offset that changes near the end): tests and pages
  // that start with question 1 are aligned in order, each test moving at
  // most three pages from where it's listed.
  const firstKey = keyPages.length ? Math.min(...keyPages) : Infinity;
  const S = [...startsTest].filter(pg => pg < firstKey).sort((a, b) => a - b);
  const E = tests.map(t => t.start);
  const cost = Array.from({ length: E.length + 1 }, () => new Float64Array(S.length + 1).fill(Infinity));
  const back = Array.from({ length: E.length + 1 }, () => new Int8Array(S.length + 1));
  cost[0][0] = 0;
  for (let i = 0; i <= E.length; i++) {
    for (let j = 0; j <= S.length; j++) {
      if (i && cost[i - 1][j] + 2.5 < cost[i][j]) { cost[i][j] = cost[i - 1][j] + 2.5; back[i][j] = 1; }
      if (j && cost[i][j - 1] + 1 < cost[i][j]) { cost[i][j] = cost[i][j - 1] + 1; back[i][j] = 2; }
      const d = i && j ? Math.abs(S[j - 1] - E[i - 1]) : Infinity;
      if (d <= 3 && cost[i - 1][j - 1] + d < cost[i][j]) { cost[i][j] = cost[i - 1][j - 1] + d; back[i][j] = 3; }
    }
  }
  for (let i = E.length, j = S.length; align && (i > 0 || j > 0);) {
    const b = back[i][j];
    if (b === 3) { tests[i - 1].start = S[j - 1]; i--; j--; } else if (b === 1) i--; else j--;
  }
  // Entries holding several tests: an entry starts on the page whose header
  // first names it, near where it's listed (contents can be a page or two
  // off; "DNA ve Genetik Kod 35" starting on 33).
  if (entriesHoldTests) {
    const norm = (t) => lowerTr(t ?? '').replace(/[^\p{L}\p{N}]/gu, '');
    const heads = new Map(pages.map(p => [p.pdfPage, norm(p.head)]));
    for (const t of tests) {
      const k = norm(t.label);
      if (k.length < 4) continue;
      let best = null;
      for (let pg = t.start - 4; pg <= t.start + 4; pg++) {
        if (!(heads.get(pg) ?? '').includes(k) || (heads.get(pg - 1) ?? '').includes(k)) continue;
        if (best === null || Math.abs(pg - t.start) < Math.abs(best - t.start)) best = pg;
      }
      if (best !== null) t.start = best;
    }
  }
  // (Nothing past the answer key is a test.)
  for (let i = tests.length - 1; i >= 0; i--) if (tests[i].start >= firstKey) tests.splice(i, 1);
  tests.sort((a, b) => a.start - b.start);
  const lastPage = keyPages.length ? Math.min(...keyPages) - 1 : n;
  tests.forEach((t, i) => { t.end = i + 1 < tests.length ? Math.max(t.start, tests[i + 1].start - 1) : lastPage; });

  // Answer-key rows join their contents entry: same name, same unit when
  // there's a choice (every unit has a "Doğrula - 1").
  let keyUnit;
  const used = new Set(), unmatched = [], keyRows = [];
  for (const it of key) {
    if (it.kind === 'unit') { keyUnit = it.unit; continue; }
    keyRows.push({ ...it, unit: keyUnit });
    if (entriesHoldTests) continue;
    const k = testKey(it.name);
    const cands = tests.filter(t => !used.has(t) && testKey(t.label) === k);
    const t = cands.find(t => t.unit === keyUnit) ?? cands.find(t => t.unit === undefined);
    if (t) { used.add(t); t.answers = it.answers; } else unmatched.push({ ...it, unit: keyUnit });
  }
  // Rows whose name doesn't match (a typo in the contents: "Düşün - 1"
  // twice) pair up in order with the unit's tests that got no row, when the
  // counts agree.
  for (const u of new Set(unmatched.map(it => it.unit))) {
    const rows = unmatched.filter(it => it.unit === u);
    const open = tests.filter(t => !t.answers && t.unit === u);
    if (rows.length === open.length) open.forEach((t, i) => { t.answers = rows[i].answers; });
  }
  const testAt = (pdfPage) => tests.findIndex(t => pdfPage >= t.start && pdfPage <= t.end);
  return { tests, testAt, keyPages, keyRows };
};

/**
 * Test labels per page (`headerTest`), pages in book order: [{ label,
 * entry }] -> labels. A page without one (a test's second page, its header
 * printing only the topic) takes the label before it in the same entry.
 */
export const carryTestLabels = (pages) => {
  let last, entry;
  return pages.map(p => {
    if (p.entry !== entry) { last = undefined; entry = p.entry; }
    if (p.label) last = p.label;
    return p.label ?? last;
  });
};

/** "Pekiştir 4", "pekiştir 04", "Bitir test 01", "BİTİR 1" -> "pekiştir4", "bitir1". */
const labelKey = (name) => testKey(name).replace(/\d+/g, d => String(+d));

/**
 * Books whose contents entries hold several tests (`headerTest`): each
 * page's own test ("pekiştir 04"; "test 02" under a "Bitir" entry) is
 * looked up in the answer key within its unit. pages: [{ pdfPage, label,
 * questions: [n] }] -> { report: [{ name, start, end, missing, extra,
 * duplicate }], answerOf(pdfPage, n) }, as checkAgainstKey.
 */
export const checkLabelsAgainstKey = (contents, pages) => {
  const groups = new Map();
  for (const p of pages) {
    const t = contents.tests[contents.testAt(p.pdfPage)];
    if (!t || !p.label) continue;
    const names = [labelKey(p.label), labelKey(`${t.label} ${p.label}`)];
    const row = contents.keyRows.find(r => r.unit === t.unit && names.includes(labelKey(r.name)));
    if (!row) continue;
    if (!groups.has(row)) groups.set(row, { t, pages: [], have: [] });
    const g = groups.get(row);
    g.pages.push(p.pdfPage);
    g.have.push(...p.questions);
  }
  const byPage = new Map();
  const report = [...groups].map(([row, g]) => {
    for (const pg of g.pages) byPage.set(pg, row);
    return {
      name: `${contentsTestName(g.t)} ${row.name}`, start: Math.min(...g.pages), end: Math.max(...g.pages),
      missing: [...row.answers.keys()].filter(n => !g.have.includes(n)),
      extra: [...new Set(g.have.filter(n => !row.answers.has(n)))],
      duplicate: [...new Set(g.have.filter((n, k) => g.have.indexOf(n) !== k))],
    };
  });
  return { report, answerOf: (pdfPage, n) => byPage.get(pdfPage)?.answers.get(n) };
};

/** Name of a contents test for crop files: "1 ünite Çarpanlar ve Katlar Doğrula - 1". */
export const contentsTestName = (t) => [t.unit && `${t.unit} ${t.unitWord}`, t.topic, t.label].filter(Boolean).join(' ');

/**
 * Crops against the answer key, per contents test. pages: [{ pdfPage,
 * questions: [n] }] -> [{ test, missing, extra, duplicate }] for tests that
 * have answers; and answerOf(pdfPage, n).
 */
export const checkAgainstKey = (contents, pages) => {
  const found = contents.tests.map(() => []);
  for (const p of pages) {
    const i = contents.testAt(p.pdfPage);
    if (i >= 0) found[i].push(...p.questions);
  }
  const report = contents.tests.map((t, i) => {
    if (!t.answers) return null;
    const have = found[i];
    return {
      test: t,
      missing: [...t.answers.keys()].filter(n => !have.includes(n)),
      extra: [...new Set(have.filter(n => !t.answers.has(n)))],
      duplicate: [...new Set(have.filter((n, k) => have.indexOf(n) !== k))],
    };
  }).filter(Boolean);
  const answerOf = (pdfPage, n) => contents.tests[contents.testAt(pdfPage)]?.answers?.get(n);
  return { report, answerOf };
};

/**
 * Answers hidden in the text layer: some publishers put an invisible
 * "DDD" / "BBB_0408010201_2" at each question's margin, just above its
 * options. -> [{ letter, bbox }] in analysis space.
 */
export const hiddenAnswerMarks = (words) => words
  .filter(w => /^(AAA|BBB|CCC|DDD|EEE)(_\w*)?$/.test(w.text))
  .map(w => ({ letter: w.text[0], bbox: w.bbox }));

/** The hidden mark inside a question's box (0-1000), if exactly one. */
export const markedAnswer = (region, marks, W, H) => {
  const b = region.box;
  const inside = marks.filter(m => {
    const cy = ((m.bbox.y0 + m.bbox.y1) / 2) / H * 1000, x = m.bbox.x0 / W * 1000;
    return cy >= b.ymin && cy <= b.ymax && x >= b.xmin - 60 && x <= b.xmax;
  });
  return inside.length === 1 ? inside[0].letter : undefined;
};

/**
 * Header of a test page that prints its number beside the topic
 * ("1   Metni Görsellerle Yorumlama", "4 Bir Peygamber Tanıyorum: Hz. Musa
 * (a.s.)", "10 ON THE PHONE") -> { testNumber, topic } or {}. The topic is
 * the rest of the line: mostly letters, with a real word in it.
 */
export const readNumberedTitle = (headerLines) => {
  for (const line of headerLines) {
    const m = /^(\d{1,3})\s+(\p{L}.*)$/u.exec(line.text.replace(/\s+/g, ' ').trim());
    if (!m) continue;
    const topic = m[2].trim();
    const letters = (topic.match(/\p{L}/gu) ?? []).length;
    if (letters >= 4 && letters / topic.replace(/\s/g, '').length >= 0.6 && /\p{L}{3,}/u.test(topic)) {
      return { testNumber: m[1].padStart(2, '0'), topic };
    }
  }
  return {};
};

// ---------------------------------------------------------------------------
// Any book's table of contents (cli/qcrop-rename.mjs): read from a contents
// page's words (text layer or OCR), or from a contents.txt the user edits,
// and matched to crops by page.
// ---------------------------------------------------------------------------

/**
 * Words of a contents page -> its pieces of text in reading order. Rows are
 * cut where a wide gap separates columns; a piece that is only a number
 * (a page number set far right) stays with the piece left of it. Columns
 * are read one after another, top to bottom.
 */
export const contentsPieces = (words, W) => {
  const pieces = [];
  for (const row of groupLines(words)) {
    const hs = row.words.map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
    const h = hs[hs.length >> 1] || 10;
    const parts = [];
    for (const w of row.words) {
      const last = parts[parts.length - 1];
      if (last && w.bbox.x0 - last.x1 <= h * 2.5) { last.words.push(w); last.x1 = w.bbox.x1; }
      else parts.push({ words: [w], x0: w.bbox.x0, x1: w.bbox.x1, y: row.bbox.y0 });
    }
    for (const part of parts) {
      const text = part.words.map(w => w.text).join(' ').trim();
      const prev = pieces[pieces.length - 1];
      if (/^\d{1,3}$/.test(text) && prev && prev.y === part.y) { prev.text += ` ${text}`; prev.x1 = part.x1; continue; }
      pieces.push({ text, x0: part.x0, x1: part.x1, y: part.y });
    }
  }
  // Columns: left edges more than an eighth of the page apart.
  const xs = [...new Set(pieces.map(p => Math.round(p.x0)))].sort((a, b) => a - b);
  const starts = xs.filter((x, i) => i === 0 || x - xs[i - 1] > W * 0.12);
  const colOf = (p) => starts.filter(x => x <= p.x0 + 1).length - 1;
  return pieces.sort((a, b) => colOf(a) - colOf(b) || a.y - b.y).map(p => p.text);
};

/**
 * Pieces of contents text -> items: { heading } (a unit or chapter line,
 * no page number), { title, page } (a test or topic and the printed page
 * it starts on) and { orphan } (a line whose page number wasn't read). Dot leaders, bullets and "İçindekiler" are dropped;
 * headings in a row (a chapter's number and its name) are joined.
 */
export const contentsItems = (pieces) => {
  const items = [];
  for (const raw of pieces) {
    const text = raw
      .replace(/[.·…_]{3,}/g, ' ').replace(/\s+:\s*\.?\s*(?=\d+$)/, ' ')
      .replace(/^[n•▪●■◆\-–—*]\s+/u, '').replace(/\s+/g, ' ').trim();
    if (!text || /i̇?çindekiler|içindekiler|contents/i.test(text.toLocaleLowerCase('tr'))) continue;
    const letters = (text.match(/\p{L}/gu) ?? []).length;
    const m = /^(.*\p{L}.*?)[\s.:·…_\-–—]*?\s(\d{1,3})$/u.exec(text);
    if (m && letters >= 2) {
      items.push({ title: m[1].replace(/[\s.:·…_\-–—]+$/u, '').trim(), page: +m[2] });
    } else if (letters >= 4 && text.length <= 80) {
      // A heading is set in capitals or names a unit or chapter; any other
      // line without a page is an entry whose number was lost (kept aside
      // for the user to complete).
      const caps = (text.match(/\p{Lu}/gu) ?? []).length;
      const isHeading = /bölüm|ünite|unit|chapter|kısım|konu|hafta/i.test(text.toLocaleLowerCase('tr')) ||
        (caps / letters >= 0.6 && letters >= 8 && /\s/.test(text));
      const last = items[items.length - 1];
      if (!isHeading) items.push({ orphan: text });
      else if (last?.heading !== undefined) last.heading = `${last.heading} ${text}`;
      else items.push({ heading: text });
    }
  }
  return items;
};

/** A page that reads as contents: many titled entries, pages mostly rising. */
export const looksLikeContents = (items, pageText = '') => {
  const entries = items.filter(it => it.page !== undefined);
  if (entries.length < 5) return false;
  let up = 0;
  for (let i = 1; i < entries.length; i++) if (entries[i].page >= entries[i - 1].page) up++;
  return up / (entries.length - 1) >= 0.6 && (entries.length >= 8 || /i̇?çindekiler|içindekiler|contents/i.test(pageText.toLocaleLowerCase('tr')));
};

/** Items -> the editable contents.txt (see parseContentsFile). */
export const contentsFileText = (items, { book = '', source = '' } = {}) => [
  `# Q-Crop contents${book ? ` of ${book}` : ''}${source ? ` (${source})` : ''}`,
  '# Check this list, fix what is wrong, then run the rename again: it uses this file.',
  '#   <page> ; <title>   one line per test or topic, page as printed in the book',
  '#   a line without a page number is a heading (unit, chapter) for the lines under it',
  '#   offset = auto      or a number: PDF page = printed page + offset',
  '#   lines starting with # are ignored',
  'offset = auto',
  '',
  ...items.map(it => it.page !== undefined ? `${it.page} ; ${it.title}`
    : it.orphan !== undefined ? `# ? ${it.orphan}      <- no page number read; add one (and remove "# ?") if this is an entry`
    : `\n${it.heading}`),
  '',
].join('\n');

/** contents.txt -> { items, offset } (offset null = find it from the crops). */
export const parseContentsFile = (text) => {
  const items = [];
  let offset = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const o = /^offset\s*=\s*(auto|-?\d+)$/i.exec(line);
    if (o) { offset = o[1].toLowerCase() === 'auto' ? null : +o[1]; continue; }
    const m = /^(\d{1,4})\s*[;\t,|]\s*(.+)$/.exec(line);
    if (m) items.push({ page: +m[1], title: m[2].trim() });
    else items.push({ heading: line });
  }
  return { items, offset };
};

/**
 * Contents items matched to the book's pages. `testStarts`: pages (as the
 * crops number them) where a question 1 was cropped, i.e. where tests
 * start. The printed-to-page offset is the one that puts the most entries
 * on such pages (unless given), then each entry may move up to three pages
 * to the nearest test start, in order (contents can be off by a page or
 * two). -> { entries: [{ name, start }], offset }, entries in page order.
 */
export const alignContents = (items, testStarts, offset = null) => {
  const entries = [];
  let heading;
  for (const it of items) {
    if (it.heading !== undefined) { heading = it.heading; continue; }
    if (it.page === undefined) continue;
    entries.push({ name: [heading, it.title].filter(Boolean).join(' '), page: it.page });
  }
  const S = [...new Set(testStarts)].sort((a, b) => a - b);
  const has = new Set(S);
  if (offset === null) {
    let best = 0, bestFit = -1;
    for (let k = -10; k <= 60; k++) {
      const fit = entries.filter(e => has.has(e.page + k)).length;
      if (fit > bestFit || (fit === bestFit && Math.abs(k) < Math.abs(best))) { best = k; bestFit = fit; }
    }
    offset = best;
  }
  const E = entries.map(e => e.page + offset);
  // Order-keeping alignment of entries to test starts (each within 3 pages).
  const cost = Array.from({ length: E.length + 1 }, () => new Float64Array(S.length + 1).fill(Infinity));
  const back = Array.from({ length: E.length + 1 }, () => new Int8Array(S.length + 1));
  cost[0][0] = 0;
  for (let i = 0; i <= E.length; i++) {
    for (let j = 0; j <= S.length; j++) {
      if (i && cost[i - 1][j] + 2.5 < cost[i][j]) { cost[i][j] = cost[i - 1][j] + 2.5; back[i][j] = 1; }
      if (j && cost[i][j - 1] + 1 < cost[i][j]) { cost[i][j] = cost[i][j - 1] + 1; back[i][j] = 2; }
      const d = i && j ? Math.abs(S[j - 1] - E[i - 1]) : Infinity;
      if (d <= 3 && cost[i - 1][j - 1] + d < cost[i][j]) { cost[i][j] = cost[i - 1][j - 1] + d; back[i][j] = 3; }
    }
  }
  const start = [...E];
  for (let i = E.length, j = S.length; i > 0 || j > 0;) {
    const b = back[i][j];
    if (b === 3) { start[i - 1] = S[j - 1]; i--; j--; } else if (b === 1) i--; else j--;
  }
  // An entry no test start confirms, whose page breaks the order of the
  // contents (a misread "83" between 31 and 35), is left out.
  const matched = start.map((st, i) => S.includes(st) && Math.abs(st - E[i]) <= 3);
  const dropped = [];
  const kept = entries.map((e, i) => ({ name: e.name, start: start[i], page: e.page, i })).filter(e => {
    if (matched[e.i]) return true;
    const prev = start.slice(0, e.i).filter((_, k) => matched[k]).pop();
    const next = start.slice(e.i + 1).find((_, k) => matched[e.i + 1 + k]);
    const ok = (prev === undefined || e.start >= prev) && (next === undefined || e.start <= next);
    if (!ok) dropped.push({ name: e.name, page: e.page });
    return ok;
  });
  const out = kept.map(e => ({ name: e.name, start: e.start })).sort((a, b) => a.start - b.start);
  return { entries: out, offset, dropped };
};

/** The contents entry a page belongs to (the last one starting at or before it). */
export const contentsEntryAt = (entries, page) => {
  let found = null;
  for (const e of entries) if (e.start <= page) found = e;
  return found;
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
  // (The same margin on the left as on the right: users widened crops that
  // started right at the text. A question number it reaches is masked.)
  const pX = W * 0.005, pY = H * 0.005, lP = W * 0.005;
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

/**
 * test04_kütle_merkezi_q1_33.jpg / karbohidratlar_q5_s104.jpg; with `week`
 * (opt-in, for books whose answer keys go by week): 6_hafta_karbohidratlar_q5_s104.jpg
 */
export const cropFileName = ({ week, testNumber, topic, questionNumber, pageLabel }) => {
  const parts = [];
  if (week) parts.push(`${week}_hafta`);
  if (testNumber) parts.push(`test${sanitizeName(testNumber)}`);
  if (topic) parts.push(sanitizeName(topic));
  parts.push(`q${questionNumber}`);
  if (pageLabel) parts.push(pageLabel);
  return parts.filter(Boolean).join('_') + '.jpg';
};
