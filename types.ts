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
  week?: string;       // header week badge as read ("10. HAFTA" -> "10"), see weekByPage
  weekUnsure?: boolean;
  weekGlyphs?: { aspect: number; bits: string }[]; // badge digit shapes (scans)
  answers?: { n: number; letter: string }[]; // answers printed on the page (profiles with answerKey)
  plainTopic?: string; // header line that reads as a topic (profiles naming per test)
  marked?: Record<string, string>; // answers hidden in the text layer, by question number (answerMarks)
  contents?: any; // what the book's contents need from this page (bookIndex)
  pdf?: PdfPageRef;
  error?: string;
  /** Results from a saved session: the page is rendered again, not analyzed. */
  restored?: { fields: Partial<PageData>; regions: QuestionRegion[] };
}

export type AppStatus = 'IDLE' | 'ANALYZING' | 'READY' | 'ERROR';
