import { GoogleGenAI, Type } from "@google/genai";
import { QuestionRegion } from "../types";

// Initialize AI inside functions to ensure latest API key if applicable
const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

export const analyzeTestPage = async (base64Image: string, mimeType: string): Promise<Omit<QuestionRegion, 'id' | 'croppedDataUrl'>[]> => {
  const ai = getAI();
  
  const prompt = `
    Analyze this image of a test paper or worksheet. 
    
    Sometimes, multiple questions refer to a shared block of text, a passage, an image, or a graph (e.g., "37 ve 38. soruları aşağıdaki parçaya göre cevaplayınız." or "Answer questions 37 and 38 based on the passage").
    
    Task 1: Identify "Shared Contexts". Draw bounding boxes around these shared passages/images along with their instructional text. Give each an ID (e.g., "c1", "c2").
    Task 2: Identify "Questions". A question block typically starts with a number (e.g., "37.", "Q1") and includes its text and options (A, B, C, D, E). 
    - DO NOT include the shared context in the question's bounding box. The question box should strictly contain just that specific question.
    - If a question relies on a shared context, include that context's ID in the 'contextId' field. If it does not, leave 'contextId' empty or omit it.

    IMPORTANT BOUNDING BOX RULES:
    - Coordinates MUST be integers between 0 and 1000.
    - They represent relative positions where [0,0] is the top-left corner of the image and [1000, 1000] is the bottom-right corner.
    - ymin: Top edge of the box
    - xmin: Left edge of the box
    - ymax: Bottom edge of the box
    - xmax: Right edge of the box
    - Ensure ymax is strictly greater than ymin, and xmax is strictly greater than xmin.
    - Make sure to leave a small margin around the text so nothing is cut off.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview", // Good balance of speed and vision capability
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
          description: "Structured test page data with shared contexts and questions.",
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
                  contextId: { type: Type.STRING, description: "ID of the shared context block this question relies on. Leave empty if none." }
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

    // Create a lookup map for context bounding boxes
    const contextMap = new Map();
    contexts.forEach((c: any) => {
      if (c.id) {
        contextMap.set(c.id, {
          ymin: c.ymin, xmin: c.xmin, ymax: c.ymax, xmax: c.xmax
        });
      }
    });
    
    // Map the raw JSON response to our expected interface format
    return questions.map((q: any) => {
      const result: Omit<QuestionRegion, 'id' | 'croppedDataUrl'> = {
        questionNumber: q.questionNumber,
        box: { ymin: q.ymin, xmin: q.xmin, ymax: q.ymax, xmax: q.xmax }
      };

      // If this question maps to a shared context, attach that bounding box
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
