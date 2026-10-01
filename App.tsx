import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Uploader from './components/Uploader';
import { analyzeTestPageLocal } from './services/localAnalyzer';
import { expandFiles, LoadedPage, PDF_EXPORT_DPI } from './services/fileLoader';
import { cropFileName, resolveTopics, imageSequence, cropRect, maskRect, stackLayout } from './core/qcropCore.mjs';
import { QuestionRegion, AppStatus, BoundingBox, PageData } from './types';
import { LoaderIcon, DownloadIcon, ScissorsIcon, TrashIcon, PlusIcon } from './components/Icons';

type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type DragState =
  | { mode: 'move'; regionId: string; startNX: number; startNY: number; origBox: BoundingBox }
  | { mode: 'resize'; regionId: string; handle: ResizeHandle; origBox: BoundingBox }
  | { mode: 'create'; kind: 'box' | 'passage'; startNX: number; startNY: number }
  // Passages are shared by several questions: `cur` is the box they all
  // hold right now, so each drag step can find and update them together.
  | { mode: 'move-passage'; startNX: number; startNY: number; origBox: BoundingBox; cur: BoundingBox }
  | { mode: 'resize-passage'; handle: ResizeHandle; origBox: BoundingBox; cur: BoundingBox };

/** Canvas tool: select/edit, draw a question box, or draw a shared passage. */
type Tool = 'select' | 'box' | 'passage';

const MIN_BOX = 10; // minimum box size in 0-1000 units
const MAX_PARALLEL = 3; // pages analyzed at once

/** The book a page belongs to (a PDF, or a numbered image sequence) and its place in it. */
const bookOf = (p: PageData): { key: string; order: number } | null => {
  if (p.pdf) return { key: `pdf:${p.pdf.source}`, order: p.pdf.pageIndex };
  const seq = imageSequence(p.file.name);
  return seq ? { key: `img:${seq.key}`, order: seq.index } : null;
};

const boxKey = (b?: BoundingBox) => b ? `${b.xmin},${b.ymin},${b.xmax},${b.ymax}` : '';

/** Questions in reading order: left column top to bottom, then the right one. */
const readingOrder = (a: BoundingBox, b: BoundingBox) => {
  const col = (x: BoundingBox) => ((x.xmin + x.xmax) / 2 < 500 ? 0 : 1);
  return col(a) - col(b) || a.ymin - b.ymin;
};

const handlePoints = (b: BoundingBox): [ResizeHandle, number, number][] => [
  ['nw', b.xmin, b.ymin], ['n', (b.xmin + b.xmax) / 2, b.ymin], ['ne', b.xmax, b.ymin],
  ['e', b.xmax, (b.ymin + b.ymax) / 2], ['se', b.xmax, b.ymax], ['s', (b.xmin + b.xmax) / 2, b.ymax],
  ['sw', b.xmin, b.ymax], ['w', b.xmin, (b.ymin + b.ymax) / 2],
];

