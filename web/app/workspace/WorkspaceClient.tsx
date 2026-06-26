"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Icon from "@/components/Icon";
import Avatar from "@/components/Avatar";
import type {
  Channel,
  ContactSegment,
  CultureRule,
  DeliveryRequest,
  DraftParagraph,
  DraftRequest,
  MessageDraft,
  OccasionNode,
  PeoplePayload,
  Person,
  Relationship,
} from "@/lib/domain";
import type {
  RemasterDashboardAccount,
  RemasterDashboardActivity,
  RemasterDashboardOverview,
} from "@/lib/remaster/read-model";
import {
  cardGradientByHint,
  deliveryStatusBadge,
  nodeChipText,
  occasionIcon,
  toneIcon,
} from "@/lib/presentation";
import {
  DraftAutosaveController,
  type SaveStatus,
} from "@/lib/workspace/draft-autosave";

type Msg = { who: "ai" | "me"; text: string };
type OutreachPresetId =
  | "follow-up"
  | "recap"
  | "check-in"
  | "congratulations"
  | "intro"
  | "personal";

interface OutreachPreset {
  readonly id: OutreachPresetId;
  readonly label: string;
  readonly instruction: string;
  readonly helperCopy: string;
  readonly quickActions: {
    readonly label: string;
    readonly prompt: string;
    readonly iconHint: string;
  }[];
}

export interface WorkspaceCurrentUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly initials: string;
  readonly sendingAccount: WorkspaceSendingAccount | null;
}

export interface WorkspaceSendingAccount {
  readonly provider: "gmail";
  readonly email: string;
  readonly status: "connected" | "expired";
}

