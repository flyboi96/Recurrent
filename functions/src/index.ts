import { createHash } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { defineSecret } from "firebase-functions/params";
import { googleAI } from "@genkit-ai/google-genai";
import { genkit, z } from "genkit";

initializeApp();
const db = getFirestore();
const googleGenAiKey = defineSecret("GOOGLE_GENAI_API_KEY");

// Project safety policy, deliberately independent of provider limits.
const MAX_PAGES = 1_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const CHUNK_CHARACTERS = 6_000;
const COVERAGE_PAGES_PER_RUN = 6;
const MAX_INPUT_TOKENS_PER_RUN = 12_000;
const MAX_OUTPUT_TOKENS_PER_RUN = 3_000;
const MAX_QUESTIONS_PER_PAGE = 3;
// A full 228-page handbook uses roughly 239k tokens. These hard ceilings allow
// one deliberate retry after a full run while containing accidental repeat use.
// Normal study uses saved questions and makes no model request.
const DAILY_LIMIT = 600_000;
const MONTHLY_LIMIT = 2_000_000;
const INGESTION_VERSION = 2;
const COVERAGE_VERSION = 2;
const WHOLE_DOCUMENT_VERSION = 2;
// Keep the map compact enough to complete as valid JSON while leaving room for
// the model to identify material across an entire handbook.
const WHOLE_DOCUMENT_OUTPUT_TOKENS = 8_000;
const WHOLE_DOCUMENT_TOKENS_PER_PAGE = 1_100;
const OBJECTIVE_BATCH_INPUT_TOKENS = 28_000;
const OBJECTIVE_BATCH_OUTPUT_TOKENS = 5_000;

type StoredPublication = { title: string; storagePath: string; fileBytes: number; externalAiApproved?: boolean; sourceHash?: string; generationCursorPage?: number; ingestionVersion?: number; coverageVersion?: number; wholeDocumentVersion?: number; coverageObjectives?: CoverageObjective[]; coverageQuestionTarget?: number; coverageQuestionCount?: number };
type SourceChunk = { id: string; page: number; chunkIndex: number; text: string };
type GeneratedQuestion = { question: string; answer: string; explanation: string; category?: string; page?: number; strictRecall?: boolean };
const GeneratedQuestionSetSchema = z.object({ questions: z.array(z.object({ question: z.string(), answer: z.string(), explanation: z.string(), category: z.string().optional(), page: z.number().int(), strictRecall: z.boolean().optional() })) });
type WholeDocumentQuestion = { question: string; answer: string; explanation: string; category: string; page: number; strictRecall?: boolean; objectiveId: string };
type CoverageObjective = { id: string; objective: string; category: string; startPage: number; endPage: number; importance: "critical" | "high" | "standard"; requiredQuestions: number };
type WholeDocumentPlan = { objectives: CoverageObjective[]; questions?: WholeDocumentQuestion[] };
const parseJson = <T>(value: string): T => JSON.parse(value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as T;
const geminiUrl = (model: string, apiKey: string) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
const coveragePlanSchema = { type: "OBJECT", properties: { objectives: { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "STRING" }, objective: { type: "STRING" }, category: { type: "STRING" }, startPage: { type: "INTEGER" }, endPage: { type: "INTEGER" }, importance: { type: "STRING", enum: ["critical", "high", "standard"] }, requiredQuestions: { type: "INTEGER" } }, required: ["id", "objective", "category", "startPage", "endPage", "importance", "requiredQuestions"] } } }, required: ["objectives"] };
const coverageBatchSchema = { type: "OBJECT", properties: { questions: { type: "ARRAY", items: { type: "OBJECT", properties: { objectiveId: { type: "STRING" }, question: { type: "STRING" }, answer: { type: "STRING" }, explanation: { type: "STRING" }, category: { type: "STRING" }, page: { type: "INTEGER" }, strictRecall: { type: "BOOLEAN" } }, required: ["objectiveId", "question", "answer", "explanation", "category", "page", "strictRecall"] } } }, required: ["questions"] };
const gradeSchema = { type: "OBJECT", properties: { rating: { type: "STRING", enum: ["correct", "partial", "needs-review"] }, feedback: { type: "STRING" }, missing: { type: "STRING" } }, required: ["rating", "feedback", "missing"] };

