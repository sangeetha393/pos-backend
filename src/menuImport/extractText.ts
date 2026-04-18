export type ExtractResult = {
  text: string;
  source: "pdf" | "image_openai" | "text" | "plain";
  warnings: string[];
};

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** Dynamic import so backend still starts if pdf-parse is not installed yet. */
export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require("pdf-parse") as (b: Buffer) => Promise<{ text?: string }>;
    const data = await pdfParse(buffer);
    return (data?.text || "").trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`PDF extract failed (install pdf-parse in backend): ${msg}`);
  }
}

export async function extractMenuFromBuffer(
  buffer: Buffer,
  mime: string,
  transcribeImage?: (b64: string, mimeType: string) => Promise<string>
): Promise<ExtractResult> {
  const warnings: string[] = [];
  const lower = mime.toLowerCase();

  if (lower === "application/pdf" || lower.includes("pdf")) {
    const text = await extractTextFromPdf(buffer);
    if (!text || text.length < 20) {
      warnings.push("PDF has very little text—it may be scanned. Use a clearer image or paste text.");
    }
    return { text, source: "pdf", warnings };
  }

  if (IMAGE_TYPES.has(lower) && transcribeImage) {
    const b64 = buffer.toString("base64");
    const text = await transcribeImage(b64, lower);
    if (!text.trim()) warnings.push("Image transcription returned empty.");
    return { text: text.trim(), source: "image_openai", warnings };
  }

  if (IMAGE_TYPES.has(lower) && !transcribeImage) {
    throw new Error("Image menu requires OPENAI_API_KEY for vision transcription.");
  }

  if (lower.startsWith("text/") || mime === "application/json") {
    return { text: buffer.toString("utf-8").trim(), source: "plain", warnings };
  }

  throw new Error(`Unsupported file type: ${mime}`);
}
