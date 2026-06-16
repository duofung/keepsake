// Barrel for the repository layer. Exports types only — never runtime values.
//
// Runtime implementations live in sibling `*.server.ts` files. This barrel
// remains type-only so callers can write
// `import type { PeopleRepository } from "@/lib/repositories"` without
// coupling to a specific implementation file.
//
// IMPORTANT: every export here is `export type`, not `export`. If a runtime
// re-export ever appears in this file, a client-component import could pull
// the entire DB layer into the browser bundle. Reviewers should reject any
// PR that drops `type` from a line in this file.

export type { CatalogRepository } from "./catalog";
export type { PeopleRepository } from "./people";
export type { DraftRepository } from "./drafts";
export type { DeliveryRepository } from "./deliveries";
export type { GmailAccountRepository } from "./gmail-accounts";

export type {
  DeliveriesListOptions,
  DeliveryEnqueueInput,
  DeliveryQueueItem,
  DeliveryStatus,
  GmailAccount,
  GmailAccountMarkExpiredInput,
  GmailAccountStatus,
  GmailAccountUpsertInput,
  MessageDraftSaveInput,
  OccasionUpsertInput,
  OwnerId,
  PersonCreateInput,
  PersonPatch,
  RepoError,
  RepoErrorKind,
  Tx,
} from "./types";
