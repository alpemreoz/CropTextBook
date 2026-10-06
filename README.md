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
- **Shared passages.** When an instruction names the questions that share a
  text, table or figure ("2. ve 3. soruları aşağıdaki metne göre
  cevaplayınız.", "4 - 5. soruları…", "1, 2, 3, 4 ve 5. soruları…",
  "(7. ve 8. soruları … göre çözünüz)"), each of those questions is cropped
  as passage + question: the passage on top, the question below it. The
  passage is whatever sits between the instruction and the first named
  question (to the end of the column when the questions start in the next
  one). When nothing sits there, it's the block above the instruction.
  Books say "aşağıdaki" or "yukarıdaki" for either layout, so the wording
  isn't used. The instruction line itself is left out.

## Fixing crops by hand (web app)

- **Boxes**: drag a box to move it, drag its handles to resize it, and use
  **Add Box** to draw a missed question. To drop a crop, use its trash icon
  or select its box on the page and press Delete/Backspace (for example a
  question whose shared passage is on the previous page). A new box is numbered from where it
  sits: a box drawn before Q2 becomes Q1 (when 1 is free), not "highest + 1".
- **Question numbers**: click the `Q5 ✎` badge on a crop and type the right
  number (Enter to save, Esc to cancel). A number used twice on a page is
  flagged, and the export adds `_2` so no file is overwritten.
- **Shared passages**: detected passages show as purple boxes on the page.
  **Add Passage** draws one by hand. The panel in the sidebar lists the
  page's questions; tick the ones that use the passage (the first question
  after it is ticked for you). Click a purple box to select it again, drag
  it or its handles to adjust it, or **Delete** it. A crop's
  **+ passage ✕** chip drops the passage from that one crop. Esc cancels
  drawing and closes the panel.
- **Navigation**: the ‹ › buttons beside the page (or the ← → keys) go to
  the previous/next page; picking a page on the left scrolls the crop list
  to that page; clicking a box on the page scrolls to its crop.

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
- **Week** (opt-in): for books whose answer key is listed by week, crops of
  week pages can start with the header's "N. HAFTA" badge:
  `6_hafta_aktif_taşıma_q5_s104.jpg`. Turn it on with **Add week to file
  names** in the web app (remembered in the browser) or `--week` in the CLI.
  Review sections (Tarama, Ara Tatil, Yarıyıl Tatili) keep their names. Pages
  from one cover to the next are one week, so a stray or misread badge is
  outvoted by the rest of its week. In scans the badge (light text on a dark
  box) gets its own digits-only read, and digits OCR misses are matched
  against digit shapes learned from badges it did read. A whole book always
  resolves; with only a few scanned pages loaded, a week can stay blank.

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
detected, `--week` prefixes crop names with the page's week (see File
names), and `--png` writes lossless PNGs instead of JPEGs (quality 95,
no chroma subsampling). `--pages 10-40,52` analyzes only those PDF pages
(the table of contents and answer key are still read from the whole book),
and `--dry-run` reports what would be cropped without writing images. A 161-page text-layer PDF takes about 45 s.

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

## Book profiles (scanned question banks)

Some books need settings the default analysis doesn't use: scanned question
banks with no header banner on half their pages, spine text in the margin,
one-line questions, numbering that restarts on learning pages, answers
printed on the page. A **profile** turns those settings on for one book
series; without a profile everything works exactly as before.

```bash
npm run cli -- ./book.pdf -o ./crops --profile apotemi
```

In the web app, pick the profile in the header (**Book profile**). Changing
it analyzes the loaded pages again.

| Profile | Book |
| --- | --- |
| `bilgisarmal` | Bilgi Sarmal – TYT Matematik Soru Bankası |
| `orijinal` | Orijinal Yayınları – TYT Matematik Soru Bankası |
| `acil` | Acil Yayınları – TYT Matematik Kurs Soru Bankası |
| `ucdortbes-start` | ÜçDörtBeş – 0'dan Başla START Matematik |
| `ucdortbes` | ÜçDörtBeş – TYT Matematik Soru Bankası |
| `3d` | 3D Yayınları – TYT Matematik Soru Bankası |
| `apotemi` | Apotemi – TYT Matematik Soru Bankası |
| `4d` | 4D Serisi (NEV) – 8. Sınıf Soru Bankası (all subjects) |
| `atom` | Atom – 8. Sınıf Konu Testleri (all subjects) |

