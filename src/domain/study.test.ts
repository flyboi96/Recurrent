import { describe, expect, it } from "vitest";
import { masteryPercent, nextReviewDate, selectDailyQuestions } from "./study";
import type { Question } from "./types";

const q = (id: string, criticality = 0): Question => ({ id, type: "multiple-choice", prompt: id, answer: "a", explanation: "", category: "systems", criticality, source: { publicationId: "p", publicationTitle: "P", section: "1", page: 1, excerpt: "x" } });
describe("study rules", () => {
  it("does not claim mastery without evidence", () => expect(masteryPercent([])).toBeNull());
  it("prioritizes critical overdue material", () => expect(selectDailyQuestions([q("new"), q("critical", 1)], { critical: { questionId: "critical", attempts: 1, correct: 0, dueAt: "2020-01-01" } }, 1)[0].id).toBe("critical"));
  it("repeats a failed item tomorrow", () => expect(nextReviewDate({ questionId: "q", correct: false, confidence: 2, answeredAt: "2026-09-06T00:00:00Z" }).toISOString().slice(0, 10)).toBe("2026-09-07"));
});
