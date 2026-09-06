import { describe, expect, it } from "vitest";
import { assertAiRequestAllowed, loadAiPolicy } from "./ai-policy";

const request = { fileBytes: 1_000, pageCount: 2, chunkCount: 2, estimatedInputTokens: 100, requestedOutputTokens: 100, questionCount: 2 };
const usage = { userTokensToday: 0, projectTokensThisMonth: 0 };

describe("AI cost policy", () => {
  it("fails closed by default", () => expect(() => assertAiRequestAllowed(request, usage, loadAiPolicy({}))).toThrow("AI is disabled"));
  it("rejects a request exceeding a project token budget", () => {
    const policy = loadAiPolicy({ AI_ENABLED: "true", AI_MAX_PROJECT_TOKENS_PER_MONTH: "150" });
    expect(() => assertAiRequestAllowed(request, usage, policy)).toThrow("Monthly project token limit");
  });
  it("permits a bounded enabled request", () => {
    const policy = loadAiPolicy({ AI_ENABLED: "true" });
    expect(() => assertAiRequestAllowed(request, usage, policy)).not.toThrow();
  });
});
