import { GoogleGenAI, Type } from "@google/genai";
import { QuestionRegion } from "../types";

const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

export interface AnalysisResult {
  pageNumber: string;
  testNumber?: string;
  topic?: string;
  regions: Omit<QuestionRegion, 'id' | 'croppedDataUrl' | 'pageNumber' | 'testNumber' | 'topic'>[];
}

export const analyzeTestPage = async (base64Image: string, mimeType: string): Promise<AnalysisResult> => {
  const ai = getAI();
  
  const prompt = `
    Analyze this image of a test paper or worksheet. 
    
    CRITICAL REQUIREMENTS FOR CLEAN CROPS:
    1. Detect Page Metadata:
       - Page Number: Extract (e.g., "19").
       - Test Number: Extract (e.g., "01").
       - Topic/Unit: Extract header info.
       
    2. EXCLUSION RULES (IMPORTANT):
       - EXCLUDE QUESTION LABELS: Do not include "1.", "2.", "37." etc. in the question bounding box. The bounding box MUST start horizontally (xmin) AFTER the question number label.
       - EXCLUDE MAPPING INSTRUCTIONS: Frequently, there is a line or bar that says something like "5, 6, 7. soruları aşağıdaki bilgilere göre çözünüz" (Questions 5, 6, 7 will be solved according to the information above). 
         YOU MUST EXCLUDE THIS INSTRUCTIONAL LINE from both the 'sharedContexts' and the 'questions' bounding boxes. It should NOT be part of any crop.
       - EXCLUDE COLUMN SEPARATORS: If the page has two columns, do not include the vertical line separating them in any bounding box. Keep a safe margin (at least 5-10 units) away from the center line.
       - EXCLUDE PAGE BORDERS: Do not include any black borders, edges of the paper, or scanner artifacts.
       - EXCLUDE HEADERS/FOOTERS: Do not include page numbers, test titles, or any other header/footer elements in the question boxes.
       
    Task 1: Identify "Shared Contexts". 
    - Draw bounding boxes around passages, images, or diagrams that apply to multiple questions.
    - DO NOT include the instructional line (the mapping text mentioned above) in this box. Just the core content (text/images).
    - Give each an ID (e.g., "c1").

    Task 2: Identify "Questions". 
    - Extract the 'questionNumber' as a string.
    - Find the bounding box ('box') for the question body strictly.
    - START the box at the first word of the question body.
    - CRITICAL: The 'xmin' of the question box MUST be to the right of the question number label (e.g., "1.", "2."). Do not capture the number itself.
    - If a question relies on a shared context, include its 'contextId'.

    OUTPUT JSON FORMAT:
    {
      "pageNumber": "19",
      "testNumber": "01",
      "topic": "Geometri",
      "sharedContexts": [{"id": "c1", "ymin": 0, "xmin": 0, "ymax": 0, "xmax": 0}],
      "questions": [{"questionNumber": "5", "ymin": 0, "xmin": 0, "ymax": 0, "xmax": 0, "contextId": "c1"}]
    }

    COORDINATE RULES: 0-1000 relative to image size. Precision is key to avoid "bleeding" of excluded elements into the crop.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-pro-preview", 
      contents: {
        parts: [
          {
            inlineData: {
              data: base64Image,
              mimeType: mimeType,
            },
          },
          { text: prompt }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          description: "Structured test page data with mapping instructions and page artifacts strictly excluded.",
          properties: {
            pageNumber: { type: Type.STRING },
            testNumber: { type: Type.STRING },
            topic: { type: Type.STRING },
            sharedContexts: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  ymin: { type: Type.INTEGER },
                  xmin: { type: Type.INTEGER },
                  ymax: { type: Type.INTEGER },
                  xmax: { type: Type.INTEGER }
                },
                required: ["id", "ymin", "xmin", "ymax", "xmax"]
              }
            },
            questions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  questionNumber: { type: Type.STRING },
                  ymin: { type: Type.INTEGER },
                  xmin: { type: Type.INTEGER },
                  ymax: { type: Type.INTEGER },
                  xmax: { type: Type.INTEGER },
                  contextId: { type: Type.STRING }
                },
                required: ["questionNumber", "ymin", "xmin", "ymax", "xmax"]
              }
            }
          },
          required: ["pageNumber", "sharedContexts", "questions"]
        }
      }
    });

    if (!response.text) throw new Error("Empty response from AI");

    const parsedData = JSON.parse(response.text);
    const contexts = parsedData.sharedContexts || [];
    const questions = parsedData.questions || [];
    const pageNum = parsedData.pageNumber || "unknown";
    const testNum = parsedData.testNumber;
    const topic = parsedData.topic;

    const contextMap = new Map();
    contexts.forEach((c: any) => {
      if (c.id) {
        contextMap.set(c.id, { ymin: c.ymin, xmin: c.xmin, ymax: c.ymax, xmax: c.xmax });
      }
    });
    
    return {
      pageNumber: pageNum,
      testNumber: testNum,
      topic: topic,
      regions: questions.map((q: any) => {
        const result: any = {
          questionNumber: q.questionNumber,
          box: { ymin: q.ymin, xmin: q.xmin, ymax: q.ymax, xmax: q.xmax }
        };
        if (q.contextId && contextMap.has(q.contextId)) {
          result.contextBox = contextMap.get(q.contextId);
        }
        return result;
      })
    };

  } catch (error) {
    console.error("Error analyzing test page:", error);
    throw new Error("Failed to analyze the page.");
  }
};