export default function App() {
  const [pages, setPages] = useState<PageData[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });
  const [tool, setTool] = useState<Tool>('select');
  const [draftBox, setDraftBox] = useState<BoundingBox | null>(null);
  // The shared passage being edited (moved, resized, assigned to questions).
  const [selectedPassage, setSelectedPassage] = useState<BoundingBox | null>(null);
  const [editingNumberId, setEditingNumberId] = useState<string | null>(null);
  const [exportProgress, setExportProgress] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);

  // Drawing tools and the passage panel belong to the page they were used on.
  useEffect(() => { setTool('select'); setSelectedPassage(null); setDraftBox(null); }, [activePageId]);

  // Esc cancels drawing and closes the passage panel; Delete/Backspace
  // removes the selected crop (or the selected passage). Not while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.key === 'Escape') {
        setTool('select'); setSelectedPassage(null); setDraftBox(null); dragRef.current = null;
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && activePage) {
        if (selectedPassage) { e.preventDefault(); deleteSelectedPassage(); return; }
        const sel = activePage.regions.find(r => r.isSelected);
        if (sel) { e.preventDefault(); handleDeleteRegion(sel.id, activePage.id); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // The page strip on the left keeps the active page's thumbnail in view
  // (it changes when a crop of another page is picked on the right).
  useEffect(() => {
    if (activePageId) document.getElementById(`thumb-${activePageId}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activePageId]);

  /** Scrolls the crop list on the right to a page's section or one crop card. */
  const revealInList = (id: string, block: ScrollLogicalPosition) =>
    // After React has rendered the selection (a page's section may be new).
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ block, behavior: 'smooth' }), 0);

  // Redraw the canvas when the container is resized (or first laid out).
  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      setContainerSize({ w: width, h: height });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, [pages.length > 0]);

  const generateId = () => Math.random().toString(36).substr(2, 9);

  const activePage = useMemo(() =>
    pages.find(p => p.id === activePageId), [pages, activePageId]
  );

  // Effective topic per page. Pages are analyzed concurrently, so
  // inheritance from unit covers is derived from state rather than at
  // analysis time: within one PDF, in document order, a page without its own
  // topic takes the most recent cover's.
  const topicByPage = useMemo(() => {
    const out = new Map<string, string | undefined>();
    const byBook = new Map<string, { page: PageData; order: number }[]>();
    for (const p of pages) {
      const book = bookOf(p);
      if (!book) { out.set(p.id, p.topic); continue; }
      if (!byBook.has(book.key)) byBook.set(book.key, []);
      byBook.get(book.key)!.push({ page: p, order: book.order });
    }
    for (const group of byBook.values()) {
      group.sort((a, b) => a.order - b.order);
      const resolved = resolveTopics(group.map(({ page: p }) => ({
        section: p.section, headerTopic: p.topic, coverTopic: p.coverTopic,
      })));
      group.forEach(({ page }, i) => out.set(page.id, resolved[i]));
    }
    return out;
  }, [pages]);

  const handleImagesSelected = useCallback(async (newFiles: LoadedPage[]) => {
    const newPages: PageData[] = newFiles.map(f => ({
      id: generateId(),
      file: f.file,
      dataUrl: f.dataUrl,
      pdf: f.pdf,
      imageObj: null,
      status: 'IDLE',
      regions: [],
      pageNumber: '...',
    }));

    setPages(prev => [...prev, ...newPages]);
    if (!activePageId) setActivePageId(newPages[0].id);
    setIsProcessing(true);
  }, [activePageId]);

  // Dev-only hook: lets automated tests feed sample pages without the file picker.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as any).__qcropLoadSamples = async (urls: string[]) => {
      const files: File[] = [];
      for (const url of urls) {
        const blob = await (await fetch(url)).blob();
        files.push(new File([blob], decodeURIComponent(url.split('/').pop() || 'page.jpg'), { type: blob.type }));
      }
      handleImagesSelected(await expandFiles(files));
    };
    (window as any).__qcropAddPages = handleImagesSelected;
  }, [handleImagesSelected]);

  // Page processing pool: at most MAX_PARALLEL pages in flight. The in-flight
  // set lives in a ref so a status update can't re-dispatch a page, and each
  // page is started from the effect instead of from another page's update
  // (a chain of those overflows React's update depth on large PDFs).
  const inFlight = useRef(new Set<string>());
  useEffect(() => {
    if (!isProcessing) return;
    const idle = pages.filter(p => p.status === 'IDLE' && !inFlight.current.has(p.id));
    if (idle.length === 0) {
      if (inFlight.current.size === 0) setIsProcessing(false);
      return;
    }
    const batch = idle.slice(0, MAX_PARALLEL - inFlight.current.size);
    if (batch.length === 0) return;
    const ids = new Set(batch.map(p => p.id));
    ids.forEach(id => inFlight.current.add(id));
    setPages(prev => prev.map(p => ids.has(p.id) ? { ...p, status: 'ANALYZING' } : p));
    batch.forEach(processPage);
  }, [pages, isProcessing]);

  async function processPage(pendingPage: PageData) {
    try {
      let dataUrl = pendingPage.dataUrl;
      let textItems;
      if (pendingPage.pdf) {
        ({ dataUrl, textItems } = await pendingPage.pdf.load());
      }

      const img = new Image();
      img.src = dataUrl;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });

      const result = await analyzeTestPageLocal(img, textItems, { bookPage: !!bookOf(pendingPage) });

      let pageNumber = result.pageNumber;
      let pageLabel: string;
      if (pendingPage.pdf) {
        // The PDF page index is unique across the book; printed numbers
        // restart in some books.
        pageNumber = String(pendingPage.pdf.pageIndex);
        pageLabel = `s${pageNumber}`;
      } else {
        // Scans are usually named after their page ("..._Page_033.jpg").
        // The filename wins over OCR: the stylized footer digits can misread
        // to a wrong-but-plausible number (e.g. seven-segment 64 -> 84).
        // Requiring the page/sayfa keyword keeps camera filenames
        // (IMG_1234) from being mistaken for book pages.
        const m = /(?:page|sayfa)[_\s-]*(\d{1,4})/i.exec(pendingPage.file.name);
        if (m) pageNumber = String(parseInt(m[1], 10));
        pageLabel = pageNumber;
      }

      // The page's own topic; PDF pages without one inherit a unit cover's
      // topic in `topicByPage`, once all pages are done.
      const topic = result.topic;

      const regionsWithData: QuestionRegion[] = result.regions.map(r => ({
        ...r,
        id: generateId(),
        pageNumber,
        pageLabel,
        testNumber: result.testNumber,
        topic,
        croppedDataUrl: cropImage(img, r.box, r.contextBox, r.mask)
      }));

      inFlight.current.delete(pendingPage.id);
      setPages(prev => prev.map(p => p.id === pendingPage.id ? {
        ...p,
        status: 'READY',
        dataUrl,
        imageObj: img,
        pageNumber,
        pageLabel,
        testNumber: result.testNumber,
        topic,
        coverTopic: result.coverTopic,
        section: result.section,
        regions: regionsWithData
      } : p));
    } catch (err: any) {
      inFlight.current.delete(pendingPage.id);
      setPages(prev => prev.map(p => p.id === pendingPage.id ? {
        ...p,
        status: 'ERROR',
        error: err.message
      } : p));
    }
  }

  // Canvas Drawing Logic
  useEffect(() => {
    if (!activePage || !activePage.imageObj || !canvasRef.current || !containerRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const container = containerRef.current;
    const { imageObj, regions, status } = activePage;

    const containerRatio = container.clientWidth / container.clientHeight;
    const imageRatio = imageObj.width / imageObj.height;

    let drawWidth = container.clientWidth;
    let drawHeight = container.clientHeight;

    if (containerRatio > imageRatio) {
      drawWidth = drawHeight * imageRatio;
    } else {
      drawHeight = drawWidth / imageRatio;
    }

    canvas.width = drawWidth;
    canvas.height = drawHeight;
    ctx.drawImage(imageObj, 0, 0, drawWidth, drawHeight);

    if (status === 'READY') {
      // Shared passages: one box each, labelled with the questions using it.
      // The selected one is drawn even before any question uses it.
      const passages = new Map<string, BoundingBox>();
      regions.forEach(r => { if (r.contextBox) passages.set(boxKey(r.contextBox), r.contextBox); });
      if (selectedPassage) passages.set(boxKey(selectedPassage), selectedPassage);
      const selKey = boxKey(selectedPassage ?? undefined);
      passages.forEach((c, key) => {
        const isSel = key === selKey;
        ctx.beginPath();
        ctx.rect((c.xmin / 1000) * drawWidth, (c.ymin / 1000) * drawHeight, ((c.xmax - c.xmin) / 1000) * drawWidth, ((c.ymax - c.ymin) / 1000) * drawHeight);
        ctx.fillStyle = isSel ? 'rgba(168, 85, 247, 0.18)' : 'rgba(168, 85, 247, 0.10)';
        ctx.fill();
        ctx.lineWidth = isSel ? 2.5 : 1.5;
        if (!isSel) ctx.setLineDash([6, 4]);
        ctx.strokeStyle = isSel ? 'rgb(126, 34, 206)' : 'rgba(147, 51, 234, 0.8)'; ctx.stroke(); ctx.setLineDash([]);
        const nums = regions.filter(r => boxKey(r.contextBox) === key)
          .map(r => r.questionNumber).sort((x, y) => parseInt(x, 10) - parseInt(y, 10));
        const label = nums.length ? `Passage Q${nums.join(', Q')}` : 'Passage (pick questions)';
        ctx.font = 'bold 11px sans-serif';
        const tx = (c.xmin / 1000) * drawWidth, ty = (c.ymin / 1000) * drawHeight;
        ctx.fillStyle = isSel ? 'rgb(126, 34, 206)' : 'rgba(147, 51, 234, 0.9)';
        ctx.fillRect(tx, ty - 16, ctx.measureText(label).width + 10, 16);
        ctx.fillStyle = '#fff'; ctx.fillText(label, tx + 5, ty - 4);
      });

      // Draw Questions
      regions.forEach(region => {
        const { ymin, xmin, ymax, xmax } = region.box;
        const startX = (xmin / 1000) * drawWidth;
        const startY = (ymin / 1000) * drawHeight;
        const width = ((xmax - xmin) / 1000) * drawWidth;
        const height = ((ymax - ymin) / 1000) * drawHeight;

        ctx.beginPath(); ctx.rect(startX, startY, width, height);
        if (region.isSelected) {
          ctx.fillStyle = 'rgba(34, 197, 94, 0.2)'; ctx.lineWidth = 2; ctx.strokeStyle = '#16a34a';
        } else {
           ctx.fillStyle = 'rgba(59, 130, 246, 0.1)'; ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)';
        }
        ctx.fill(); ctx.stroke();

        ctx.fillStyle = region.isSelected ? '#16a34a' : 'rgba(59, 130, 246, 0.8)';
        ctx.font = 'bold 12px sans-serif';
        const text = `Q${region.questionNumber}`;
        const textMetrics = ctx.measureText(text);
        ctx.fillRect(startX, startY - 20 > 0 ? startY - 20 : startY, textMetrics.width + 12, 20);
        ctx.fillStyle = 'white'; ctx.fillText(text, startX + 6, (startY - 20 > 0 ? startY - 6 : startY + 14));
      });

      // Resize handles on the selected box or passage
      const drawHandles = (box: BoundingBox, color: string) => {
        handlePoints(box).forEach(([, hx, hy]) => {
          const px = (hx / 1000) * drawWidth, py = (hy / 1000) * drawHeight;
          ctx.fillStyle = '#fff'; ctx.strokeStyle = color; ctx.lineWidth = 1.5;
          ctx.fillRect(px - 5, py - 5, 10, 10);
          ctx.strokeRect(px - 5, py - 5, 10, 10);
        });
      };
      const sel = regions.find(r => r.isSelected);
      if (sel) drawHandles(sel.box, '#16a34a');
      if (selectedPassage) drawHandles(selectedPassage, 'rgb(126, 34, 206)');

      // Draft box while drawing a new question box (green) or passage (purple)
      if (draftBox) {
        const purple = tool === 'passage';
        ctx.beginPath();
        ctx.rect((draftBox.xmin / 1000) * drawWidth, (draftBox.ymin / 1000) * drawHeight,
          ((draftBox.xmax - draftBox.xmin) / 1000) * drawWidth, ((draftBox.ymax - draftBox.ymin) / 1000) * drawHeight);
        ctx.setLineDash([6, 4]); ctx.strokeStyle = purple ? 'rgb(126, 34, 206)' : '#16a34a'; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = purple ? 'rgba(168, 85, 247, 0.10)' : 'rgba(34, 197, 94, 0.08)'; ctx.fill();
      }
    }
  }, [activePage, containerSize, draftBox, selectedPassage, tool]);

  /**
   * A question's image: the question box (number masked out when inside it),
   * or, for questions that share a passage, the passage on top and the
   * question below it (same layout as the CLI, via stackLayout).
   */
  const composeCrop = (
    draw: (ctx: CanvasRenderingContext2D, r: { sx: number; sy: number; sw: number; sh: number }, dx: number, dy: number) => void,
    W: number, H: number, qBox: BoundingBox, cBox?: BoundingBox, mask?: BoundingBox,
  ): HTMLCanvasElement => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const q = cropRect(qBox, W, H);
    const c = cBox ? cropRect(cBox, W, H) : null;
    const at = c ? stackLayout(c, q, Math.round(H * 0.012)) : { width: q.sw, height: q.sh, qAt: { x: 0, y: 0 }, ctxAt: { x: 0, y: 0 } };
    canvas.width = at.width; canvas.height = at.height;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, at.width, at.height);
    if (c) draw(ctx, c, at.ctxAt.x, at.ctxAt.y);
    draw(ctx, q, at.qAt.x, at.qAt.y);
    const m = maskRect(mask, q, W, H);
    if (m) { ctx.fillStyle = '#fff'; ctx.fillRect(at.qAt.x + m.x, at.qAt.y + m.y, m.w, m.h); }
    return canvas;
  };

  const cropImage = (img: HTMLImageElement, qBox: BoundingBox, cBox?: BoundingBox, mask?: BoundingBox): string =>
    composeCrop((ctx, r, dx, dy) => ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, dx, dy, r.sw, r.sh),
      img.width, img.height, qBox, cBox, mask).toDataURL('image/jpeg', 0.95);

  // --- Manual region editing -------------------------------------------------

  const canvasNorm = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return {
      nx: Math.max(0, Math.min(1000, ((e.clientX - rect.left) / rect.width) * 1000)),
      ny: Math.max(0, Math.min(1000, ((e.clientY - rect.top) / rect.height) * 1000)),
      tolX: (12 / rect.width) * 1000,
      tolY: (12 / rect.height) * 1000,
    };
  };

  const updateRegionBox = (regionId: string, box: BoundingBox) => {
    setPages(prev => prev.map(p => p.id !== activePageId ? p : {
      ...p, regions: p.regions.map(r => r.id === regionId ? { ...r, box } : r)
    }));
  };

  const recrop = (p: PageData, r: QuestionRegion): QuestionRegion =>
    p.imageObj ? { ...r, croppedDataUrl: cropImage(p.imageObj, r.box, r.contextBox, r.mask) } : r;

  /** Applies `fn` to a page's regions; the ones it changes get a new crop. */
  const editRegions = (pageId: string, fn: (r: QuestionRegion) => QuestionRegion) => {
    setPages(prev => prev.map(p => p.id !== pageId ? p : {
      ...p, regions: p.regions.map(r => { const n = fn(r); return n === r ? r : recrop(p, n); }),
    }));
  };

  const refreshCrop = (regionId: string) => {
    if (activePageId) editRegions(activePageId, r => r.id === regionId ? { ...r } : r);
  };

  // --- Shared passages ---------------------------------------------------------

  /** Moves every question using passage `from` over to box `to` (no recrop). */
  const movePassage = (from: BoundingBox, to: BoundingBox) => {
    const key = boxKey(from);
    setPages(prev => prev.map(p => p.id !== activePageId ? p : {
      ...p, regions: p.regions.map(r => boxKey(r.contextBox) === key ? { ...r, contextBox: to } : r),
    }));
    setSelectedPassage(to);
  };

  /** Uses (or stops using) the selected passage for one question. */
  const togglePassageFor = (regionId: string, on: boolean) => {
    if (!selectedPassage || !activePageId) return;
    editRegions(activePageId, r => r.id !== regionId ? r : { ...r, contextBox: on ? selectedPassage : undefined });
  };

  const deleteSelectedPassage = () => {
    if (!selectedPassage || !activePageId) return;
    const key = boxKey(selectedPassage);
    editRegions(activePageId, r => boxKey(r.contextBox) === key ? { ...r, contextBox: undefined } : r);
    setSelectedPassage(null);
  };

  // Detection can attach the wrong passage; this drops it from the crop.
  const handleRemovePassage = (regionId: string, pageId: string) => {
    editRegions(pageId, r => r.id !== regionId ? r : { ...r, contextBox: undefined });
  };

  // --- Question numbers --------------------------------------------------------

  const setQuestionNumber = (regionId: string, pageId: string, value: string) => {
    const n = value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    setEditingNumberId(null);
    if (!n) return;
    setPages(prev => prev.map(p => p.id !== pageId ? p : {
      ...p, regions: p.regions.map(r => r.id === regionId ? { ...r, questionNumber: n } : r),
    }));
  };

  /**
   * A number for a box drawn by hand, from where it sits among the page's
   * questions: one past the question before it in reading order, or one
   * before the question after it (a missed Q1 above Q2 becomes Q1), and
   * only if that number is free; else one past the highest.
   */
  const guessNumber = (box: BoundingBox, regions: QuestionRegion[]): string => {
    const nums = regions.map(r => parseInt(r.questionNumber, 10));
    const used = new Set(nums);
    const sorted = regions.filter((_, i) => !isNaN(nums[i])).sort((a, b) => readingOrder(a.box, b.box));
    const prev = [...sorted].reverse().find(r => readingOrder(r.box, box) < 0);
    const next = sorted.find(r => readingOrder(r.box, box) > 0);
    if (prev && !used.has(parseInt(prev.questionNumber, 10) + 1)) return String(parseInt(prev.questionNumber, 10) + 1);
    if (next && parseInt(next.questionNumber, 10) > 1 && !used.has(parseInt(next.questionNumber, 10) - 1)) {
      return String(parseInt(next.questionNumber, 10) - 1);
    }
    const valid = nums.filter(n => !isNaN(n));
    return String((valid.length ? Math.max(...valid) : 0) + 1);
  };

  const handleDeleteRegion = (regionId: string, pageId: string) => {
    setPages(prev => prev.map(p => p.id !== pageId ? p : {
      ...p, regions: p.regions.filter(r => r.id !== regionId)
    }));
  };

  // --- Canvas mouse handling ---------------------------------------------------

  const inBox = (b: BoundingBox, nx: number, ny: number) => nx >= b.xmin && nx <= b.xmax && ny >= b.ymin && ny <= b.ymax;

  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (!activePage || activePage.status !== 'READY') return;
    const { nx, ny, tolX, tolY } = canvasNorm(e);

    if (tool !== 'select') {
      dragRef.current = { mode: 'create', kind: tool, startNX: nx, startNY: ny };
      setDraftBox({ xmin: nx, ymin: ny, xmax: nx, ymax: ny });
      return;
    }

    const onHandle = (b: BoundingBox) =>
      handlePoints(b).find(([, hx, hy]) => Math.abs(nx - hx) <= tolX && Math.abs(ny - hy) <= tolY)?.[0];
    if (selectedPassage) {
      const handle = onHandle(selectedPassage);
      if (handle) {
        dragRef.current = { mode: 'resize-passage', handle, origBox: { ...selectedPassage }, cur: selectedPassage };
        return;
      }
    }
    const sel = activePage.regions.find(r => r.isSelected);
    if (sel) {
      const handle = onHandle(sel.box);
      if (handle) {
        dragRef.current = { mode: 'resize', regionId: sel.id, handle, origBox: { ...sel.box } };
        return;
      }
    }

    // Question boxes sit on top of passages.
    const hit = [...activePage.regions].reverse().find(r => inBox(r.box, nx, ny));
    if (hit) {
      setSelectedPassage(null);
      if (!hit.isSelected) handleSelectRegion(hit.id, activePage.id);
      revealInList(`crop-${hit.id}`, 'nearest');
      dragRef.current = { mode: 'move', regionId: hit.id, startNX: nx, startNY: ny, origBox: { ...hit.box } };
      return;
    }
    const passage = [selectedPassage, ...activePage.regions.map(r => r.contextBox)]
      .find((b): b is BoundingBox => !!b && inBox(b, nx, ny));
    if (passage) {
      setSelectedPassage(passage);
      setPages(prev => prev.map(p => p.id !== activePage.id ? p : {
        ...p, regions: p.regions.map(r => r.isSelected ? { ...r, isSelected: false } : r),
      }));
      dragRef.current = { mode: 'move-passage', startNX: nx, startNY: ny, origBox: { ...passage }, cur: passage };
      return;
    }
    setSelectedPassage(null);
  };

  const handleCanvasMouseMove = (e: React.MouseEvent) => {
    const drag = dragRef.current;
    if (!drag || !activePage) return;
    const { nx, ny } = canvasNorm(e);

    const moved = (o: BoundingBox, startNX: number, startNY: number): BoundingBox => {
      const w = o.xmax - o.xmin, h = o.ymax - o.ymin;
      const xmin = Math.max(0, Math.min(1000 - w, o.xmin + nx - startNX));
      const ymin = Math.max(0, Math.min(1000 - h, o.ymin + ny - startNY));
      return { xmin, ymin, xmax: xmin + w, ymax: ymin + h };
    };
    const resized = (o: BoundingBox, handle: ResizeHandle): BoundingBox => {
      const b = { ...o };
      if (handle.includes('w')) b.xmin = Math.min(nx, b.xmax - MIN_BOX);
      if (handle.includes('e')) b.xmax = Math.max(nx, b.xmin + MIN_BOX);
      if (handle.includes('n')) b.ymin = Math.min(ny, b.ymax - MIN_BOX);
      if (handle.includes('s')) b.ymax = Math.max(ny, b.ymin + MIN_BOX);
      return b;
    };

    if (drag.mode === 'create') {
      setDraftBox({
        xmin: Math.min(drag.startNX, nx), ymin: Math.min(drag.startNY, ny),
        xmax: Math.max(drag.startNX, nx), ymax: Math.max(drag.startNY, ny),
      });
    } else if (drag.mode === 'move') {
      updateRegionBox(drag.regionId, moved(drag.origBox, drag.startNX, drag.startNY));
    } else if (drag.mode === 'resize') {
      updateRegionBox(drag.regionId, resized(drag.origBox, drag.handle));
    } else {
      const to = drag.mode === 'move-passage'
        ? moved(drag.origBox, drag.startNX, drag.startNY)
        : resized(drag.origBox, drag.handle);
      movePassage(drag.cur, to);
      drag.cur = to;
    }
  };

  const handleCanvasMouseUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !activePage) { setDraftBox(null); return; }

    if (drag.mode === 'create') {
      const b = draftBox;
      setDraftBox(null);
      setTool('select');
      if (!b || b.xmax - b.xmin < MIN_BOX || b.ymax - b.ymin < MIN_BOX || !activePage.imageObj) return;
      const box: BoundingBox = {
        xmin: Math.round(b.xmin), ymin: Math.round(b.ymin),
        xmax: Math.round(b.xmax), ymax: Math.round(b.ymax),
      };
      if (drag.kind === 'passage') {
        // The passage panel opens for it; the first question after it in
        // reading order uses it from the start (the rest are ticked by hand).
        setSelectedPassage(box);
        const first = [...activePage.regions].sort((x, y) => readingOrder(x.box, y.box)).find(r => readingOrder(r.box, box) > 0);
        editRegions(activePage.id, r => r.id === first?.id ? { ...r, contextBox: box, isSelected: false } : r.isSelected ? { ...r, isSelected: false } : r);
        return;
      }
      setSelectedPassage(null);
      const newRegion: QuestionRegion = {
        id: generateId(),
        questionNumber: guessNumber(box, activePage.regions),
        pageNumber: activePage.pageNumber,
        pageLabel: activePage.pageLabel,
        testNumber: activePage.testNumber,
        topic: activePage.topic,
        box,
        croppedDataUrl: cropImage(activePage.imageObj, box),
        isSelected: true,
      };
      setPages(prev => prev.map(p => p.id !== activePage.id ? p : {
        ...p, regions: [...p.regions.map(r => ({ ...r, isSelected: false })), newRegion]
      }));
    } else if (drag.mode === 'move-passage' || drag.mode === 'resize-passage') {
      const key = boxKey(drag.cur);
      editRegions(activePage.id, r => boxKey(r.contextBox) === key ? { ...r } : r);
    } else {
      refreshCrop(drag.regionId);
    }
  };

  /**
   * The exported image. PDF crops are rendered again from the PDF at
   * PDF_EXPORT_DPI (the on-screen preview comes from a smaller page render);
   * image crops are already cut from the original file at full resolution.
   */
  const exportBlob = async (region: QuestionRegion, page: PageData): Promise<Blob | null> => {
    if (page.pdf) {
      try {
        const pdf = page.pdf;
        const { width, height } = await pdf.size(PDF_EXPORT_DPI);
        const pieces = new Map<string, HTMLCanvasElement>();
        for (const b of [region.box, region.contextBox].filter(Boolean) as BoundingBox[]) {
          const r = cropRect(b, width, height);
          pieces.set(`${r.sx},${r.sy}`, await pdf.renderRegion(PDF_EXPORT_DPI, r));
        }
        const canvas = composeCrop((ctx, r, dx, dy) => ctx.drawImage(pieces.get(`${r.sx},${r.sy}`)!, dx, dy),
          width, height, region.box, region.contextBox, region.mask);
        return await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.95));
      } catch (err) {
        console.warn('High-res render failed; exporting the preview crop', err);
      }
    }
    return region.croppedDataUrl ? (await fetch(region.croppedDataUrl)).blob() : null;
  };

  const saveBlob = (blob: Blob, name: string) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  };

  const handleDownloadCrop = async (region: QuestionRegion, pageId: string) => {
    const page = pages.find(p => p.id === pageId);
    const blob = page && await exportBlob(region, page);
    if (blob) saveBlob(blob, cropFilename(region, pageId));
  };

  const cropFilename = (region: QuestionRegion, pageId: string) => cropFileName({
    testNumber: region.testNumber,
    topic: topicByPage.get(pageId) ?? region.topic,
    questionNumber: region.questionNumber,
    pageLabel: region.pageLabel ?? region.pageNumber,
  });

  const handleDownloadAll = async () => {
    if (exportProgress) return;
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    const jobs = pages.flatMap(page => page.regions.filter(r => r.croppedDataUrl).map(region => ({ page, region })));
    // Same name twice (a number used twice) would overwrite: add _2, _3.
    const used = new Set<string>();
    try {
      for (let i = 0; i < jobs.length; i++) {
        setExportProgress(`${i + 1} / ${jobs.length}`);
        const { page, region } = jobs[i];
        const blob = await exportBlob(region, page);
        let name = cropFilename(region, page.id);
        for (let k = 2; used.has(name); k++) name = cropFilename(region, page.id).replace(/\.jpg$/, `_${k}.jpg`);
        used.add(name);
        if (blob) zip.file(name, blob);
      }
      setExportProgress('Zipping…');
      saveBlob(await zip.generateAsync({ type: 'blob' }), 'q-crop-export.zip');
    } finally {
      setExportProgress(null);
    }
  };

  const handleSelectRegion = (id: string, pId: string) => {
    setPages(prev => prev.map(p => {
      if (p.id !== pId) return p;
      return { ...p, regions: p.regions.map(r => ({ ...r, isSelected: r.id === id })) };
    }));
  };

  const allQuestions = useMemo(() => pages.flatMap(p => p.regions), [pages]);

  return (
    <>
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shrink-0 sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <div className="bg-brand-600 text-white p-2.5 rounded-2xl shadow-lg shadow-brand-100">
            <ScissorsIcon className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-slate-900 tracking-tighter leading-none mb-1">Q-Crop</h1>
            <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400 font-black">Intelligent Extraction Pro</p>
          </div>
        </div>
        
        {pages.length > 0 && (
          <button onClick={() => {setPages([]); setActivePageId(null);}} className="px-5 py-2.5 text-sm font-black text-slate-600 hover:text-red-600 bg-slate-100 hover:bg-red-50 rounded-xl transition-all uppercase tracking-widest">
            Reset App
          </button>
        )}
      </header>

      <main className="flex-1 flex overflow-hidden">
        {pages.length === 0 ? (
           <Uploader onImagesSelected={handleImagesSelected} isLoading={false} />
        ) : (
          <div className="flex-1 flex w-full h-full">
            
            {/* Page Navigation Strip */}
            <div className="w-24 bg-slate-900 border-r border-slate-800 flex flex-col shrink-0 overflow-y-auto items-center py-4 gap-4 no-scrollbar">
              {pages.map((p, idx) => (
                <button 
                  key={p.id}
                  id={`thumb-${p.id}`}
                  onClick={() => { setActivePageId(p.id); revealInList(`page-section-${p.id}`, 'start'); }}
                  className={`w-14 h-14 rounded-2xl overflow-hidden border-4 transition-all relative flex-shrink-0
                    ${activePageId === p.id ? 'border-brand-500 scale-110 shadow-lg shadow-brand-500/20' : 'border-slate-700 hover:border-slate-500 opacity-60'}
                  `}
                >
                  {p.dataUrl && <img src={p.dataUrl} className="w-full h-full object-cover" />}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-[10px] font-black uppercase">
                    {p.status === 'ANALYZING' ? <LoaderIcon className="w-4 h-4" /> : `P${p.pageNumber}`}
                  </div>
                </button>
              ))}
            </div>

            <div className="flex-1 bg-slate-100 p-6 overflow-hidden relative flex flex-col" ref={containerRef}>
                <div className="flex-1 flex items-center justify-center relative shadow-2xl bg-slate-300/30 rounded-3xl overflow-hidden border border-slate-200/50">
                    {activePage?.status === 'READY' && (
                      <div className="absolute top-4 left-4 z-20 flex gap-2">
                        <button
                          onClick={() => setTool(t => t === 'box' ? 'select' : 'box')}
                          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest shadow-lg transition-all
                            ${tool === 'box' ? 'bg-brand-600 text-white ring-4 ring-brand-200' : 'bg-white text-slate-700 hover:bg-brand-50 hover:text-brand-700'}`}
                        >
                          <PlusIcon className="w-4 h-4" />
                          {tool === 'box' ? 'Drag on page to draw box' : 'Add Box'}
                        </button>
                        <button
                          onClick={() => setTool(t => t === 'passage' ? 'select' : 'passage')}
                          title="Draw a passage (text, table or figure) that several questions share; each of them is then cropped as passage + question"
                          className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest shadow-lg transition-all
                            ${tool === 'passage' ? 'bg-purple-600 text-white ring-4 ring-purple-200' : 'bg-white text-slate-700 hover:bg-purple-50 hover:text-purple-700'}`}
                        >
                          <PlusIcon className="w-4 h-4" />
                          {tool === 'passage' ? 'Drag on page to draw passage' : 'Add Passage'}
                        </button>
                      </div>
                    )}
                    {activePage?.imageObj ? (
                      <canvas
                        ref={canvasRef}
                        className="block max-w-full max-h-full shadow-2xl bg-white"
                        style={{ cursor: tool !== 'select' ? 'crosshair' : 'default' }}
                        onMouseDown={handleCanvasMouseDown}
                        onMouseMove={handleCanvasMouseMove}
                        onMouseUp={handleCanvasMouseUp}
                        onMouseLeave={handleCanvasMouseUp}
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-4">
                        <LoaderIcon className="w-12 h-12 text-brand-500" />
                        <span className="text-slate-500 font-bold">Preparing Page {activePage?.pageNumber}...</span>
                      </div>
                    )}
                    
                    {activePage?.status === 'ANALYZING' && (
                      <div className="absolute inset-0 bg-white/40 backdrop-blur-sm flex items-center justify-center z-10">
                         <div className="bg-white px-8 py-5 rounded-3xl shadow-2xl flex items-center gap-4">
                           <LoaderIcon className="w-6 h-6 text-brand-600" />
                           <span className="font-black text-slate-800 text-sm uppercase tracking-widest">AI Scanning Page {activePage.pageNumber}</span>
                         </div>
                      </div>
                    )}
                </div>
                
                <div className="h-14 flex flex-col items-center justify-center">
                   <div className="flex items-center gap-4 text-slate-400 font-black text-[10px] uppercase tracking-[0.2em]">
                      <span>Page {activePage?.pageNumber || '...'}</span>
                      {activePage?.testNumber && (
                        <>
                          <span className="w-1 h-1 bg-slate-300 rounded-full"></span>
                          <span className="text-brand-600">Test {activePage.testNumber}</span>
                        </>
                      )}
                      {activePage && topicByPage.get(activePage.id) && (
                        <>
                          <span className="w-1 h-1 bg-slate-300 rounded-full"></span>
                          <span className="text-slate-500">{topicByPage.get(activePage.id)}</span>
                        </>
                      )}
                   </div>
                </div>
            </div>

            <div className="w-[400px] bg-white border-l border-slate-200 flex flex-col shrink-0 z-20 overflow-hidden">
              <div className="p-8 border-b border-slate-100 bg-slate-50/20 shrink-0">
                <div className="flex justify-between items-end mb-6">
                  <div>
                    <h2 className="text-xl font-black text-slate-900 tracking-tighter">Export Queue</h2>
                    <p className="text-xs text-slate-400 font-bold uppercase tracking-widest mt-1">Files named by Test & Topic</p>
                  </div>
                  <span className="bg-slate-900 text-white text-[10px] font-black px-3 py-1.5 rounded-lg">
                    {allQuestions.length} TOTAL
                  </span>
                </div>
                
                <button
                  onClick={handleDownloadAll}
                  disabled={allQuestions.length === 0 || !!exportProgress}
                  className="w-full bg-brand-600 hover:bg-brand-700 text-white font-black py-4 px-4 rounded-2xl flex items-center justify-center gap-3 transition-all disabled:opacity-20 shadow-xl shadow-brand-100 active:scale-[0.97] uppercase text-sm tracking-widest"
                >
                  {exportProgress ? <LoaderIcon className="w-5 h-5 animate-spin" /> : <DownloadIcon className="w-5 h-5" />}
                  {exportProgress ? `Exporting ${exportProgress}` : 'Export All (Auto-Named)'}
                </button>
              </div>

                {activePage?.status === 'READY' && selectedPassage && (
                  <div className="mx-6 mt-4 bg-purple-50/60 rounded-2xl border-2 border-purple-200 p-4 shrink-0">
                    <div className="text-[11px] font-black uppercase tracking-widest text-purple-700">Shared passage</div>
                    <p className="text-[11px] text-slate-500 mt-1 mb-3">
                      Tick the questions that use it. Each one is cropped as passage + question. Drag the purple box to move or resize it.
                    </p>
                    <div className="grid grid-cols-4 gap-1.5 max-h-40 overflow-y-auto">
                      {[...activePage.regions]
                        .sort((x, y) => (parseInt(x.questionNumber, 10) - parseInt(y.questionNumber, 10)) || readingOrder(x.box, y.box))
                        .map(r => {
                          const on = boxKey(r.contextBox) === boxKey(selectedPassage);
                          return (
                            <label key={r.id} className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-black cursor-pointer border
                              ${on ? 'bg-purple-50 border-purple-300 text-purple-800' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
                              <input type="checkbox" className="accent-purple-600" checked={on}
                                onChange={e => togglePassageFor(r.id, e.target.checked)} />
                              Q{r.questionNumber}
                            </label>
                          );
                        })}
                    </div>
                    {activePage.regions.length === 0 && (
                      <p className="text-[11px] text-slate-400">No questions on this page yet. Add their boxes first.</p>
                    )}
                    <div className="flex gap-2 mt-3">
                      <button onClick={deleteSelectedPassage}
                        className="flex-1 text-[11px] font-black uppercase tracking-wider py-2 rounded-lg text-red-600 hover:bg-red-50">
                        Delete
                      </button>
                      <button onClick={() => setSelectedPassage(null)}
                        className="flex-1 text-[11px] font-black uppercase tracking-wider py-2 rounded-lg bg-purple-600 text-white hover:bg-purple-700">
                        Done
                      </button>
                    </div>
                  </div>
                )}
              <div className="flex-1 overflow-y-auto p-6 space-y-8 no-scrollbar">
                {pages.map(page => (
                  <div key={page.id} id={`page-section-${page.id}`} className="space-y-4 scroll-mt-2">
                    <div className="sticky top-0 z-10 bg-white/90 backdrop-blur py-2 flex flex-col border-b border-slate-100">
                      <div className="flex items-center gap-3">
                        <div className="w-6 h-6 bg-slate-800 text-white rounded-lg flex items-center justify-center text-[10px] font-black">
                          {page.pageNumber}
                        </div>
                        <span className="text-xs font-black text-slate-800 uppercase tracking-widest">Page {page.pageNumber}</span>
                      </div>
                      {topicByPage.get(page.id) && (
                        <span className="text-[10px] text-slate-400 font-bold truncate mt-1 pl-9">
                          {topicByPage.get(page.id)}
                        </span>
                      )}
                    </div>

                    {[...page.regions].sort((x, y) =>
                      (parseInt(x.questionNumber, 10) - parseInt(y.questionNumber, 10)) || readingOrder(x.box, y.box)).map((region) => (
                      <div 
                        key={region.id}
                        id={`crop-${region.id}`}
                        className={`group relative border-2 rounded-2xl overflow-hidden transition-all duration-300
                          ${region.isSelected ? 'border-brand-500 shadow-xl shadow-brand-50/50 scale-[1.02]' : 'border-slate-100 hover:border-slate-300'}
                        `}
                        onClick={() => { setActivePageId(page.id); handleSelectRegion(region.id, page.id); }}
                      >
                        <div className={`px-4 py-3 flex justify-between items-center transition-colors ${region.isSelected ? 'bg-brand-50' : 'bg-slate-50'}`}>
                          <div className="flex flex-col">
                            {editingNumberId === region.id ? (
                              <input
                                autoFocus
                                defaultValue={region.questionNumber}
                                inputMode="numeric"
                                onClick={e => e.stopPropagation()}
                                onFocus={e => e.target.select()}
                                onBlur={e => setQuestionNumber(region.id, page.id, e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                                  if (e.key === 'Escape') setEditingNumberId(null);
                                }}
                                className="w-16 text-[11px] font-black px-2 py-0.5 rounded-lg border-2 border-brand-500 outline-none"
                              />
                            ) : (
                              <button
                                onClick={e => { e.stopPropagation(); setEditingNumberId(region.id); }}
                                title="Change the question number"
                                className={`text-[11px] font-black px-2 py-0.5 rounded-lg w-fit flex items-center gap-1 hover:ring-2 hover:ring-brand-300 ${region.isSelected ? 'bg-brand-600 text-white' : 'bg-slate-800 text-white'}`}
                              >
                                Q{region.questionNumber}
                                <span className="opacity-60 text-[9px]">✎</span>
                              </button>
                            )}
                            {page.regions.some(o => o.id !== region.id && o.questionNumber === region.questionNumber) && (
                              <span className="text-[9px] font-bold text-red-600 mt-1">Same number used twice on this page</span>
                            )}
                            <span className="text-[9px] text-slate-400 font-bold mt-1">
                              {region.testNumber ? `Test ${region.testNumber}` : ''}
                            </span>
                            {region.contextBox && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleRemovePassage(region.id, page.id); }}
                                title="This question shares a passage with others; click to crop it without the passage"
                                className="text-[9px] font-bold mt-1 px-1.5 py-0.5 rounded-md w-fit bg-purple-100 text-purple-700 hover:bg-red-100 hover:text-red-700 transition-colors"
                              >
                                + passage ✕
                              </button>
                            )}
                          </div>
                          <div className="flex items-center">
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDownloadCrop(region, page.id); }}
                              className="text-slate-400 hover:text-brand-600 p-2 rounded-xl hover:bg-white transition-all"
                            >
                               <DownloadIcon className="w-5 h-5" />
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDeleteRegion(region.id, page.id); }}
                              title="Delete this crop (or select its box on the page and press Delete)"
                              className="text-slate-400 hover:text-red-600 p-2 rounded-xl hover:bg-white transition-all"
                            >
                               <TrashIcon className="w-5 h-5" />
                            </button>
                          </div>
                        </div>
                        
                        <div className="bg-white p-4">
                          {region.croppedDataUrl ? (
                             <img src={region.croppedDataUrl} className="w-full h-auto max-h-64 object-contain rounded-xl border border-slate-50" />
                          ) : (
                             <div className="w-full h-24 flex items-center justify-center bg-slate-50 rounded-xl animate-pulse text-[10px] font-bold text-slate-300 uppercase tracking-widest">Cleaning...</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
