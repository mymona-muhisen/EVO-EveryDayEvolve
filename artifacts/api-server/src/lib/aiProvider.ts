/** Text-generation boundary: callers provide facts, never SDK-specific requests. */
export interface AiTextProvider {
  generateText(system: string, context: object, json?: boolean): Promise<string>;
}