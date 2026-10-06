import { normalizePdfTextItems } from '../core/qcropCore.mjs';

// Expands user-selected files into pages. Images pass through as data URLs.
// PDFs become one lazy page each: rendering and text-layer extraction happen
// in `load()` when the page's turn comes, so a 160-page book shows up
// instantly and only one full-resolution render is in flight at a time.

/** Text-layer item with coordinates as fractions of the page. */
export interface PdfTextItem {
  str: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PdfPageRef {
  source: string;
  pageIndex: number;
  load: () => Promise<{ dataUrl: string; textItems: PdfTextItem[] }>;
  /** Page size in pixels at `dpi`. */
  size: (dpi: number) => Promise<{ width: number; height: number }>;
  /** Renders only the given pixel rectangle (at `dpi`) onto a new canvas. */
  renderRegion: (dpi: number, rect: { sx: number; sy: number; sw: number; sh: number }) => Promise<HTMLCanvasElement>;
}

/** Resolution of exported PDF crops (the page preview is much smaller). */
export const PDF_EXPORT_DPI = 600;

export interface LoadedPage {
  /** Empty for PDF pages until `pdf.load()` runs. */
  dataUrl: string;
  file: File;
  pdf?: PdfPageRef;
}

const PDF_RENDER_TARGET = 2600; // px longest side; plenty for OCR + crops

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result as string);
    reader.readAsDataURL(file);
  });

const expandPdf = async (file: File): Promise<LoadedPage[]> => {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const baseName = file.name.replace(/\.pdf$/i, '');

  const load = async (i: number) => {
    const page = await doc.getPage(i);
    const unit = page.getViewport({ scale: 1 });
    const textItems = normalizePdfTextItems((await page.getTextContent()).items, unit);

    const scale = PDF_RENDER_TARGET / Math.max(unit.width, unit.height);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup();
    // A blob URL keeps the JPEG out of the JS heap (base64 strings of a
    // whole book add up to hundreds of MB).
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('render failed'))), 'image/jpeg', 0.92));
    return { dataUrl: URL.createObjectURL(blob), textItems };
  };

  const size = async (i: number, dpi: number) => {
    const vp = (await doc.getPage(i)).getViewport({ scale: dpi / 72 });
    return { width: Math.round(vp.width), height: Math.round(vp.height) };
  };

  // Vector text stays sharp at any scale, so crops are re-rendered from the
  // PDF at export time instead of cut from the preview render.
  const renderRegion = async (i: number, dpi: number, r: { sx: number; sy: number; sw: number; sh: number }) => {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const canvas = document.createElement('canvas');
    canvas.width = r.sw;
    canvas.height = r.sh;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, r.sw, r.sh);
    await page.render({ canvasContext: ctx, viewport, transform: [1, 0, 0, 1, -r.sx, -r.sy] }).promise;
    page.cleanup();
    return canvas;
  };

  return Array.from({ length: doc.numPages }, (_, k) => ({
    dataUrl: '',
    // Named without a "page" keyword on purpose: the PDF page index is used
    // as-is (s<index>), never parsed back out of the filename.
    file: new File([], `${baseName} (p${k + 1}).jpg`, { type: 'image/jpeg' }),
    pdf: {
      source: file.name, pageIndex: k + 1, load: () => load(k + 1),
      size: (dpi: number) => size(k + 1, dpi),
      renderRegion: (dpi: number, r: { sx: number; sy: number; sw: number; sh: number }) => renderRegion(k + 1, dpi, r),
    },
  }));
};

export const expandFiles = async (files: File[]): Promise<LoadedPage[]> => {
  const out: LoadedPage[] = [];
  for (const file of files) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      out.push(...await expandPdf(file));
    } else if (file.type.startsWith('image/')) {
      out.push({ dataUrl: await readAsDataUrl(file), file });
    }
  }
  return out;
};
