export type IngestionStage = "uploaded" | "extracting" | "chunking" | "classifying" | "generating" | "ready" | "failed";
export const INGESTION_PIPELINE: IngestionStage[] = ["uploaded", "extracting", "chunking", "classifying", "generating", "ready"];
export function canUseExternalAi(sensitivity: "public" | "private" | "controlled") { return sensitivity !== "controlled"; }