const estimateTokens = (text: string) => Math.ceil(text.length / 4);
const period = (date: Date, kind: "day" | "month") => kind === "day" ? date.toISOString().slice(0, 10) : date.toISOString().slice(0, 7);
const splitText = (text: string) => text.match(new RegExp(`.{1,${CHUNK_CHARACTERS}}(?:\\s|$)`, "g"))?.map(value => value.trim()).filter(Boolean) ?? [];

async function checkBudgetHeadroom(userId: string, worstCaseTokens: number) {
  const now = new Date(); const day = db.doc(`users/${userId}/aiUsage/daily-${period(now, "day")}`); const month = db.doc(`users/${userId}/aiUsage/monthly-${period(now, "month")}`);
  await db.runTransaction(async transaction => {
    const [daySnapshot, monthSnapshot] = await Promise.all([transaction.get(day), transaction.get(month)]);
    // reservedTokens was written by releases before v0.3.4, even when Gemini
    // failed.  It is intentionally ignored here so failed setup attempts do
    // not consume a user's future study allowance.
    const dayTokens = Number(daySnapshot.data()?.actualTokens ?? 0); const monthTokens = Number(monthSnapshot.data()?.actualTokens ?? 0);
    if (dayTokens + worstCaseTokens > DAILY_LIMIT) throw new HttpsError("resource-exhausted", "Daily AI budget reached. Try another coverage set tomorrow.");
    if (monthTokens + worstCaseTokens > MONTHLY_LIMIT) throw new HttpsError("resource-exhausted", "Monthly AI budget reached. Try again next month.");
  });
}

async function recordSuccessfulUsage(userId: string, inputTokens: number, outputTokens: number) {
  const actualTokens = Math.max(1, inputTokens + outputTokens); const now = new Date(); const day = db.doc(`users/${userId}/aiUsage/daily-${period(now, "day")}`); const month = db.doc(`users/${userId}/aiUsage/monthly-${period(now, "month")}`);
  await db.runTransaction(async transaction => {
    const [daySnapshot, monthSnapshot] = await Promise.all([transaction.get(day), transaction.get(month)]);
    const dayTokens = Number(daySnapshot.data()?.actualTokens ?? 0); const monthTokens = Number(monthSnapshot.data()?.actualTokens ?? 0);
    if (dayTokens + actualTokens > DAILY_LIMIT) throw new HttpsError("resource-exhausted", "Daily AI budget reached. Try another coverage set tomorrow.");
    if (monthTokens + actualTokens > MONTHLY_LIMIT) throw new HttpsError("resource-exhausted", "Monthly AI budget reached. Try again next month.");
    const usage = { actualTokens: dayTokens + actualTokens, inputTokens: FieldValue.increment(inputTokens), outputTokens: FieldValue.increment(outputTokens), successfulRuns: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() };
    transaction.set(day, usage, { merge: true }); transaction.set(month, { ...usage, actualTokens: monthTokens + actualTokens }, { merge: true });
  });
}

async function extractPages(buffer: Buffer): Promise<{ page: number; text: string }[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs"); const document = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  if (document.numPages > MAX_PAGES) throw new HttpsError("invalid-argument", `PDF exceeds the ${MAX_PAGES}-page safety limit.`);
  const pages: { page: number; text: string }[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) { const page = await document.getPage(pageNumber); const content = await page.getTextContent(); const text = content.items.map(item => "str" in item ? item.str : "").join(" ").replace(/\s+/g, " ").trim(); if (text) pages.push({ page: pageNumber, text }); }
  return pages;
}

async function writeChunks(userId: string, publicationId: string, pages: { page: number; text: string }[]) {
  const writes = pages.flatMap(page => splitText(page.text).map((text, chunkIndex) => ({ page: page.page, chunkIndex, text })));
  for (let start = 0; start < writes.length; start += 400) { const batch = db.batch(); writes.slice(start, start + 400).forEach(chunk => { const id = `p${String(chunk.page).padStart(4, "0")}-c${String(chunk.chunkIndex).padStart(3, "0")}`; batch.set(db.doc(`users/${userId}/publications/${publicationId}/chunks/${id}`), { ...chunk, ingestionVersion: INGESTION_VERSION, createdAt: FieldValue.serverTimestamp() }, { merge: true }); }); await batch.commit(); }
  return writes.length;
}

async function existingPublicationQuestions(userId: string, publicationId: string) {
  return db.collection(`users/${userId}/questions`).where("publicationId", "==", publicationId).get();
}

