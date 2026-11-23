import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { SYSTEM_PROMPT, buildUserText } from "./prompt";
import { ExtractionSchema, MODEL, type Extraction } from "./schema";

export interface ModelResult {
  extraction: Extraction;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; model: string };
}

/** Failure with a message that is safe to show: never includes document text or API payloads. */
export class ExtractionError extends Error {}

const client = () => new Anthropic(); // reads ANTHROPIC_API_KEY

/**
 * One call to Claude: the PDF as a document block plus the email text, answered as schema-validated JSON.
 * No tools are given, so nothing in the document can trigger an action. The model only fills the schema.
 */
export async function extractWithClaude(pdf: Buffer, email: { subject: string; from: string; body: string | null }): Promise<ModelResult> {
  if (!process.env.ANTHROPIC_API_KEY) throw new ExtractionError("ANTHROPIC_API_KEY belum diisi di .env.");
  try {
    const res = await client().beta.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      // Server-side fallback if a safety classifier declines the request (opt-in, per the API guidance).
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
            { type: "text", text: buildUserText(email) },
          ],
        },
      ],
      output_config: { format: betaZodOutputFormat(ExtractionSchema), effort: "medium" },
    });
    if (res.stop_reason === "refusal") throw new ExtractionError("Model menolak memproses dokumen ini (kebijakan keamanan).");
    if (res.stop_reason === "max_tokens") throw new ExtractionError("Hasil terpotong (dokumen terlalu panjang).");
    if (!res.parsed_output) throw new ExtractionError("Model tidak mengembalikan data yang sesuai skema.");
    return {
      extraction: res.parsed_output,
      usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, cache_read_input_tokens: res.usage.cache_read_input_tokens, model: res.model },
    };
  } catch (e) {
    if (e instanceof ExtractionError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new ExtractionError("API key Anthropic ditolak. Periksa ANTHROPIC_API_KEY.");
    if (e instanceof Anthropic.RateLimitError) throw new ExtractionError("Batas permintaan Anthropic tercapai. Coba lagi sebentar lagi.");
    if (e instanceof Anthropic.BadRequestError) throw new ExtractionError(`Permintaan ditolak Anthropic: ${e.message.slice(0, 200)}`);
    if (e instanceof Anthropic.APIError) throw new ExtractionError(`Anthropic API error (HTTP ${e.status}).`);
    throw new ExtractionError("Gagal memanggil Anthropic.");
  }
}
