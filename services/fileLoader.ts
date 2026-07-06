// Expands user-selected files into page images: images pass through as data
// URLs, PDFs are rendered page-by-page at high resolution. PDF pages are
// named without a "page" keyword on purpose — the PDF page index rarely
// matches the printed book page, so App's filename fallback must not pick it
// up; the footer OCR reads the real page number from the crisp render.

export interface LoadedPage {
  dataUrl: string;
  file: File;
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
  const pages: LoadedPage[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const unit = page.getViewport({ scale: 1 });
    const scale = PDF_RENDER_TARGET / Math.max(unit.width, unit.height);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const blob = await (await fetch(dataUrl)).blob();
    pages.push({
      dataUrl,
      file: new File([blob], `${baseName} (p${i}).jpg`, { type: 'image/jpeg' }),
    });
    page.cleanup();
  }
  await doc.destroy();
  return pages;
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
