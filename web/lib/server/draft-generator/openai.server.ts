import "server-only";

// OpenAI-compatible draft generator. Speaks the standard
// `POST /v1/chat/completions` chat-completions JSON shape, so any provider
// that exposes that contract — OpenAI proper, an Anthropic-compatible
// gateway, vLLM, or a local stub for tests — drops into this seam.
//
// The route handler never sees this file. It is wired by
// `draft-generator/index.server.ts` when `KEEPSAKE_DRAFT_SOURCE=openai`.
//
// Scope (P4-A):
// - Tone, subject, paragraphs, and assistantNote come from the LLM.
// - attachedCard and quickActions stay deterministic (reuse the mock recipe)
//   so we ship a working seam without trusting the model to round-trip our
//   presentation-layer shapes.
// - Errors are normalised into `DraftGeneratorError` so the service layer
//   can map them to a clean HTTP error without leaking provider details.

import type { MessageDraft, Tone } from "@/lib/domain";
import { deterministicRecipe } from "./mock.server";
import type {
  DraftContext,
  DraftGenerator,
  DraftGeneratorErrorKind,
} from "./types";

const TONE_VALUES: Tone[] = [
  "tender-intimate",
  "playful",
  "heartfelt",
  "warm-caring",
  "warm-festive",
  "warm-easy",
  "light-warm",
];

const DEFAULT_API_BASE = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 20_000;

export class DraftGeneratorError extends Error {
  readonly kind: DraftGeneratorErrorKind;
  constructor(kind: DraftGeneratorErrorKind, message: string) {
    super(message);
    this.name = "DraftGeneratorError";
    this.kind = kind;
  }
}

interface OpenAIConfig {
  apiKey: string;
  apiBase: string;
  model: string;
  timeoutMs: number;
}

function readConfig(): OpenAIConfig {
  const apiKey = process.env.KEEPSAKE_DRAFT_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new DraftGeneratorError(
      "misconfigured",
      "KEEPSAKE_DRAFT_API_KEY is required when KEEPSAKE_DRAFT_SOURCE=openai.",
    );
  }

  const apiBase = (process.env.KEEPSAKE_DRAFT_API_BASE || DEFAULT_API_BASE).trim();
  if (!/^https?:\/\//.test(apiBase)) {
    throw new DraftGeneratorError(
      "misconfigured",
      "KEEPSAKE_DRAFT_API_BASE must start with http:// or https://.",
    );
  }

  const model = (process.env.KEEPSAKE_DRAFT_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  return { apiKey, apiBase: apiBase.replace(/\/+$/, ""), model, timeoutMs: DEFAULT_TIMEOUT_MS };
}

function systemPrompt(): string {
  return [
    "You are Keepsake's relationship-aware drafting assistant.",
    "You write short, sincere emails for an individual to send to one specific person they care about.",
    "Constraints:",
    "- Plain text only. No HTML, no markdown formatting characters.",
    "- 2 to 5 short paragraphs.",
    "- Reflect the relationship and culture you are given. Do not introduce holidays, religions, or names the user did not mention.",
    "- Respect the userInstruction if present; treat it as a revision request.",
    `- Pick a tone from this exact set: ${TONE_VALUES.join(", ")}.`,
    "- Return a single JSON object with this shape:",
    '  {"tone": <one of the tones>, "toneLabel": <human label>, "subject": <string>, "paragraphs": [{"text": <string>}, ...], "assistantNote": <short, 1-sentence summary of what you wrote or changed>}',
    "- Do not wrap the JSON in code fences. Output JSON only.",
  ].join("\n");
}

function userPrompt(ctx: DraftContext): string {
  const occasion = ctx.occasion
    ? { id: ctx.occasion.id, kind: ctx.occasion.kind, label: ctx.occasion.label, daysUntil: ctx.occasion.daysUntil ?? null }
    : null;

  return JSON.stringify(
    {
      person: { id: ctx.person.id, name: ctx.person.name, since: ctx.person.since ?? null },
      relationship: { id: ctx.relationship.id, kind: ctx.relationship.kind, label: ctx.relationship.label },
      cultureRule: { id: ctx.cultureRule.id, label: ctx.cultureRule.label },
      occasion,
      userInstruction: ctx.userInstruction || "",
    },
    null,
    0,
  );
}

