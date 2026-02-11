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
    
    CRITICAL REQUIREMENTS:
    1. Detect Page Metadata (Usually at the top/bottom):
       - Page Number: Look for the number (e.g., "19") usually at the bottom center or corner.
       - Test Number: Look for text like "TEST 01" or "Test 1" (often in a badge or at the top right).
       - Topic/Unit: Look for headers like "2. Ünite" or "Şiirde Ahenk" at the top of the page. Extract both if available.
       
    2. EXCLUDE QUESTION LABELS FROM CROPS:
       - Detect question numbers (e.g., "1.", "2.", "3.") but ensure the bounding box 'box' EXCLUDES these labels. 
       - The crop must be "clean", starting exactly where the question body text begins.

    Task 1: Identify "Shared Contexts". 
    - Draw bounding boxes around shared passages/images along with their instructional text. 
    - Give each an ID (e.g., "c1").

    Task 2: Identify "Questions". 
    - Extract the 'questionNumber' as a string.
    - Find the bounding box ('box') for the question body strictly excluding the number label.
    - If a question relies on a shared context, include its 'contextId'.

    OUTPUT JSON FORMAT:
    {
      "pageNumber": "19",
      "testNumber": "01",
      "topic": "2. Ünite - Şiirde Ahenk",
      "sharedContexts": [{"id": "c1", "ymin": 0, "xmin": 0, "ymax": 0, "xmax": 0}],
      "questions": [{"questionNumber": "1", "ymin": 0, "xmin": 0, "ymax": 0, "xmax": 0, "contextId": "c1"}]
    }

    COORDINATE RULES: 0-1000 relative to image size. Be extremely precise.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview", 
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
          description: "Structured test page data with page metadata and clean crops.",
          properties: {
            pageNumber: { type: Type.STRING },
            testNumber: { type: Type.STRING, description: "Extracted test number, e.g. 01" },
            topic: { type: Type.STRING, description: "Extracted unit or topic, e.g. 2. Unite - Siirde Ahenk" },
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
