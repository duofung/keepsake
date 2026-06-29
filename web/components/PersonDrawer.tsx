"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import Icon from "./Icon";
import Avatar from "./Avatar";
import type { FormEvent, ReactNode } from "react";
import type {
  ContactSegment,
  ContactTouchpointType,
  CultureRule,
  OccasionNode,
  Person,
  Relationship,
} from "@/lib/domain";
import type { RemasterDashboardAccount } from "@/lib/remaster/read-model";
import { nodeChipText, occasionIcon, occasionTintBg, urgencyLevel } from "@/lib/presentation";

export type PersonMaintenanceInput = {
  name: string;
  segment: ContactSegment;
  organization: string;
  roleTitle: string;
  sourceContext: string;
  note: string;
  lastContactAt: string;
  nextFollowUpAt: string;
};

type Props = {
  person: Person | null;
  account: RemasterDashboardAccount | null;
  relationship: Relationship | null;
  culture: CultureRule | null;
  occasions: OccasionNode[];
  onUpdate: (personId: string, input: PersonMaintenanceInput) => Promise<Person>;
  onArchive: (personId: string) => Promise<void>;
  onRestore: (personId: string) => Promise<Person>;
  onSetNextFollowUp: (personId: string, date: string) => Promise<Person>;
  onMarkFollowUpDone: (personId: string) => Promise<Person>;
  onSnoozeFollowUp: (personId: string, date: string) => Promise<Person>;
  onLogTouchpoint: (personId: string, input: TouchpointLogInput) => Promise<Person>;
  onClose: () => void;
};

export type TouchpointLogInput = {
  touchType: ContactTouchpointType;
  occurredAt: string;
};

type FollowUpAction = "mark-done" | "set-next" | "snooze" | "log-touchpoint";

export default function PersonDrawer({
  person, account, relationship, culture, occasions, onUpdate, onArchive, onRestore,
  onSetNextFollowUp, onMarkFollowUpDone, onSnoozeFollowUp, onLogTouchpoint, onClose,
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
            onUpdate={onUpdate}
            onArchive={onArchive}
            onRestore={onRestore}
            onSetNextFollowUp={onSetNextFollowUp}
            onMarkFollowUpDone={onMarkFollowUpDone}
            onSnoozeFollowUp={onSnoozeFollowUp}
            onLogTouchpoint={onLogTouchpoint}
            onClose={onClose}
          />
        )}
      </aside>
    </>
  );
}

