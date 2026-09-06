import type { Question } from "@/domain/types";

export interface AiProvider { generateQuestions(input: { source: string; publicationId: string }): Promise<Question[]>; evaluateConceptual(input: { question: Question; answer: string }): Promise<{ correct: boolean; feedback: string }>; }

/** Server-side provider seam. Implement with OpenAI only in a Cloud Function/API route. */
export class UnconfiguredAiProvider implements AiProvider {
  async generateQuestions(): Promise<Question[]> { throw new Error("AI processing has not been configured."); }
  async evaluateConceptual(): Promise<{ correct: boolean; feedback: string }> { throw new Error("AI grading has not been configured."); }
}
