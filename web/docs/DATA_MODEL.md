# Data Model

The current data model lives in `lib/domain.ts`. It is intentionally close to the future Postgres schema.

## Core Entities

`Person`

- Owns recipient profile facts.
- References `relationshipId`, `cultureId`, and `nextOccasionId`.
- Stores known facts and personal taboos as structured text, not HTML.

`Relationship`

- Defines relationship kind and group.
- Examples: partner, mother, father, close friend, friend.
- Relationship kind influences tone and content strategy.

`CultureRule`

- Strategic product asset.
- Defines festivals, palette hints, canonical greetings, and taboos.
- Used by draft generation and future card generation.

`OccasionNode`

- A date Keepsake watches for a person.
- Has a canonical `dateISO`, `daysUntil`, kind, label, and `isPrimary`.
- In production, `daysUntil` should be derived from `dateISO`.

`MessageDraft`

- Structured AI output.
- Contains subject, tone, plain-text paragraphs, optional highlights, quick actions, assistant note, and optional attached card metadata.
- Paragraphs must remain plain text. Rendering turns highlights into UI styling.

`Delivery`

- History and future delivery state.
- Tracks recipient, occasion, channel, timestamp, and status.

## Next Database Tables

Recommended first Postgres tables:

- `users`
- `people`
- `relationships`
- `cultures`
- `occasion_nodes`
- `message_drafts`
- `deliveries`

Later:

- `cards`
- `scheduled_jobs`
- `email_accounts`
- `subscriptions`
- `audit_events`

## Privacy Notes

Relationship data is sensitive. Database work should assume encryption at rest, least privilege, and a future export/delete flow.