function DrawerContent({
  person, account, relationship, culture, occasions, onUpdate, onArchive, onRestore,
  onSetNextFollowUp, onMarkFollowUpDone, onSnoozeFollowUp, onLogTouchpoint, onClose,
}: {
  person: Person; account: RemasterDashboardAccount | null; relationship: Relationship; culture: CultureRule;
  occasions: OccasionNode[];
  onUpdate: (personId: string, input: PersonMaintenanceInput) => Promise<Person>;
  onArchive: (personId: string) => Promise<void>;
  onRestore: (personId: string) => Promise<Person>;
  onSetNextFollowUp: (personId: string, date: string) => Promise<Person>;
  onMarkFollowUpDone: (personId: string) => Promise<Person>;
  onSnoozeFollowUp: (personId: string, date: string) => Promise<Person>;
  onLogTouchpoint: (personId: string, input: TouchpointLogInput) => Promise<Person>;
  onClose: () => void;
}) {
  const primary = occasions.find((o) => o.isPrimary) ?? occasions[0] ?? null;
  const businessLine = drawerBusinessLine(person, relationship);
  const lastTouch = account?.lastTouchLabel ?? fallbackLastTouch(person);
  const nextFollowUp = account?.nextFollowUpLabel ?? fallbackNextFollowUp(primary);
  const rhythmSummary = account?.followUpRhythm.label ?? "Unscheduled";
  const touchpointSummary = account?.touchpointSummary ?? `${segmentLabel(person)} touchpoints · ${nextFollowUp} · ${lastTouch}`;
  const relationshipContext = buildRelationshipContext(person, relationship, culture);
  const businessContext = buildBusinessContext(person);
  const rememberFacts = person.knownFacts.length > 0
    ? person.knownFacts
    : [{ text: "No memory note yet. Capture what matters before the next touchpoint.", isLead: true }];
  const prepareLabel = primary
    ? `Draft next note for ${primary.label}`
    : "Draft next note";
  const [draft, setDraft] = useState(() => draftFromPerson(person));
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [actionBusy, setActionBusy] = useState<FollowUpAction | null>(null);
  const [actionDate, setActionDate] = useState(() => defaultFollowUpDate(person));
  const [touchDate, setTouchDate] = useState(() => todayISO());
  const [touchType, setTouchType] = useState<ContactTouchpointType>(person.lastTouchpointType ?? "email");
  const [error, setError] = useState<string | null>(null);
  const isArchived = Boolean(person.archivedAt);

  useEffect(() => {
    setDraft(draftFromPerson(person));
    setSaving(false);
    setArchiving(false);
    setRestoring(false);
    setActionBusy(null);
    setActionDate(defaultFollowUpDate(person));
    setTouchDate(person.lastContactAt?.slice(0, 10) ?? todayISO());
    setTouchType(person.lastTouchpointType ?? "email");
    setError(null);
  }, [person]);

  async function submitMaintenance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isArchived) {
      setError("Restore this contact before editing the dossier.");
      return;
    }
    if (!draft.name.trim()) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await onUpdate(person.id, draft);
      setDraft(draftFromPerson(updated));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not update this contact.");
    } finally {
      setSaving(false);
    }
  }

  async function archiveContact() {
    const confirmed = typeof window === "undefined"
      ? true
      : window.confirm(`Archive ${person.name}? They will leave People/Home, but touchpoint history stays.`);
    if (!confirmed) return;
    setArchiving(true);
    setError(null);
    try {
      await onArchive(person.id);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not archive this contact.");
      setArchiving(false);
    }
  }

  async function restoreContact() {
    setRestoring(true);
    setError(null);
    try {
      const restored = await onRestore(person.id);
      setDraft(draftFromPerson(restored));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not restore this contact.");
      setRestoring(false);
    }
  }

  async function runFollowUpAction(action: FollowUpAction) {
    if (isArchived) {
      setError("Restore this contact before managing follow-up actions.");
      return;
    }

    setActionBusy(action);
    setError(null);
    try {
      let updated: Person;
      if (action === "mark-done") {
        updated = await onMarkFollowUpDone(person.id);
      } else if (action === "set-next") {
        if (!actionDate) throw new Error("Choose the next follow-up date first.");
        updated = await onSetNextFollowUp(person.id, actionDate);
      } else if (action === "snooze") {
        if (!actionDate) throw new Error("Choose the snooze date first.");
        updated = await onSnoozeFollowUp(person.id, actionDate);
      } else {
        if (!touchDate) throw new Error("Choose when the touchpoint happened.");
        updated = await onLogTouchpoint(person.id, { touchType, occurredAt: touchDate });
      }
      setDraft(draftFromPerson(updated));
      setActionDate(defaultFollowUpDate(updated));
      setTouchDate(updated.lastContactAt?.slice(0, 10) ?? todayISO());
      setTouchType(updated.lastTouchpointType ?? touchType);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not update follow-up action.");
    } finally {
      setActionBusy(null);
    }
  }

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
          background: isArchived ? "#FFF6F0" : "rgba(252, 234, 240, 0.92)",
          color: isArchived ? "#B94F4F" : "var(--heartline-purple-deep)",
          fontSize: 10.5, fontWeight: 760, letterSpacing: "0.06em", textTransform: "uppercase",
        }}>
          <Icon name={isArchived ? "i-clock" : "i-heart-handshake"} />
          {isArchived ? "Archived dossier" : "Relationship dossier"}
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
        {isArchived && (
          <div
            data-testid="person-archived-state"
            style={{
              marginTop: 14,
              padding: "11px 12px",
              borderRadius: 14,
              background: "#FFF6F0",
              border: "0.5px solid rgba(213, 92, 92, 0.2)",
              color: "#9A5A44",
              fontSize: 12.25,
              lineHeight: 1.5,
            }}
          >
            Archived contact · hidden from active People and Home. Restore to resume follow-up management.
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "2px 24px 18px" }}>
        <Section title="OVERVIEW">
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9,
          }}>
            <DossierField label="Segment" value={segmentLabel(person)} />
            <DossierField label="Status" value={isArchived ? "Archived" : "Active"} />
            <DossierField label="Priority" value={person.starred ? "Prioritized" : "Standard cadence"} />
            <DossierField label="Organization" value={person.organization ?? "Independent contact"} />
            <DossierField label="Role / title" value={person.roleTitle ?? "Role not set"} />
          </div>
          <div style={{ marginTop: 9 }}>
            <DossierField label="Context / source" value={person.sourceContext ?? person.since ?? "Source context not captured"} wide />
          </div>
        </Section>

        <Section title="MAINTENANCE LOOP">
          <form data-testid="person-maintenance-form" onSubmit={submitMaintenance} style={{ display: "grid", gap: 10 }}>
            {isArchived && (
              <p style={{ margin: 0, color: "var(--gray-2)", fontSize: 12.25, lineHeight: 1.5 }}>
                Archived contacts are review-only here. Restore this contact to edit fields or plan new outreach.
              </p>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 0.84fr", gap: 9 }}>
              <label style={maintenanceFieldStyle}>
                <span style={maintenanceLabelStyle}>Name</span>
                <input
                  disabled={isArchived}
                  value={draft.name}
                  onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                  style={maintenanceInputStyle}
                />
              </label>
              <label style={maintenanceFieldStyle}>
                <span style={maintenanceLabelStyle}>Segment</span>
                <select
                  disabled={isArchived}
                  value={draft.segment}
                  onChange={(event) => setDraft((current) => ({ ...current, segment: event.target.value as ContactSegment }))}
                  style={maintenanceInputStyle}
                >
                  {CONTACT_SEGMENTS.map((segment) => (
                    <option key={segment} value={segment}>{segmentText[segment]}</option>
                  ))}
                </select>
              </label>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
              <label style={maintenanceFieldStyle}>
                <span style={maintenanceLabelStyle}>Organization</span>
                <input
                  disabled={isArchived}
                  value={draft.organization}
                  onChange={(event) => setDraft((current) => ({ ...current, organization: event.target.value }))}
                  style={maintenanceInputStyle}
                />
              </label>
              <label style={maintenanceFieldStyle}>
                <span style={maintenanceLabelStyle}>Role title</span>
                <input
                  disabled={isArchived}
                  value={draft.roleTitle}
                  onChange={(event) => setDraft((current) => ({ ...current, roleTitle: event.target.value }))}
                  style={maintenanceInputStyle}
                />
              </label>
            </div>
            <label style={maintenanceFieldStyle}>
              <span style={maintenanceLabelStyle}>Source context</span>
              <input
                disabled={isArchived}
                value={draft.sourceContext}
                onChange={(event) => setDraft((current) => ({ ...current, sourceContext: event.target.value }))}
                style={maintenanceInputStyle}
              />
            </label>
            <label style={maintenanceFieldStyle}>
              <span style={maintenanceLabelStyle}>Remember</span>
              <textarea
                disabled={isArchived}
                value={draft.note}
                onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))}
                style={{ ...maintenanceInputStyle, minHeight: 78, resize: "vertical", lineHeight: 1.45 }}
              />
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
              <label style={maintenanceFieldStyle}>
                <span style={maintenanceLabelStyle}>Last touch</span>
                <input
                  disabled={isArchived}
                  type="date"
                  value={draft.lastContactAt}
                  onChange={(event) => setDraft((current) => ({ ...current, lastContactAt: event.target.value }))}
                  style={maintenanceInputStyle}
                />
              </label>
              <label style={maintenanceFieldStyle}>
                <span style={maintenanceLabelStyle}>Next follow-up</span>
                <input
                  disabled={isArchived}
                  type="date"
                  value={draft.nextFollowUpAt}
                  onChange={(event) => setDraft((current) => ({ ...current, nextFollowUpAt: event.target.value }))}
                  style={maintenanceInputStyle}
                />
              </label>
            </div>
            {error && (
              <p role="alert" style={{ margin: 0, color: "#D55C5C", fontSize: 12.25 }}>
                {error}
              </p>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="submit"
                disabled={saving || archiving || restoring || isArchived}
                style={{
                  padding: "9px 13px",
                  borderRadius: 12,
                  border: "none",
                  background: "var(--heartline-purple-deep)",
                  color: "#fff",
                  fontSize: 12.75,
                  fontWeight: 650,
                  cursor: saving || archiving || restoring || isArchived ? "default" : "pointer",
                  opacity: saving || archiving || restoring || isArchived ? 0.68 : 1,
                }}
              >
                {isArchived ? "Restore to edit" : saving ? "Saving..." : "Save changes"}
              </button>
            </div>
          </form>
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
            <TouchpointRow icon="i-bulb" label="Rhythm" value={rhythmSummary} />
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

        <Section title="FOLLOW-UP ACTIONS">
          <div data-testid="person-follow-up-actions" style={{ display: "grid", gap: 10 }}>
            <p data-testid="drawer-action-bridge" style={actionBridgeTextStyle}>
              Review context, mark done, or draft outreach from this dossier.
            </p>
            {isArchived && (
              <p style={{ margin: 0, color: "var(--gray-2)", fontSize: 12.25, lineHeight: 1.5 }}>
                Restore this contact before marking follow-ups or logging touchpoints.
              </p>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <button
                type="button"
                onClick={() => void runFollowUpAction("mark-done")}
                disabled={isArchived || Boolean(actionBusy)}
                style={actionButtonStyle(isArchived || Boolean(actionBusy), true)}
              >
                <Icon name="i-check" /> {actionBusy === "mark-done" ? "Marking..." : "Mark done"}
              </button>
              <Link
                href={`/workspace?person=${person.id}`}
                onClick={onClose}
                style={{
                  ...actionLinkStyle,
                  pointerEvents: isArchived ? "none" : "auto",
                  opacity: isArchived ? 0.62 : 1,
                }}
              >
                <Icon name="i-edit" /> Draft outreach
              </Link>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8, alignItems: "end" }}>
              <label style={maintenanceFieldStyle}>
                <span style={maintenanceLabelStyle}>Next follow-up</span>
                <input
                  disabled={isArchived || Boolean(actionBusy)}
                  type="date"
                  value={actionDate}
                  onChange={(event) => setActionDate(event.target.value)}
                  style={maintenanceInputStyle}
                />
              </label>
              <button
                type="button"
                onClick={() => void runFollowUpAction("set-next")}
                disabled={isArchived || Boolean(actionBusy)}
                style={compactActionButtonStyle(isArchived || Boolean(actionBusy))}
              >
                {actionBusy === "set-next" ? "Setting..." : "Set"}
              </button>
              <button
                type="button"
                onClick={() => void runFollowUpAction("snooze")}
                disabled={isArchived || Boolean(actionBusy)}
                style={compactActionButtonStyle(isArchived || Boolean(actionBusy))}
              >
                {actionBusy === "snooze" ? "Snoozing..." : "Snooze"}
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "0.9fr 1fr auto", gap: 8, alignItems: "end" }}>
              <label style={maintenanceFieldStyle}>
                <span style={maintenanceLabelStyle}>Touchpoint type</span>
                <select
                  disabled={isArchived || Boolean(actionBusy)}
                  value={touchType}
                  onChange={(event) => setTouchType(event.target.value as ContactTouchpointType)}
                  style={maintenanceInputStyle}
                >
                  {TOUCHPOINT_TYPES.map((type) => (
                    <option key={type} value={type}>{touchpointTypeText[type]}</option>
                  ))}
                </select>
              </label>
              <label style={maintenanceFieldStyle}>
                <span style={maintenanceLabelStyle}>Occurred</span>
                <input
                  disabled={isArchived || Boolean(actionBusy)}
                  type="date"
                  value={touchDate}
                  onChange={(event) => setTouchDate(event.target.value)}
                  style={maintenanceInputStyle}
                />
              </label>
              <button
                type="button"
                onClick={() => void runFollowUpAction("log-touchpoint")}
                disabled={isArchived || Boolean(actionBusy)}
                style={compactActionButtonStyle(isArchived || Boolean(actionBusy))}
              >
                {actionBusy === "log-touchpoint" ? "Logging..." : "Log"}
              </button>
            </div>
          </div>
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
        {isArchived ? (
          <>
            <p style={{ margin: "0 0 10px", color: "var(--gray-2)", fontSize: 12.25, lineHeight: 1.5 }}>
              Restore this contact to return it to Active People, Home follow-ups, and workspace drafting.
            </p>
            <button
              type="button"
              onClick={restoreContact}
              disabled={saving || restoring}
              style={{
                width: "100%",
                padding: "11px 13px",
                background: "var(--heartline-purple-deep)",
                border: "none",
                borderRadius: 12,
                color: "#fff",
                fontSize: 13,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                cursor: saving || restoring ? "default" : "pointer",
                opacity: saving || restoring ? 0.68 : 1,
              }}
            >
              <Icon name="i-users" /> {restoring ? "Restoring..." : "Restore contact"}
            </button>
          </>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 0.88fr", gap: 9 }}>
              <Link
                href={`/workspace?person=${person.id}`}
                onClick={onClose}
                className="heartline-button"
                style={{ justifyContent: "center" }}
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
                <Icon name="i-pencil" /> Draft outreach
              </Link>
            </div>
            <button
              type="button"
              onClick={archiveContact}
              disabled={saving || archiving}
              style={{
                width: "100%",
                marginTop: 9,
                padding: "10px 13px",
                background: "rgba(255,255,255,0.74)",
                border: "0.5px solid rgba(213, 92, 92, 0.24)",
                borderRadius: 12,
                color: "#B94F4F",
                fontSize: 12.75,
                fontWeight: 650,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                cursor: saving || archiving ? "default" : "pointer",
                opacity: saving || archiving ? 0.68 : 1,
              }}
            >
              <Icon name="i-alert" /> {archiving ? "Archiving..." : "Archive contact"}
            </button>
          </>
        )}
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
  if (person.lastContactAt) {
    const dateISO = person.lastContactAt.slice(0, 10);
    return person.lastTouchpointType
      ? `Last touch · ${touchpointTypeText[person.lastTouchpointType]} · ${dateISO}`
      : `Last touch · ${dateISO}`;
  }
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

