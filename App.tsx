import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import JSZip from 'jszip';
import Uploader from './components/Uploader';
import { analyzeTestPage } from './services/geminiService';
import { QuestionRegion, AppStatus, BoundingBox, PageData } from './types';
import { LoaderIcon, DownloadIcon, ScissorsIcon, ZipIcon } from './components/Icons';

export default function App() {
  const [pages, setPages] = useState<PageData[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [isZipping, setIsZipping] = useState(false);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const generateId = () => Math.random().toString(36).substr(2, 9);

  const activePage = useMemo(() => 
    pages.find(p => p.id === activePageId), [pages, activePageId]
  );

  const handleImagesSelected = useCallback(async (newFiles: { dataUrl: string, file: File }[]) => {
    const newPages: PageData[] = newFiles.map(f => ({
      id: generateId(),
      file: f.file,
      dataUrl: f.dataUrl,
      imageObj: null,
      status: 'IDLE',
      regions: [],
      pageNumber: '...',
    }));

    setPages(prev => [...prev, ...newPages]);
    if (!activePageId) setActivePageId(newPages[0].id);
    setIsProcessing(true);
    setStartTime(Date.now());
    setDuration(null);
  }, [activePageId]);

  // Serial processing effect for pages
  useEffect(() => {
    const processNext = async () => {
      const pendingPage = pages.find(p => p.status === 'IDLE');
      if (!pendingPage) {
        setIsProcessing(false);
        if (startTime) {
          setDuration(Math.round((Date.now() - startTime) / 1000));
        }
        return;
      }

      setPages(prev => prev.map(p => p.id === pendingPage.id ? { ...p, status: 'ANALYZING' } : p));

      try {
        const img = new Image();
        img.src = pendingPage.dataUrl;
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });

        const base64 = pendingPage.dataUrl.split(',')[1];
        const result = await analyzeTestPage(base64, pendingPage.file.type);

        // Logic for Test Number Inheritance
        let finalTestNumber = result.testNumber;
        let finalTopic = result.topic;
        
        const pendingIndex = pages.findIndex(p => p.id === pendingPage.id);
        const prevPage = pendingIndex > 0 ? pages[pendingIndex - 1] : null;

        if (!finalTestNumber && prevPage && prevPage.testNumber) {
          const firstQNum = parseInt(result.regions[0]?.questionNumber || '0');
          // If it doesn't start with 1, it's likely a continuation of the previous test
          if (firstQNum > 1) {
            finalTestNumber = prevPage.testNumber;
            if (!finalTopic) finalTopic = prevPage.topic;
          }
        }

        const regionsWithData: QuestionRegion[] = result.regions.map(r => ({
          ...r,
          id: generateId(),
          pageNumber: result.pageNumber,
          testNumber: finalTestNumber,
          topic: finalTopic,
          croppedDataUrl: cropImage(img, r.box, (r as any).contextBox)
        }));

        setPages(prev => prev.map(p => p.id === pendingPage.id ? { 
          ...p, 
          status: 'READY', 
          imageObj: img,
          pageNumber: result.pageNumber,
          testNumber: finalTestNumber,
          topic: finalTopic,
          regions: regionsWithData 
        } : p));
      } catch (err: any) {
        setPages(prev => prev.map(p => p.id === pendingPage.id ? { 
          ...p, 
          status: 'ERROR', 
          error: err.message 
        } : p));
      }
    };

    if (isProcessing) processNext();
  }, [pages, isProcessing]);

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
      // Draw Contexts
      const drawnContexts = new Set<string>();
      regions.forEach(region => {
        if (region.contextBox) {
          const c = region.contextBox;
          const key = `${c.xmin},${c.ymin},${c.xmax},${c.ymax}`;
          if (!drawnContexts.has(key)) {
            drawnContexts.add(key);
            ctx.beginPath();
            ctx.rect((c.xmin / 1000) * drawWidth, (c.ymin / 1000) * drawHeight, ((c.xmax - c.xmin) / 1000) * drawWidth, ((c.ymax - c.ymin) / 1000) * drawHeight);
            ctx.fillStyle = 'rgba(168, 85, 247, 0.05)'; 
            ctx.fill();
            ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(168, 85, 247, 0.4)'; ctx.stroke(); ctx.setLineDash([]); 
          }
        }
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
    }
  }, [activePage, containerRef.current?.clientWidth, containerRef.current?.clientHeight]);

  const cropImage = (img: HTMLImageElement, qBox: BoundingBox, cBox?: BoundingBox): string => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    const getC = (box: BoundingBox, isQ: boolean) => {
      const padX = isQ ? img.width * 0.002 : img.width * 0.005;
      const padY = isQ ? img.height * 0.002 : img.height * 0.005;
      // For questions, we don't add padding to the left (xmin) to avoid re-capturing the number label
      const sx = Math.max(0, (box.xmin / 1000) * img.width - (isQ ? 0 : padX));
      const sy = Math.max(0, (box.ymin / 1000) * img.height - padY);
      const sw = Math.min(img.width - sx, ((box.xmax - box.xmin) / 1000) * img.width + (isQ ? padX : padX * 2));
      const sh = Math.min(img.height - sy, ((box.ymax - box.ymin) / 1000) * img.height + (padY * 2));
      return { sx, sy, sw, sh };
    };

    const q = getC(qBox, true);
    if (!cBox) {
      canvas.width = q.sw; canvas.height = q.sh; ctx.fillStyle = '#fff'; ctx.fillRect(0,0,q.sw,q.sh);
      ctx.drawImage(img, q.sx, q.sy, q.sw, q.sh, 0, 0, q.sw, q.sh);
    } else {
      const c = getC(cBox, false); const gap = 40;
      canvas.width = Math.max(c.sw, q.sw); canvas.height = c.sh + gap + q.sh;
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(img, c.sx, c.sy, c.sw, c.sh, (canvas.width-c.sw)/2, 0, c.sw, c.sh);
      ctx.beginPath(); ctx.setLineDash([10,10]); ctx.moveTo(30, c.sh+gap/2); ctx.lineTo(canvas.width-30, c.sh+gap/2);
      ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
      ctx.drawImage(img, q.sx, q.sy, q.sw, q.sh, (canvas.width-q.sw)/2, c.sh+gap, q.sw, q.sh);
    }
    return canvas.toDataURL('image/jpeg', 0.92);
  };

  const sanitizeFilename = (str: string) => {
    // Support Turkish characters: ç, ğ, ı, ö, ş, ü
    return str
      .replace(/[^a-z0-9çğıöşüÇĞİÖŞÜ]/gi, '_')
      .replace(/_+/g, '_')
      .toLowerCase();
  };

  const handleDownloadCrop = (region: QuestionRegion) => {
    if (!region.croppedDataUrl) return;
    const link = document.createElement('a');
    link.href = region.croppedDataUrl;
    
    // Complex filename convention
    const testPart = region.testNumber ? `Test${sanitizeFilename(region.testNumber)}_` : '';
    const topicPart = region.topic ? `${sanitizeFilename(region.topic)}_` : '';
    const name = `${testPart}${topicPart}Q${region.questionNumber}_${region.pageNumber}.jpg`;
    
    link.download = name;
    document.body.appendChild(link); link.click(); document.body.removeChild(link);
  };

  const handleDownloadAll = () => {
    let count = 0;
    pages.forEach(page => {
      page.regions.forEach(region => {
        if (region.croppedDataUrl) {
          setTimeout(() => handleDownloadCrop(region), count * 200);
          count++;
        }
      });
    });
  };

  const handleDownloadZip = async () => {
    if (allQuestions.length === 0) return;
    setIsZipping(true);
    try {
      const zip = new JSZip();
      
      for (const region of allQuestions) {
        if (region.croppedDataUrl) {
          const base64Data = region.croppedDataUrl.split(',')[1];
          const testPart = region.testNumber ? `Test${sanitizeFilename(region.testNumber)}_` : '';
          const topicPart = region.topic ? `${sanitizeFilename(region.topic)}_` : '';
          const name = `${testPart}${topicPart}Q${region.questionNumber}_${region.pageNumber}.jpg`;
          zip.file(name, base64Data, { base64: true });
        }
      }

      const content = await zip.generateAsync({ type: 'blob' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(content);
      link.download = `Q-Crop_Export_${new Date().toISOString().split('T')[0]}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error('Error creating ZIP:', error);
    } finally {
      setIsZipping(false);
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
                  onClick={() => setActivePageId(p.id)}
                  className={`w-14 h-14 rounded-2xl overflow-hidden border-4 transition-all relative flex-shrink-0
                    ${activePageId === p.id ? 'border-brand-500 scale-110 shadow-lg shadow-brand-500/20' : 'border-slate-700 hover:border-slate-500 opacity-60'}
                  `}
                >
                  <img src={p.dataUrl} className="w-full h-full object-cover" />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-[10px] font-black uppercase">
                    {p.status === 'ANALYZING' ? <LoaderIcon className="w-4 h-4" /> : `P${p.pageNumber}`}
                  </div>
                </button>
              ))}
            </div>

            <div className="flex-1 bg-slate-100 p-6 overflow-hidden relative flex flex-col" ref={containerRef}>
                <div className="flex-1 flex items-center justify-center relative shadow-2xl bg-slate-300/30 rounded-3xl overflow-hidden border border-slate-200/50">
                    {activePage?.imageObj ? (
                      <canvas ref={canvasRef} className="block max-w-full max-h-full shadow-2xl bg-white" />
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
                      {activePage?.topic && (
                        <>
                          <span className="w-1 h-1 bg-slate-300 rounded-full"></span>
                          <span className="text-slate-500">{activePage.topic}</span>
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
                    {duration !== null && (
                      <p className="text-[10px] text-brand-600 font-black uppercase tracking-widest mt-2">
                        Processed in {duration}s
                      </p>
                    )}
                  </div>
                  <span className="bg-slate-900 text-white text-[10px] font-black px-3 py-1.5 rounded-lg">
                    {allQuestions.length} TOTAL
                  </span>
                </div>
                
                <div className="flex flex-col gap-3">
                  <button
                    onClick={handleDownloadZip}
                    disabled={allQuestions.length === 0 || isZipping}
                    className="w-full bg-slate-900 hover:bg-slate-800 text-white font-black py-4 px-4 rounded-2xl flex items-center justify-center gap-3 transition-all disabled:opacity-20 shadow-xl active:scale-[0.97] uppercase text-sm tracking-widest"
                  >
                    {isZipping ? <LoaderIcon className="w-5 h-5" /> : <ZipIcon className="w-5 h-5" />}
                    Download ZIP
                  </button>

                  <button
                    onClick={handleDownloadAll}
                    disabled={allQuestions.length === 0}
                    className="w-full bg-brand-600 hover:bg-brand-700 text-white font-black py-3 px-4 rounded-2xl flex items-center justify-center gap-3 transition-all disabled:opacity-20 shadow-lg shadow-brand-100 active:scale-[0.97] uppercase text-[11px] tracking-widest"
                  >
                    <DownloadIcon className="w-4 h-4" />
                    Export All (Individual)
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-8 no-scrollbar">
                {pages.map(page => (
                  <div key={page.id} className="space-y-4">
                    <div className="sticky top-0 z-10 bg-white/90 backdrop-blur py-2 flex flex-col border-b border-slate-100">
                      <div className="flex items-center gap-3">
                        <div className="w-6 h-6 bg-slate-800 text-white rounded-lg flex items-center justify-center text-[10px] font-black">
                          {page.pageNumber}
                        </div>
                        <span className="text-xs font-black text-slate-800 uppercase tracking-widest">Page {page.pageNumber}</span>
                      </div>
                      {page.topic && (
                        <span className="text-[10px] text-slate-400 font-bold truncate mt-1 pl-9">
                          {page.topic}
                        </span>
                      )}
                    </div>

                    {page.regions.map((region) => (
                      <div 
                        key={region.id} 
                        className={`group relative border-2 rounded-2xl overflow-hidden transition-all duration-300
                          ${region.isSelected ? 'border-brand-500 shadow-xl shadow-brand-50/50 scale-[1.02]' : 'border-slate-100 hover:border-slate-300'}
                        `}
                        onClick={() => { setActivePageId(page.id); handleSelectRegion(region.id, page.id); }}
                      >
                        <div className={`px-4 py-3 flex justify-between items-center transition-colors ${region.isSelected ? 'bg-brand-50' : 'bg-slate-50'}`}>
                          <div className="flex flex-col">
                            <span className={`text-[11px] font-black px-2 py-0.5 rounded-lg w-fit ${region.isSelected ? 'bg-brand-600 text-white' : 'bg-slate-800 text-white'}`}>
                              Q{region.questionNumber}
                            </span>
                            <span className="text-[9px] text-slate-400 font-bold mt-1">
                              {region.testNumber ? `Test ${region.testNumber}` : ''}
                            </span>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDownloadCrop(region); }}
                            className="text-slate-400 hover:text-brand-600 p-2 rounded-xl hover:bg-white transition-all"
                          >
                             <DownloadIcon className="w-5 h-5" />
                          </button>
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
