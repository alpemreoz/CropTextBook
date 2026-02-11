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
  testNumber?: string; // e.g., "TEST 01"
  topic?: string;      // e.g., "2. Ünite - Şiirde Ahenk"
  box: BoundingBox;
  contextBox?: BoundingBox;
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
  testNumber?: string;
  topic?: string;
  error?: string;
}

export type AppStatus = 'IDLE' | 'ANALYZING' | 'READY' | 'ERROR';