const CONTACT_SEGMENTS: ContactSegment[] = ["client", "partner", "prospect", "investor", "personal"];
const TOUCHPOINT_TYPES: ContactTouchpointType[] = ["email", "meeting", "call", "message", "note", "other"];

const segmentText: Record<ContactSegment, string> = {
  client: "Client",
  partner: "Partner",
  prospect: "Prospect",
  investor: "Investor",
  personal: "Personal",
};

const touchpointTypeText: Record<ContactTouchpointType, string> = {
  call: "Call",
  email: "Email",
  meeting: "Meeting",
  message: "Message",
  note: "Note",
  other: "Other",
};

function draftFromPerson(person: Person): PersonMaintenanceInput {
  return {
    name: person.name,
    segment: person.segment ?? "personal",
    organization: person.organization ?? "",
    roleTitle: person.roleTitle ?? "",
    sourceContext: person.sourceContext ?? person.since ?? "",
    note: person.knownFacts.map((fact) => fact.text).join(" "),
    lastContactAt: person.lastContactAt?.slice(0, 10) ?? "",
    nextFollowUpAt: person.nextFollowUpAt?.slice(0, 10) ?? "",
  };
}

function segmentLabel(person: Person): string {
  return segmentText[person.segment ?? "personal"];
}

function defaultFollowUpDate(person: Person): string {
  return person.nextFollowUpAt?.slice(0, 10) ?? addDaysISO(7);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function actionButtonStyle(disabled: boolean, primary = false) {
  return {
    padding: "10px 12px",
    borderRadius: 12,
    border: primary ? "none" : "0.5px solid rgba(239, 224, 218, 0.9)",
    background: primary ? "var(--heartline-purple-deep)" : "rgba(255,255,255,0.82)",
    color: primary ? "#fff" : "var(--heartline-purple-deep)",
    fontSize: 12.75,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.62 : 1,
  } as const;
}

function compactActionButtonStyle(disabled: boolean) {
  return {
    ...actionButtonStyle(disabled),
    minWidth: 66,
    height: 36,
    padding: "8px 10px",
  } as const;
}

const actionLinkStyle = {
  padding: "10px 12px",
  borderRadius: 12,
  background: "rgba(255,255,255,0.82)",
  border: "0.5px solid rgba(239, 224, 218, 0.9)",
  color: "var(--heartline-purple-deep)",
  fontSize: 12.75,
  fontWeight: 700,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  textDecoration: "none",
} as const;

const actionBridgeTextStyle = {
  margin: 0,
  color: "var(--gray-2)",
  fontSize: 12.25,
  lineHeight: 1.5,
} as const;

const maintenanceFieldStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
} as const;

const maintenanceLabelStyle = {
  color: "var(--gray-3)",
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
} as const;

const maintenanceInputStyle = {
  border: "0.5px solid rgba(239, 224, 218, 0.9)",
  borderRadius: 11,
  background: "rgba(255,255,255,0.82)",
  color: "var(--ink)",
  fontSize: 12.75,
  outline: "none",
  padding: "9px 10px",
  boxShadow: "0 1px 0 rgba(70, 42, 82, 0.03)",
} as const;
