
import React, { useCallback, useRef } from 'react';
import { UploadIcon } from './Icons';

interface UploaderProps {
  onImagesSelected: (files: { dataUrl: string, file: File }[]) => void;
  isLoading: boolean;
}

const Uploader: React.FC<UploaderProps> = ({ onImagesSelected, isLoading }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    // Explicitly cast the Array.from result to File[] to avoid 'unknown' type errors in the iteration
    const files = Array.from(event.target.files || []) as File[];
    const results: { dataUrl: string, file: File }[] = [];

    for (const file of files) {
      if (file.type.startsWith('image/')) {
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target?.result as string);
          reader.readAsDataURL(file);
        });
        results.push({ dataUrl, file });
      }
    }

    if (results.length > 0) {
      onImagesSelected(results);
    }
    
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [onImagesSelected]);

  return (
    <div className="flex flex-col items-center justify-center w-full h-full p-8 bg-slate-50">
      <div 
        className={`w-full max-w-2xl p-16 border-4 border-dashed rounded-[2.5rem] text-center transition-all duration-300 shadow-2xl shadow-slate-200/50
          ${isLoading ? 'border-slate-200 bg-slate-100 opacity-70 cursor-wait' : 'border-brand-300 bg-white hover:border-brand-500 hover:bg-brand-50/30 cursor-pointer hover:scale-[1.01]'}
        `}
        onClick={() => !isLoading && fileInputRef.current?.click()}
      >
        <div className="w-24 h-24 bg-brand-100 rounded-3xl flex items-center justify-center mx-auto mb-8 text-brand-600">
           <UploadIcon className="w-10 h-10" />
        </div>
        <h3 className="text-3xl font-black mb-3 text-slate-800 tracking-tight">Bulk Question Extractor</h3>
        <p className="text-slate-500 mb-10 text-lg">Select multiple exam pages to crop all questions at once.</p>
        
        <div className="inline-flex items-center gap-3 px-6 py-3 bg-brand-600 text-white rounded-2xl font-bold shadow-lg shadow-brand-200 hover:bg-brand-700 transition-all">
          <UploadIcon className="w-5 h-5" />
          Browse Files
        </div>
        
        <input 
          type="file" 
          ref={fileInputRef}
          onChange={handleFileChange}
          accept="image/jpeg, image/png, image/webp" 
          className="hidden" 
          multiple
        />
      </div>
    </div>
  );
};

export default Uploader;
