import "server-only";

import type {
  CommandEvent,
  CommandIntent,
  CommandResponse,
  SuggestedAction,
} from "./types";

// Deterministic, pure-logic command router.
//
// The router is the single seam every channel adapter (WhatsApp,
// Telegram, Slack, the local mock route) hands off to. By keeping it
// deterministic + side-effect-free we get:
//
//   * one place to evolve intent classification (LLM, keyword, hybrid),
//   * no DB / OpenAI / queue dependencies — the router can be exercised
//     by a smoke that never boots Postgres or a real provider,
//   * "ReMaster web stays the execution surface" enforced at the type level:
//     even a successful `compose_request` returns `needs_review`, never
//     `ok`, so no adapter can claim it sent mail.
//
// P8-A scope: keyword classification only. Later slices may add an LLM
// classifier; the contract above is the boundary.

const FOLLOWUP_PATTERNS: readonly RegExp[] = [
  /最近/,
  /跟进/,
  /关系/,
  /\bfollow[\s-]?up(?:s)?\b/i,
  /\bwho\s+(?:should|do)\s+i\b/i,
];

const COMPOSE_PATTERNS: readonly RegExp[] = [
  // 中文: 发/写 + optional quantifier ("一封", "一个", "封", "个", "条") + 邮件
  /[发写]\S{0,4}?邮件/,
  /\bsend\s+(?:an?\s+)?(?:email|message|note)\b/i,
  /\bemail\b/i,
  /\bdraft\s+(?:an?\s+)?(?:email|message|note)\b/i,
];

const FOLLOWUP_REPLY =
  "I found account/contact follow-ups ready for outreach review. Open ReMaster to review them.";
const COMPOSE_REPLY =
  "I organized the outreach request. Review and send it in ReMaster.";
const UNKNOWN_REPLY =
  "I can help with account/contact follow-ups or outreach drafting in ReMaster.";

export async function routeCommandEvent(
  event: CommandEvent,
): Promise<CommandResponse> {
  const text = event.text.trim();
  if (text.length === 0) {
    return {
      status: "unsupported",
      intent: "unknown",
      text: UNKNOWN_REPLY,
    };
  }

  const intent = classify(text);

  if (intent === "relationship_followup_query") {
    return {
      status: "ok",
      intent,
      text: FOLLOWUP_REPLY,
      suggestedAction: { kind: "open_relationship_followups" },
      reviewUrl: "/people",
    };
  }

  if (intent === "compose_request") {
    const recipientHint = extractRecipientHint(text);
    const contextHint = extractContextHint(text);
    const suggestedAction: SuggestedAction = {
      kind: "open_compose_workspace",
      ...(recipientHint ? { recipientHint } : {}),
      ...(contextHint ? { contextHint } : {}),
    };
    return {
      status: "needs_review",
      intent,
      text: COMPOSE_REPLY,
      suggestedAction,
      reviewUrl: buildComposeReviewUrl(suggestedAction),
    };
  }

  return {
    status: "unsupported",
    intent: "unknown",
    text: UNKNOWN_REPLY,
  };
}

function buildComposeReviewUrl(action: SuggestedAction): string {
  if (action.kind !== "open_compose_workspace") return "/workspace";

  const params = new URLSearchParams();
  params.set("source", "channel");
  if (action.recipientHint) params.set("recipientHint", action.recipientHint);
  if (action.contextHint) params.set("contextHint", action.contextHint);

  return `/workspace?${params.toString()}`;
}

function classify(text: string): CommandIntent {
  // Compose wins over follow-up when both fire: "帮我给 Helen 发邮件 follow
  // up 之前的事" is a compose request first. The smoke pins this so
  // future tweaks have to keep it.
  if (COMPOSE_PATTERNS.some((re) => re.test(text))) return "compose_request";
  if (FOLLOWUP_PATTERNS.some((re) => re.test(text))) return "relationship_followup_query";
  return "unknown";
}

// Coarse recipient extraction. We try a few high-signal patterns and
// fall back to nothing — the goal is to seed the Workspace pre-fill,
// not to win a NER benchmark.
function extractRecipientHint(text: string): string | undefined {
  // 中文: "给 <Name> 发/写"
  const zh = text.match(/给\s*([^\s，。,.!?]{1,32})\s*(?:发|写)/);
  if (zh?.[1]) return zh[1].trim();

  // English: "to <Name>", "email <Name>", "send <Name>". The keyword
  // match is case-insensitive (handles "Send Helen") but we still
  // require the *name* token to look like a proper noun.
  const en = text.match(
    /\b(?:to|email|send|draft\s+for|for)\s+([A-Z][a-zA-Z'-]{1,31})/i,
  );
  if (en?.[1]) return en[1];

  return undefined;
}

function extractContextHint(text: string): string | undefined {
  // 中文: "她/他今天<verb>" — grab the trailing clause as the why.
  const zh = text.match(/(?:她|他)(今天[^,，。.!?]{2,40})/);
  if (zh?.[1]) return zh[1].trim();

  // English: "she got X today", "he just X" — same idea.
  const en = text.match(
    /\b(?:she|he|they)\s+(?:just\s+|got\s+)?([a-zA-Z][a-zA-Z\s'-]{4,60})/i,
  );
  if (en?.[1]) return en[1].trim();

  return undefined;
}