What a profile can switch on (see `core/profiles.mjs`, where each profile
lists only what differs from the defaults):

- `headerFromLabels`: question numbers read from the column margins from
  the top of the page decide where content starts (pages whose first
  question sits where a header would be).
- `trimEdgeText`: a thin band of ink along the page edge (vertical spine
  text, scan borders) isn't part of a column.
- `footerZone`: a footer starts in the bottom part of the page; a lower
  "footer" is the page's last questions.
- `leftmostGutter`: without a visible divider, the gutter is the leftmost
  blank run (books with a logo in the gutter).
- `answerSheetGuard: false`: keep one-line questions whose options start
  right under the number.
- `numberingRestarts`: numbering may start over on a page (1, 2, 3 under
  each sub-heading of a learning page).
- `namesPerTest`, `topicIgnore`: a test's number and topic, read on any of
  its pages, name all its crops; banner text on the ignore list is never a
  topic.
- `answerKey`: the answers printed on the page (`bottom` strip, or `top`
  for books printing them under the test title) are read for
  **answers.csv** and the **self-check**.
- `mixedColumns` (text-layer PDFs): pages that mix full-width questions
  and passages with two-column stretches are cut into bands. A question
  numbered at the left margin is full width when no right-column number
  sits beside it and its text runs across the gutter (or its A)–D) options
  spread across it); a run of lines crossing the gutter without a number is
  a full-width passage. Questions that take a whole page work the same way.
- `bookIndex`: the book's table of contents ("İçindekiler") and answer key
  ("CEVAP ANAHTARI") are read. Each test's pages come from the contents
  (checked against the pages where question 1 starts, since contents pages
  can be a page or two off), crops are named after their test, and every
  test is checked against its row in the answer key.
- `answerMarks`: answers hidden in the text layer (an invisible "DDD" at
  each question's margin, as these publishers print) give each crop its
  answer where no answer key does.
- `titleFromHeader`: the test number and topic printed together in the
  header ("1  Metni Görsellerle Yorumlama") name the test's crops.

### Grade-8 books (`4d`, `atom`)

Options run A)–D). Crops of a `4d` book are named after their test in the
table of contents: `<unit>_ünite_<topic>_<test>_q<N>_s<page>.jpg`, e.g.
`1_ünite_çarpanlar_ve_katlar_doğrula_1_q3_s10.jpg`; tests for several units
("DENE TESTİ - 1 (1. Ünite)") are named on their own:
`dene_testi_1_q5_s52.jpg`. Atom books have no contents pages; their header
gives the test number and topic: `test01_metni_görsellerle_yorumlama_q1_s1.jpg`.
The English book's units are named the same way (`1_unit_friendship_remember_1_…`).

Every answer comes from the book's printed answer key (`4d`) or, for Atom
books, from the answer hidden at each question; where the two disagree
(a handful of English questions), the key is used and `check.txt` lists
them. Things the text layer can't help with: a question printed entirely
as a picture (no text at all) isn't found, and two-column passages beside
an image-only figure may need a hand-drawn passage box.

### answers.csv and the self-check

With an answer-key profile the CLI writes `answers.csv` (file, page,
question, answer) and `check.txt` next to the crops, and prints a one-line
summary. With `bookIndex`, `check.txt` lists per test the questions in the
answer key that weren't cropped, crops whose number isn't in the key, and
numbers cropped twice. The self-check groups the book into tests (numbering starts over
in each) and compares each test's crops with its printed answers:
questions printed but not cropped, and crops beyond the printed answers.
In the web app each crop shows its answer, pages of a test with missing
questions say so, and the ZIP export includes `answers.csv`. Printed
answers are read by OCR too, so a "not cropped" now and then is a missed
answer read rather than a missed question.

## Legacy Gemini mode

`services/geminiService.ts` still contains the original Gemini-based analyzer
(unused). The local analyzer in `services/localAnalyzer.ts` returns the same
result shape, so the two are interchangeable if a cloud/local-LLM fallback is
ever needed again.
