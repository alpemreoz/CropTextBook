# Q-Crop — Smart Question Extractor

Upload scanned test-book pages, get every question automatically detected,
cropped, and exported as individually named JPEGs.

**Runs 100% locally — no AI API, no keys, no token limits.** Page analysis is
done in the browser with classical layout analysis (ink projections for
header/footer/column detection) plus [Tesseract.js](https://github.com/naptha/tesseract.js)
OCR (WASM) to find question-number labels and read page metadata (page number,
TEST number, topic). Cropping, stitching and export were always local.

## Run locally

Prerequisites: Node.js

```bash
npm install
npm run dev
```

Then open the printed URL, select one or more page scans (JPEG/PNG/WebP) and
export. On first use Tesseract downloads its Turkish language data (~10 MB,
cached by the browser afterwards).

Notes:
- Detection is tuned for the standard two-column Turkish test-book layout
  (numbered questions at each column's left margin, header with unit/topic,
  page number in the footer).
- If the footer page number can't be read (stylized fonts), the page number is
  taken from the filename (e.g. `..._Page_033.jpg` → 33).
- Export All produces a single ZIP with the naming scheme
  `Test<NN>_<topic>_Q<N>_<page>.jpg`.

## Legacy Gemini mode

`services/geminiService.ts` still contains the original Gemini-based analyzer
(unused). The local analyzer in `services/localAnalyzer.ts` returns the same
result shape, so the two are interchangeable if a cloud/local-LLM fallback is
ever needed again.
