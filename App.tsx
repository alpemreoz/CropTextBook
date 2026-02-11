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
      // 1. Draw Context Boxes first (so they are visually underneath question boxes if they get close)
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

            // Draw dashed purple rectangle
            ctx.beginPath();
            ctx.rect(startX, startY, width, height);
            ctx.fillStyle = 'rgba(168, 85, 247, 0.1)'; 
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.strokeStyle = 'rgba(168, 85, 247, 0.8)';
            ctx.stroke();
            ctx.setLineDash([]); // Reset dash
            
            // Context Badge
            ctx.fillStyle = 'rgba(168, 85, 247, 0.9)';
            ctx.font = 'bold 12px sans-serif';
            ctx.fillRect(startX, startY - 20 > 0 ? startY - 20 : startY, 56, 20);
            ctx.fillStyle = 'white';
            ctx.fillText("Context", startX + 6, startY - 20 > 0 ? startY - 5 : startY + 14);
          }
        }
      });

      // 2. Draw Question Boxes
      regions.forEach(region => {
        const { ymin, xmin, ymax, xmax } = region.box;
        
        // Convert 0-1000 scale to actual canvas pixels
        const startX = (xmin / 1000) * drawWidth;
        const startY = (ymin / 1000) * drawHeight;
        const width = ((xmax - xmin) / 1000) * drawWidth;
        const height = ((ymax - ymin) / 1000) * drawHeight;

        // Draw rectangle
        ctx.beginPath();
        ctx.rect(startX, startY, width, height);
        
        if (region.isSelected) {
          ctx.fillStyle = 'rgba(34, 197, 94, 0.2)'; // Brand color with opacity
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#16a34a';
        } else {
           ctx.fillStyle = 'rgba(59, 130, 246, 0.1)'; // Blue with opacity
           ctx.fill();
           ctx.lineWidth = 2;
           ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)';
        }
        ctx.stroke();

        // Draw Badge
        ctx.fillStyle = region.isSelected ? '#16a34a' : 'rgba(59, 130, 246, 0.9)';
        ctx.font = 'bold 14px sans-serif';
        const text = `Q${region.questionNumber}`;
        const textMetrics = ctx.measureText(text);
        const textWidth = textMetrics.width;
        
        // Badge background
        ctx.fillRect(startX, startY - 24 > 0 ? startY - 24 : startY, textWidth + 16, 24);
        
        // Badge text
        ctx.fillStyle = 'white';
        ctx.fillText(text, startX + 8, (startY - 24 > 0 ? startY - 8 : startY + 16));
      });
    }

  }, [imageObj, regions, status, containerRef.current?.clientWidth, containerRef.current?.clientHeight]); 

  // Handle Resize to re-draw canvas
  useEffect(() => {
    const handleResize = () => {
        // Trigger a fake state update to force re-evaluation of canvas draw
        setRegions(prev => [...prev]);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);


  // Helper function to crop the actual high-res image and optionally stitch context
  const cropImage = (img: HTMLImageElement, qBox: BoundingBox, cBox?: BoundingBox): string => {
    const offscreenCanvas = document.createElement('canvas');
    const ctx = offscreenCanvas.getContext('2d');
    if (!ctx) return '';

    const paddingX = img.width * 0.01;
    const paddingY = img.height * 0.01;

    // Helper to calculate exact pixel coordinates with bounds checking
    const getCoords = (box: BoundingBox) => {
      const sx = Math.max(0, (box.xmin / 1000) * img.width - paddingX);
      const sy = Math.max(0, (box.ymin / 1000) * img.height - paddingY);
      const sw = Math.min(img.width - sx, ((box.xmax - box.xmin) / 1000) * img.width + paddingX * 2);
      const sh = Math.min(img.height - sy, ((box.ymax - box.ymin) / 1000) * img.height + paddingY * 2);
      return { sx, sy, sw, sh };
    };

    const q = getCoords(qBox);

    if (!cBox) {
      // Standard single crop
      offscreenCanvas.width = q.sw;
      offscreenCanvas.height = q.sh;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, q.sw, q.sh);
      ctx.drawImage(img, q.sx, q.sy, q.sw, q.sh, 0, 0, q.sw, q.sh);
    } else {
      // Complex crop: Stitch Context Block on top of Question Block
      const c = getCoords(cBox);
      const gap = 30; // 30px gap for clarity between context and question
      
      // Canvas needs to be wide enough for the widest block, and tall enough for both + gap
      offscreenCanvas.width = Math.max(c.sw, q.sw);
      offscreenCanvas.height = c.sh + gap + q.sh;

      // Fill background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, offscreenCanvas.width, offscreenCanvas.height);

      // Draw Context
      ctx.drawImage(img, c.sx, c.sy, c.sw, c.sh, 0, 0, c.sw, c.sh);

      // Draw neat divider line
      ctx.beginPath();
      ctx.moveTo(20, c.sh + gap / 2);
      ctx.lineTo(offscreenCanvas.width - 20, c.sh + gap / 2);
      ctx.strokeStyle = '#cbd5e1'; // slate-300
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 8]);
      ctx.stroke();
      ctx.setLineDash([]); // reset

      // Draw Question
      ctx.drawImage(img, q.sx, q.sy, q.sw, q.sh, 0, c.sh + gap, q.sw, q.sh);
    }

    return offscreenCanvas.toDataURL('image/jpeg', 0.9); // Quality 0.9
  };

  const handleDownloadCrop = (region: QuestionRegion) => {
    if (!region.croppedDataUrl) return;
    const link = document.createElement('a');
    link.href = region.croppedDataUrl;
    link.download = `Question_${region.questionNumber}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleDownloadAll = () => {
    regions.forEach(region => {
      if (region.croppedDataUrl) {
         // Slight delay to prevent browser blocking multiple rapid downloads
         setTimeout(() => handleDownloadCrop(region), 100);
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
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between shrink-0 sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="bg-brand-500 text-white p-2 rounded-lg">
            <ScissorsIcon className="w-5 h-5" />
          </div>
          <h1 className="text-xl font-bold text-gray-800 tracking-tight">Q-Crop</h1>
        </div>
        
        {status !== 'IDLE' && (
          <button 
            onClick={handleReset}
            className="text-sm font-medium text-gray-500 hover:text-gray-800 transition-colors"
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
                 <>
                   <LoaderIcon className="w-12 h-12 text-brand-500 mb-6" />
                   <h2 className="text-2xl font-semibold text-gray-800 mb-2">Analyzing Document...</h2>
                   <p className="text-gray-500 max-w-md">Our AI is scanning the image to map out individual questions and shared paragraphs. This usually takes a few seconds.</p>
                 </>
              )}
              {status === 'ERROR' && (
                 <>
                   <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mb-6">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-8 h-8">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                   </div>
                   <h2 className="text-2xl font-semibold text-gray-800 mb-2">Analysis Failed</h2>
                   <p className="text-red-500 mb-6 max-w-md">{errorMsg}</p>
                   <button 
                     onClick={handleReset}
                     className="px-6 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-700 font-medium transition-colors"
                   >
                     Try Another Image
                   </button>
                 </>
              )}
           </div>
        )}

        {/* Main Workspace Workspace */}
        {(status === 'READY' || (status === 'ANALYZING' && imageDataUrl)) && (
          <div className="flex-1 flex w-full h-full">
            
            {/* Canvas Area */}
            <div className="flex-1 bg-gray-200 p-4 overflow-hidden relative" ref={containerRef}>
                <div className="w-full h-full flex items-center justify-center relative shadow-inner bg-gray-300 rounded-lg overflow-hidden border border-gray-300">
                    <canvas 
                      ref={canvasRef} 
                      className="block max-w-full max-h-full shadow-lg bg-white"
                      style={{ objectFit: 'contain' }}
                    />
                    
                    {/* Overlay Loader if re-analyzing */}
                    {status === 'ANALYZING' && (
                      <div className="absolute inset-0 bg-white/50 backdrop-blur-sm flex items-center justify-center z-10">
                         <LoaderIcon className="w-10 h-10 text-brand-600" />
                      </div>
                    )}
                </div>
            </div>

            {/* Sidebar */}
            <div className="w-96 bg-white border-l border-gray-200 flex flex-col shrink-0 shadow-[-4px_0_15px_-3px_rgba(0,0,0,0.05)] z-20">
              
              <div className="p-5 border-b border-gray-100 bg-gray-50/50 shrink-0">
                <div className="flex justify-between items-center mb-1">
                  <h2 className="text-lg font-bold text-gray-800">Detected Questions</h2>
                  <span className="bg-brand-100 text-brand-700 text-xs font-bold px-2 py-1 rounded-full">
                    {regions.length} Found
                  </span>
                </div>
                <p className="text-sm text-gray-500 mb-4">Review crops and export individually or all at once.</p>
                
                <button
                  onClick={handleDownloadAll}
                  disabled={regions.length === 0 || !regions.every(r => r.croppedDataUrl)}
                  className="w-full bg-brand-600 hover:bg-brand-700 text-white font-medium py-2.5 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                >
                  <DownloadIcon className="w-5 h-5" />
                  Export All as JPG ZIP
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {regions.map((region) => (
                  <div 
                    key={region.id} 
                    className={`border rounded-xl overflow-hidden transition-all duration-200 shadow-sm
                      ${region.isSelected ? 'border-brand-500 ring-2 ring-brand-100' : 'border-gray-200 hover:border-gray-300'}
                    `}
                    onClick={() => handleSelectRegion(region.id)}
                  >
                    <div className="bg-gray-50 px-3 py-2 border-b border-gray-100 flex justify-between items-center cursor-pointer">
                      <span className="font-semibold text-gray-700 flex items-center gap-2">
                         <div className={`w-2 h-2 rounded-full ${region.isSelected ? 'bg-brand-500' : 'bg-gray-300'}`}></div>
                         Question {region.questionNumber}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDownloadCrop(region); }}
                        disabled={!region.croppedDataUrl}
                        className="text-gray-400 hover:text-brand-600 p-1 rounded transition-colors disabled:opacity-50"
                        title="Download this crop"
                      >
                         <DownloadIcon className="w-5 h-5" />
                      </button>
                    </div>
                    
                    <div className="bg-white p-3 cursor-pointer relative group">
                      {region.croppedDataUrl ? (
                         <>
                           <img 
                              src={region.croppedDataUrl} 
                              alt={`Crop for question ${region.questionNumber}`}
                              className="w-full h-auto max-h-48 object-contain rounded border border-gray-100 bg-gray-50"
                           />
                           {region.contextBox && (
                             <span className="absolute top-4 left-4 bg-purple-100 text-purple-700 text-[10px] font-bold px-2 py-0.5 rounded shadow-sm opacity-90">
                               Includes Context
                             </span>
                           )}
                           <div className="absolute inset-0 bg-black/5 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                              <span className="bg-white/90 text-gray-800 text-xs font-semibold px-2 py-1 rounded shadow-sm">View</span>
                           </div>
                         </>
                      ) : (
                         <div className="w-full h-24 flex items-center justify-center bg-gray-50 text-gray-400 text-sm">
                           Processing...
                         </div>
                      )}
                    </div>
                  </div>
                ))}
                
                {regions.length === 0 && status === 'READY' && (
                   <div className="text-center py-10 text-gray-500">
                     <p>No questions detected.</p>
                     <p className="text-sm mt-2">Try a clearer image or a different page.</p>
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
