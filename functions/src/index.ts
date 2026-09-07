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
const MAX_OUTPUT_TOKENS_PER_RUN = 1_200;
const DAILY_LIMIT = 20_000;
const MONTHLY_LIMIT = 150_000;
const INGESTION_VERSION = 2;

type StoredPublication = { title: string; storagePath: string; fileBytes: number; externalAiApproved?: boolean; sourceHash?: string; generationCursorPage?: number; ingestionVersion?: number };
type SourceChunk = { id: string; page: number; chunkIndex: number; text: string };
type GeneratedQuestion = { question: string; answer: string; explanation: string; category?: string; page?: number; strictRecall?: boolean };
const GeneratedQuestionSetSchema = z.object({ questions: z.array(z.object({ question: z.string(), answer: z.string(), explanation: z.string(), category: z.string().optional(), page: z.number().int(), strictRecall: z.boolean().optional() })) });

const estimateTokens = (text: string) => Math.ceil(text.length / 4);
const period = (date: Date, kind: "day" | "month") => kind === "day" ? date.toISOString().slice(0, 10) : date.toISOString().slice(0, 7);
const splitText = (text: string) => text.match(new RegExp(`.{1,${CHUNK_CHARACTERS}}(?:\\s|$)`, "g"))?.map(value => value.trim()).filter(Boolean) ?? [];

async function reserveTokens(userId: string, tokens: number) {
  const now = new Date(); const day = db.doc(`users/${userId}/aiUsage/daily-${period(now, "day")}`); const month = db.doc(`users/${userId}/aiUsage/monthly-${period(now, "month")}`);
  await db.runTransaction(async transaction => {
    const [daySnapshot, monthSnapshot] = await Promise.all([transaction.get(day), transaction.get(month)]);
    const dayTokens = Number(daySnapshot.data()?.reservedTokens ?? 0); const monthTokens = Number(monthSnapshot.data()?.reservedTokens ?? 0);
    if (dayTokens + tokens > DAILY_LIMIT) throw new HttpsError("resource-exhausted", "Daily AI budget reached.");
    if (monthTokens + tokens > MONTHLY_LIMIT) throw new HttpsError("resource-exhausted", "Monthly project AI budget reached.");
    transaction.set(day, { reservedTokens: dayTokens + tokens, updatedAt: FieldValue.serverTimestamp() }, { merge: true }); transaction.set(month, { reservedTokens: monthTokens + tokens, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
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
  const chunks = await nextCoverageChunks(userId, publicationId, publication.generationCursorPage ?? 1);
  if (!chunks.length) { await db.doc(`users/${userId}/publications/${publicationId}`).set({ status: "ready", coverageCompleteAt: FieldValue.serverTimestamp() }, { merge: true }); return { generated: 0, complete: true, nextPage: null }; }
  const source = chunks.map(chunk => `[page ${chunk.page}]\n${chunk.text}`).join("\n\n"); const inputTokens = estimateTokens(source);
  if (inputTokens > MAX_INPUT_TOKENS_PER_RUN) throw new HttpsError("resource-exhausted", "This coverage set exceeds the input safety budget."); await reserveTokens(userId, inputTokens + MAX_OUTPUT_TOKENS_PER_RUN);
  const apiKey = googleGenAiKey.value(); if (!apiKey) throw new HttpsError("failed-precondition", "Google GenAI secret is not configured."); const ai = genkit({ plugins: [googleAI({ apiKey })] });
  const result = await ai.generate({ model: googleAI.model(process.env.GEMINI_MODEL || "gemini-3.6-flash"), config: { maxOutputTokens: MAX_OUTPUT_TOKENS_PER_RUN, temperature: 0.2 }, output: { schema: GeneratedQuestionSetSchema }, prompt: `You generate source-grounded professional study questions. Use only the source passages below. Generate one concise recall question for each supplied page, cite its supplied page exactly, and do not invent facts.\n\n${source}` });
  const generated = result.output?.questions as GeneratedQuestion[] | undefined; if (!Array.isArray(generated) || !generated.length) throw new Error("Gemini returned no structured questions.");
  const validPages = new Set(chunks.map(chunk => chunk.page)); const batch = db.batch(); const accepted = generated.slice(0, chunks.length).filter(question => validPages.has(Number(question.page)));
  accepted.forEach(question => { const sourceChunk = chunks.find(chunk => chunk.page === Number(question.page)); batch.set(db.collection(`users/${userId}/questions`).doc(), { question: question.question, answer: question.answer, explanation: question.explanation, category: question.category || "other", page: Number(question.page), strictRecall: Boolean(question.strictRecall), publicationId, publicationTitle: publication.title, sourceChunkId: sourceChunk?.id ?? null, sourceExcerpt: sourceChunk?.text.slice(0, 700) ?? "", createdAt: FieldValue.serverTimestamp() }); });
  const nextPage = Math.max(...chunks.map(chunk => chunk.page)) + 1; batch.set(db.doc(`users/${userId}/publications/${publicationId}`), { status: "ready", generationCursorPage: nextPage, questionCount: FieldValue.increment(accepted.length), lastGeneratedAt: FieldValue.serverTimestamp() }, { merge: true }); await batch.commit(); return { generated: accepted.length, complete: false, nextPage };
}

/** Manual-only worker. App Check remains in observation mode until valid production metrics are confirmed. */
export const processPublication = onCall({ region: "us-central1", timeoutSeconds: 540, memory: "1GiB", maxInstances: 1, concurrency: 1, secrets: [googleGenAiKey], enforceAppCheck: false }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to process a publication."); if (process.env.AI_ENABLED !== "true") throw new HttpsError("failed-precondition", "AI processing is disabled by project policy."); const userId = request.auth.uid; const publicationId = String(request.data?.publicationId ?? ""); if (!publicationId) throw new HttpsError("invalid-argument", "publicationId is required.");
  const publicationRef = db.doc(`users/${userId}/publications/${publicationId}`); const publicationSnapshot = await publicationRef.get(); if (!publicationSnapshot.exists) throw new HttpsError("not-found", "Publication not found."); const publication = publicationSnapshot.data() as StoredPublication;
  if (!publication.externalAiApproved) throw new HttpsError("permission-denied", "External AI approval is required for this publication."); if (!publication.storagePath || publication.fileBytes > MAX_FILE_BYTES) throw new HttpsError("invalid-argument", "Publication is not eligible for processing.");
  try { if (!publication.sourceHash || publication.ingestionVersion !== INGESTION_VERSION) { await publicationRef.set({ status: "indexing", processingStartedAt: FieldValue.serverTimestamp() }, { merge: true }); const indexed = await indexPublication(userId, publicationId, publication); const refreshed = (await publicationRef.get()).data() as StoredPublication; return { indexed, ...(await generateCoverageSet(userId, publicationId, refreshed)) }; } return await generateCoverageSet(userId, publicationId, publication); } catch (error) { logger.error("Publication processing failed", { publicationId, error }); await publicationRef.set({ status: "failed", processingError: error instanceof Error ? error.message.slice(0, 200) : "Unknown error" }, { merge: true }); throw error; }
});
