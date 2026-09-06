/**
 * Cost and safety policy for any server-side AI task. This module is deliberately
 * provider-agnostic: an OpenAI key alone never enables a request.
 */
export type AiIngestionRequest = {
  fileBytes: number;
  pageCount: number;
  chunkCount: number;
  estimatedInputTokens: number;
  requestedOutputTokens: number;
  questionCount: number;
};

export type AiUsage = {
  userTokensToday: number;
  projectTokensThisMonth: number;
};

export type AiPolicy = {
  enabled: boolean;
  maxFileBytes: number;
  maxPagesPerPublication: number;
  maxChunksPerPublication: number;
  maxInputTokensPerRequest: number;
  maxOutputTokensPerRequest: number;
  maxQuestionsPerPublication: number;
  maxUserTokensPerDay: number;
  maxProjectTokensPerMonth: number;
};

const positive = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

/** AI is disabled unless an operator explicitly opts in with AI_ENABLED=true. */
export function loadAiPolicy(env: NodeJS.ProcessEnv = process.env): AiPolicy {
  return {
    enabled: env.AI_ENABLED === "true",
    maxFileBytes: positive(env.AI_MAX_PDF_BYTES, 25 * 1024 * 1024),
    maxPagesPerPublication: positive(env.AI_MAX_PDF_PAGES, 150),
    maxChunksPerPublication: positive(env.AI_MAX_CHUNKS_PER_PUBLICATION, 180),
    maxInputTokensPerRequest: positive(env.AI_MAX_INPUT_TOKENS_PER_REQUEST, 12_000),
    maxOutputTokensPerRequest: positive(env.AI_MAX_OUTPUT_TOKENS_PER_REQUEST, 1_200),
    maxQuestionsPerPublication: positive(env.AI_MAX_QUESTIONS_PER_PUBLICATION, 20),
    maxUserTokensPerDay: positive(env.AI_MAX_USER_TOKENS_PER_DAY, 20_000),
    maxProjectTokensPerMonth: positive(env.AI_MAX_PROJECT_TOKENS_PER_MONTH, 150_000)
  };
}

function reject(message: string): never { throw new Error(`AI_POLICY_DENIED: ${message}`); }

/** Call before scheduling or sending every provider request. */
export function assertAiRequestAllowed(request: AiIngestionRequest, usage: AiUsage, policy = loadAiPolicy()): void {
  if (!policy.enabled) reject("AI is disabled. Set AI_ENABLED=true only after billing controls are configured.");
  if (request.fileBytes > policy.maxFileBytes) reject("PDF exceeds the configured file-size limit.");
  if (request.pageCount > policy.maxPagesPerPublication) reject("PDF exceeds the configured page limit.");
  if (request.chunkCount > policy.maxChunksPerPublication) reject("Publication exceeds the configured chunk limit.");
  if (request.estimatedInputTokens > policy.maxInputTokensPerRequest) reject("Request input exceeds the token limit.");
  if (request.requestedOutputTokens > policy.maxOutputTokensPerRequest) reject("Request output exceeds the token limit.");
  if (request.questionCount > policy.maxQuestionsPerPublication) reject("Requested question count exceeds the limit.");
  const requestedTokens = request.estimatedInputTokens + request.requestedOutputTokens;
  if (usage.userTokensToday + requestedTokens > policy.maxUserTokensPerDay) reject("Daily user token limit reached.");
  if (usage.projectTokensThisMonth + requestedTokens > policy.maxProjectTokensPerMonth) reject("Monthly project token limit reached.");
}

/**
 * Production implementation must use a Firestore transaction. Never trust
 * client-provided counters; reserve the token budget before calling a provider.
 */
export interface AiUsageLedger {
  reserve(input: { userId: string; tokens: number; now: Date }): Promise<AiUsage>;
  reconcile(input: { userId: string; reservedTokens: number; actualTokens: number; now: Date }): Promise<void>;
}
