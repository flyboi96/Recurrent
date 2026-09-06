import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import OpenAI from "openai";

initializeApp();
const db = getFirestore();
const MAX_PAGES = 150;
const MAX_CHUNKS = 12;
const MAX_INPUT_TOKENS = 12_000;
const MAX_OUTPUT_TOKENS = 1_200;
const DAILY_LIMIT = 20_000;
const MONTHLY_LIMIT = 150_000;

type StoredPublication = { title: string; storagePath: string; fileBytes: number; externalAiApproved?: boolean };
type GeneratedQuestion = { question: string; answer: string; explanation: string; category?: string; page?: number; strictRecall?: boolean };

const estimateTokens = (text: string) => Math.ceil(text.length / 4);
const period = (date: Date, kind: "day" | "month") => kind === "day" ? date.toISOString().slice(0, 10) : date.toISOString().slice(0, 7);

async function reserveTokens(userId: string, tokens: number) {
  const now = new Date(); const day = db.doc(`users/${userId}/aiUsage/daily-${period(now, "day")}`); const month = db.doc(`users/${userId}/aiUsage/monthly-${period(now, "month")}`);
  await db.runTransaction(async transaction => {
    const [daySnapshot, monthSnapshot] = await Promise.all([transaction.get(day), transaction.get(month)]);
    const dayTokens = Number(daySnapshot.data()?.reservedTokens ?? 0); const monthTokens = Number(monthSnapshot.data()?.reservedTokens ?? 0);
    if (dayTokens + tokens > DAILY_LIMIT) throw new HttpsError("resource-exhausted", "Daily AI budget reached.");
    if (monthTokens + tokens > MONTHLY_LIMIT) throw new HttpsError("resource-exhausted", "Monthly project AI budget reached.");
    transaction.set(day, { reservedTokens: dayTokens + tokens, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    transaction.set(month, { reservedTokens: monthTokens + tokens, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  });
}

async function extractPages(buffer: Buffer): Promise<{ page: number; text: string }[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  if (document.numPages > MAX_PAGES) throw new HttpsError("invalid-argument", `PDF exceeds the ${MAX_PAGES}-page processing limit.`);
  const pages: { page: number; text: string }[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber); const content = await page.getTextContent();
    const text = content.items.map(item => "str" in item ? item.str : "").join(" ").replace(/\s+/g, " ").trim();
    if (text) pages.push({ page: pageNumber, text });
  }
  return pages;
}

export const processPublication = onCall({ region: "us-central1", timeoutSeconds: 120, memory: "512MiB", maxInstances: 1, concurrency: 1 }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to process a publication.");
  const userId = request.auth.uid;
  if (process.env.AI_ENABLED !== "true") throw new HttpsError("failed-precondition", "AI processing is disabled by project policy.");
  const publicationId = String(request.data?.publicationId ?? ""); if (!publicationId) throw new HttpsError("invalid-argument", "publicationId is required.");
  const publicationRef = db.doc(`users/${userId}/publications/${publicationId}`); const publicationSnapshot = await publicationRef.get();
  if (!publicationSnapshot.exists) throw new HttpsError("not-found", "Publication not found.");
  const publication = publicationSnapshot.data() as StoredPublication;
  if (!publication.externalAiApproved) throw new HttpsError("permission-denied", "External AI approval is required for this publication.");
  if (!publication.storagePath || publication.fileBytes > 25 * 1024 * 1024) throw new HttpsError("invalid-argument", "Publication is not eligible for processing.");
  const apiKey = process.env.OPENAI_API_KEY; if (!apiKey) throw new HttpsError("failed-precondition", "OpenAI secret is not configured.");
  await publicationRef.update({ status: "processing", processingStartedAt: FieldValue.serverTimestamp() });
  try {
    const [buffer] = await getStorage().bucket().file(publication.storagePath).download(); const pages = await extractPages(buffer);
    const chunks = pages.flatMap(page => page.text.match(/.{1,1400}(?:\s|$)/g)?.map(text => ({ page: page.page, text })) ?? []).slice(0, MAX_CHUNKS);
    const source = chunks.map(chunk => `[page ${chunk.page}] ${chunk.text}`).join("\n"); const inputTokens = estimateTokens(source);
    if (inputTokens > MAX_INPUT_TOKENS) throw new HttpsError("resource-exhausted", "Document excerpt exceeds the input budget.");
    await reserveTokens(userId, inputTokens + MAX_OUTPUT_TOKENS);
    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({ model: process.env.OPENAI_MODEL || "gpt-4.1-mini", max_tokens: MAX_OUTPUT_TOKENS, response_format: { type: "json_object" }, messages: [{ role: "system", content: "Generate 5 concise professional-study questions from only the supplied source. Return JSON {questions:[{question,answer,explanation,category,page,strictRecall}]}. Cite the provided page number. Do not invent facts." }, { role: "user", content: source }] });
    const generated = JSON.parse(completion.choices[0]?.message.content || "{}").questions as GeneratedQuestion[] | undefined;
    if (!Array.isArray(generated) || !generated.length) throw new Error("Model returned no questions.");
    const batch = db.batch(); generated.slice(0, 5).forEach(question => batch.set(db.collection(`users/${userId}/questions`).doc(), { ...question, publicationId, publicationTitle: publication.title, sourceExcerpt: chunks.find(chunk => chunk.page === question.page)?.text.slice(0, 500) ?? "", createdAt: FieldValue.serverTimestamp() }));
    batch.update(publicationRef, { status: "ready", questionCount: generated.length, processedAt: FieldValue.serverTimestamp() }); await batch.commit();
    return { generated: generated.length };
  } catch (error) { logger.error("Publication processing failed", error); await publicationRef.update({ status: "failed", processingError: error instanceof Error ? error.message.slice(0, 200) : "Unknown error" }); throw error; }
});
