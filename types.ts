export interface BoundingBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export interface QuestionRegion {
  id: string;
  questionNumber: string;
  box: BoundingBox;
  contextBox?: BoundingBox; // Stores the bounding box of a shared paragraph/image if applicable
  croppedDataUrl?: string;
  isSelected?: boolean;
}

export type AppStatus = 'IDLE' | 'ANALYZING' | 'READY' | 'ERROR';
