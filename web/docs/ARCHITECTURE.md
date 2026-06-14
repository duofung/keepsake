# Keepsake Architecture

Keepsake is a relationship-first email product. The core flow is:

Person + Relationship + Occasion + CultureRule + History -> MessageDraft -> Delivery

Cards are optional attachments to an email. They should never become the primary workflow.

## Current Shape

The app is a Next.js App Router project under `/web`.

- `app/` contains route screens and API routes.
- `components/` contains reusable UI primitives and shared surfaces.
- `lib/domain.ts` defines product/domain contracts.
- `lib/presentation.ts` maps domain values to visual tokens.
- `lib/mock.ts` is the in-memory store that will later be replaced by database queries.

## Boundary Rules

- Domain types must not contain HTML.
- Presentation choices such as icons, gradients, chip colors, and formatting live outside `domain.ts`.
- The Workspace must talk to draft generation through `/api/drafts`; it should not own generation logic.
- People data can use the mock store during the prototype phase, but page code should consume domain-shaped data.
- Provider integrations must sit behind API routes or service modules so the UI does not depend on Gmail, LLM, image, or print vendors.

## Build Path

1. Keep the current mock API stable.
2. Replace mock data access in `lib/mock.ts` with Postgres queries.
3. Replace the mock recipe logic in `/api/drafts` with an LLM call.
4. Add delivery APIs for send, schedule, and history.
5. Add provider adapters for email, image generation, and print fulfillment.