async function indexPublication(userId: string, publicationId: string, publication: StoredPublication) {
  const [buffer] = await getStorage().bucket().file(publication.storagePath).download(); const sourceHash = createHash("sha256").update(buffer).digest("hex"); const pages = await extractPages(buffer); const chunkCount = await writeChunks(userId, publicationId, pages);
  await db.doc(`users/${userId}/publications/${publicationId}`).set({ sourceHash, pageCount: pages.length, chunkCount, ingestionVersion: INGESTION_VERSION, generationCursorPage: 1, indexedAt: FieldValue.serverTimestamp(), status: "indexed" }, { merge: true });
  return { sourceHash, pageCount: pages.length, chunkCount };
}

async function nextCoverageChunks(userId: string, publicationId: string, cursorPage: number) {
  const snapshot = await db.collection(`users/${userId}/publications/${publicationId}/chunks`).where("page", ">=", cursorPage).orderBy("page").limit(COVERAGE_PAGES_PER_RUN * 8).get(); const chunks: SourceChunk[] = []; const usedPages = new Set<number>();
  for (const document of snapshot.docs) { const data = document.data(); const page = Number(data.page); if (usedPages.has(page)) continue; usedPages.add(page); chunks.push({ id: document.id, page, chunkIndex: Number(data.chunkIndex), text: String(data.text) }); if (chunks.length === COVERAGE_PAGES_PER_RUN) break; }
  return chunks;
}

async function generateCoverageSet(userId: string, publicationId: string, publication: StoredPublication) {
  // A new coverage version re-visits an existing manual without deleting the
  // earlier questions. This lets us deepen an initial smoke-test pass safely.
  const replaceExistingCoverage = publication.coverageVersion !== COVERAGE_VERSION; const cursorPage = replaceExistingCoverage ? 1 : publication.generationCursorPage ?? 1; const chunks = await nextCoverageChunks(userId, publicationId, cursorPage);
  if (!chunks.length) { await db.doc(`users/${userId}/publications/${publicationId}`).set({ status: "ready", coverageCompleteAt: FieldValue.serverTimestamp() }, { merge: true }); return { generated: 0, complete: true, nextPage: null }; }
  const source = chunks.map(chunk => `[page ${chunk.page}]\n${chunk.text}`).join("\n\n"); const inputTokens = estimateTokens(source);
  if (inputTokens > MAX_INPUT_TOKENS_PER_RUN) throw new HttpsError("resource-exhausted", "This coverage set exceeds the input safety budget."); await checkBudgetHeadroom(userId, inputTokens + MAX_OUTPUT_TOKENS_PER_RUN);
  const apiKey = googleGenAiKey.value(); if (!apiKey) throw new HttpsError("failed-precondition", "Google GenAI secret is not configured."); const ai = genkit({ plugins: [googleAI({ apiKey })] });
  let result; try { result = await ai.generate({ model: googleAI.model(process.env.GEMINI_MODEL || "gemini-3.6-flash"), config: { maxOutputTokens: MAX_OUTPUT_TOKENS_PER_RUN, temperature: 0.1, thinkingConfig: { thinkingLevel: "MINIMAL" } }, output: { schema: GeneratedQuestionSetSchema }, prompt: `Create only job-relevant, source-grounded professional study questions from the supplied passages. Test operational procedures, limitations, warnings, cautions, decision conditions, system behavior, emergency actions, and exact values where operationally relevant. Do NOT ask about the manual's title, version, revision history, volume, table of contents, page location, chapter layout, publication organization, or other document-navigation trivia. If a page contains only administrative or navigation material, return no question for that page. For operational material, return one to three DISTINCT questions. Return every field for every question: question, answer, explanation, and exact page number. Keep each field concise. Use only the passages; do not invent facts or duplicate a fact.\n\n${source}` }); } catch (error) { logger.warn("Gemini returned an incomplete coverage set", { publicationId, message: error instanceof Error ? error.message.slice(0, 160) : "Unknown error" }); throw new HttpsError("unavailable", "Gemini returned an incomplete coverage set. Please retry."); }
  const generated = result.output?.questions as GeneratedQuestion[] | undefined; if (!Array.isArray(generated)) throw new Error("Gemini returned no structured questions.");
  // Prefer the provider's measured usage; retain a conservative local fallback
  // for providers that omit usage metadata.
  const actualInputTokens = Number(result.usage.inputTokens ?? inputTokens); const actualOutputTokens = Number(result.usage.outputTokens ?? estimateTokens(JSON.stringify(generated))); await recordSuccessfulUsage(userId, actualInputTokens, actualOutputTokens);
  const validPages = new Set(chunks.map(chunk => chunk.page)); const questionsPerPage = new Map<number, number>(); const questionFingerprints = new Set<string>(); const accepted = generated.filter(question => { const page = Number(question.page); const fingerprint = `${page}:${question.question.trim().toLowerCase()}`; const count = questionsPerPage.get(page) ?? 0; if (!validPages.has(page) || !question.question.trim() || !question.answer.trim() || !question.explanation.trim() || questionFingerprints.has(fingerprint) || count >= MAX_QUESTIONS_PER_PAGE) return false; questionsPerPage.set(page, count + 1); questionFingerprints.add(fingerprint); return true; }); const batch = db.batch();
  const previousQuestions = replaceExistingCoverage ? await existingPublicationQuestions(userId, publicationId) : null; if (previousQuestions && previousQuestions.size + accepted.length > 400) throw new HttpsError("failed-precondition", "This publication needs a staged coverage upgrade."); previousQuestions?.docs.forEach(question => batch.delete(question.ref));
  accepted.forEach(question => { const sourceChunk = chunks.find(chunk => chunk.page === Number(question.page)); batch.set(db.collection(`users/${userId}/questions`).doc(), { question: question.question, answer: question.answer, explanation: question.explanation, category: question.category || "other", page: Number(question.page), strictRecall: Boolean(question.strictRecall), publicationId, publicationTitle: publication.title, sourceChunkId: sourceChunk?.id ?? null, sourceExcerpt: sourceChunk?.text.slice(0, 700) ?? "", createdAt: FieldValue.serverTimestamp() }); });
  const nextPage = Math.max(...chunks.map(chunk => chunk.page)) + 1; batch.set(db.doc(`users/${userId}/publications/${publicationId}`), { status: "ready", coverageVersion: COVERAGE_VERSION, generationCursorPage: nextPage, questionCount: replaceExistingCoverage ? accepted.length : FieldValue.increment(accepted.length), lastGeneratedAt: FieldValue.serverTimestamp() }, { merge: true }); await batch.commit(); return { generated: accepted.length, complete: false, nextPage };
}

