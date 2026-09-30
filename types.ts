import type { PdfPageRef } from './services/fileLoader';

export interface BoundingBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export interface QuestionRegion {
  id: string;
  questionNumber: string;
  pageNumber: string;
  pageLabel?: string;  // page part of the export filename: "33", or "s104" for PDF pages
  testNumber?: string; // e.g., "TEST 01"
  topic?: string;      // e.g., "2. Ünite - Şiirde Ahenk"
  box: BoundingBox;
  contextBox?: BoundingBox;
  mask?: BoundingBox;   // area painted white in the crop (the question number, when inside the box)
  croppedDataUrl?: string;
  isSelected?: boolean;
}

export interface PageData {
  id: string;
  file: File;
  dataUrl: string;
  imageObj: HTMLImageElement | null;
  status: AppStatus;
  regions: QuestionRegion[];
  pageNumber: string;
  pageLabel?: string;
  testNumber?: string;
  topic?: string;
  coverTopic?: string; // set on unit cover pages; inherited by later pages of the same book
  section?: string;    // "TARAMA 1" style badge that names the page on its own
  pdf?: PdfPageRef;
  error?: string;
}

export type AppStatus = 'IDLE' | 'ANALYZING' | 'READY' | 'ERROR';
