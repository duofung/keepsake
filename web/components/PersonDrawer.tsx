"use client";

import Link from "next/link";
import Icon from "./Icon";
import Avatar from "./Avatar";
import type { ReactNode } from "react";
import type { CultureRule, OccasionNode, Person, Relationship } from "@/lib/domain";
import type { RemasterDashboardAccount } from "@/lib/remaster/read-model";
import { nodeChipText, occasionIcon, occasionTintBg, urgencyLevel } from "@/lib/presentation";

type Props = {
  person: Person | null;
  account: RemasterDashboardAccount | null;
  relationship: Relationship | null;
  culture: CultureRule | null;
  occasions: OccasionNode[];
  onClose: () => void;
};

export default function PersonDrawer({
  person, account, relationship, culture, occasions, onClose,
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
        data-testid="person-dossier-drawer"
        aria-label="Relationship dossier"
        style={{
          position: "absolute", top: 0, right: 0, bottom: 0, width: 420,
          maxWidth: "calc(100vw - 52px)",
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
            account={account}
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
  person, account, relationship, culture, occasions, onClose,
}: {
  person: Person; account: RemasterDashboardAccount | null; relationship: Relationship; culture: CultureRule;
  occasions: OccasionNode[]; onClose: () => void;
}) {
  const primary = occasions.find((o) => o.isPrimary) ?? occasions[0] ?? null;
  const businessLine = drawerBusinessLine(person, relationship);
  const lastTouch = account?.lastTouchLabel ?? fallbackLastTouch(person);
  const nextFollowUp = account?.nextFollowUpLabel ?? fallbackNextFollowUp(primary);
  const touchpointSummary = account?.touchpointSummary ?? `${segmentLabel(person)} touchpoints · ${nextFollowUp} · ${lastTouch}`;
  const relationshipContext = buildRelationshipContext(person, relationship, culture);
  const businessContext = buildBusinessContext(person);
  const rememberFacts = person.knownFacts.length > 0
    ? person.knownFacts
    : [{ text: "No memory note yet. Capture what matters before the next touchpoint.", isLead: true }];
  const prepareLabel = primary
    ? `Draft next note for ${primary.label}`
    : "Draft next note";

  return (
    <>
      <div style={{ padding: "22px 24px 18px", position: "relative" }}>
        <button
          type="button"
          aria-label="Close relationship dossier"
          onClick={onClose}
          style={{
            position: "absolute", top: 18, right: 20, width: 34, height: 34,
            borderRadius: "50%", background: "var(--heartline-rose-wash)", border: "none",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--heartline-purple-deep)", fontSize: 17, cursor: "pointer",
          }}
        >
          <Icon name="i-x" />
        </button>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 7, marginBottom: 14,
          padding: "5px 10px", borderRadius: 999,
          background: "rgba(252, 234, 240, 0.92)",
          color: "var(--heartline-purple-deep)",
          fontSize: 10.5, fontWeight: 760, letterSpacing: "0.06em", textTransform: "uppercase",
        }}>
          <Icon name="i-heart-handshake" />
          Relationship dossier
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, paddingRight: 34 }}>
          <Avatar name={person.name} bg={person.avatarBg} fg={person.avatarFg} size={58} fontSize={21} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 650, color: "var(--ink)", display: "flex", alignItems: "center", gap: 6 }}>
              {person.name}
              {person.starred && (
                <span style={{ color: "var(--amber)", fontSize: 14 }}>
                  <Icon name="i-star" fill />
                </span>
              )}
            </div>
            <div style={{ fontSize: 12.25, color: "var(--gray-2)", marginTop: 3, lineHeight: 1.35 }}>
              {businessLine}
            </div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "2px 24px 18px" }}>
        <Section title="OVERVIEW">
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9,
          }}>
            <DossierField label="Segment" value={segmentLabel(person)} />
            <DossierField label="Priority" value={person.starred ? "Prioritized" : "Standard cadence"} />
            <DossierField label="Organization" value={person.organization ?? "Independent contact"} />
            <DossierField label="Role / title" value={person.roleTitle ?? "Role not set"} />
          </div>
          <div style={{ marginTop: 9 }}>
            <DossierField label="Context / source" value={person.sourceContext ?? person.since ?? "Source context not captured"} wide />
          </div>
        </Section>

        <Section title="RELATIONSHIP CONTEXT">
          <div style={{ display: "grid", gap: 8 }}>
            <DossierNote icon="i-users" label="Positioning">
              {relationshipContext}
            </DossierNote>
            <DossierNote icon="i-bulb" label="Current context">
              {businessContext}
            </DossierNote>
          </div>
        </Section>

        <Section title="TOUCHPOINTS">
          <div style={{ display: "grid", gap: 8 }}>
            <TouchpointRow icon="i-clock" label="Last touch" value={lastTouch.replace(/^Last touch ·\s*/, "")} />
            <TouchpointRow icon="i-bell" label="Next follow-up" value={nextFollowUp.replace(/^Next follow-up ·\s*/, "")} />
            <TouchpointRow
              icon={primary ? occasionIcon[primary.kind] : "i-bulb"}
              label="Next activity"
              value={primary ? milestoneLine(primary) : "No milestone scheduled"}
            />
          </div>
          <p style={{ margin: "10px 0 0", color: "var(--gray-2)", fontSize: 11.75, lineHeight: 1.45 }}>
            {touchpointSummary}
          </p>
          {occasions.length > 1 && (
            <div style={{ marginTop: 10 }}>
              {occasions.map((occasion, index) => (
                <OccasionRow key={occasion.id} occasion={occasion} last={index === occasions.length - 1} personColor={person.avatarFg} />
              ))}
            </div>
          )}
        </Section>

        <Section title="NOTES / REMEMBER">
          <div style={{
            background: "rgba(255, 244, 241, 0.86)", borderRadius: 14, padding: "12px 13px",
            fontSize: 12.5, lineHeight: 1.65, color: "var(--gray-1)",
          }}>
            {rememberFacts.map((fact, index) => (
              <span key={`${fact.text}-${index}`} style={fact.isLead ? { color: "var(--ink)", fontWeight: 560 } : undefined}>
                {fact.text}{index < rememberFacts.length - 1 ? " " : ""}
              </span>
            ))}
          </div>
          {(culture.taboos.length > 0 || person.personalTaboos.length > 0) && (
            <div style={{
              marginTop: 10,
              background: "#FFF6F0", borderRadius: 11, padding: "11px 13px",
              display: "flex", gap: 9, alignItems: "flex-start",
            }}>
              <span style={{ fontSize: 15, color: "#D98A4E", marginTop: 1 }}>
                <Icon name="i-alert" />
              </span>
              <p style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: "#9A6B43" }}>
                {culture.id === "malay-muslim"
                  ? "Muslim context: avoid Christmas greetings and keep gifts halal. "
                  : ""}
                {person.personalTaboos.join(" ")}
              </p>
            </div>
          )}
        </Section>
      </div>

      <div style={{
        padding: "15px 24px 17px",
        borderTop: "0.5px solid rgba(239, 224, 218, 0.82)",
        background: "rgba(255, 253, 249, 0.82)",
      }}>
        <div style={{ fontSize: 10.75, fontWeight: 740, color: "var(--gray-2)", letterSpacing: "0.08em", marginBottom: 9 }}>
          ACTIONS
        </div>
        <div style={{ display: "flex", gap: 9 }}>
          <Link
            href={`/workspace?person=${person.id}`}
            onClick={onClose}
            className="heartline-button"
            style={{ flex: 1 }}
          >
            <Icon name="i-edit" /> Open workspace
          </Link>
          <Link
            href={`/workspace?person=${person.id}`}
            onClick={onClose}
            aria-label={prepareLabel}
            title={prepareLabel}
            style={{
              padding: "11px 13px", background: "#fff", borderRadius: 12, color: "var(--heartline-purple-deep)",
              fontSize: 13.25, display: "flex", alignItems: "center", gap: 6, textDecoration: "none",
              boxShadow: "inset 0 0 0 0.5px var(--line)",
              whiteSpace: "nowrap",
            }}
          >
            <Icon name="i-pencil" /> Draft next note
          </Link>
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 740, color: "var(--gray-2)", letterSpacing: "0.08em", marginBottom: 10 }}>
        {title}
      </div>
      {children}
    </section>
  );
}

