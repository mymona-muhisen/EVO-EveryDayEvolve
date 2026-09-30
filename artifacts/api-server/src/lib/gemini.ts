import { GoogleGenAI } from "@google/genai";
import type { AiTextProvider } from "./aiProvider";

export const GEMINI_MODEL = "gemini-3-flash-preview";

/** Server-only adapter. The client is initialized lazily so missing keys use fallbacks. */
export const geminiProvider: AiTextProvider = {
  async generateText(system, context, json = false) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

    const client = new GoogleGenAI({ apiKey });
    const response = await client.models.generateContent({
      model: GEMINI_MODEL,
      contents: JSON.stringify(context),
      config: {
        systemInstruction: system,
        temperature: 0.8,
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: json ? 1024 : 300,
        ...(json ? { responseMimeType: "application/json" } : {}),
      },
    });
    const text = response.text?.trim();
    if (!text) throw new Error("Empty Gemini response");
    return text;
  },
};