// Provider-agnostic command channel contract.
//
// WhatsApp, Telegram, Slack, and similar tools are treated as input +
// notification endpoints, not as mobile clients. Each platform-specific
// webhook is expected to normalise its payload into a `CommandEvent` and
// hand it to `routeCommandEvent()` (see `router.server.ts`). The router
// returns a `CommandResponse` the platform adapter can render back into
// the user's chat (a reply text, optionally a structured suggested
// action). ReMaster's web app stays the execution / review surface — the
// channel layer NEVER sends mail, NEVER enqueues a delivery, and (in this
// P8-A slice) NEVER touches the DB.

export type ChannelProvider = "whatsapp" | "telegram" | "slack" | "mock";

export interface CommandEvent {
  readonly provider: ChannelProvider;
  /** Provider-side user identity (phone hash, chat id, slack user id, …). */
  readonly externalUserId: string | null;
  /** Provider-side thread / conversation identity, when applicable. */
  readonly externalThreadId: string | null;
  /** User-supplied message body, trimmed but otherwise unmodified. */
  readonly text: string;
  /** Provider-reported event timestamp. */
  readonly receivedAtISO: string;
  /** Original provider payload, kept opaque so the router stays pure. */
  readonly raw?: unknown;
}

export type CommandIntent =
  | "relationship_followup_query"
  | "compose_request"
  | "unknown";

/**
 * What ReMaster's web app should open / pre-fill if the user follows
 * through. The channel layer only *suggests* — it never starts the
 * action itself. Adapters that want to deep-link can render the kind
 * into a ReMaster web URL or similar.
 */
export type SuggestedAction =
  | {
      readonly kind: "open_relationship_followups";
    }
  | {
      readonly kind: "open_compose_workspace";
      readonly recipientHint?: string;
      readonly contextHint?: string;
    };

export interface CommandResponse {
  /**
   * - `ok`              — channel handled the message; no follow-up needed
   * - `needs_review`    — channel acknowledged a request, but the user
   *                       must finish (review + send) inside ReMaster.
   *                       This is the explicit "I started something,
   *                       you finish it" signal.
   * - `unsupported`     — router could not map the text to any intent;
   *                       ReMaster suggests what kinds of messages it
   *                       understands.
   */
  readonly status: "ok" | "needs_review" | "unsupported";
  readonly text: string;
  readonly intent: CommandIntent;
  readonly suggestedAction?: SuggestedAction;
  /**
   * Relative ReMaster URL the provider adapter can render as a review link.
   * This is the bridge between command channels as input surfaces and the web
   * app as the only execution surface. Real provider adapters may prepend the
   * deployment origin, but the channel layer itself keeps the URL relative.
   */
  readonly reviewUrl?: string;
}