interface ParsedLLMDraft {
  tone: Tone;
  toneLabel: string;
  subject: string;
  paragraphs: { text: string }[];
  assistantNote: string;
}

function parseLLMJson(raw: string): ParsedLLMDraft {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DraftGeneratorError(
      "malformed_response",
      "Provider response was not valid JSON.",
    );
  }

  if (!value || typeof value !== "object") {
    throw new DraftGeneratorError("malformed_response", "Provider response was not a JSON object.");
  }
  const candidate = value as Record<string, unknown>;

  const tone = candidate.tone;
  if (typeof tone !== "string" || !TONE_VALUES.includes(tone as Tone)) {
    throw new DraftGeneratorError(
      "malformed_response",
      "Provider returned an unsupported tone.",
    );
  }

  const toneLabel = candidate.toneLabel;
  if (typeof toneLabel !== "string" || !toneLabel.trim()) {
    throw new DraftGeneratorError("malformed_response", "Provider returned an empty toneLabel.");
  }

  const subject = candidate.subject;
  if (typeof subject !== "string" || !subject.trim()) {
    throw new DraftGeneratorError("malformed_response", "Provider returned an empty subject.");
  }

  if (!Array.isArray(candidate.paragraphs) || candidate.paragraphs.length === 0) {
    throw new DraftGeneratorError("malformed_response", "Provider returned no paragraphs.");
  }

  const paragraphs: { text: string }[] = [];
  for (const para of candidate.paragraphs) {
    if (!para || typeof para !== "object") {
      throw new DraftGeneratorError("malformed_response", "Provider paragraph was not an object.");
    }
    const text = (para as { text?: unknown }).text;
    if (typeof text !== "string" || !text.trim()) {
      throw new DraftGeneratorError("malformed_response", "Provider returned an empty paragraph.");
    }
    paragraphs.push({ text });
  }

  const assistantNote = candidate.assistantNote;
  if (typeof assistantNote !== "string" || !assistantNote.trim()) {
    throw new DraftGeneratorError("malformed_response", "Provider returned an empty assistantNote.");
  }

  return {
    tone: tone as Tone,
    toneLabel,
    subject,
    paragraphs,
    assistantNote,
  };
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: unknown } }[];
}

async function callProvider(cfg: OpenAIConfig, ctx: DraftContext): Promise<ParsedLLMDraft> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${cfg.apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.7,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: userPrompt(ctx) },
        ],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new DraftGeneratorError(
      "unavailable",
      `Provider call failed: ${(error as Error)?.message ?? "network error"}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new DraftGeneratorError(
      "unavailable",
      `Provider returned status ${res.status}.`,
    );
  }

  let payload: ChatCompletionResponse;
  try {
    payload = (await res.json()) as ChatCompletionResponse;
  } catch {
    throw new DraftGeneratorError(
      "malformed_response",
      "Provider response was not valid JSON.",
    );
  }

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new DraftGeneratorError(
      "malformed_response",
      "Provider response is missing message content.",
    );
  }

  return parseLLMJson(content);
}

export function createOpenAIDraftGenerator(): DraftGenerator {
  // Read once, fail fast at construction. The dispatcher catches and surfaces
  // the misconfigured kind without falling back to mock.
  const cfg = readConfig();
  const modelVersion = `openai:${cfg.model}`;

  return {
    modelProvider: "openai",
    modelVersion,
    async generate(ctx: DraftContext): Promise<MessageDraft> {
      const parsed = await callProvider(cfg, ctx);
      // attachedCard + quickActions stay deterministic — the LLM doesn't
      // round-trip our presentation hints reliably yet, and we don't want a
      // loose contract crossing into Workspace renderers this slice.
      const recipe = deterministicRecipe(ctx);

      const alternativeTones = recipe.alternativeTones.filter(
        (alt) => alt.tone !== parsed.tone,
      );

      return {
        id: `draft-${Date.now()}`,
        personId: ctx.person.id,
        occasionId: ctx.occasion?.id ?? null,
        tone: parsed.tone,
        toneLabel: parsed.toneLabel,
        alternativeTones,
        subject: parsed.subject,
        paragraphs: parsed.paragraphs,
        attachedCard: recipe.card,
        quickActions: recipe.quickActions,
        assistantNote: parsed.assistantNote,
      };
    },
  };
}