function DossierField({ label, value, wide }: { label: string; value: ReactNode; wide?: boolean }) {
  return (
    <div style={{
      minWidth: 0,
      background: "rgba(255,255,255,0.7)",
      border: "0.5px solid rgba(239, 224, 218, 0.72)",
      borderRadius: 12,
      padding: "9px 10px",
      gridColumn: wide ? "1 / -1" : undefined,
    }}>
      <div style={{ fontSize: 10.5, color: "var(--gray-3)", fontWeight: 650, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--ink)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
        {value}
      </div>
    </div>
  );
}

function DossierNote({ icon, label, children }: { icon: string; label: string; children: ReactNode }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "28px 1fr", gap: 10,
      background: "rgba(255,255,255,0.64)",
      border: "0.5px solid rgba(239, 224, 218, 0.72)",
      borderRadius: 13,
      padding: "10px 11px",
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: 9,
        background: "var(--heartline-rose-wash)",
        color: "var(--heartline-purple-deep)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 14,
      }}>
        <Icon name={icon} />
      </div>
      <div>
        <div style={{ fontSize: 10.5, color: "var(--gray-3)", fontWeight: 650, marginBottom: 3 }}>
          {label}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--gray-1)", lineHeight: 1.5 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function TouchpointRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "28px 1fr", gap: 10,
      alignItems: "center",
      background: "rgba(255, 248, 245, 0.82)",
      borderRadius: 13,
      padding: "9px 10px",
    }}>
      <div style={{
        width: 28, height: 28, borderRadius: 9,
        background: "rgba(252, 234, 240, 0.9)",
        color: "var(--heartline-purple-deep)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 14,
      }}>
        <Icon name={icon} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 10.5, color: "var(--gray-3)", fontWeight: 650, marginBottom: 2 }}>
          {label}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--ink)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
          {value}
        </div>
      </div>
    </div>
  );
}

