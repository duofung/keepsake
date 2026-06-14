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
