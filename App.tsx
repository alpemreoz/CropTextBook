import React, { useState, useEffect, useRef, useCallback } from 'react';
import Uploader from './components/Uploader';
import { analyzeTestPage } from './services/geminiService';
import { QuestionRegion, AppStatus, BoundingBox } from './types';
import { LoaderIcon, CheckIcon, DownloadIcon, ScissorsIcon } from './components/Icons';

export default function App() {
  const [status, setStatus] = useState<AppStatus>('IDLE');
  const [errorMsg, setErrorMsg] = useState<string>('');
  
  // Image data
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageObj, setImageObj] = useState<HTMLImageElement | null>(null);
  
  // App Data
  const [regions, setRegions] = useState<QuestionRegion[]>([]);
  
  // Canvas Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Helper to generate a unique ID
  const generateId = () => Math.random().toString(36).substr(2, 9);

  // Handle new image upload
  const handleImageSelected = useCallback(async (dataUrl: string, file: File) => {
    setImageDataUrl(dataUrl);
    setImageFile(file);
    setStatus('ANALYZING');
    setErrorMsg('');
    setRegions([]);

    // Load image object for cropping later
    const img = new Image();
    img.onload = async () => {
      setImageObj(img);
      
      try {
        // Prepare base64 for API (remove data URI prefix)
        const base64String = dataUrl.split(',')[1];
        
        // Call Gemini API
        const detectedRegions = await analyzeTestPage(base64String, file.type);
        
        // Add IDs to regions
        const regionsWithIds: QuestionRegion[] = detectedRegions.map(r => ({
          ...r,
          id: generateId()
        }));

        setRegions(regionsWithIds);
        setStatus('READY');
      } catch (err: any) {
        setStatus('ERROR');
        setErrorMsg(err.message || "An error occurred during analysis.");
      }
    };
    img.onerror = () => {
      setStatus('ERROR');
      setErrorMsg("Failed to load the image locally.");
    };
    img.src = dataUrl;
  }, []);

  // Process crops when regions or imageObj changes
  useEffect(() => {
    if (status === 'READY' && imageObj && regions.length > 0 && !regions[0].croppedDataUrl) {
      const generateCrops = async () => {
        const updatedRegions = [...regions];
        for (let i = 0; i < updatedRegions.length; i++) {
          const region = updatedRegions[i];
          if (!region.croppedDataUrl) {
             updatedRegions[i] = {
                 ...region,
                 croppedDataUrl: cropImage(imageObj, region.box, region.contextBox)
             };
          }
        }
        setRegions(updatedRegions);
      };
      generateCrops();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, imageObj, regions]);


  // Draw main canvas
  useEffect(() => {
    if (status !== 'READY' && status !== 'ANALYZING') return;
    if (!imageObj || !canvasRef.current || !containerRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const container = containerRef.current;
    
    // Fit canvas to container while maintaining aspect ratio
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

    // Draw image
    ctx.drawImage(imageObj, 0, 0, drawWidth, drawHeight);

    // Draw overlays if READY
    if (status === 'READY') {
      // 1. Draw Context Boxes first
      const drawnContexts = new Set<string>();
      regions.forEach(region => {
        if (region.contextBox) {
          const c = region.contextBox;
          const key = `${c.xmin},${c.ymin},${c.xmax},${c.ymax}`;
          
          if (!drawnContexts.has(key)) {
            drawnContexts.add(key);
            
            const startX = (c.xmin / 1000) * drawWidth;
            const startY = (c.ymin / 1000) * drawHeight;
            const width = ((c.xmax - c.xmin) / 1000) * drawWidth;
            const height = ((c.ymax - c.ymin) / 1000) * drawHeight;

            ctx.beginPath();
            ctx.rect(startX, startY, width, height);
            ctx.fillStyle = 'rgba(168, 85, 247, 0.05)'; 
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = 'rgba(168, 85, 247, 0.4)';
            ctx.stroke();
            ctx.setLineDash([]); 
          }
        }
      });

      // 2. Draw Question Boxes
      regions.forEach(region => {
        const { ymin, xmin, ymax, xmax } = region.box;
        
        const startX = (xmin / 1000) * drawWidth;
        const startY = (ymin / 1000) * drawHeight;
        const width = ((xmax - xmin) / 1000) * drawWidth;
        const height = ((ymax - ymin) / 1000) * drawHeight;

        ctx.beginPath();
        ctx.rect(startX, startY, width, height);
        
        if (region.isSelected) {
          ctx.fillStyle = 'rgba(34, 197, 94, 0.2)';
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#16a34a';
        } else {
           ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
           ctx.fill();
           ctx.lineWidth = 1.5;
           ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)';
        }
        ctx.stroke();

        ctx.fillStyle = region.isSelected ? '#16a34a' : 'rgba(59, 130, 246, 0.8)';
        ctx.font = 'bold 12px sans-serif';
        const text = `Q${region.questionNumber}`;
        const textMetrics = ctx.measureText(text);
        const textWidth = textMetrics.width;
        
        ctx.fillRect(startX, startY - 20 > 0 ? startY - 20 : startY, textWidth + 12, 20);
        ctx.fillStyle = 'white';
        ctx.fillText(text, startX + 6, (startY - 20 > 0 ? startY - 6 : startY + 14));
      });
    }

  }, [imageObj, regions, status, containerRef.current?.clientWidth, containerRef.current?.clientHeight]); 

  useEffect(() => {
    const handleResize = () => setRegions(prev => [...prev]);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const cropImage = (img: HTMLImageElement, qBox: BoundingBox, cBox?: BoundingBox): string => {
    const offscreenCanvas = document.createElement('canvas');
    const ctx = offscreenCanvas.getContext('2d');
    if (!ctx) return '';

    // Very minimal padding to avoid including nearby labels
    const paddingX = img.width * 0.005; 
    const paddingY = img.height * 0.005;

    const getCoords = (box: BoundingBox, isQuestion: boolean) => {
      // For questions, we use even less left-padding because the label is usually on the left
      const leftPad = isQuestion ? img.width * 0.002 : paddingX; 
      
      const sx = Math.max(0, (box.xmin / 1000) * img.width - leftPad);
      const sy = Math.max(0, (box.ymin / 1000) * img.height - paddingY);
      const sw = Math.min(img.width - sx, ((box.xmax - box.xmin) / 1000) * img.width + (leftPad + paddingX));
      const sh = Math.min(img.height - sy, ((box.ymax - box.ymin) / 1000) * img.height + paddingY * 2);
      return { sx, sy, sw, sh };
    };

    const q = getCoords(qBox, true);

    if (!cBox) {
      offscreenCanvas.width = q.sw;
      offscreenCanvas.height = q.sh;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, q.sw, q.sh);
      ctx.drawImage(img, q.sx, q.sy, q.sw, q.sh, 0, 0, q.sw, q.sh);
    } else {
      const c = getCoords(cBox, false);
      const gap = 40; 
      
      offscreenCanvas.width = Math.max(c.sw, q.sw);
      offscreenCanvas.height = c.sh + gap + q.sh;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);

      // Center horizontally if widths differ
      const cOffsetX = (offscreenCanvas.width - c.sw) / 2;
      const qOffsetX = (offscreenCanvas.width - q.sw) / 2;

      ctx.drawImage(img, c.sx, c.sy, c.sw, c.sh, cOffsetX, 0, c.sw, c.sh);

      ctx.beginPath();
      ctx.setLineDash([10, 10]);
      ctx.moveTo(30, c.sh + gap / 2);
      ctx.lineTo(offscreenCanvas.width - 30, c.sh + gap / 2);
      ctx.strokeStyle = '#e2e8f0'; 
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]); 

      ctx.drawImage(img, q.sx, q.sy, q.sw, q.sh, qOffsetX, c.sh + gap, q.sw, q.sh);
    }

    return offscreenCanvas.toDataURL('image/jpeg', 0.92);
  };

  const handleDownloadCrop = (region: QuestionRegion) => {
    if (!region.croppedDataUrl) return;
    const link = document.createElement('a');
    link.href = region.croppedDataUrl;
    link.download = `Q${region.questionNumber}_Clean.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDownloadAll = () => {
    regions.forEach((region, idx) => {
      if (region.croppedDataUrl) {
         setTimeout(() => handleDownloadCrop(region), idx * 200);
      }
    });
  };

  const handleSelectRegion = (id: string) => {
    setRegions(prev => prev.map(r => ({
      ...r,
      isSelected: r.id === id
    })));
  };

  const handleReset = () => {
    setStatus('IDLE');
    setImageFile(null);
    setImageDataUrl(null);
    setImageObj(null);
    setRegions([]);
  };

  return (
    <>
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between shrink-0 sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="bg-brand-600 text-white p-2 rounded-xl shadow-sm">
            <ScissorsIcon className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 tracking-tight leading-none mb-1">Q-Crop</h1>
            <p className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Clean Extraction Pro</p>
          </div>
        </div>
        
        {status !== 'IDLE' && (
          <button 
            onClick={handleReset}
            className="px-4 py-2 text-sm font-semibold text-slate-500 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-all"
          >
            Start Over
          </button>
        )}
      </header>

      <main className="flex-1 flex overflow-hidden">
        {status === 'IDLE' && (
           <Uploader onImageSelected={handleImageSelected} isLoading={false} />
        )}

        {(status === 'ANALYZING' || status === 'ERROR') && !regions.length && (
           <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-gray-50">
              {status === 'ANALYZING' && (
                 <div className="bg-white p-12 rounded-3xl shadow-xl border border-slate-100 max-w-sm flex flex-col items-center">
                   <div className="relative mb-8">
                     <div className="absolute inset-0 bg-brand-200 rounded-full blur-2xl opacity-50 animate-pulse"></div>
                     <LoaderIcon className="w-16 h-16 text-brand-500 relative" />
                   </div>
                   <h2 className="text-2xl font-bold text-slate-800 mb-3">Cleaning Crops...</h2>
                   <p className="text-slate-500 text-sm leading-relaxed">Our AI is meticulously excluding labels and stitching context for a perfect export.</p>
                 </div>
              )}
              {status === 'ERROR' && (
                 <div className="bg-white p-12 rounded-3xl shadow-xl border border-red-100 max-w-sm flex flex-col items-center">
                   <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mb-6">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-8 h-8">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                      </svg>
                   </div>
                   <h2 className="text-xl font-bold text-slate-800 mb-2">Analysis Failed</h2>
                   <p className="text-red-500 text-sm mb-8">{errorMsg}</p>
                   <button 
                     onClick={handleReset}
                     className="w-full py-3 bg-slate-900 text-white rounded-xl hover:bg-slate-800 font-bold transition-all shadow-lg shadow-slate-200"
                   >
                     Try Another Image
                   </button>
                 </div>
              )}
           </div>
        )}

        {(status === 'READY' || (status === 'ANALYZING' && imageDataUrl)) && (
          <div className="flex-1 flex w-full h-full">
            
            <div className="flex-1 bg-slate-100 p-6 overflow-hidden relative" ref={containerRef}>
                <div className="w-full h-full flex items-center justify-center relative shadow-2xl bg-slate-300/50 rounded-2xl overflow-hidden border border-slate-200/50">
                    <canvas 
                      ref={canvasRef} 
                      className="block max-w-full max-h-full shadow-2xl bg-white rounded-sm"
                      style={{ objectFit: 'contain' }}
                    />
                    
                    {status === 'ANALYZING' && (
                      <div className="absolute inset-0 bg-white/40 backdrop-blur-[2px] flex items-center justify-center z-10">
                         <div className="bg-white px-6 py-4 rounded-2xl shadow-xl flex items-center gap-3">
                           <LoaderIcon className="w-5 h-5 text-brand-600" />
                           <span className="font-bold text-slate-700 text-sm">Updating Analysis...</span>
                         </div>
                      </div>
                    )}
                </div>
            </div>

            <div className="w-[400px] bg-white border-l border-slate-200 flex flex-col shrink-0 z-20 overflow-hidden">
              
              <div className="p-6 border-b border-slate-100 bg-slate-50/30 shrink-0">
                <div className="flex justify-between items-end mb-4">
                  <div>
                    <h2 className="text-lg font-bold text-slate-900">Output Preview</h2>
                    <p className="text-xs text-slate-500">Labels are removed from final images.</p>
                  </div>
                  <span className="bg-slate-900 text-white text-[10px] font-black px-2.5 py-1 rounded-md uppercase">
                    {regions.length} Items
                  </span>
                </div>
                
                <button
                  onClick={handleDownloadAll}
                  disabled={regions.length === 0 || !regions.every(r => r.croppedDataUrl)}
                  className="w-full bg-brand-600 hover:bg-brand-700 text-white font-bold py-3.5 px-4 rounded-xl flex items-center justify-center gap-2.5 transition-all disabled:opacity-30 disabled:grayscale shadow-lg shadow-brand-100 active:scale-[0.98]"
                >
                  <DownloadIcon className="w-5 h-5" />
                  Download All Clean Crops
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {regions.map((region) => (
                  <div 
                    key={region.id} 
                    className={`group relative border-2 rounded-2xl overflow-hidden transition-all duration-300
                      ${region.isSelected ? 'border-brand-500 shadow-xl shadow-brand-50/50 scale-[1.02]' : 'border-slate-100 hover:border-slate-200'}
                    `}
                    onClick={() => handleSelectRegion(region.id)}
                  >
                    <div className={`px-4 py-2.5 flex justify-between items-center transition-colors ${region.isSelected ? 'bg-brand-50' : 'bg-slate-50'}`}>
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-black uppercase px-1.5 py-0.5 rounded ${region.isSelected ? 'bg-brand-600 text-white' : 'bg-slate-200 text-slate-600'}`}>
                          Q{region.questionNumber}
                        </span>
                        {region.contextBox && (
                          <span className="bg-purple-100 text-purple-700 text-[10px] font-black uppercase px-1.5 py-0.5 rounded">
                            + Context
                          </span>
                        )}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDownloadCrop(region); }}
                        disabled={!region.croppedDataUrl}
                        className="text-slate-400 hover:text-brand-600 p-1.5 rounded-lg hover:bg-white transition-all disabled:opacity-0"
                      >
                         <DownloadIcon className="w-4 h-4" />
                      </button>
                    </div>
                    
                    <div className="bg-white p-4 cursor-pointer">
                      {region.croppedDataUrl ? (
                         <div className="relative">
                           <img 
                              src={region.croppedDataUrl} 
                              alt={`Crop for question ${region.questionNumber}`}
                              className="w-full h-auto max-h-64 object-contain rounded-lg border border-slate-50 bg-slate-50/20"
                           />
                           <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <div className="bg-white/90 backdrop-blur shadow-sm border border-slate-100 px-2 py-1 rounded text-[9px] font-bold text-slate-500 uppercase">
                                Clean Crop
                              </div>
                           </div>
                         </div>
                      ) : (
                         <div className="w-full h-32 flex flex-col items-center justify-center bg-slate-50 rounded-lg animate-pulse">
                           <div className="w-8 h-8 rounded-full bg-slate-200 mb-2"></div>
                           <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Rendering...</span>
                         </div>
                      )}
                    </div>
                  </div>
                ))}
                
                {regions.length === 0 && status === 'READY' && (
                   <div className="text-center py-20 flex flex-col items-center">
                     <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mb-4">
                       <ScissorsIcon className="w-8 h-8 text-slate-300" />
                     </div>
                     <p className="font-bold text-slate-400 text-sm">No Questions Found</p>
                     <p className="text-slate-300 text-xs mt-1">Try a clearer image.</p>
                   </div>
                )}
              </div>

            </div>
          </div>
        )}
      </main>
    </>
  );
}
