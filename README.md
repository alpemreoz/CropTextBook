# Q-Crop — Smart Question Extractor

Upload test-book pages (scans or a PDF), get every multiple-choice question
automatically detected, cropped, and exported as individually named JPEGs.

**Runs 100% locally — no AI API, no keys, no token limits.** Page analysis
uses classical layout analysis (ink projections for header/footer/column
detection) plus the page's text: a PDF's own text layer when it has one
(exact and fast), otherwise [Tesseract.js](https://github.com/naptha/tesseract.js)
OCR. The detection logic lives in `core/qcropCore.mjs` and is shared by the
web app and the CLI.

## Run locally

Prerequisites: Node.js

```bash
npm install
npm run dev
```

Then open the printed URL, select page scans (JPEG/PNG/WebP) or a PDF, and
export. On first use Tesseract downloads its Turkish language data (~10 MB,
cached by the browser afterwards). Keep the tab in the foreground while a PDF
is processing: browsers pause PDF page rendering in background tabs.

## What gets cropped

- Only **test questions**: a numbered label at a column's left margin whose
  question has an `A) … E)` option block. Written-exam ("Yazılı Sınav") and
  activity ("Etkinlik") items are skipped: anything below such a heading, and
  lettered statement lists that run past E) (true/false exercises).
- When a question's lines start left of its number (unindented poems), the
  crop widens to keep them and the number is painted out instead.
- Each crop runs from the question text through its options, including
  anything hanging below them (stacked fractions, option tables). It stops at
  the whitespace before the next block, at anything that starts back at the
  column margin below the options (a section icon or label), or at a section
  heading such as "Yazılı Sınav". The number label is excluded.
- Two-column layouts; a divider that ends where a full-width section starts
  is handled.

## File names

`[test<NN>_][<topic>_]q<N>_<page>.jpg`, lowercase, Turkish letters kept.

- **Page**: for PDFs, `s` + the PDF page index (unique across the file, e.g.
  `s104`). For scans, the number in the filename (`..._Page_033.jpg` → `33`),
  else the footer is OCR'd.
- **Topic**: the page header's topic (e.g. `kütle_merkezi`); for PDF books
  whose test pages don't print one, the topic from the most recent unit cover
  page (the line above the "Adı :" student form); review sections name
  themselves (`tarama_1`).
- **Test**: the corner "TEST 04" badge, when the book has one.

Example: `aktif_taşıma_endositoz_ekzositoz_q5_s104.jpg`.

## CLI (headless, faster)

The same pipeline as a Node script — no browser; writes crops straight to one
output folder:

```bash
npm run cli -- <PDFs, images or folders...> -o <output-folder>
# e.g.
npm run cli -- ./book.pdf -o ./crops
npm run cli -- ./scans -o ./crops
```

PDF input needs poppler (`brew install poppler`) for rendering and the text
layer. Detection runs on a 300 dpi render; each crop is then rendered again
from the PDF at 600 dpi, so text and vector drawings stay sharp. `--dpi 800`
(or any 72–1200) changes the crop resolution without changing what's
detected, and `--png` writes lossless PNGs instead of JPEGs (quality 95,
no chroma subsampling). A 161-page text-layer PDF takes about 45 s.

The web app works the same way: previews come from a smaller page render,
and **Export** re-renders PDF crops at 600 dpi.

Crops from page images can't be sharper than the images themselves. When
exporting pages from Adobe, use 600 dpi.

Page images (scans, or pages exported from a PDF) go through OCR, about
0.7 s/page in the CLI and 5 s/page in the browser. Numbered files
(`Book_Sayfa_001.jpg`, `…_002.jpg`, …) are read as one book in page order,
so topics come from the unit covers as with a PDF. On images, question
numbers are read a second time from each column's margin, and questions
whose options sit beside drawings get two extra option passes (sparse-text
OCR, then shape-based "A)" detection). When a PDF with real text exists,
it's still the better input: exact, faster, and sharper crops (vector
rendering instead of the image's fixed pixels).

## Legacy Gemini mode

`services/geminiService.ts` still contains the original Gemini-based analyzer
(unused). The local analyzer in `services/localAnalyzer.ts` returns the same
result shape, so the two are interchangeable if a cloud/local-LLM fallback is
ever needed again.
