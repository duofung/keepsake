# API Contracts

These contracts are the handoff point between UI, database, and future providers.

## GET /api/people

Returns the current people graph.

Response:

```ts
PeoplePayload {
  people: Person[];
  relationships: Relationship[];
  cultures: CultureRule[];
  occasions: OccasionNode[];
}
```

Current implementation:

- Static route.
- Returns `peoplePayload()` from `lib/mock.ts`.

Future implementation:

- Query user-scoped rows from Postgres.
- Derive `daysUntil` from `dateISO`.
- Keep the response shape stable unless `domain.ts` changes deliberately.

## GET /api/session

Returns the current user identity used by Home, Profile, Workspace, and
owner-scoped server helpers.

Response:

```ts
{
  user: {
    id: OwnerId;
    email: string;
    name: string;
    initials: string;
    sendingAccount: {
      provider: "gmail";
      email: string;
      status: "connected" | "expired";
    } | null;
  };
}
```

Current implementation:

- Dynamic route.
- Reads validated `DEV_OWNER_*` values through
  `lib/server/auth/current-user.server.ts`.
- Mock mode returns `sendingAccount: null`.
- DB mode fills `sendingAccount` from the owner's primary `gmail_accounts`
  row when one exists; missing row still returns `null`.
- Returns 401 when dev auth is missing.
- Returns 500 when dev auth is misconfigured.

Future implementation:

- Keep `{ user }` stable.
- Resolve session/cookies/OAuth inside `auth/current-user.server.ts`.
- Fill the same `sendingAccount` shape from real session-backed account lookup.

## GET /api/oauth/gmail/start

Starts Gmail OAuth for the current user.

Query:

```ts
{
  returnTo?: string;
}
```

Current implementation:

- Dynamic route.
- Requires current-user auth.
- Delegates to `lib/server/oauth/gmail.server.ts`.
- Returns `501 { error, code: "not_configured" }` because Google OAuth is not
  wired yet.
- Returns 401 for missing auth and 500 for misconfigured auth.
- Does not read Google env vars, create OAuth state, exchange tokens, write
  DB rows, or enqueue/send anything.

Future implementation:

- Generate a Google authorization URL.
- Store and validate OAuth state behind the OAuth seam.
- Redirect to the provider on success.
- Keep the route shape thin: auth -> service -> JSON error or redirect.

## GET /api/oauth/gmail/callback

Completes Gmail OAuth for the current user.

Query:

```ts
{
  code?: string;
  state?: string;
  error?: string;
}
```

Current implementation:

- Dynamic route.
- Requires current-user auth.
- Delegates to `lib/server/oauth/gmail.server.ts`.
- Returns `400 { error, code: "provider_error" }` when the provider sends
  `error`.
- Returns `400 { error, code: "invalid_callback" }` when `code` or `state` is
  missing.
- Returns `501 { error, code: "not_configured" }` for a syntactically valid
  callback because Google OAuth is not wired yet.
- Does not exchange tokens, persist Gmail accounts, or update
  `CurrentUser.sendingAccount`.

Future implementation:

- Validate state.
- Exchange code for tokens.
- Persist encrypted refresh-token metadata through `GmailAccountRepository`
  over `gmail_accounts`.
- Update account state so `CurrentUser.sendingAccount` can be filled from the
  primary Gmail account.

## Future Command Channel Webhooks

WhatsApp, Telegram, Slack, and similar tools are planned as command inputs and
notification surfaces, not full mobile clients. The web app remains the
execution surface for final send, detailed editing, account setup, and high-risk
confirmation.

Provider webhook routes will be provider-specific:

```text
POST /api/webhooks/whatsapp
POST /api/webhooks/telegram
POST /api/webhooks/slack
```

Current implementation:

- Not implemented.

Future implementation:

- Verify provider signatures or secrets in the route.
- Normalize provider payloads into a shared server-side command event:

```ts
type CommandEvent = {
  provider: "whatsapp" | "telegram" | "slack";
  externalUserId: string;
  externalConversationId: string;
  messageId: string;
  text: string;
  receivedAt: string;
};
```

- Delegate to a shared command router.
- Return provider-appropriate acknowledgements quickly so webhook retries do
  not create duplicate work.
- Dedupe by provider message/update id.

Command channel responses should normalize to:

```ts
type CommandResponse =
  | { kind: "text"; text: string }
  | { kind: "choices"; text: string; actions: CommandAction[] }
  | { kind: "workspace_link"; text: string; href: string };
```

Important boundaries:

- Webhook routes do not use web session auth and must not call
  `currentUserIdOrThrow()`.
- Provider identities map to a Keepsake owner through channel account/link
  tables, not columns on `users`.
- Channel adapters should not call `app/api/*` over HTTP, `lib/mock.ts`,
  `draft-generator` directly, Gmail OAuth/account repositories, crypto helpers,
  or worker-only delivery methods.
- WhatsApp inbound user tasks can be answered inside the provider customer
  service window; proactive reminders must use template-aware notification
  logic.

## POST /api/drafts

Generates or revises an email draft.

Request:

```ts
DraftRequest {
  personId: ID;
  occasionId: ID | null;
  userInstruction: string;
}
```

Response:

```ts
MessageDraft {
  id: ID;
  personId: ID;
  occasionId: ID | null;
  tone: Tone;
  toneLabel: string;
  alternativeTones: { tone: Tone; label: string }[];
  subject: string;
  paragraphs: DraftParagraph[];
  attachedCard: AttachedCard | null;
  quickActions: DraftQuickAction[];
  assistantNote: string;
}
```

Current implementation:

- Dynamic route.
- Resolves person, relationship, culture, and occasion server-side from `lib/mock.ts`.
- Uses mock `baseRecipe()` and `applyInstruction()`.
- Returns 400 for invalid JSON or missing required fields.
- Returns 404 when `personId` does not exist.
- Returns 404 when `occasionId` does not exist or does not belong to `personId`.

Future implementation:

- Build prompt input from person profile, relationship, occasion, culture rules, history, and user instruction.
- Call the LLM provider.
- Validate the model response against `MessageDraft` before returning it.
