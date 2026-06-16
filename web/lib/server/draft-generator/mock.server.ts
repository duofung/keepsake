import "server-only";

// Mock draft generator. The only piece that will be replaced by a real LLM
// call. Same inputs the eventual prompt will use: person + relationship +
// culture + occasion + userInstruction. Output is a structured MessageDraft.
//
// Verbatim of the logic that previously lived in app/api/drafts/route.ts;
// behaviour is preserved 1:1 (verified by scripts/test-drafts.mjs).

import type { MessageDraft, OccasionKind, Tone } from "@/lib/domain";
import type { DraftContext, DraftGenerator, Recipe } from "./types";

function baseRecipe(ctx: DraftContext): Recipe {
  const name = ctx.person.name;
  const kind: OccasionKind = ctx.occasion?.kind ?? "check-in";

  const flirtyAlts = [
    { tone: "playful" as Tone, label: "Playful" },
    { tone: "heartfelt" as Tone, label: "Heartfelt" },
  ];

  if (kind === "anniversary" && ctx.relationship.kind === "partner") {
    return {
      tone: "tender-intimate",
      toneLabel: "Tender & intimate",
      alternativeTones: flirtyAlts,
      subject: "12 years, and still you",
      paragraphs: [
        { text: `${name},` },
        {
          text: `Twelve years ago today, I had no idea what I was signing up for — and I'm so glad I didn't, because I'd never have believed it could be this good.`,
          highlights: ["this good"],
        },
        { text: `You still make the ordinary days feel like something. Happy anniversary, my love.` },
        { text: `— always yours` },
      ],
      card: {
        styleLabel: "A designed card",
        description: "Tender rose tones · AI-made for you two",
        paletteHint: "rose",
        iconHint: "i-heart",
      },
      quickActions: [
        { label: "More flirty", prompt: "Make it more flirty", iconHint: "i-heart" },
        { label: "Add a memory", prompt: "Mention our Penang trip", iconHint: "i-pencil" },
        { label: "Shorter", prompt: "Shorter", iconHint: "i-edit" },
      ],
    };
  }

  if (kind === "birthday" && ctx.relationship.kind === "mother") {
    return {
      tone: "warm-caring",
      toneLabel: "Warm & caring",
      alternativeTones: [
        { tone: "heartfelt", label: "Heartfelt" },
        { tone: "warm-easy", label: "Warm & easy" },
      ],
      subject: "Happy birthday, Mom",
      paragraphs: [
        { text: `${name},` },
        { text: `How's the new place settling in? The balcony faces south, so those flowers you always wanted finally have a home.` },
        { text: `Your knees have been bothering you — don't spend all day on your feet. Happy birthday. Nothing matters more than you being well.` },
        { text: `— love you` },
      ],
      card: {
        styleLabel: "A designed card",
        description: "Soft warm tones · a birthday card",
        paletteHint: "warm-pastel",
        iconHint: "i-cake",
      },
      quickActions: [
        { label: "More personal", prompt: "Make it warmer", iconHint: "i-pencil" },
        { label: "Shorter", prompt: "Shorter", iconHint: "i-edit" },
        { label: "Add love", prompt: "Add more affection", iconHint: "i-heart" },
      ],
    };
  }

  if (kind === "hari-raya" && ctx.cultureRule.id === "malay-muslim") {
    return {
      tone: "warm-festive",
      toneLabel: "Warm & festive",
      alternativeTones: [
        { tone: "heartfelt", label: "Heartfelt" },
        { tone: "warm-caring", label: "Warm & caring" },
      ],
      subject: `Selamat Hari Raya, ${name}`,
      paragraphs: [
        { text: `${name},` },
        { text: `Selamat Hari Raya, maaf zahir dan batin. I hope these days back home in Penang bring you rest, good food, and time with your family.` },
        { text: `Thinking of you and your mother. Let's catch up properly when you're back in KL.` },
        { text: `— always, your friend` },
      ],
      card: {
        styleLabel: "A designed card",
        description: "Festive green tones · Hari Raya card",
        paletteHint: "festive-green",
        iconHint: "i-moon",
      },
      quickActions: [
        { label: "More personal", prompt: "Make it more personal", iconHint: "i-pencil" },
        { label: "Shorter", prompt: "Shorter", iconHint: "i-edit" },
        { label: "More festive", prompt: "Make it more festive", iconHint: "i-moon" },
      ],
    };
  }

  if (kind === "birthday" && ctx.relationship.kind === "father") {
    return {
      tone: "warm-easy",
      toneLabel: "Warm & easy",
      alternativeTones: [
        { tone: "heartfelt", label: "Heartfelt" },
        { tone: "warm-caring", label: "Warm & caring" },
      ],
      subject: "Thinking of you, Dad",
      paragraphs: [
        { text: `${name},` },
        { text: `Just thinking of you. Hope you're taking it easy and the garden's coming along.` },
        { text: `Let's get that fishing trip on the calendar before the year runs away from us.` },
        { text: `— talk soon` },
      ],
      card: {
        styleLabel: "A designed card",
        description: "Calm blue tones",
        paletteHint: "calm-blue",
        iconHint: "i-cake",
      },
      quickActions: [
        { label: "Warmer", prompt: "Make it warmer", iconHint: "i-pencil" },
        { label: "Shorter", prompt: "Shorter", iconHint: "i-edit" },
        { label: "More heartfelt", prompt: "More heartfelt", iconHint: "i-heart" },
      ],
    };
  }

  // Default: check-in (no occasion / drifted friend)
  return {
    tone: "light-warm",
    toneLabel: "Light & warm",
    alternativeTones: [
      { tone: "heartfelt", label: "Heartfelt" },
      { tone: "playful", label: "Playful" },
    ],
    subject: "It's been too long",
    paragraphs: [
      { text: `${name},` },
      { text: `No reason for this email — just realised it's been two months and I miss you.` },
      { text: `How have you been, really? Coffee soon? I'll come to your side of town.` },
      { text: `— thinking of you` },
    ],
    card: {
      styleLabel: "A designed card",
      description: "Soft, no-occasion tones",
      paletteHint: "soft",
      iconHint: "i-heart",
    },
    quickActions: [
      { label: "Warmer", prompt: "Make it warmer", iconHint: "i-pencil" },
      { label: "Shorter", prompt: "Shorter", iconHint: "i-edit" },
      { label: "More personal", prompt: "More personal", iconHint: "i-heart" },
    ],
  };
}

