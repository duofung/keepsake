"use client";

import Link from "next/link";
import Icon from "./Icon";
import Avatar from "./Avatar";
import type { CultureRule, OccasionNode, Person, Relationship } from "@/lib/domain";
import { nodeChipText, occasionIcon, occasionTintBg, urgencyLevel } from "@/lib/presentation";

type Props = {
  person: Person | null;
  relationship: Relationship | null;
  culture: CultureRule | null;
  occasions: OccasionNode[];
  onClose: () => void;
};

export default function PersonDrawer({
  person, relationship, culture, occasions, onClose,
}: Props) {
  const open = !!person;
  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "absolute", inset: 0, background: "rgba(47,37,50,0.26)",
          opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none",
          transition: ".3s", zIndex: 20,
        }}
      />
      <aside
        style={{
          position: "absolute", top: 0, right: 0, bottom: 0, width: 380,
          background: "var(--heartline-bg-2)", zIndex: 30,
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform .34s cubic-bezier(.4,0,.2,1)",
          display: "flex", flexDirection: "column",
          boxShadow: "-16px 0 46px -20px rgba(70,42,82,0.34)",
        }}
      >
        {person && relationship && culture && (
          <DrawerContent
            person={person}
            relationship={relationship}
            culture={culture}
            occasions={occasions}
            onClose={onClose}
          />
        )}
      </aside>
    </>
  );
}

function DrawerContent({
  person, relationship, culture, occasions, onClose,
}: {
  person: Person; relationship: Relationship; culture: CultureRule;
  occasions: OccasionNode[]; onClose: () => void;
}) {
  const primary = occasions.find((o) => o.isPrimary) ?? occasions[0];
  const prepareLabel = primary
    ? `Draft outreach for ${primary.label}`
    : "Draft outreach";

  return (
    <>
      <div style={{ padding: "22px 24px 18px", position: "relative" }}>
        <button
          onClick={onClose}
          style={{
            position: "absolute", top: 18, right: 20, width: 30, height: 30,
            borderRadius: "50%", background: "var(--heartline-rose-wash)", border: "none",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--heartline-purple-deep)", fontSize: 17, cursor: "pointer",
          }}
        >
          <Icon name="i-x" />
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Avatar name={person.name} bg={person.avatarBg} fg={person.avatarFg} size={56} fontSize={21} />
          <div>
            <div style={{ fontSize: 18, fontWeight: 600, color: "var(--ink)", display: "flex", alignItems: "center", gap: 6 }}>
              {person.name}
              {person.starred && (
                <span style={{ color: "var(--amber)", fontSize: 14 }}>
                  <Icon name="i-star" fill />
                </span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "var(--gray-2)", marginTop: 2 }}>
              {relationship.label}
              {person.since ? ` · ${person.since}` : ""}
            </div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 24px 20px" }}>
        <Section title="CONTACT PROFILE">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
            <Tag dot={culture.dotColor}>{relationship.label}</Tag>
            {culture.id !== "none" && <Tag dot={culture.dotColor}>{culture.label}</Tag>}
            {person.identityTags.map((t, i) => <Tag key={i}>{t}</Tag>)}
          </div>
        </Section>

        <Section title="DATES & FOLLOW-UPS">
          {occasions.length === 0 && (
            <p style={{ fontSize: 12.5, color: "var(--gray-3)" }}>
              No dates yet - add one to keep this contact on your radar.
            </p>
          )}
          {occasions.map((o, i) => {
            const lvl = urgencyLevel(o.daysUntil);
            const whenText = nodeChipText(o.label, o.daysUntil).split("·")[1]?.trim() ?? "";
            return (
              <div
                key={o.id}
                style={{
                  display: "flex", alignItems: "center", gap: 11, padding: "10px 0",
                  borderBottom: i < occasions.length - 1 ? "0.5px solid var(--line)" : "none",
                }}
              >
                <div style={{
                  width: 32, height: 32, borderRadius: 9,
                  background: occasionTintBg[o.kind], color: person.avatarFg,
                  display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0,
                }}>
                  <Icon name={occasionIcon[o.kind]} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>{o.label}</div>
                  {o.detail && (
                    <div style={{ fontSize: 11.5, color: "var(--gray-3)", marginTop: 1 }}>{o.detail}</div>
                  )}
                </div>
                <div style={{
                  fontSize: 11.5, textAlign: "right",
                  color: lvl === "far" ? "var(--gray-3)" : "var(--heartline-purple-deep)",
                  fontWeight: lvl === "far" ? 400 : 500,
                }}>
                  {whenText}
                </div>
              </div>
            );
          })}
        </Section>

        <Section title="NOTES & CONTEXT">
          <div style={{
            background: "rgba(255, 244, 241, 0.86)", borderRadius: 14, padding: "12px 13px",
            fontSize: 12.5, lineHeight: 1.65, color: "var(--gray-1)",
          }}>
            {person.knownFacts.map((f, i) => (
              <span key={i} style={f.isLead ? { color: "var(--ink)", fontWeight: 500 } : undefined}>
                {f.text}{i < person.knownFacts.length - 1 ? " " : ""}
              </span>
            ))}
          </div>
        </Section>

        {(culture.taboos.length > 0 || person.personalTaboos.length > 0) && (
          <Section title="WATCHOUTS">
            <div style={{
              background: "#FFF6F0", borderRadius: 11, padding: "11px 13px",
              display: "flex", gap: 9, alignItems: "flex-start",
            }}>
              <span style={{ fontSize: 15, color: "#D98A4E", marginTop: 1 }}>
                <Icon name="i-alert" />
              </span>
              <p style={{ fontSize: 12, lineHeight: 1.6, color: "#9A6B43" }}>
                {culture.id === "malay-muslim"
                  ? "Muslim — no Christmas greetings, and keep gifts halal. "
                  : ""}
                {person.personalTaboos.join(" ")}
              </p>
            </div>
          </Section>
        )}
      </div>

      <div style={{ padding: "16px 24px", display: "flex", gap: 9 }}>
        <Link
          href={`/workspace?person=${person.id}`}
          onClick={onClose}
          className="heartline-button"
          style={{
            flex: 1,
          }}
        >
          <Icon name="i-edit" /> {prepareLabel}
        </Link>
        <button style={{
          padding: "11px 14px", background: "#fff", borderRadius: 12, color: "var(--heartline-purple-deep)",
          fontSize: 13.5, display: "flex", alignItems: "center", gap: 6, border: "none", cursor: "pointer",
          boxShadow: "inset 0 0 0 0.5px var(--line)",
        }}>
          <Icon name="i-pencil" /> Edit
        </button>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--gray-2)", letterSpacing: "0.08em", marginBottom: 10 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Tag({ children, dot }: { children: React.ReactNode; dot?: string }) {
  return (
    <span style={{
      fontSize: 12, padding: "5px 11px", borderRadius: 10, background: "var(--soft)",
      color: "var(--gray-1)", display: "flex", alignItems: "center", gap: 5,
      border: "0.5px solid rgba(239, 224, 218, 0.72)",
    }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: "50%", background: dot }} />}
      {children}
    </span>
  );
}
