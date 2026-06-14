// Barrel for the repository layer. Exports types only — never runtime values.
//
// Status: DESIGN ONLY. There are no implementations yet; this file lets
// callers write `import type { PeopleRepository } from "@/lib/repositories"`
// without coupling to a specific implementation file.
//
// IMPORTANT: every export here is `export type`, not `export`. If a runtime
// re-export ever appears in this file, a client-component import could pull
// the entire DB layer into the browser bundle. Reviewers should reject any
// PR that drops `type` from a line in this file.

export type { CatalogRepository } from "./catalog";
export type { PeopleRepository } from "./people";
export type { DraftRepository } from "./drafts";
export type { DeliveryRepository } from "./deliveries";

export type {
  DeliveriesListOptions,
  DeliveryEnqueueInput,
  DeliveryQueueItem,
  DeliveryStatus,
  MessageDraftSaveInput,
  OccasionUpsertInput,
  OwnerId,
  PersonCreateInput,
  PersonPatch,
  RepoError,
  RepoErrorKind,
  Tx,
} from "./types";
