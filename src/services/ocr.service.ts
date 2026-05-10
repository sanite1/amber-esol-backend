import { ImageAnnotatorClient } from "@google-cloud/vision";
import ApiError from "../errors/apiError";
import logger from "../config/logger";

/**
 * OCR for Home Office residency documents.
 *
 * Production: uses @google-cloud/vision in the EU region (set
 * GCP_PROJECT_ID + GOOGLE_APPLICATION_CREDENTIALS).
 *
 * Local dev: set MOCK_OCR=true to skip the GCP call and return a
 * canned successful extraction. Useful for offline development.
 */

let client: ImageAnnotatorClient | null = null;

const getClient = (): ImageAnnotatorClient => {
  if (client) return client;
  client = new ImageAnnotatorClient();
  return client;
};

export interface OcrResult {
  rawText: string;
  extractedDate: Date | null;
  confidence: number; // 0-1
  warnings: string[];
}

/**
 * Try to extract a UK residency / status date from raw OCR text.
 * Conservative — returns null if no date is found with high confidence.
 */
const extractResidencyDate = (text: string): Date | null => {
  // ISO YYYY-MM-DD
  const iso = text.match(/(20\d{2})-(\d{2})-(\d{2})/);
  if (iso) return new Date(`${iso[1]}-${iso[2]}-${iso[3]}`);

  // DD/MM/YYYY or DD-MM-YYYY
  const ddmm = text.match(/(\d{2})[\/\-](\d{2})[\/\-](20\d{2})/);
  if (ddmm) {
    return new Date(`${ddmm[3]}-${ddmm[2]}-${ddmm[1]}`);
  }

  // Written month: 25 March 2024
  const written = text.match(
    /(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})/i
  );
  if (written) {
    return new Date(`${written[1]} ${written[2]} ${written[3]}`);
  }

  return null;
};

export const ocrResidencyDocument = async (
  imageBuffer: Buffer
): Promise<OcrResult> => {
  // Mock mode — skip the actual GCP call
  if (process.env.MOCK_OCR === "true") {
    logger.info("OCR mock mode active — returning canned result");
    return {
      rawText: "MOCK OCR — Residency permit issued 15/03/2023.",
      extractedDate: new Date("2023-03-15"),
      confidence: 0.92,
      warnings: ["mock_mode"],
    };
  }

  if (!process.env.GCP_PROJECT_ID) {
    throw new ApiError(
      500,
      "OCR is not configured (GCP_PROJECT_ID missing). Set MOCK_OCR=true for local dev."
    );
  }

  try {
    const visionClient = getClient();
    const [result] = await visionClient.textDetection({
      image: { content: imageBuffer.toString("base64") },
    });
    const fullText = result.fullTextAnnotation?.text ?? "";
    const pages = result.fullTextAnnotation?.pages ?? [];

    // Compute average confidence from page-level confidence values
    const confidences = pages
      .flatMap((p) => p.blocks ?? [])
      .map((b) => b.confidence ?? 0)
      .filter((c) => c > 0);
    const avgConfidence =
      confidences.length > 0
        ? confidences.reduce((a, b) => a + b, 0) / confidences.length
        : 0;

    const extractedDate = extractResidencyDate(fullText);

    const warnings: string[] = [];
    if (avgConfidence < 0.8) warnings.push("low_confidence");
    if (!extractedDate) warnings.push("no_date_found");

    return {
      rawText: fullText,
      extractedDate,
      confidence: avgConfidence,
      warnings,
    };
  } catch (err) {
    logger.error({ err }, "OCR processing failed");
    throw new ApiError(503, "Document processing is temporarily unavailable.");
  }
};
