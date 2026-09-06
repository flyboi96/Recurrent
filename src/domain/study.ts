import { MasteryState, Question, StudyResult } from "./types";

export const DEFAULT_WEIGHTS = { due: 35, weak: 20, critical: 15, recent: 15, fresh: 15 };

/** A cautious score: sparse data stays close to 50 rather than implying precision. */
export function masteryPercent(states: MasteryState[]): number | null {
  if (!states.length) return null;
  const total = states.reduce((sum, state) => sum + state.attempts, 0);
  if (!total) return null;
  const correct = states.reduce((sum, state) => sum + state.correct, 0);
  return Math.round(((correct + 1) / (total + 2)) * 100 / 5) * 5;
}

export function nextReviewDate(result: StudyResult, prior?: MasteryState): Date {
  const successes = result.correct ? (prior?.correct ?? 0) + 1 : 0;
  const days = result.correct ? Math.min(30, Math.max(1, 2 ** Math.min(successes, 5)) * result.confidence) : 1;
  const date = new Date(result.answeredAt);
  date.setDate(date.getDate() + days);
  return date;
}

export function selectDailyQuestions(questions: Question[], states: Record<string, MasteryState>, count = 5, now = new Date()): Question[] {
  const scored = questions.map((question) => {
    const state = states[question.id];
    const accuracy = state?.attempts ? state.correct / state.attempts : 0.5;
    const overdue = !state?.dueAt || new Date(state.dueAt) <= now;
    const weak = state?.attempts && accuracy < 0.75;
    const score = (overdue ? DEFAULT_WEIGHTS.due : 0) + (weak ? DEFAULT_WEIGHTS.weak : 0) +
      question.criticality * DEFAULT_WEIGHTS.critical + (question.isNew ? DEFAULT_WEIGHTS.fresh : DEFAULT_WEIGHTS.recent);
    return { question, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, count).map(({ question }) => question);
}
