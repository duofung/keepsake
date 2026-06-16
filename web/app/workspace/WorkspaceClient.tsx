"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Icon from "@/components/Icon";
import Avatar from "@/components/Avatar";
import type {
  CultureRule,
  DraftParagraph,
  DraftRequest,
  MessageDraft,
  OccasionNode,
  PeoplePayload,
  Person,
  Relationship,
} from "@/lib/domain";
import { cardGradientByHint, nodeChipText, occasionIcon, toneIcon } from "@/lib/presentation";

type Msg = { who: "ai" | "me"; text: string };

export interface WorkspaceCurrentUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly initials: string;
}

export default function WorkspaceClient({
  currentUser,
  initialPayload,
}: {
  currentUser: WorkspaceCurrentUser;
  initialPayload: PeoplePayload;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const personId = params.get("person") ?? "p-lin";

  const [payload] = useState<PeoplePayload>(initialPayload);
  const [draft, setDraft] = useState<MessageDraft | null>(null);
  const [versions, setVersions] = useState<MessageDraft[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [hasCard, setHasCard] = useState(true);
  const [log, setLog] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const initialDraftKeyRef = useRef<string | null>(null);

  const person: Person | null = useMemo(
    () => payload.people.find((p) => p.id === personId) ?? null,
    [payload, personId],
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

  const applyDraft = useCallback((
    next: MessageDraft,
    logMode: "append" | "replace" = "append",
  ) => {
    setDraft(next);
    setSelectedVersionId(next.id);
    setSubject(next.subject);
    setHasCard(!!next.attachedCard);
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
    setHasCard(true);
    setLog([]);

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
    setLog((prev) => [...prev, { who: "me", text }]);
    void requestDraft(text);
  }

  function send(mode: "email" | "post") {
    if (!person) return;
    const txt = mode === "email"
      ? `Email sent to ${person.name}. I'll keep watching over the rest.`
      : `On its way to ${person.name}'s door as a printed card.`;
    setToast(txt);
    setTimeout(() => { setToast(null); router.push("/"); }, 2000);
  }

  function showVersion(version: MessageDraft) {
    if ((selectedVersionId ?? draft?.id) === version.id) return;
    setDraft(version);
    setSelectedVersionId(version.id);
    setSubject(version.subject);
    setHasCard(!!version.attachedCard);
    setLog((prev) => [...prev, { who: "ai", text: "Restored that version." }]);
  }

  if (!person || !relationship || !culture) {
    return <div style={{ padding: 24, color: "var(--gray-2)", fontSize: 13 }}>Loading…</div>;
  }

  const nodeText = occasion
    ? nodeChipText(occasion.label, occasion.daysUntil)
    : "Last note · 2 mo ago";
  const nodeIcon = occasion ? occasionIcon[occasion.kind] : "i-bulb";
  const activeVersionId = selectedVersionId ?? draft?.id ?? null;

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
            <Avatar name={person.name} bg={person.avatarBg} fg={person.avatarFg} size={30} fontSize={12} />
            <div>
              <h3 style={{ fontSize: 14, fontWeight: 600 }}>To {person.name}</h3>
              <p style={{ fontSize: 11, color: "var(--gray-3)" }}>
                {relationship.label}{person.since ? ` · ${person.since}` : ""}
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
        <div style={{ width: "36%", minWidth: 360, maxWidth: 440, background: "var(--rail)", display: "flex", flexDirection: "column" }}>
          <div ref={logRef} style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            {log.map((m, i) => (
              <div
                key={i}
                style={{
                  display: "flex", gap: 9, alignItems: "flex-start", maxWidth: "92%",
                  alignSelf: m.who === "me" ? "flex-end" : "flex-start",
                  flexDirection: m.who === "me" ? "row-reverse" : "row",
                }}
              >
                {m.who === "ai" && (
                  <div style={{
                    width: 25, height: 25, borderRadius: 8, background: "var(--blue-wash)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    flexShrink: 0, color: "var(--blue)", fontSize: 13,
                  }}>
                    <Icon name="i-sparkles" />
                  </div>
                )}
                <div
                  style={{
                    padding: "10px 12px", fontSize: 12.5, lineHeight: 1.6,
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
              <div style={{ display: "flex", gap: 9, opacity: 0.6 }}>
                <div style={{
                  width: 25, height: 25, borderRadius: 8, background: "var(--blue-wash)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "var(--blue)", fontSize: 13,
                }}>
                  <Icon name="i-sparkles" />
                </div>
                <div style={{
                  padding: "10px 12px", fontSize: 12.5, background: "#fff",
                  borderRadius: "5px 14px 14px 14px",
                }}>·  ·  ·</div>
              </div>
            )}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 16px 9px" }}>
            {draft?.quickActions.map((q, i) => (
              <button
                key={i}
                onClick={() => sendInstruction(q.prompt)}
                style={{
                  fontSize: 11.5, padding: "6px 11px", background: "#fff", borderRadius: 12,
                  color: "var(--gray-1)", display: "flex", alignItems: "center", gap: 5,
                  cursor: "pointer", border: "none",
                }}
              >
                <span style={{ fontSize: 13 }}><Icon name={q.iconHint} /></span>
                {q.label}
              </button>
            ))}
          </div>
          <div style={{ padding: "11px 14px", display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{
              flex: 1, display: "flex", alignItems: "center", gap: 7, background: "#fff",
              borderRadius: 19, padding: "5px 6px 5px 14px",
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
                placeholder="Tell me how to change the email…"
                style={{
                  flex: 1, border: "none", background: "none", fontSize: 12.5,
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
                  width: 28, height: 28, borderRadius: "50%", background: "var(--blue)",
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
        <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "#fff", overflow: "hidden" }}>
          <div style={{ padding: "15px 22px 10px", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "var(--gray-3)", fontWeight: 500 }}>Tone:</span>
            <span style={{
              fontSize: 12, fontWeight: 500, color: "var(--blue-deep)",
              background: "var(--blue-wash)", padding: "6px 12px", borderRadius: 11,
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
                  fontSize: 11.5, color: "var(--gray-2)", padding: "6px 11px",
                  borderRadius: 11, border: "0.5px solid #E1E6EB", cursor: "pointer",
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

          <div style={{ padding: "0 22px 12px", borderBottom: "0.5px solid var(--line)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "5px 0", fontSize: 12.5 }}>
              <span style={{ color: "var(--gray-3)", width: 48 }}>To</span>
              <span style={{ color: "var(--ink)", fontWeight: 500 }}>{person.name}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 12.5 }}>
              <span style={{ color: "var(--gray-3)", width: 48 }}>From</span>
              <span style={{
                width: 22, height: 22, borderRadius: "50%", background: "var(--blue-wash)",
                color: "var(--blue-deep)", display: "inline-flex", alignItems: "center",
                justifyContent: "center", fontSize: 10, fontWeight: 600, flexShrink: 0,
              }}>
                {currentUser.initials}
              </span>
              <span style={{ color: "var(--ink)", fontWeight: 500 }}>{currentUser.name}</span>
              <span style={{ color: "var(--gray-3)" }}>{currentUser.email}</span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "5px 0", fontSize: 12.5 }}>
              <span style={{ color: "var(--gray-3)", width: 48 }}>Subject</span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                style={{
                  fontSize: 13, fontWeight: 500, color: "var(--ink)", border: "none",
                  outline: "none", width: "100%", background: "none",
                }}
              />
            </div>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "22px 30px" }}>
            <div className="ks-mail-body">
            <div className="mail-text" style={{ fontSize: 14.5, lineHeight: 1.85, color: "var(--ink)" }}>
              {draft?.paragraphs.map((p, i) => (
                <p key={i}>{renderParagraph(p)}</p>
              ))}
            </div>

            <div style={{ marginTop: 16, borderTop: "0.5px solid var(--line)", paddingTop: 14 }}>
              <div style={{ fontSize: 11, color: "var(--gray-3)", fontWeight: 500, marginBottom: 9, letterSpacing: "0.03em" }}>
                ATTACHED TO THIS EMAIL · OPTIONAL
              </div>
              {hasCard && draft?.attachedCard ? (
                <div style={{
                  display: "flex", gap: 12, alignItems: "center", padding: 11,
                  background: "var(--soft)", borderRadius: 12,
                }}>
                  <div style={{
                    width: 60, height: 74, borderRadius: 8, flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#fff", fontSize: 22,
                    background: cardGradientByHint[draft.attachedCard.paletteHint] ?? cardGradientByHint.soft,
                  }}>
                    <Icon name={draft.attachedCard.iconHint} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>
                      {draft.attachedCard.styleLabel}
                    </div>
                    <div style={{ fontSize: 11.5, color: "var(--gray-3)", marginTop: 2 }}>
                      {draft.attachedCard.description}
                    </div>
                  </div>
                  <button
                    onClick={() => setHasCard(false)}
                    style={{
                      width: 24, height: 24, borderRadius: "50%", background: "#fff",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      color: "var(--gray-2)", fontSize: 13, border: "none", cursor: "pointer",
                    }}
                  >
                    <Icon name="i-x" />
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setHasCard(true)}
                  style={{
                    display: "flex", alignItems: "center", gap: 9, padding: 11,
                    border: "0.5px dashed #D4DBE2", borderRadius: 12, cursor: "pointer",
                    color: "var(--gray-2)", background: "transparent", width: "100%", textAlign: "left",
                  }}
                >
                  <span style={{
                    width: 32, height: 32, borderRadius: 8, background: "var(--soft)",
                    display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0,
                  }}>
                    <Icon name="i-cards" />
                  </span>
                  <span>
                    <span style={{ fontSize: 12.5, fontWeight: 500, display: "block" }}>Add a designed card</span>
                    <span style={{ fontSize: 11, color: "var(--gray-3)" }}>Make the email feel like a gift</span>
                  </span>
                </button>
              )}
            </div>
            </div>
          </div>

          <div style={{
            padding: "12px 22px", borderTop: "0.5px solid var(--line)",
            display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--gray-3)" }}>
              <span style={{ fontSize: 14 }}><Icon name="i-clock" /></span>
              Send now, or schedule for the day
            </div>
            <div style={{ display: "flex", gap: 9 }}>
              <button onClick={() => send("post")} style={btnSmGhost}>
                <Icon name="i-truck" /> Mail as card
              </button>
              <button onClick={() => send("email")} style={btnSmPri}>
                <Icon name="i-send" /> Send email
              </button>
            </div>
          </div>
        </div>
      </div>

      {toast && (
        <div style={{
          position: "absolute", left: "50%", bottom: 24,
          transform: "translateX(-50%)", background: "var(--ink)", color: "#fff",
          padding: "13px 22px", borderRadius: 13, fontSize: 13,
          display: "flex", alignItems: "center", gap: 9, zIndex: 50,
        }}>
          <span style={{ fontSize: 17, color: "#7FD99F" }}><Icon name="i-check" /></span>
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}

function renderParagraph({ text, highlights = [] }: DraftParagraph): React.ReactNode {
  if (!highlights.length) return text;
  let parts: React.ReactNode[] = [text];
  for (const h of highlights) {
    const next: React.ReactNode[] = [];
    let key = 0;
    for (const p of parts) {
      if (typeof p !== "string") { next.push(p); continue; }
      const idx = p.indexOf(h);
      if (idx === -1) { next.push(p); continue; }
      if (idx > 0) next.push(p.slice(0, idx));
      next.push(<span key={`hl-${key++}`} className="hl">{h}</span>);
      const rest = p.slice(idx + h.length);
      if (rest) next.push(rest);
    }
    parts = next;
  }
  return <>{parts.map((node, i) => <span key={i}>{node}</span>)}</>;
}

const btnSmPri: React.CSSProperties = {
  padding: "10px 16px", fontSize: 13, fontWeight: 500, borderRadius: 11,
  display: "flex", alignItems: "center", gap: 7,
  background: "var(--blue)", color: "#fff", border: "none", cursor: "pointer",
};
const btnSmGhost: React.CSSProperties = {
  padding: "10px 16px", fontSize: 13, fontWeight: 500, borderRadius: 11,
  display: "flex", alignItems: "center", gap: 7,
  background: "#fff", color: "var(--gray-1)", border: "none", cursor: "pointer",
};