async function generateWholeDocumentSet(userId: string, publicationId: string, publication: StoredPublication) {
  const [buffer] = await getStorage().bucket().file(publication.storagePath).download(); const pages = Math.max(1, Number((await db.doc(`users/${userId}/publications/${publicationId}`).get()).data()?.pageCount ?? 1));
  // The provider reported roughly 1,035 input tokens/page for this handbook.
  // Reserve against observed whole-PDF usage, not the old optimistic estimate.
  await checkBudgetHeadroom(userId, pages * WHOLE_DOCUMENT_TOKENS_PER_PAGE + WHOLE_DOCUMENT_OUTPUT_TOKENS);
  const apiKey = googleGenAiKey.value(); if (!apiKey) throw new HttpsError("failed-precondition", "Google GenAI secret is not configured.");
  const prompt = `Create a comprehensive, coverage-driven learning-objective map from this entire aircraft operating handbook. Do not select an arbitrary total question count. Identify every meaningful operational objective: procedures, systems, limitations, warnings/cautions, emergency actions, decision conditions, failure indications, and exact operational values. Exclude document-navigation trivia such as title, revision history, volume, table of contents, page locations, and document organization.

Return a compact JSON map with at most 45 thematic objectives. Each objective may cover a closely related page range, so cover the entire handbook instead of making one item per detail. Keep objective text under 16 words and category text under 5 words. Combine related standard details; do not omit critical or high operational material. Use one question for each standard objective, two for high objectives, and up to three for critical objectives where distinct recall is needed. This request creates the coverage map only; source-grounded questions will be generated in smaller follow-up batches.`;
  const response = await fetch(geminiUrl(process.env.GEMINI_MODEL || "gemini-3.6-flash", apiKey), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: "application/pdf", data: buffer.toString("base64") } }, { text: prompt }] }], generationConfig: { responseMimeType: "application/json", responseJsonSchema: coveragePlanSchema, maxOutputTokens: WHOLE_DOCUMENT_OUTPUT_TOKENS, temperature: 0.1, thinkingConfig: { thinkingLevel: "MINIMAL" } } }) });
  if (!response.ok) throw new HttpsError("unavailable", `Gemini document request failed (${response.status}).`); const payload = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
  const candidate = payload.candidates?.[0]; const text = candidate?.content?.parts?.map(part => part.text ?? "").join("") ?? ""; await recordSuccessfulUsage(userId, Number(payload.usageMetadata?.promptTokenCount ?? pages * WHOLE_DOCUMENT_TOKENS_PER_PAGE), Number(payload.usageMetadata?.candidatesTokenCount ?? estimateTokens(text))); let plan: WholeDocumentPlan; try { plan = parseJson<WholeDocumentPlan>(text); } catch { logger.warn("Gemini coverage plan was not valid JSON", { publicationId, finishReason: (candidate as { finishReason?: string } | undefined)?.finishReason ?? "missing", responseCharacters: text.length }); throw new HttpsError("unavailable", "Gemini returned an incomplete coverage plan. Please retry."); }
  const objectives = (plan.objectives ?? []).filter(objective => objective.id?.trim() && objective.objective?.trim() && Number.isInteger(objective.startPage) && Number.isInteger(objective.endPage) && objective.requiredQuestions > 0).slice(0, 180); if (objectives.length < 10) throw new HttpsError("unavailable", "Gemini returned too little operational coverage. Please retry."); const accepted: WholeDocumentQuestion[] = [];
  const chunks = await db.collection(`users/${userId}/publications/${publicationId}/chunks`).get(); const chunksByPage = new Map<number, SourceChunk>(); chunks.docs.forEach(document => { const data = document.data(); const page = Number(data.page); if (!chunksByPage.has(page)) chunksByPage.set(page, { id: document.id, page, chunkIndex: Number(data.chunkIndex), text: String(data.text) }); });
  const previous = await existingPublicationQuestions(userId, publicationId); if (previous.size + accepted.length > 400) throw new HttpsError("failed-precondition", "This publication needs a staged question-bank replacement."); const batch = db.batch(); previous.docs.forEach(question => batch.delete(question.ref));
  for (const question of accepted) { const chunk = chunksByPage.get(question.page); batch.set(db.collection(`users/${userId}/questions`).doc(), { ...question, strictRecall: Boolean(question.strictRecall), publicationId, publicationTitle: publication.title, sourceChunkId: chunk?.id ?? null, sourceExcerpt: String(chunk?.text ?? "").slice(0, 700), generatedBy: "gemini-coverage-plan", createdAt: FieldValue.serverTimestamp() }); }
  const target = objectives.reduce((total, objective) => total + Math.min(3, Number(objective.requiredQuestions)), 0);
  batch.set(db.doc(`users/${userId}/publications/${publicationId}`), { status: "ready", wholeDocumentVersion: WHOLE_DOCUMENT_VERSION, coverageObjectives: objectives, coverageObjectiveCount: objectives.length, coverageQuestionTarget: target, coverageQuestionCount: 0, coverageComplete: false, questionCount: 0, wholeDocumentGeneratedAt: FieldValue.serverTimestamp() }, { merge: true }); await batch.commit(); return { generated: 0, complete: false, nextPage: null, remainingObjectives: objectives.length, planning: true };
}

