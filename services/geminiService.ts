import { GoogleGenAI, Type } from "@google/genai";
import { QuestionRegion } from "../types";

// Initialize AI inside functions to ensure latest API key if applicable
const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

export const analyzeTestPage = async (base64Image: string, mimeType: string): Promise<Omit<QuestionRegion, 'id' | 'croppedDataUrl'>[]> => {
  const ai = getAI();
  
  const prompt = `
    Analyze this image of a test paper or worksheet. 
    
    CRITICAL REQUIREMENT: EXCLUDE QUESTION LABELS FROM CROPS
    The user wants "clean" crops of the question content. 
    The question numbers (e.g., "37.", "38.", "Q1") must be detected for metadata purposes, but they MUST NOT be inside the bounding box coordinates for the question body.
    
    Task 1: Identify "Shared Contexts". 
    - Draw bounding boxes around shared passages/images along with their instructional text (e.g. "37 ve 38. soruları..."). 
    - Give each an ID (e.g., "c1", "c2").

    Task 2: Identify "Questions". 
    - Extract the 'questionNumber' as a string (e.g., "37", "38").
    - Find the bounding box ('box') for the question body.
    - IMPORTANT: The 'box' MUST START AFTER the question number and its trailing punctuation (like '.' or ')').
    - If the text is "37. Bu parçada...", the box xmin/ymin must start exactly at the "B" of "Bu".
    - Do not include the question number, the dot, or the space immediately following the number in the bounding box.
    - Ensure all options (A, B, C, D, E) and the full text are included.
    - If a question relies on a shared context, include that context's 'contextId'.

    OUTPUT JSON FORMAT:
    {
      "sharedContexts": [{"id": "c1", "ymin": 0, "xmin": 0, "ymax": 0, "xmax": 0}],
      "questions": [{"questionNumber": "37", "ymin": 0, "xmin": 0, "ymax": 0, "xmax": 0, "contextId": "c1"}]
    }

    COORDINATE RULES:
    - Values 0-1000 relative to image size.
    - Be extremely precise. Even 1-2 units too far left might include the number. Err on the side of starting the box 2-3 units to the right of the actual number label.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview", 
      contents: [
        {
          inlineData: {
            data: base64Image,
            mimeType: mimeType,
          },
        },
        { text: prompt }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          description: "Structured test page data with shared contexts and questions body strictly excluded from labels.",
          properties: {
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
          required: ["sharedContexts", "questions"]
        }
      }
    });

    if (!response.text) {
      throw new Error("Empty response from AI");
    }

    const parsedData = JSON.parse(response.text);
    const contexts = parsedData.sharedContexts || [];
    const questions = parsedData.questions || [];

    const contextMap = new Map();
    contexts.forEach((c: any) => {
      if (c.id) {
        contextMap.set(c.id, {
          ymin: c.ymin, xmin: c.xmin, ymax: c.ymax, xmax: c.xmax
        });
      }
    });
    
    return questions.map((q: any) => {
      const result: Omit<QuestionRegion, 'id' | 'croppedDataUrl'> = {
        questionNumber: q.questionNumber,
        box: { ymin: q.ymin, xmin: q.xmin, ymax: q.ymax, xmax: q.xmax }
      };

      if (q.contextId && contextMap.has(q.contextId)) {
        result.contextBox = contextMap.get(q.contextId);
      }

      return result;
    });

  } catch (error) {
    console.error("Error analyzing test page:", error);
    throw new Error("Failed to analyze the image. Please try again.");
  }
};