function OccasionRow({
  occasion, last, personColor,
}: {
  occasion: OccasionNode; last: boolean; personColor: string;
}) {
  const level = urgencyLevel(occasion.daysUntil);
  const whenText = nodeChipText(occasion.label, occasion.daysUntil).split("·")[1]?.trim() ?? "";
  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 10, padding: "9px 0",
        borderBottom: last ? "none" : "0.5px solid var(--line)",
      }}
    >
      <div style={{
        width: 30, height: 30, borderRadius: 9,
        background: occasionTintBg[occasion.kind], color: personColor,
        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0,
      }}>
        <Icon name={occasionIcon[occasion.kind]} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 560, color: "var(--ink)" }}>{occasion.label}</div>
        {occasion.detail && (
          <div style={{ fontSize: 11.25, color: "var(--gray-3)", marginTop: 1 }}>{occasion.detail}</div>
        )}
      </div>
      <div style={{
        fontSize: 11.25, textAlign: "right",
        color: level === "far" ? "var(--gray-3)" : "var(--heartline-purple-deep)",
        fontWeight: level === "far" ? 420 : 580,
      }}>
        {whenText}
      </div>
    </div>
  );
}

function drawerBusinessLine(person: Person, relationship: Relationship): string {
  const organization = person.organization?.trim() ?? "";
  const roleTitle = person.roleTitle?.trim() ?? "";
  const sourceContext = person.sourceContext?.trim() ?? "";
  const legacyContext = person.since?.trim() ?? "";
  const business = [organization, roleTitle].filter(Boolean).join(" / ");
  return business || sourceContext || `${relationship.label}${legacyContext ? ` · ${legacyContext}` : ""}`;
}

function buildRelationshipContext(
  person: Person,
  relationship: Relationship,
  culture: CultureRule,
): string {
  const segment = segmentLabel(person);
  const organization = person.organization?.trim();
  const roleTitle = person.roleTitle?.trim();
  const rolePart = [organization, roleTitle].filter(Boolean).join(" / ");
  const culturePart = culture.id !== "none" ? ` · ${culture.label}` : "";
  if (rolePart) return `${segment} relationship · ${rolePart}${culturePart}`;
  return `${segment} relationship · ${relationship.label}${culturePart}`;
}

function buildBusinessContext(person: Person): string {
  const source = person.sourceContext?.trim();
  if (source) return source;
  const identity = person.identityTags.find((tag) => tag.trim().length > 0);
  if (identity) return identity;
  const leadFact = person.knownFacts.find((fact) => fact.isLead)?.text ?? person.knownFacts[0]?.text;
  if (leadFact) return leadFact;
  return "Context still to learn from future touchpoints.";
}

function fallbackLastTouch(person: Person): string {
  if (person.lastContactAt) return `Last touch · ${person.lastContactAt.slice(0, 10)}`;
  return "Last touch · No outreach yet";
}

function fallbackNextFollowUp(primary: OccasionNode | null): string {
  if (!primary) return "Next follow-up · Not scheduled";
  return `Next follow-up · ${primary.label} · ${daysUntilText(primary.daysUntil)}`;
}

function milestoneLine(primary: OccasionNode): string {
  const whenText = nodeChipText(primary.label, primary.daysUntil).split("·")[1]?.trim() ?? daysUntilText(primary.daysUntil);
  return `${primary.label} · ${whenText}`;
}

function daysUntilText(daysUntil: number): string {
  if (daysUntil < 0) return `${Math.abs(daysUntil)} days ago`;
  if (daysUntil === 0) return "today";
  if (daysUntil === 1) return "tomorrow";
  return `in ${daysUntil} days`;
}

function segmentLabel(person: Person): string {
  switch (person.segment ?? "personal") {
    case "client":
      return "Client";
    case "partner":
      return "Partner";
    case "prospect":
      return "Prospect";
    case "investor":
      return "Investor";
    default:
      return "Personal";
  }
}