function applyInstruction(recipe: Recipe, ctx: DraftContext): { recipe: Recipe; note: string } {
  const low = ctx.userInstruction.toLowerCase().trim();
  if (!low) {
    const which = ctx.occasion?.label?.toLowerCase() ?? "a note";
    return {
      recipe,
      note: `For ${ctx.person.name}'s ${which}, I've drafted an email in a ${recipe.toneLabel.toLowerCase()} tone — set to your relationship, not a generic greeting. Read it and tell me what to change.`,
    };
  }

  const name = ctx.person.name;

  if (low.includes("flirt")) {
    return {
      recipe: {
        ...recipe,
        tone: "playful",
        toneLabel: "Playful",
        paragraphs: [
          { text: `${name},` },
          {
            text: `Twelve years and you still have no business looking at me like that across the kitchen. Unfair. Keeping you anyway.`,
            highlights: ["still"],
          },
          { text: `Happy anniversary, trouble. Wear the green one.` },
          { text: `— yours, grinning` },
        ],
      },
      note: "Turned up the flirt — lighter and cheeky.",
    };
  }

  if (low.includes("penang") || low.includes("memory")) {
    return {
      recipe: {
        ...recipe,
        paragraphs: [
          { text: `${name},` },
          { text: `Twelve years today. I keep thinking about Penang last spring — you on that rooftop, the whole sky going gold. That's the version of us I'll never tire of.` },
          { text: `Happy anniversary, my love.` },
          { text: `— always yours` },
        ],
      },
      note: "Wove in the Penang rooftop memory.",
    };
  }

  if (low.includes("short")) {
    const isFestive = recipe.tone === "warm-festive";
    return {
      recipe: {
        ...recipe,
        paragraphs: [
          { text: `${name},` },
          {
            text: isFestive
              ? "Selamat Hari Raya — thinking of you and your family."
              : `Just you, and how glad I am for you. ${ctx.occasion?.label ?? "Thinking of you"}.`,
          },
          { text: "— always" },
        ],
      },
      note: "Trimmed right down — sometimes fewer words land harder.",
    };
  }

  if (low.includes("warm") || low.includes("personal") || low.includes("affection") || low.includes("heartfelt")) {
    const last = recipe.paragraphs[recipe.paragraphs.length - 2];
    return {
      recipe: {
        ...recipe,
        paragraphs: recipe.paragraphs.map((p, i) =>
          i === recipe.paragraphs.length - 2 && last
            ? { ...p, text: p.text.replace(/\.?$/, ". I mean every word.") }
            : p,
        ),
      },
      note: "Made it warmer, leaning on what I know about them.",
    };
  }

  if (low.includes("festive")) {
    return { recipe, note: "Added more festive warmth." };
  }

  return { recipe, note: "Done — updated the email on the right." };
}

/**
 * Build a stateless mock generator. The returned object implements
 * `DraftGenerator`; route handlers compose it the same way they will
 * compose a future LLM client.
 *
 * Stateless → safe to instantiate at module scope and reuse across requests.
 */
export const MOCK_MODEL_PROVIDER = "mock";
export const MOCK_MODEL_VERSION = "mock-draft-generator:v1";

export function createMockDraftGenerator(): DraftGenerator {
  return {
    modelProvider: MOCK_MODEL_PROVIDER,
    modelVersion: MOCK_MODEL_VERSION,
    async generate(ctx: DraftContext): Promise<MessageDraft> {
      const base = baseRecipe(ctx);
      const { recipe, note } = applyInstruction(base, ctx);
      return {
        id: `draft-${Date.now()}`,
        personId: ctx.person.id,
        occasionId: ctx.occasion?.id ?? null,
        tone: recipe.tone,
        toneLabel: recipe.toneLabel,
        alternativeTones: recipe.alternativeTones,
        subject: recipe.subject,
        paragraphs: recipe.paragraphs,
        attachedCard: recipe.card,
        quickActions: recipe.quickActions,
        assistantNote: note,
      };
    },
  };
}

/**
 * Reusable deterministic recipe builder. The LLM adapter calls this to keep
 * `attachedCard` and `quickActions` stable while the prose pieces (tone,
 * subject, paragraphs, assistantNote) come from the provider.
 */
export function deterministicRecipe(ctx: DraftContext) {
  return baseRecipe(ctx);
}
