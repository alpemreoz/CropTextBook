import React, { useCallback, useRef } from 'react';
import { UploadIcon } from './Icons';

interface UploaderProps {
  onImageSelected: (dataUrl: string, file: File) => void;
  isLoading: boolean;
}

const Uploader: React.FC<UploaderProps> = ({ onImageSelected, isLoading }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        if (e.target?.result && typeof e.target.result === 'string') {
          onImageSelected(e.target.result, file);
        }
      };
      reader.readAsDataURL(file);
    } else if (file && file.type === 'application/pdf') {
      alert("PDF support is coming soon! For now, please upload image formats (JPG, PNG). You can easily convert a PDF to images first.");
    }
    // Reset input so the same file can be selected again if needed
    if (fileInputRef.current) {
        fileInputRef.current.value = '';
    }
  }, [onImageSelected]);

  return (
    <div className="flex flex-col items-center justify-center w-full h-full p-8">
      <div 
        className={`w-full max-w-2xl p-12 border-2 border-dashed rounded-xl text-center transition-colors
          ${isLoading ? 'border-gray-300 bg-gray-50 opacity-70 pointer-events-none' : 'border-brand-500 bg-brand-50 hover:bg-brand-100 cursor-pointer'}
        `}
        onClick={() => !isLoading && fileInputRef.current?.click()}
      >
        <UploadIcon className={`mx-auto w-16 h-16 mb-4 ${isLoading ? 'text-gray-400' : 'text-brand-500'}`} />
        <h3 className="text-xl font-semibold mb-2 text-gray-800">Upload Exam Page</h3>
        <p className="text-gray-500 mb-6">Drag and drop an image, or click to browse.</p>
        <p className="text-sm text-gray-400">Supports JPG, PNG (Max 10MB)</p>
        
        <input 
          type="file" 
          ref={fileInputRef}
          onChange={handleFileChange}
          accept="image/jpeg, image/png, image/webp" 
          className="hidden" 
        />
      </div>
    </div>
  );
};

export default Uploader;
