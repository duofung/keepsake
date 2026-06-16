// Client-side draft autosave controller for Workspace.
//
// Centralises the race-condition logic so the same module is reachable from
// both the React component and focused Node tests. Why a class instead of
// a clump of useRefs:
//
//   * P4-B blocker 1: pending edits MUST survive a failed save. Failure
//     must not silently drop the dirty state — the next `flush()` must
//     still try to save the same edits.
//   * P4-B blocker 2: a PATCH response that arrives after the user has
//     navigated to another draft / version / person MUST NOT overwrite
//     the current compose UI.
//
// The controller has no React dependency. The component injects fetch,
// status + version setters, and a `getActiveKey` callback.

import type { AttachedCard, MessageDraft } from "@/lib/domain";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export interface PatchResult {
  readonly status: number;
  readonly draft: MessageDraft | null;
}

export interface AutosaveDeps {
  fetchPatch: (body: {
    draftId: string;
    subject: string;
    attachedCard: AttachedCard | null;
  }) => Promise<PatchResult>;
  /**
   * Per-branch identity (e.g. `${personId}:${occasionId}`). Stable while
   * the user is editing the same person+occasion pair; changes the moment
   * they navigate.
   */
  getActiveKey: () => string | null;
  setStatus: (status: SaveStatus) => void;
  /** Called when the server's response is for the still-active branch. */
  applyServerVersion: (next: MessageDraft) => void;
  debounceMs: number;
}

interface Baseline {
  draftId: string;
  subject: string;
  attachedCard: AttachedCard | null;
  key: string | null;
}

interface PendingEdits {
  subject: string;
  attachedCard: AttachedCard | null;
}

function sameCard(a: AttachedCard | null, b: AttachedCard | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class DraftAutosaveController {
  private baseline: Baseline | null = null;
  private cardSnapshot: AttachedCard | null = null;
  private pending: PendingEdits | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<boolean> | null = null;

  constructor(private readonly deps: AutosaveDeps) {}

  /**
   * Adopt a server-confirmed draft as the new edit baseline. Wipes any
   * pending edits / debounced timer / in-flight tracking so a stale
   * response from a previous branch is ignored.
   *
   * Note: the previous in-flight PATCH still resolves in the background
   * (we can't cancel a fetch we already kicked off). Its response will
   * fail the stale-check (`this.baseline.draftId !== captured baselineId`)
   * and be dropped from the UI.
   */
  setBaseline(draft: MessageDraft, key: string | null): void {
    this.baseline = {
      draftId: draft.id,
      subject: draft.subject,
      attachedCard: draft.attachedCard,
      key,
    };
    if (draft.attachedCard) this.cardSnapshot = draft.attachedCard;
    this.pending = null;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.inFlight = null;
    this.deps.setStatus("idle");
  }

  rememberCard(card: AttachedCard | null): void {
    if (card) this.cardSnapshot = card;
  }

  getCardSnapshot(): AttachedCard | null {
    return this.cardSnapshot;
  }

  /** Read-only view of the current baseline; used by the subject autosave gate. */
  getBaseline(): Readonly<Baseline> | null {
    return this.baseline;
  }

  schedule(edits: PendingEdits, immediate: boolean): void {
    this.pending = edits;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (immediate) {
      void this.flush();
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, this.deps.debounceMs);
  }

  /**
   * Persist any pending edits. Returns `true` only when the server has
   * acknowledged the latest user edits.
   *
   * Failure semantics (Blocker 1): on any failure path, `this.pending` is
   * left intact so the next flush re-attempts the same edits. Send paths
   * use the return value to decide whether to proceed.
   */
  async flush(): Promise<boolean> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.inFlight) {
      const upstreamOk = await this.inFlight;
      if (!upstreamOk) return false;
    }
    const pending = this.pending;
    const baseline = this.baseline;
    if (!pending || !baseline) return true;

    // No-op suppression: the edits already match what the server has.
    if (
      pending.subject === baseline.subject
      && sameCard(pending.attachedCard, baseline.attachedCard)
    ) {
      this.deps.setStatus("saved");
      if (this.pending === pending) this.pending = null;
      return true;
    }

    const baselineId = baseline.draftId;
    const baselineKey = baseline.key;
    this.deps.setStatus("saving");

    const promise: Promise<boolean> = (async (): Promise<boolean> => {
      let result: PatchResult;
      try {
        result = await this.deps.fetchPatch({
          draftId: baselineId,
          subject: pending.subject,
          attachedCard: pending.attachedCard,
        });
      } catch {
        this.handleFailure(baselineId, baselineKey);
        return false;
      }

      if (result.status !== 200 || !result.draft) {
        this.handleFailure(baselineId, baselineKey);
        return false;
      }

      // Server has the edit. Decide whether to push it into the UI.
      const stillActive =
        this.baseline?.draftId === baselineId
        && this.deps.getActiveKey() === baselineKey;

      if (stillActive) {
        const next = result.draft;
        this.baseline = {
          draftId: next.id,
          subject: next.subject,
          attachedCard: next.attachedCard,
          key: baselineKey,
        };
        if (next.attachedCard) this.cardSnapshot = next.attachedCard;
        this.deps.applyServerVersion(next);
        this.deps.setStatus("saved");
      }
      // Pending was persisted server-side. Clear it ONLY if no fresher
      // keystroke came in during the in-flight window.
      if (this.pending === pending) this.pending = null;
      return true;
    })();

    this.inFlight = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlight === promise) this.inFlight = null;
    }
  }

  /**
   * Save failed. Keep `this.pending` intact so the next flush retries.
   * Only surface "error" status when the user is still on this branch —
   * otherwise we'd flash a stale error onto an unrelated draft view.
   */
  private handleFailure(baselineId: string, baselineKey: string | null): void {
    const stillActive =
      this.baseline?.draftId === baselineId
      && this.deps.getActiveKey() === baselineKey;
    if (stillActive) {
      this.deps.setStatus("error");
    }
  }

  /** Tear down timers — call from `useEffect` cleanup on unmount. */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // Test introspection — controller has no React, so tests don't need
  // RTL/jsdom. Public on purpose so the controller smoke can verify the
  // invariants the route layer can't.
  __peekPending(): PendingEdits | null {
    return this.pending;
  }
  __peekBaseline(): Readonly<Baseline> | null {
    return this.baseline;
  }
}
