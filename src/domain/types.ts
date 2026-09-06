export type ContentType = "systems" | "limitations" | "emergency" | "regulations" | "weather";
export type QuestionType = "multiple-choice" | "free-recall" | "exact-recall" | "scenario";
export type Sensitivity = "public" | "private" | "controlled";

export interface SourceReference {
  publicationId: string;
  publicationTitle: string;
  section: string;
  page: number;
  excerpt: string;
}
export interface Publication {
  id: string; title: string; platform: string; category: ContentType; enabled: boolean;
  dailyQuiz: boolean; dailyLesson: boolean; priority: "high" | "normal" | "low";
  sensitivity: Sensitivity; status: "ready" | "processing" | "failed"; pages: number;
}
export interface Question {
  id: string; type: QuestionType; prompt: string; choices?: string[]; answer: string;
  explanation: string; source: SourceReference; category: ContentType; criticality: number;
  strictRecall?: boolean; isNew?: boolean;
}
export interface MasteryState { questionId: string; attempts: number; correct: number; lastReviewed?: string; dueAt?: string; }
export interface StudyResult { questionId: string; correct: boolean; confidence: 1 | 2 | 3; answeredAt: string; }
export interface StudyProfile { id: string; name: string; description: string; questionCount: number; emphasis: ContentType[]; }
