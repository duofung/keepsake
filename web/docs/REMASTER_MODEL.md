# ReMaster Model Blueprint

This document defines the recommended future relationship model for ReMaster.
It is a planning document only. It does not describe a shipped schema, a live
runtime, or an approved migration sequence in code.

The current runtime is still centered on `Person`, `OccasionNode`,
`MessageDraft`, and `Delivery`. The goal here is to describe where the product
should move next without pretending that move has already happened.

## Design Constraints

- Keep the current owner-scoped model and review-first communication workflow.
- Minimize disruption to existing draft, delivery, and command-channel seams.
- Prefer additive migration from current `person` / `occasion` / `delivery`
  concepts instead of a big-bang rewrite.
- Keep the first ReMaster model small enough to support real workflows before
  adding more taxonomy.

## Current Runtime Baseline

Today the codebase is organized around:

- `Person` as the main relationship record.
- `OccasionNode` as the main upcoming-moment trigger.
- `MessageDraft` as the Workspace artifact.
- `Delivery` as the outbound execution/history record.

That baseline is still what powers `/api/people`, `/api/drafts`,
`/api/deliveries`, the History page, and the current command-channel read path.

## Recommended Future Core Entities

| Entity | Purpose | Recommended first version |
|---|---|---|
| Account / organization | The business entity the owner is managing a relationship with. This should become the default top-level anchor for lists, dashboards, and timeline views. | `id`, `ownerId`, `name`, `primaryRelationshipType`, `status`, optional firmographic fields such as `domain`, `website`, `notes`. |
| Contact | A human stakeholder tied to one or more business relationships. | `id`, `ownerId`, `displayName`, optional `primaryEmail`, optional communication/context fields, `status`. |
| Contact role / stakeholder role | The link between an account and a contact. Separates "who this person is" from "how they matter in this relationship." | Join shape such as `accountId`, `contactId`, `role`, optional `title`, optional `influenceLevel`, `isPrimary`. |
| Business relationship type | The business-level relationship between the owner and the account. | Controlled vocabulary referenced from the account, starting with one primary type: `client`, `prospect`, `partner`, `investor`, `vendor`, `advisor`, `press`, `other`. Secondary tags can wait. |
| Activity / timeline event | Unified log of what happened, what is scheduled, and what needs follow-up. | `id`, `ownerId`, `accountId`, optional `contactId`, `type`, `occurredAt`, optional `status`, `summary`, `source`, `metadata`. |

## Recommended Relationship Shape

- `Account` is the business anchor.
- `Contact` represents the human.
- `Contact role` connects the human to the account in a specific capacity.
- `Business relationship type` describes the account-to-owner relationship, not
  the contact's stakeholder role.
- `ActivityEvent` belongs to an account and may also point at a specific
  contact.

This keeps the center of gravity on the business relationship while still
supporting person-level outreach.

## What Should Stay Supporting, Not Core

- `MessageDraft` should remain a supporting artifact for outbound work, linked
  to account/contact context as needed.
- Gmail accounts and command-channel accounts remain infrastructure records, not
  relationship-core entities.
- Communication preferences, cultural context, or writing guidance can attach
  to accounts/contacts, but they do not need to become separate first-class
  business entities on day one.

## Forward Mapping From Today's Model

| Current runtime concept | Forward ReMaster mapping | Planning note |
|---|---|---|
| `Person` | `Contact` first, usually with an associated `Account` | Existing person records map most directly to contacts. When an organization is known, attach the contact through a role link. When it is not known yet, allow temporary contact-first records instead of forcing fake account data. |
| `relationshipId` catalog | `primaryRelationshipType` on `Account`, or retained as legacy metadata until reclassified | Current personal relationship labels will not map cleanly to business types in every case. Do not force false precision during migration. |
| `cultureId` / communication context | Communication preferences or contextual metadata on `Contact` or `Account` | Preserve useful writing context, but move it under the business relationship model rather than keeping it person-first. |
| `OccasionNode` | `ActivityEvent` with a business-relevant subtype such as `milestone`, `follow_up_due`, `meeting`, `renewal`, or `planned_touchpoint` | The current occasion concept should not automatically survive as its own top-level business entity. Use the subset that becomes real business follow-up anchors. |
| `MessageDraft` | Draft artifact associated with an account/contact context | Drafting remains important, but the draft is not the relationship record. |
| `Delivery` | Outbound communication activity in the timeline, backed by delivery-specific operational state underneath | The delivery queue, webhook, and worker machinery can stay operationally separate while the product surface treats deliveries as one activity family. |

## Recommended Phasing

1. Documentation now.
   Keep runtime and schema unchanged. Make the target model explicit in docs so
   collaborators stop guessing.
2. Compatibility read model next.
   Introduce account/contact/activity-oriented reads that can be derived from
   current person/occasion/delivery data before changing primary product flows.
3. New product surfaces after that.
   Move list/detail/timeline flows toward account/contact/activity views while
   keeping current People/Workspace/History contracts alive during transition.
4. Retirement last.
   Only deprecate person/occasion-first contracts after their consumers are
   gone or safely wrapped by compatibility seams.

## Migration Posture

Recommended defaults for a minimally disruptive transition:

- Keep `owner_id` scoping as the primary security boundary.
- Start with one primary business relationship type per account.
- Let `ActivityEvent` absorb timeline concerns before creating many special
  event tables.
- Preserve legacy labels/metadata when the business mapping is ambiguous.
- Avoid inventing synthetic organizations unless the product truly needs them;
  a temporary contact-first state is safer than low-quality account data.

## Open Questions

- Should one contact be able to link to multiple accounts on day one, or should
  that wait until the first concrete use case appears?
- Which current occasion types are worth keeping as business follow-up anchors,
  and which should stay legacy-only?
- Should deliveries remain a distinct operational table indefinitely, with
  timeline rows derived from them, or eventually become one persistence model?
- How much of the legacy relationship taxonomy should survive as historical
  metadata during reclassification?
