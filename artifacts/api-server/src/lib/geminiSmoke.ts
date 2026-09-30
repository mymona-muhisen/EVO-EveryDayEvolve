import { geminiProvider } from "./gemini";

/** Explicit live smoke check: two small calls, no route or fallback involved. */
async function main(): Promise<void> {
  for (const json of [false, true]) {
    const kind = json ? "JSON" : "text";
    try {
      const result = await geminiProvider.generateText(
        json
          ? 'أعد JSON حصراً بالشكل: {"message": string}'
          : "اكتب تحية عربية قصيرة في جملة واحدة.",
        { greeting: "مرحبًا" },
        json,
      );
      if (json) {
        const parsed: unknown = JSON.parse(result);
        if (
          !parsed || typeof parsed !== "object" || !("message" in parsed) ||
          typeof parsed.message !== "string" || !parsed.message.trim()
        ) throw new Error("Invalid JSON response");
      }
      // Never print prompts, response text, SDK errors or credential-bearing requests.
      process.stdout.write(`Gemini ${kind} generation OK\n`);
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error &&
        typeof error.status === "number" && Number.isInteger(error.status) &&
        error.status >= 100 && error.status <= 599 ? ` (HTTP ${error.status})` : "";
      process.stderr.write(`Gemini ${kind} generation failed${status}\n`);
      process.exitCode = 1;
    }
  }
}

void main();