async function generateRemainingCoverage(userId: string, publicationId: string, publication: StoredPublication) {
  const objectives = Array.isArray(publication.coverageObjectives) ? publication.coverageObjectives : [];
  const existing = await existingPublicationQuestions(userId, publicationId); const answeredByObjective = new Map<string, number>(); existing.docs.forEach(document => { const id = String(document.data().objectiveId ?? ""); if (id) answeredByObjective.set(id, (answeredByObjective.get(id) ?? 0) + 1); });
  const remaining = objectives.filter(objective => (answeredByObjective.get(objective.id) ?? 0) < objective.requiredQuestions); if (!remaining.length) return { generated: 0, complete: true, nextPage: null, remainingObjectives: 0 };
  const sourceChunks = await db.collection(`users/${userId}/publications/${publicationId}/chunks`).get(); const chunks = sourceChunks.docs.map(document => ({ id: document.id, ...document.data() } as SourceChunk)); const selected: CoverageObjective[] = []; let source = "";
  for (const objective of remaining) { const pages = chunks.filter(chunk => chunk.page >= objective.startPage && chunk.page <= objective.endPage); const addition = pages.map(chunk => `[page ${chunk.page}]\n${chunk.text}`).join("\n\n"); if (!addition || estimateTokens(`${source}\n${addition}`) > OBJECTIVE_BATCH_INPUT_TOKENS) continue; selected.push(objective); source += `\n\n[OBJECTIVE ${objective.id}: ${objective.objective}; remaining questions: ${objective.requiredQuestions - (answeredByObjective.get(objective.id) ?? 0)}]\n${addition}`; if (selected.length >= 6) break; }
  if (!selected.length) throw new HttpsError("resource-exhausted", "The next uncovered objectives exceed the per-run source safety budget."); await checkBudgetHeadroom(userId, estimateTokens(source) + OBJECTIVE_BATCH_OUTPUT_TOKENS);
  const apiKey = googleGenAiKey.value(); if (!apiKey) throw new HttpsError("failed-precondition", "Google GenAI secret is not configured."); const prompt = `Create source-grounded recurrent-study questions only for the supplied coverage objectives and passages. For each objective, generate its stated remaining number of DISTINCT questions. Test operational procedures, limitations, warnings/cautions, decision conditions, system behavior, emergency actions, and exact values when operationally relevant. Never ask document-navigation trivia. Return JSON only: {"questions":[{"objectiveId":"","question":"","answer":"","explanation":"why this matters operationally","category":"","page":1,"strictRecall":false}]}. Use only the provided passages.`;
  const response = await fetch(geminiUrl(process.env.GEMINI_MODEL || "gemini-3.6-flash", apiKey), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: `${prompt}\n\n${source}` }] }], generationConfig: { responseMimeType: "application/json", responseJsonSchema: coverageBatchSchema, maxOutputTokens: 6_000, temperature: 0.1, thinkingConfig: { thinkingLevel: "MINIMAL" } } }) }); if (!response.ok) throw new HttpsError("unavailable", `Gemini coverage request failed (${response.status}).`);
  const payload = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }; const candidate = payload.candidates?.[0]; const text = candidate?.content?.parts?.map(part => part.text ?? "").join("") ?? ""; await recordSuccessfulUsage(userId, Number(payload.usageMetadata?.promptTokenCount ?? estimateTokens(source)), Number(payload.usageMetadata?.candidatesTokenCount ?? estimateTokens(text))); let generated: WholeDocumentQuestion[]; try { generated = parseJson<{ questions: WholeDocumentQuestion[] }>(text).questions; } catch { logger.warn("Gemini coverage batch was not valid JSON", { publicationId, finishReason: candidate?.finishReason ?? "missing", responseCharacters: text.length, objectiveCount: selected.length }); throw new HttpsError("unavailable", "Gemini returned an incomplete coverage batch. Please retry."); }
  const allowed = new Set(selected.map(objective => objective.id)); const accepted = generated.filter(question => allowed.has(question.objectiveId) && question.question?.trim() && question.answer?.trim() && question.explanation?.trim() && Number.isInteger(question.page)); if (!accepted.length) throw new HttpsError("unavailable", "Gemini returned no usable coverage questions. Please retry.");
  const chunksByPage = new Map<number, SourceChunk>(); chunks.forEach(chunk => { if (!chunksByPage.has(chunk.page)) chunksByPage.set(chunk.page, chunk); }); const batch = db.batch(); accepted.forEach(question => { const chunk = chunksByPage.get(question.page); batch.set(db.collection(`users/${userId}/questions`).doc(), { ...question, strictRecall: Boolean(question.strictRecall), publicationId, publicationTitle: publication.title, sourceChunkId: chunk?.id ?? null, sourceExcerpt: String(chunk?.text ?? "").slice(0, 700), generatedBy: "gemini-coverage-batch", createdAt: FieldValue.serverTimestamp() }); });
  const total = existing.size + accepted.length; const target = Number(publication.coverageQuestionTarget ?? total); const updatedCounts = new Map(answeredByObjective); accepted.forEach(question => updatedCounts.set(question.objectiveId, (updatedCounts.get(question.objectiveId) ?? 0) + 1)); const remainingObjectives = objectives.filter(objective => (updatedCounts.get(objective.id) ?? 0) < objective.requiredQuestions).length; const complete = remainingObjectives === 0 && total >= target; batch.set(db.doc(`users/${userId}/publications/${publicationId}`), { status: "ready", questionCount: total, coverageQuestionCount: total, coverageComplete: complete, lastCoverageBatchAt: FieldValue.serverTimestamp() }, { merge: true }); await batch.commit(); return { generated: accepted.length, complete, nextPage: null, remainingObjectives };
}