export default function WorkspaceClient({
  currentUser,
  initialPayload,
  remasterOverview,
}: {
  currentUser: WorkspaceCurrentUser;
  initialPayload: PeoplePayload;
  remasterOverview: RemasterDashboardOverview;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const personId = params.get("person") ?? "p-lin";

  const [payload] = useState<PeoplePayload>(initialPayload);
  const [draft, setDraft] = useState<MessageDraft | null>(null);
  const [versions, setVersions] = useState<MessageDraft[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [hasCard, setHasCard] = useState(true);
  // Send-time recipient email. Local-only — never persisted on the draft
  // (the canonical draft does not carry recipient identity) and never
  // backfilled onto Person. The user types it for each send.
  const [recipientEmail, setRecipientEmail] = useState("");
  const [recipientEmailError, setRecipientEmailError] = useState<string | null>(null);
  const [log, setLog] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [toast, setToast] = useState<{ text: string; tone: "success" | "error" } | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const initialDraftKeyRef = useRef<string | null>(null);
  // Single source of truth for autosave / flush / stale-response handling.
  // Constructed lazily inside an effect so `setSaveStatus` etc. are
  // captured exactly once and shared by the same controller across
  // re-renders.
  const autosaveRef = useRef<DraftAutosaveController | null>(null);
  if (autosaveRef.current === null) {
    autosaveRef.current = new DraftAutosaveController({
      debounceMs: 700,
      fetchPatch: async (body) => {
        try {
          const res = await fetch("/api/drafts", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) return { status: res.status, draft: null };
          const draft = (await res.json()) as MessageDraft;
          return { status: 200, draft };
        } catch {
          return { status: 0, draft: null };
        }
      },
      getActiveKey: () => initialDraftKeyRef.current,
      setStatus: (status) => setSaveStatus(status),
      applyServerVersion: (next) => {
        setDraft((current) => (current ? { ...current, ...next } : next));
        setSelectedVersionId(next.id);
        setVersions((prev) => {
          const filtered = prev.filter((v) => v.id !== next.id);
          return [next, ...filtered].slice(0, 5);
        });
      },
    });
  }

  const person: Person | null = useMemo(
    () => payload.people.find((p) => p.id === personId) ?? null,
    [payload, personId],
  );
  const [selectedPresetId, setSelectedPresetId] = useState<OutreachPresetId>(
    () => defaultPresetForSegment(person?.segment ?? "client"),
  );
  const relationship: Relationship | null = useMemo(
    () => person ? payload.relationships.find((r) => r.id === person.relationshipId) ?? null : null,
    [payload, person],
  );
  const culture: CultureRule | null = useMemo(
    () => person ? payload.cultures.find((c) => c.id === person.cultureId) ?? null : null,
    [payload, person],
  );
  const occasion: OccasionNode | null = useMemo(
    () => person?.nextOccasionId
      ? payload.occasions.find((o) => o.id === person.nextOccasionId) ?? null
      : null,
    [payload, person],
  );
  const activityById = useMemo(
    () => new Map(
      [...remasterOverview.upcomingActivities, ...remasterOverview.recentActivities]
        .map((activity) => [activity.id, activity]),
    ),
    [remasterOverview.recentActivities, remasterOverview.upcomingActivities],
  );
  const account = useMemo(
    () => person
      ? remasterOverview.accounts.find((item) => item.primaryContactId === person.id) ?? null
      : null,
    [person, remasterOverview.accounts],
  );
  const contact = useMemo(
    () => person
      ? remasterOverview.contacts.find((item) => item.id === person.id) ?? null
      : null,
    [person, remasterOverview.contacts],
  );
  const currentActivity = useMemo(
    () => {
      if (!account) return null;
      if (account.nextActivityId) {
        const explicit = activityById.get(account.nextActivityId);
        if (explicit) return explicit;
      }
      return remasterOverview.upcomingActivities.find((activity) => (
        activity.accountId === account.id
        && activity.contactId === account.primaryContactId
      )) ?? null;
    },
    [account, activityById, remasterOverview.upcomingActivities],
  );
  const selectedPreset = useMemo(
    () => outreachPresetById(selectedPresetId),
    [selectedPresetId],
  );
  const segmentFrame = useMemo(
    () => workspaceSegmentFrame(person?.segment ?? "personal"),
    [person?.segment],
  );

  const applyDraft = useCallback((
    next: MessageDraft,
    logMode: "append" | "replace" = "append",
  ) => {
    setDraft(next);
    setSelectedVersionId(next.id);
    setSubject(next.subject);
    setBodyText(paragraphsToBodyText(next.paragraphs));
    setHasCard(!!next.attachedCard);
    autosaveRef.current?.setBaseline(next, initialDraftKeyRef.current);
    setLog((prev) => {
      const note = { who: "ai" as const, text: next.assistantNote };
      return logMode === "replace" ? [note] : [...prev, note];
    });
  }, []);

  const fetchVersions = useCallback(async () => {
    if (!person) {
      setVersions([]);
      return;
    }

    const key = `${person.id}:${occasion?.id ?? "none"}`;
    const query = new URLSearchParams({
      personId: person.id,
      limit: "5",
    });
    if (occasion?.id) query.set("occasionId", occasion.id);

    try {
      const res = await fetch(`/api/drafts/versions?${query.toString()}`);
      if (initialDraftKeyRef.current !== key) return;

      if (!res.ok) {
        console.warn(`Could not load draft versions (${res.status}): ${await res.text()}`);
        setVersions([]);
        return;
      }

      const body = (await res.json()) as { drafts?: MessageDraft[] };
      setVersions(Array.isArray(body.drafts) ? body.drafts.slice(0, 5) : []);
    } catch (error) {
      if (initialDraftKeyRef.current !== key) return;
      console.warn("Could not load draft versions", error);
      setVersions([]);
    }
  }, [person, occasion]);

  const requestDraft = useCallback(async (userInstruction: string) => {
    if (!person || !relationship || !culture) return;
    setLoading(true);
    const body: DraftRequest = {
      personId: person.id,
      occasionId: occasion?.id ?? null,
      userInstruction,
    };
    try {
      const res = await fetch("/api/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      const next = (await res.json()) as MessageDraft;
      applyDraft(next);
      await fetchVersions();
    } finally {
      setLoading(false);
    }
  }, [person, relationship, culture, occasion, applyDraft, fetchVersions]);

  // Restore latest saved draft first; generate an initial draft only on miss.
  useEffect(() => {
    if (!person || !relationship || !culture) return;
    const key = `${person.id}:${person.nextOccasionId ?? "none"}`;
    if (initialDraftKeyRef.current === key) return;
    initialDraftKeyRef.current = key;
    setDraft(null);
    setVersions([]);
    setSelectedVersionId(null);
    setSubject("");
    setBodyText("");
    setHasCard(true);
    setSelectedPresetId(defaultPresetForSegment(person.segment));
    setLog([]);
    // Send-time recipient identity is per-person; never carry over to a new
    // person/occasion branch. The same applies to any inline error from the
    // previous branch's send attempt.
    setRecipientEmail("");
    setRecipientEmailError(null);

    const query = new URLSearchParams({ personId: person.id });
    if (occasion?.id) query.set("occasionId", occasion.id);

    async function restoreOrGenerate() {
      setLoading(true);
      let shouldGenerate = false;

      try {
        const res = await fetch(`/api/drafts?${query.toString()}`);
        if (initialDraftKeyRef.current !== key) return;

        if (res.status === 200) {
          const restored = (await res.json()) as MessageDraft;
          applyDraft(restored, "replace");
          await fetchVersions();
          return;
        }

        if (res.status !== 204) {
          console.warn(`Could not restore latest draft (${res.status}): ${await res.text()}`);
        }
        shouldGenerate = true;
      } catch (error) {
        if (initialDraftKeyRef.current !== key) return;
        console.warn("Could not restore latest draft", error);
        shouldGenerate = true;
      } finally {
        if (!shouldGenerate && initialDraftKeyRef.current === key) {
          setLoading(false);
        }
      }

      if (initialDraftKeyRef.current === key) {
        await requestDraft("").catch((error) => {
          console.error(error);
        });
      }
    }

    void restoreOrGenerate();
  }, [person, relationship, culture, occasion, requestDraft, applyDraft, fetchVersions]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  function sendInstruction(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setLog((prev) => [...prev, { who: "me", text: trimmed }]);
    void requestDraft(instructionWithPreset(trimmed, selectedPreset));
  }

  function choosePreset(preset: OutreachPreset) {
    if (preset.id === selectedPresetId) return;
    setSelectedPresetId(preset.id);
    setLog((prev) => [...prev, { who: "ai", text: preset.helperCopy }]);
  }

  const clearTimers = useCallback(() => {
    if (navTimerRef.current) {
      clearTimeout(navTimerRef.current);
      navTimerRef.current = null;
    }
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    clearTimers();
    autosaveRef.current?.dispose();
  }, [clearTimers]);

  // Debounced subject/body autosave. Card toggles bypass this effect and call
  // `schedule(..., immediate=true)` directly from their click handlers so
  // their behaviour is deterministic; re-running this effect when
  // `hasCard` changes would double-fire the save.
  useEffect(() => {
    const controller = autosaveRef.current;
    if (!controller) return;
    const baseline = controller.getBaseline();
    if (!baseline) return;
    const paragraphs = bodyTextToParagraphs(bodyText);
    if (
      subject === baseline.subject
      && sameParagraphText(paragraphs, baseline.paragraphs)
    ) return;
    const card = hasCard ? controller.getCardSnapshot() : null;
    controller.schedule({ subject, paragraphs, attachedCard: card }, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject, bodyText]);

  const showToast = useCallback(
    (text: string, tone: "success" | "error", dismissMs: number) => {
      clearTimers();
      setToast({ text, tone });
      toastTimerRef.current = setTimeout(() => setToast(null), dismissMs);
    },
    [clearTimers],
  );

  const queueDelivery = useCallback(
    async (channel: Channel) => {
      if (!person || sending) return;
      const recipient = person.name;

      // Client-side recipient-email guard for the email channel. The server
      // re-validates regardless; this is just so the user gets a fast,
      // inline error instead of a generic 400.
      let trimmedRecipientEmail = "";
      if (channel === "email") {
        trimmedRecipientEmail = recipientEmail.trim();
        if (!trimmedRecipientEmail) {
          setRecipientEmailError("Add a recipient email before queueing this message.");
          return;
        }
        if (!CLIENT_EMAIL_RE.test(trimmedRecipientEmail)) {
          setRecipientEmailError("Enter a valid recipient email.");
          return;
        }
        setRecipientEmailError(null);
      }

      setSending(true);
      // Persist whatever the user has typed/toggled before handing the
      // delivery off. The send boundary references the latest server-side
      // draft, so a missed save would queue an out-of-date version. If the
      // save fails, do not queue — the save-status pill explains why.
      const saved = (await autosaveRef.current?.flush()) ?? false;
      if (!saved) {
        setSending(false);
        showToast(
          "Could not save your latest edits. Try again before sending.",
          "error",
          5000,
        );
        return;
      }
      const body: DeliveryRequest = {
        personId: person.id,
        occasionId: occasion?.id ?? null,
        channel,
        ...(channel === "email" ? { recipientEmail: trimmedRecipientEmail } : {}),
      };
      try {
        const res = await fetch("/api/deliveries", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });

        if (res.status === 202) {
          // Success copy says "queued" — not "sent" or "delivered" — because
          // the worker performs delivery later. Subject/body/card edits are
          // flushed above before the row is queued.
          const text = channel === "email"
            ? `Queued email for ${recipient}.`
            : `Queued printed card for ${recipient}.`;
          showToast(text, "success", 2000);
          navTimerRef.current = setTimeout(() => router.push("/"), 1600);
          return;
        }

        const payload = (await res.json().catch(() => null)) as
          | { error?: string; code?: string }
          | null;
        showToast(mapSendError(res.status, payload?.code), "error", 5000);
      } catch {
        showToast(GENERIC_SEND_ERROR, "error", 5000);
      } finally {
        setSending(false);
      }
    },
    [person, occasion, sending, router, showToast, recipientEmail],
  );

  function showVersion(version: MessageDraft) {
    if ((selectedVersionId ?? draft?.id) === version.id) return;
    setDraft(version);
    setSelectedVersionId(version.id);
    setSubject(version.subject);
    setBodyText(paragraphsToBodyText(version.paragraphs));
    setHasCard(!!version.attachedCard);
    autosaveRef.current?.setBaseline(version, initialDraftKeyRef.current);
    setLog((prev) => [...prev, { who: "ai", text: "Restored that version." }]);
  }

  if (!person || !relationship || !culture) {
    return <div style={{ padding: 24, color: "var(--gray-2)", fontSize: 13 }}>Loading…</div>;
  }

  const accountName = account?.name ?? person.name;
  const primaryContactName = contact?.displayName ?? person.name;
  const businessSegmentLabel = contactSegmentLabel[person.segment];
  const accountTypeLabel = account ? businessSegmentLabel : relationship.label;
  const relationshipDetail = account?.relationshipLabel && account.relationshipLabel !== accountTypeLabel
    ? `${businessSegmentLabel} contact · ${account.relationshipLabel}`
    : `${businessSegmentLabel} contact`;
  const accountContextLabel =
    account?.sourceContext
    ?? contact?.sourceContext
    ?? person.sourceContext
    ?? person.since
    ?? segmentFrame.contextFallback;
  const secondaryLabel = account?.secondaryLabel
    && account.secondaryLabel !== account.contextLabel
    && account.secondaryLabel !== account.relationshipLabel
    && account.secondaryLabel !== account.organization
    ? account.secondaryLabel
    : "";
  const accountMetaText = [
    workspaceIdentityLine(account, contact, person),
    `Primary contact: ${primaryContactName}`,
    relationshipDetail,
    accountContextLabel,
    secondaryLabel,
  ].filter(Boolean).join(" · ");
  const activitySummary = workspaceActivitySummary(account, currentActivity, occasion, segmentFrame);
  const nodeText = activitySummary.text;
  const nodeIcon = activitySummary.icon;
  const activeVersionId = selectedVersionId ?? draft?.id ?? null;
  const senderLabel = currentUser.sendingAccount
    ? currentUser.sendingAccount.email
    : `${currentUser.email} (sender not configured)`;

  return (
    <div className="ks-workspace-frame">
      {/* top bar */}
      <div style={{ padding: "13px 22px", display: "flex", alignItems: "center", gap: 11, justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
          <button
            onClick={() => router.push("/")}
            style={{
              width: 30, height: 30, borderRadius: 9, display: "flex",
              alignItems: "center", justifyContent: "center", color: "var(--gray-1)",
              fontSize: 18, background: "none", border: "none", cursor: "pointer",
            }}
          >
            <Icon name="i-arrow-left" />
          </button>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <Avatar name={accountName} bg={person.avatarBg} fg={person.avatarFg} size={30} fontSize={12} />
              <div>
                <h3 style={{ fontSize: 14, fontWeight: 600 }}>{segmentFrame.title} for {accountName}</h3>
                <p style={{ fontSize: 11, color: "var(--gray-3)" }}>
                  {accountMetaText}
                </p>
            </div>
          </div>
        </div>
        <div style={{
          fontSize: 11.5, color: "var(--blue-deep)", background: "var(--blue-wash)",
          padding: "6px 12px", borderRadius: 13, display: "flex", alignItems: "center", gap: 6,
        }}>
          <Icon name={nodeIcon} />
          <span>{nodeText}</span>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* assist panel */}
        <div style={{ width: "30%", minWidth: 286, maxWidth: 330, background: "var(--rail)", display: "flex", flexDirection: "column" }}>
          <div ref={logRef} style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{
              background: "#fff", borderRadius: 8, padding: "11px 12px",
              border: "0.5px solid var(--line)", color: "var(--gray-1)",
              fontSize: 12, lineHeight: 1.55,
            }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 7,
                color: "var(--blue-deep)", fontWeight: 600, marginBottom: 4,
              }}>
                <Icon name="i-heart-handshake" />
                <span>ReMaster outreach assistant</span>
              </div>
              <div>{segmentFrame.assistantCopy}</div>
              <div style={{ marginTop: 6, color: "var(--gray-3)" }}>
                {selectedPreset.helperCopy}
              </div>
            </div>
            {log.map((m, i) => (
              <div
                key={i}
                style={{
                  display: "flex", gap: 8, alignItems: "flex-start", maxWidth: "92%",
                  alignSelf: m.who === "me" ? "flex-end" : "flex-start",
                  flexDirection: m.who === "me" ? "row-reverse" : "row",
                }}
              >
                {m.who === "ai" && (
                  <div style={{
                    width: 23, height: 23, borderRadius: 8, background: "var(--blue-wash)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    flexShrink: 0, color: "var(--blue)", fontSize: 12,
                  }}>
                    <Icon name="i-sparkles" />
                  </div>
                )}
                <div
                  style={{
                    padding: "9px 11px", fontSize: 12, lineHeight: 1.55,
                    background: m.who === "ai" ? "#fff" : "var(--blue)",
                    color: m.who === "ai" ? "var(--ink)" : "#fff",
                    borderRadius: m.who === "ai" ? "5px 14px 14px 14px" : "14px 5px 14px 14px",
                  }}
                >
                  {m.text}
                </div>
              </div>
            ))}
            {loading && (
              <div style={{ display: "flex", gap: 8, opacity: 0.6 }}>
                <div style={{
                  width: 23, height: 23, borderRadius: 8, background: "var(--blue-wash)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "var(--blue)", fontSize: 12,
                }}>
                  <Icon name="i-sparkles" />
                </div>
                <div style={{
                  padding: "9px 11px", fontSize: 12, background: "#fff",
                  borderRadius: "5px 14px 14px 14px",
                }}>·  ·  ·</div>
              </div>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 14px 8px" }}>
            {selectedPreset.quickActions.map((q, i) => (
              <button
                key={`${selectedPreset.id}-${i}`}
                onClick={() => sendInstruction(q.prompt)}
                style={{
                  fontSize: 11, padding: "5px 10px", background: "var(--blue-wash)", borderRadius: 12,
                  color: "var(--blue-deep)", display: "flex", alignItems: "center", gap: 5,
                  cursor: "pointer", border: "none",
                }}
              >
                <span style={{ fontSize: 13 }}><Icon name={q.iconHint} /></span>
                {q.label}
              </button>
            ))}
            {draft?.quickActions.map((q, i) => (
              <button
                key={i}
                onClick={() => sendInstruction(q.prompt)}
                style={{
                  fontSize: 11, padding: "5px 10px", background: "#fff", borderRadius: 12,
                  color: "var(--gray-1)", display: "flex", alignItems: "center", gap: 5,
                  cursor: "pointer", border: "none",
                }}
              >
                <span style={{ fontSize: 13 }}><Icon name={q.iconHint} /></span>
                {q.label}
              </button>
            ))}
          </div>
          <div style={{ padding: "9px 13px", display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              flex: 1, display: "flex", alignItems: "center", gap: 7, background: "#fff",
              borderRadius: 18, padding: "4px 5px 4px 12px",
            }}>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && input.trim()) {
                    sendInstruction(input.trim());
                    setInput("");
                  }
                }}
                placeholder="Tell me how to change the outreach…"
                style={{
                  flex: 1, border: "none", background: "none", fontSize: 12,
                  outline: "none", color: "var(--ink)",
                }}
              />
              <button
                onClick={() => {
                  if (input.trim()) {
                    sendInstruction(input.trim());
                    setInput("");
                  }
                }}
                style={{
                  width: 27, height: 27, borderRadius: "50%", background: "var(--blue)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0, color: "#fff", fontSize: 15, border: "none", cursor: "pointer",
                }}
              >
                <Icon name="i-arrow-up" />
              </button>
            </div>
          </div>
        </div>

        {/* compose */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", background: "#fff", overflow: "hidden" }}>
          <div style={{
            width: "min(100%, 640px)",
            padding: "12px 16px 8px",
            display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap",
          }}>
            <span style={{ fontSize: 11, color: "var(--gray-3)", fontWeight: 500 }}>Intent:</span>
            {OUTREACH_PRESETS.map((preset) => {
              const active = preset.id === selectedPresetId;
              return (
                <button
                  key={preset.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => choosePreset(preset)}
                  style={{
                    fontSize: 11.5, fontWeight: active ? 600 : 500,
                    color: active ? "var(--blue-deep)" : "var(--gray-2)",
                    background: active ? "var(--blue-wash)" : "#fff",
                    padding: "5px 10px", borderRadius: 10, cursor: "pointer",
                    border: active ? "0.5px solid var(--blue)" : "0.5px solid #E1E6EB",
                  }}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          <div style={{
            width: "min(100%, 640px)",
            padding: "0 16px 8px",
            display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap",
          }}>
            <span style={{ fontSize: 11, color: "var(--gray-3)", fontWeight: 500 }}>Tone:</span>
            <span style={{
              fontSize: 11.5, fontWeight: 500, color: "var(--blue-deep)",
              background: "var(--blue-wash)", padding: "5px 11px", borderRadius: 10,
              display: "flex", alignItems: "center", gap: 6,
            }}>
              <Icon name={draft ? toneIcon[draft.tone] : "i-heart"} />
              <span>{draft?.toneLabel ?? ""}</span>
            </span>
            {draft?.alternativeTones.map((alt) => (
              <button
                key={alt.tone}
                onClick={() => sendInstruction(`Make it ${alt.label.toLowerCase()}`)}
                style={{
                  fontSize: 11, color: "var(--gray-2)", padding: "5px 10px",
                  borderRadius: 10, border: "0.5px solid #E1E6EB", cursor: "pointer",
                  background: "transparent",
                }}
              >
                {alt.label}
              </button>
            ))}
            {versions.length > 1 && (
              <div style={{
                marginLeft: "auto", height: 28, display: "flex", alignItems: "center",
                gap: 5, minWidth: 0,
              }}>
                <span style={{ fontSize: 11, color: "var(--gray-3)", fontWeight: 500 }}>
                  Versions
                </span>
                {versions.slice(0, 5).map((version, index) => {
                  const active = version.id === activeVersionId;
                  return (
                    <button
                      key={version.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => showVersion(version)}
                      title={version.subject}
                      style={{
                        height: 28, minWidth: index === 0 ? 76 : 46, maxWidth: 104,
                        padding: "0 9px", borderRadius: 10, cursor: "pointer",
                        border: active ? "0.5px solid var(--blue)" : "0.5px solid #E1E6EB",
                        background: active ? "var(--blue-wash)" : "#fff",
                        color: active ? "var(--blue-deep)" : "var(--gray-2)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        gap: 5, fontSize: 11.5, fontWeight: active ? 600 : 500,
                        overflow: "hidden", flexShrink: 0,
                      }}
                    >
                      <span style={{ fontSize: 12, flexShrink: 0 }}>
                        <Icon name={toneIcon[version.tone]} />
                      </span>
                      <span style={{
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {index === 0 ? "Current" : `v${index + 1}`}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div style={{
            width: "min(100%, 640px)",
            padding: "0 16px 10px",
            borderBottom: "0.5px solid var(--line)",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12 }}>
              <span style={{ color: "var(--gray-3)", width: 42 }}>To</span>
              <span style={{ color: "var(--ink)", fontWeight: 500 }}>{person.name}</span>
              <input
                type="email"
                value={recipientEmail}
                onChange={(e) => {
                  setRecipientEmail(e.target.value);
                  if (recipientEmailError) setRecipientEmailError(null);
                }}
                placeholder="recipient@example.com"
                aria-label="Recipient email"
                data-testid="recipient-email-input"
                style={{
                  flex: 1, minWidth: 0, fontSize: 12, color: "var(--ink)",
                  border: "none", outline: "none", background: "none",
                }}
              />
              {recipientEmailError && (
                <span
                  role="alert"
                  data-testid="recipient-email-error"
                  style={{ fontSize: 11, color: "#C5544C" }}
                >
                  {recipientEmailError}
                </span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12 }}>
              <span style={{ color: "var(--gray-3)", width: 42 }}>From</span>
              <span style={{
                width: 20, height: 20, borderRadius: "50%", background: "var(--blue-wash)",
                color: "var(--blue-deep)", display: "inline-flex", alignItems: "center",
                justifyContent: "center", fontSize: 9.5, fontWeight: 600, flexShrink: 0,
              }}>
                {currentUser.initials}
              </span>
              <span style={{ color: "var(--ink)", fontWeight: 500 }}>{currentUser.name}</span>
              <span style={{ color: "var(--gray-3)" }}>{senderLabel}</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "4px 0", fontSize: 12 }}>
              <span style={{ color: "var(--gray-3)", width: 42 }}>Subject</span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                style={{
                  fontSize: 12.5, fontWeight: 500, color: "var(--ink)", border: "none",
                  outline: "none", width: "100%", background: "none",
                }}
              />
            </div>
          </div>

          <div style={{
            flex: 1,
            width: "100%",
            overflowY: "auto",
            padding: "18px 20px",
            display: "flex",
            justifyContent: "center",
          }}>
            <div className="ks-mail-body">
              <section>
                <div style={{ fontSize: 10.5, color: "var(--gray-3)", fontWeight: 600, letterSpacing: "0.03em", marginBottom: 8 }}>
                  {segmentFrame.draftLabel}
                </div>
                <textarea
                  value={bodyText}
                  onChange={(e) => setBodyText(e.target.value)}
                  data-testid="message-body-editor"
                  aria-label="Email body"
                  placeholder={segmentFrame.bodyPlaceholder}
                  style={{
                    width: "100%", minHeight: 210, resize: "vertical",
                    border: "none", borderRadius: 0, background: "transparent",
                    color: "var(--ink)", outline: "none",
                    fontSize: 13.5, lineHeight: 1.7, padding: 0,
                    fontFamily: "inherit",
                  }}
                />
              </section>

            <section style={{ marginTop: 16, borderTop: "0.5px solid var(--line)", paddingTop: 12 }}>
              <div style={{ fontSize: 10.5, color: "var(--gray-3)", fontWeight: 600, marginBottom: 8, letterSpacing: "0.03em" }}>
                PRINT VERSION
              </div>
              {hasCard && draft?.attachedCard ? (
                <div style={{
                  display: "flex", gap: 11, alignItems: "center", padding: 10,
                  background: "var(--soft)", borderRadius: 11,
                }}>
                  <div style={{
                    width: 52, height: 64, borderRadius: 8, flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#fff", fontSize: 19,
                    background: cardGradientByHint[draft.attachedCard.paletteHint] ?? cardGradientByHint.soft,
                  }}>
                    <Icon name={draft.attachedCard.iconHint} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink)" }}>
                      {draft.attachedCard.styleLabel}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--gray-3)", marginTop: 2 }}>
                      {draft.attachedCard.description}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      if (draft?.attachedCard) autosaveRef.current?.rememberCard(draft.attachedCard);
                      setHasCard(false);
                      autosaveRef.current?.schedule({
                        subject,
                        paragraphs: bodyTextToParagraphs(bodyText),
                        attachedCard: null,
                      }, true);
                    }}
                    style={{
                      width: 23, height: 23, borderRadius: "50%", background: "#fff",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      color: "var(--gray-2)", fontSize: 13, border: "none", cursor: "pointer",
                    }}
                  >
                    <Icon name="i-x" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setHasCard(true);
                    const restored = autosaveRef.current?.getCardSnapshot() ?? null;
                    if (restored) {
                      autosaveRef.current?.schedule({
                        subject,
                        paragraphs: bodyTextToParagraphs(bodyText),
                        attachedCard: restored,
                      }, true);
                    }
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, padding: 10,
                    border: "0.5px dashed #D4DBE2", borderRadius: 11, cursor: "pointer",
                    color: "var(--gray-2)", background: "transparent", width: "100%", textAlign: "left",
                  }}
                >
                  <span style={{
                    width: 30, height: 30, borderRadius: 8, background: "var(--soft)",
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0,
                  }}>
                    <Icon name="i-cards" />
                  </span>
                  <span style={{ fontSize: 12, fontWeight: 500, display: "block" }}>Add print version</span>
                </button>
              )}
            </section>
            </div>
          </div>

          <div style={{
            width: "min(100%, 640px)",
            padding: "10px 16px",
            borderTop: "0.5px solid var(--line)",
            display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 11, color: "var(--gray-3)" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 14 }}><Icon name="i-clock" /></span>
                Queue when ready, or hold for the right moment
              </span>
              <span
                role="status"
                aria-live="polite"
                data-save-status={saveStatus}
                style={{
                  fontSize: 11,
                  color: saveStatus === "error" ? "#C5544C" : "var(--gray-3)",
                  fontStyle: saveStatus === "idle" ? "italic" : "normal",
                  opacity: saveStatus === "idle" ? 0.7 : 1,
                }}
              >
                {saveStatusLabel(saveStatus)}
              </span>
            </div>
            <div style={{ display: "flex", gap: 9 }}>
              <button
                onClick={() => void queueDelivery("post")}
                disabled={sending}
                aria-busy={sending}
                style={{ ...btnSmGhost, opacity: sending ? 0.55 : 1, cursor: sending ? "default" : "pointer" }}
              >
                <Icon name="i-truck" /> {sending ? "Queuing…" : "Queue print card"}
              </button>
              <button
                onClick={() => void queueDelivery("email")}
                disabled={sending}
                aria-busy={sending}
                style={{ ...btnSmPri, opacity: sending ? 0.55 : 1, cursor: sending ? "default" : "pointer" }}
              >
                <Icon name="i-send" /> {sending ? "Queuing…" : "Queue email"}
              </button>
            </div>
          </div>
        </div>

        {toast && (
          <div
            role={toast.tone === "error" ? "alert" : "status"}
            style={{
              position: "absolute", left: "50%", bottom: 24,
              transform: "translateX(-50%)", background: "var(--ink)", color: "#fff",
              padding: "13px 22px", borderRadius: 13, fontSize: 13,
              display: "flex", alignItems: "center", gap: 9, zIndex: 50,
              maxWidth: 460,
            }}
          >
            <span
              style={{
                fontSize: 17,
                color: toast.tone === "error" ? "#F08D8D" : "#7FD99F",
              }}
            >
              <Icon name={toast.tone === "error" ? "i-alert" : "i-check"} />
            </span>
            <span>{toast.text}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function paragraphsToBodyText(paragraphs: DraftParagraph[]): string {
  return paragraphs.map((paragraph) => paragraph.text).join("\n\n");
}

function bodyTextToParagraphs(text: string): DraftParagraph[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({ text: part }));
  return paragraphs.length ? paragraphs : [{ text: "" }];
}

function sameParagraphText(a: DraftParagraph[], b: DraftParagraph[]): boolean {
  return paragraphsToBodyText(a) === paragraphsToBodyText(b);
}

function saveStatusLabel(status: "idle" | "saving" | "saved" | "error"): string {
  switch (status) {
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "error":
      return "Could not save";
    default:
      return "Edits save automatically";
  }
}

const contactSegmentLabel: Record<ContactSegment, string> = {
  client: "Client",
  partner: "Partner",
  prospect: "Prospect",
  investor: "Investor",
  personal: "Personal",
};

interface WorkspaceSegmentFrame {
  readonly title: string;
  readonly draftLabel: string;
  readonly activityLabel: string;
  readonly lastDeliveryLabel: string;
  readonly noActivityText: string;
  readonly assistantCopy: string;
  readonly contextFallback: string;
  readonly bodyPlaceholder: string;
}

const workspaceSegmentFrames: Record<ContactSegment, WorkspaceSegmentFrame> = {
  client: {
    title: "Client follow-up",
    draftLabel: "CLIENT FOLLOW-UP DRAFT",
    activityLabel: "Next follow-up",
    lastDeliveryLabel: "Last outreach",
    noActivityText: "No client follow-up scheduled",
    assistantCopy: "Use this space to prepare client follow-ups, account recaps, and next-step outreach before queueing anything.",
    contextFallback: "Business context not set",
    bodyPlaceholder: "Write the client follow-up body...",
  },
  partner: {
    title: "Partner outreach",
    draftLabel: "PARTNER TOUCHPOINT DRAFT",
    activityLabel: "Next partnership touchpoint",
    lastDeliveryLabel: "Last partner outreach",
    noActivityText: "No partner touchpoint scheduled",
    assistantCopy: "Shape a partnership check-in, recap, or collaborative next step while keeping the existing contact context intact.",
    contextFallback: "Partnership context not set",
    bodyPlaceholder: "Write the partner outreach body...",
  },
  prospect: {
    title: "Prospect outreach",
    draftLabel: "PROSPECT OUTREACH DRAFT",
    activityLabel: "Next outreach",
    lastDeliveryLabel: "Last prospect outreach",
    noActivityText: "No prospect outreach scheduled",
    assistantCopy: "Prepare a concise intro, nudge, or follow-up for a prospect without turning this into a sales pipeline.",
    contextFallback: "Prospect context not set",
    bodyPlaceholder: "Write the prospect outreach body...",
  },
  investor: {
    title: "Investor update",
    draftLabel: "INVESTOR UPDATE DRAFT",
    activityLabel: "Next investor update",
    lastDeliveryLabel: "Last investor update",
    noActivityText: "No investor update scheduled",
    assistantCopy: "Draft an investor update or relationship touchpoint for review before anything is queued.",
    contextFallback: "Investor context not set",
    bodyPlaceholder: "Write the investor update body...",
  },
  personal: {
    title: "Personal note",
    draftLabel: "PERSONAL NOTE DRAFT",
    activityLabel: "Next note",
    lastDeliveryLabel: "Last personal note",
    noActivityText: "No personal note scheduled",
    assistantCopy: "Personal contacts still work here; the assistant keeps the note warm while preserving the same review-first flow.",
    contextFallback: "Personal context not set",
    bodyPlaceholder: "Write the personal note body...",
  },
};

function workspaceSegmentFrame(segment: ContactSegment): WorkspaceSegmentFrame {
  return workspaceSegmentFrames[segment] ?? workspaceSegmentFrames.personal;
}

function defaultPresetForSegment(segment: ContactSegment): OutreachPresetId {
  switch (segment) {
    case "client":
      return "follow-up";
    case "partner":
      return "check-in";
    case "prospect":
      return "intro";
    case "investor":
      return "recap";
    default:
      return "personal";
  }
}

const OUTREACH_PRESETS: readonly [OutreachPreset, ...OutreachPreset[]] = [
  {
    id: "follow-up",
    label: "Follow up",
    instruction: "Use a business follow-up intent: be specific, useful, and clear about the next step.",
    helperCopy: "Follow up keeps the draft focused on context, value, and one clear next step.",
    quickActions: [
      { label: "Clarify next step", prompt: "Make the next step clearer and practical", iconHint: "i-bulb" },
      { label: "Add context", prompt: "Add a brief context line before the ask", iconHint: "i-pencil" },
    ],
  },
  {
    id: "recap",
    label: "Recap",
    instruction: "Use a recap intent: summarize what happened, what matters, and what should happen next.",
    helperCopy: "Recap frames the outreach around what was discussed and what needs attention now.",
    quickActions: [
      { label: "Summarize sharply", prompt: "Make this a sharper recap with bullets in prose", iconHint: "i-edit" },
      { label: "Add decision", prompt: "Call out the decision or next milestone", iconHint: "i-check-plain" },
    ],
  },
  {
    id: "check-in",
    label: "Check-in",
    instruction: "Use a check-in intent: warm, low-friction, and relationship-aware without overclaiming.",
    helperCopy: "Check-in keeps the message warm and low-pressure while still business-aware.",
    quickActions: [
      { label: "Softer ask", prompt: "Make the ask softer and easier to answer", iconHint: "i-heart-handshake" },
      { label: "Shorter", prompt: "Shorter", iconHint: "i-edit" },
    ],
  },
  {
    id: "congratulations",
    label: "Congratulations",
    instruction: "Use a congratulations intent: acknowledge the milestone, then bridge naturally to the relationship.",
    helperCopy: "Congratulations centers the milestone first, then keeps the outreach grounded.",
    quickActions: [
      { label: "Add milestone", prompt: "Mention the milestone more directly", iconHint: "i-star" },
      { label: "Less formal", prompt: "Make it less formal but still professional", iconHint: "i-pencil" },
    ],
  },
  {
    id: "intro",
    label: "Intro",
    instruction: "Use an intro intent: establish relevance quickly, keep it concise, and avoid a hard sell.",
    helperCopy: "Intro helps with prospect outreach: relevance first, light ask second.",
    quickActions: [
      { label: "Lead with relevance", prompt: "Open with why this is relevant to them", iconHint: "i-bulb" },
      { label: "Tighter intro", prompt: "Make the intro tighter and more direct", iconHint: "i-edit" },
    ],
  },
  {
    id: "personal",
    label: "Personal",
    instruction: "Use a personal note intent: warm, human, and specific to the relationship.",
    helperCopy: "Personal keeps the same drafting and queue flow, but softens the business framing.",
    quickActions: [
      { label: "Warmer", prompt: "Make it warmer", iconHint: "i-heart" },
      { label: "Add memory", prompt: "Add a small specific memory", iconHint: "i-pencil" },
    ],
  },
];

function outreachPresetById(id: OutreachPresetId): OutreachPreset {
  return OUTREACH_PRESETS.find((preset) => preset.id === id) ?? OUTREACH_PRESETS[0];
}

function instructionWithPreset(text: string, preset: OutreachPreset): string {
  return `${preset.instruction}\n\n${text}`;
}

function workspaceIdentityLine(
  account: RemasterDashboardAccount | null,
  contact: { organization: string | null; roleTitle: string | null } | null,
  person: Person,
): string {
  const organization = account?.organization ?? contact?.organization ?? person.organization;
  const roleTitle = account?.roleTitle ?? contact?.roleTitle ?? person.roleTitle;

  if (organization && roleTitle) return `${roleTitle} at ${organization}`;
  if (organization) return organization;
  if (roleTitle) return roleTitle;
  if (person.sourceContext) return person.sourceContext;
  return person.segment === "personal" ? "Personal contact" : "Business context not set";
}

function workspaceActivitySummary(
  account: RemasterDashboardAccount | null,
  currentActivity: RemasterDashboardActivity | null,
  occasion: OccasionNode | null,
  frame: WorkspaceSegmentFrame,
): { text: string; icon: string } {
  if (currentActivity && currentActivity.daysUntil !== null) {
    return {
      text: `${frame.activityLabel} · ${nodeChipText(currentActivity.title, currentActivity.daysUntil)}`,
      icon: occasionIcon[currentActivity.occasionKind ?? "check-in"],
    };
  }

  if (account?.lastDeliveryStatus) {
    const badge = deliveryStatusBadge[account.lastDeliveryStatus];
    const deliveryDate = account.lastDeliveryAtISO ? ` · ${account.lastDeliveryAtISO.slice(0, 10)}` : "";
    return {
      text: `${frame.lastDeliveryLabel} · ${badge.label}${deliveryDate}`,
      icon: badge.icon,
    };
  }

  if (occasion) {
    return {
      text: `${frame.activityLabel} · ${nodeChipText(occasion.label, occasion.daysUntil)}`,
      icon: occasionIcon[occasion.kind],
    };
  }

  return { text: frame.noActivityText, icon: "i-bulb" };
}

// Mirrors the server-side `EMAIL_RE` in `lib/server/delivery-send/mock.server.ts`.
// The server re-validates regardless; this is only an inline fast-fail so the
// user doesn't see a generic 400 toast.
const CLIENT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const GENERIC_SEND_ERROR =
  "Could not queue this delivery. Please try again.";

function mapSendError(status: number, code: string | undefined): string {
  if (status === 401) {
    return "Your session has expired. Please sign in again.";
  }
  if (status === 404) {
    if (code === "person_not_found") {
      return "This recipient is no longer available. Go back and pick someone else.";
    }
    if (code === "occasion_not_found") {
      return "This occasion is no longer available. Go back and reload.";
    }
  }
  if (status === 409) {
    if (code === "sender_not_connected") {
      return "Connect Gmail from Account before queueing an email.";
    }
    if (code === "sender_expired") {
      return "Your Gmail connection has expired. Reconnect from Account.";
    }
    if (code === "no_draft") {
      return "Generate or refresh the draft before queueing.";
    }
  }
  return GENERIC_SEND_ERROR;
}

const btnSmPri: React.CSSProperties = {
  padding: "9px 14px", fontSize: 12.5, fontWeight: 500, borderRadius: 10,
  display: "flex", alignItems: "center", gap: 7,
  background: "var(--blue)", color: "#fff", border: "none", cursor: "pointer",
};
const btnSmGhost: React.CSSProperties = {
  padding: "9px 14px", fontSize: 12.5, fontWeight: 500, borderRadius: 10,
  display: "flex", alignItems: "center", gap: 7,
  background: "#fff", color: "var(--gray-1)", border: "none", cursor: "pointer",
};