export const gradeFreeResponse = onCall({ region: "us-central1", timeoutSeconds: 60, memory: "512MiB", maxInstances: 1, concurrency: 1, secrets: [googleGenAiKey], enforceAppCheck: false }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to grade an answer."); const questionId = String(request.data?.questionId ?? ""); const responseText = String(request.data?.response ?? "").trim(); if (!questionId || !responseText) throw new HttpsError("invalid-argument", "questionId and response are required.");
  const question = (await db.doc(`users/${request.auth.uid}/questions/${questionId}`).get()).data(); if (!question) throw new HttpsError("not-found", "Question not found."); await checkBudgetHeadroom(request.auth.uid, 1_500); const apiKey = googleGenAiKey.value(); if (!apiKey) throw new HttpsError("failed-precondition", "Google GenAI secret is not configured.");
  const prompt = `Grade this learner response against the source-grounded rubric. Do not require word-for-word agreement. Return JSON only: {"rating":"correct|partial|needs-review","feedback":"","missing":""}. Question: ${question.question}\nExpected answer: ${question.answer}\nWhy it matters: ${question.explanation}\nSource excerpt: ${question.sourceExcerpt}\nLearner response: ${responseText}`;
  const response = await fetch(geminiUrl(process.env.GEMINI_MODEL || "gemini-3.6-flash", apiKey), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", responseJsonSchema: gradeSchema, maxOutputTokens: 500, temperature: 0, thinkingConfig: { thinkingLevel: "MINIMAL" } } }) }); if (!response.ok) throw new HttpsError("unavailable", "AI grading is temporarily unavailable."); const payload = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }; const candidate = payload.candidates?.[0]; const text = candidate?.content?.parts?.map(part => part.text ?? "").join("") ?? ""; await recordSuccessfulUsage(request.auth.uid, Number(payload.usageMetadata?.promptTokenCount ?? estimateTokens(prompt)), Number(payload.usageMetadata?.candidatesTokenCount ?? estimateTokens(text))); try { return parseJson<{ rating: string; feedback: string; missing: string }>(text); } catch { logger.warn("Gemini grading response was not valid JSON", { questionId, finishReason: candidate?.finishReason ?? "missing", responseCharacters: text.length }); throw new HttpsError("unavailable", "AI grading is temporarily unavailable."); }
});

/** Manual-only worker. App Check remains in observation mode until valid production metrics are confirmed. */
export const processPublication = onCall({ region: "us-central1", timeoutSeconds: 540, memory: "1GiB", maxInstances: 1, concurrency: 1, secrets: [googleGenAiKey], enforceAppCheck: false }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to process a publication."); if (process.env.AI_ENABLED !== "true") throw new HttpsError("failed-precondition", "AI processing is disabled by project policy."); const userId = request.auth.uid; const publicationId = String(request.data?.publicationId ?? ""); if (!publicationId) throw new HttpsError("invalid-argument", "publicationId is required.");
  const publicationRef = db.doc(`users/${userId}/publications/${publicationId}`); const publicationSnapshot = await publicationRef.get(); if (!publicationSnapshot.exists) throw new HttpsError("not-found", "Publication not found."); const publication = publicationSnapshot.data() as StoredPublication;
  if (!publication.externalAiApproved) throw new HttpsError("permission-denied", "External AI approval is required for this publication."); if (!publication.storagePath || publication.fileBytes > MAX_FILE_BYTES) throw new HttpsError("invalid-argument", "Publication is not eligible for processing.");
  try { if (!publication.sourceHash || publication.ingestionVersion !== INGESTION_VERSION) { await publicationRef.set({ status: "indexing", processingStartedAt: FieldValue.serverTimestamp() }, { merge: true }); const indexed = await indexPublication(userId, publicationId, publication); const refreshed = (await publicationRef.get()).data() as StoredPublication; return { indexed, ...(await generateWholeDocumentSet(userId, publicationId, refreshed)) }; } if (publication.wholeDocumentVersion === WHOLE_DOCUMENT_VERSION && Array.isArray(publication.coverageObjectives)) return await generateRemainingCoverage(userId, publicationId, publication); return await generateWholeDocumentSet(userId, publicationId, publication); } catch (error) { logger.error("Publication processing failed", { publicationId, error }); await publicationRef.set({ status: "failed", processingError: error instanceof Error ? error.message.slice(0, 200) : "Unknown error" }, { merge: true }); throw error; }
});
