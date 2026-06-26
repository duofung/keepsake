"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icon";
import Avatar from "@/components/Avatar";
import PersonDrawer from "@/components/PersonDrawer";
import type { FormEvent } from "react";
import type { ContactSegment, Person, PeoplePayload, Relationship, RelationshipGroup } from "@/lib/domain";
import type {
  RemasterDashboardAccount,
  RemasterDashboardActivity,
  RemasterDashboardOverview,
  RemasterRelationshipType,
} from "@/lib/remaster/read-model";
import { deliveryStatusBadge, occasionIcon, urgencyLevel } from "@/lib/presentation";

type AccountTab = "All" | ContactSegment;

const segmentIcon: Record<ContactSegment, string> = {
  client: "i-users",
  partner: "i-heart",
  prospect: "i-heart-handshake",
  investor: "i-star",
  personal: "i-users",
};

const segmentLabel: Record<ContactSegment, string> = {
  client: "Client",
  partner: "Partner",
  prospect: "Prospect",
  investor: "Investor",
  personal: "Personal",
};

const segmentPluralLabel: Record<ContactSegment, string> = {
  client: "Clients",
  partner: "Partners",
  prospect: "Prospects",
  investor: "Investors",
  personal: "Personal",
};

const relationshipTypeLabel: Record<RemasterRelationshipType, string> = {
  partner: "Partner",
  personal: "Personal",
  network: "Network",
  colleague: "Colleague",
};

const relationshipTypeByGroup: Record<RelationshipGroup, RemasterRelationshipType> = {
  Partner: "partner",
  Family: "personal",
  Friends: "network",
  Colleagues: "colleague",
};

const SEGMENT_ORDER: ContactSegment[] = [
  "client", "partner", "prospect", "investor", "personal",
];

const TAB_ORDER: AccountTab[] = ["All", ...SEGMENT_ORDER];

const metaColor: Record<string, string> = {
  soon: "var(--heartline-purple-deep)",
  mid: "var(--heartline-sage)",
  far: "var(--gray-3)",
};

const LOCAL_PEOPLE_KEY = "keepsake.localPeople.v1";

const avatarPalette = [
  { bg: "#D9EAFA", fg: "#4F83BA" },
  { bg: "#F9DDD2", fg: "#C87855" },
  { bg: "#DDD4F0", fg: "#856FC0" },
  { bg: "#D8F0E6", fg: "#5FA77D" },
  { bg: "#F3D7E8", fg: "#B86795" },
  { bg: "#F7E7BE", fg: "#B68221" },
];

type Props = {
  overview: RemasterDashboardOverview;
  payload: PeoplePayload;
};

export default function PeopleClient({ overview, payload }: Props) {
  const { relationships, cultures, occasions } = payload;
  const [people, setPeople] = useState<Person[]>(() => payload.people.map(normalizePerson));
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<AccountTab>("All");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    setPeople(mergePeople(payload.people, readLocalPeople()));
  }, [payload.people]);

  const relationshipById = useMemo(
    () => new Map(relationships.map((r) => [r.id, r])),
    [relationships],
  );

  const cultureById = useMemo(
    () => new Map(cultures.map((c) => [c.id, c])),
    [cultures],
  );

  const activityById = useMemo(
    () => new Map(
      [...overview.upcomingActivities, ...overview.recentActivities]
        .map((activity) => [activity.id, activity]),
    ),
    [overview.recentActivities, overview.upcomingActivities],
  );

  const accounts = useMemo(() => {
    const serverContactIds = new Set(overview.accounts.map((account) => account.primaryContactId));
    const projectedAccounts = people.flatMap((person) => {
      if (serverContactIds.has(person.id)) return [];
      const relationship = relationshipById.get(person.relationshipId);
      const culture = cultureById.get(person.cultureId);
      if (!relationship) return [];
      return [buildCompatibilityAccount(person, relationship, culture?.label ?? null)];
    });

    return [...projectedAccounts, ...overview.accounts];
  }, [cultureById, overview.accounts, people, relationshipById]);

  const grouped = useMemo(() => {
    const out: Record<ContactSegment, RemasterDashboardAccount[]> = {
      client: [],
      partner: [],
      prospect: [],
      investor: [],
      personal: [],
    };
    for (const account of accounts) {
      out[accountSegment(account)].push(account);
    }
    return out;
  }, [accounts]);

  const tabs = useMemo(
    () => TAB_ORDER.map((id) => ({
      id,
      n: tabCount(id, accounts, grouped),
    })),
    [accounts, grouped],
  );

  const visibleEntries = useMemo(() => {
    const all = SEGMENT_ORDER
      .map((type) => ({
        id: type,
        title: segmentPluralLabel[type].toUpperCase(),
        icon: segmentIcon[type],
        accounts: grouped[type],
      }))
      .filter((entry) => entry.accounts.length > 0);

    return tab === "All" ? all : all.filter((entry) => entry.id === tab);
  }, [grouped, tab]);

  const drawerPerson = openId ? people.find((p) => p.id === openId) ?? null : null;
  const drawerRel = drawerPerson ? relationshipById.get(drawerPerson.relationshipId) ?? null : null;
  const drawerCulture = drawerPerson ? cultureById.get(drawerPerson.cultureId) ?? null : null;
  const drawerOccasions = drawerPerson
    ? occasions.filter((o) => o.personId === drawerPerson.id)
    : [];

  const defaultCultureId = cultures.find((c) => c.id === "none")?.id
    ?? cultures[0]?.id
    ?? "none";

  async function handleAddPerson(input: AddPersonInput) {
    const relationship = relationshipById.get(relationshipIdForSegment(input.segment)) ?? relationships[0];
    const culture = cultureById.get(defaultCultureId) ?? cultures.find((c) => c.id === "none") ?? cultures[0];
    if (!relationship || !culture) return;

    const response = await fetch("/api/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: input.name,
        segment: input.segment,
        organization: input.organization,
        roleTitle: input.roleTitle,
        sourceContext: input.sourceContext,
        relationshipId: relationship.id,
        cultureId: culture.id,
        note: input.note,
        starred: input.starred,
      }),
    });

    if (!response.ok) {
      if (response.status === 501) {
        addPersonToList(createLocalPerson(input));
        return;
      }
      const body = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(body?.error ?? "Could not add this contact.");
    }

    const serverPerson = await response.json() as Person;
    addPersonToList(serverPerson);
  }

  function addPersonToList(person: Person) {
    const shouldPersistLocally = person.id.startsWith("local-");
    if (shouldPersistLocally) {
      const nextLocal = [person, ...readLocalPeople().filter((localPerson) => localPerson.id !== person.id)];
      saveLocalPeople(nextLocal);
    }
    setPeople((current) => [person, ...current.filter((p) => p.id !== person.id)]);
    setTab("All");
    setAdding(false);
    setOpenId(person.id);
  }

  function createLocalPerson(input: AddPersonInput): Person {
    const relationship = relationshipById.get(relationshipIdForSegment(input.segment)) ?? relationships[0];
    const culture = cultureById.get(defaultCultureId) ?? cultures.find((c) => c.id === "none") ?? cultures[0];
    if (!relationship || !culture) {
      throw new Error("Choose a contact type and culture first.");
    }

    const palette = avatarPalette[people.length % avatarPalette.length];
    const note = input.note.trim();
    const sourceContext = input.sourceContext.trim();
    return {
      id: makeLocalPersonId(),
      name: input.name.trim(),
      segment: input.segment,
      organization: input.organization.trim() || null,
      roleTitle: input.roleTitle.trim() || null,
      sourceContext: sourceContext || null,
      starred: input.starred,
      avatarBg: palette.bg,
      avatarFg: palette.fg,
      relationshipId: relationship.id,
      cultureId: culture.id,
      since: sourceContext || undefined,
      identityTags: sourceContext ? [sourceContext] : [],
      knownFacts: note
        ? [{ text: note, isLead: true }]
        : [{ text: "New business context to learn.", isLead: true }],
      personalTaboos: [],
      nextOccasionId: null,
      lastContactAt: new Date().toISOString().slice(0, 10),
    };
  }

  return (
    <div className="ks-page ks-page--stack">
      <div className="ks-page-inner ks-page-inner--people" style={{ paddingBottom: 14, width: "min(100%, 1000px)" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <p style={{
              margin: "0 0 8px",
              color: "var(--heartline-rose-strong)",
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: "0.09em",
              textTransform: "uppercase",
            }}>
              ReMaster contacts
            </p>
            <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--ink-2)", margin: 0 }}>Business relationships</h1>
            <p style={{ fontSize: 12.5, color: "var(--gray-2)", marginTop: 5 }}>
              {people.length} {people.length === 1 ? "contact" : "contacts"} across client, partner, prospect, investor, and personal segments
            </p>
          </div>
          <button
            data-testid="add-person-button"
            onClick={() => setAdding(true)}
            className="heartline-button"
            style={{
              whiteSpace: "nowrap",
          }}
          >
            <Icon name="i-plus" /> Add contact
          </button>
        </div>
      </div>

      <div className="ks-page-inner ks-page-inner--people" style={{ paddingTop: 0, paddingBottom: 8, display: "flex", gap: 7, flexWrap: "wrap", width: "min(100%, 1000px)" }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              fontSize: 13, padding: "8px 14px", borderRadius: 999,
              color: tab === t.id ? "var(--heartline-purple-deep)" : "var(--gray-1)",
              background: tab === t.id ? "var(--heartline-rose-wash)" : "rgba(255,255,255,0.56)",
              fontWeight: tab === t.id ? 650 : 500,
              display: "flex", alignItems: "center", gap: 6,
              border: tab === t.id ? "0.5px solid rgba(204, 120, 153, 0.28)" : "0.5px solid rgba(239, 224, 218, 0.78)",
              cursor: "pointer",
            }}
          >
            {tabLabel(t.id)}
            <span style={{ fontSize: 11, color: tab === t.id ? "var(--heartline-rose-strong)" : "var(--gray-3)" }}>{t.n}</span>
          </button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div className="ks-page-inner ks-page-inner--people" style={{ paddingTop: 14, width: "min(100%, 1000px)" }}>
        {visibleEntries.length === 0 && (
          <div style={{
            background: "rgba(255,255,255,0.82)",
            border: "0.5px solid rgba(239, 224, 218, 0.92)",
            borderRadius: 18,
            padding: 18,
            color: "var(--gray-2)",
            fontSize: 13,
          }}>
            No contacts in this segment yet.
          </div>
        )}
        {visibleEntries.map((entry) => (
          <div key={entry.id} style={{ marginBottom: 24 }}>
            <div style={{
              fontSize: 11.5, fontWeight: 600, color: "var(--gray-2)",
              letterSpacing: "0.08em", marginBottom: 12,
              display: "flex", alignItems: "center", gap: 7,
            }}>
              <span style={{ fontSize: 14, color: "var(--heartline-rose-strong)" }}>
                <Icon name={entry.icon} />
              </span>
              {entry.title}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 13 }}>
              {entry.accounts.map((account) => {
                const nextActivity = account.nextActivityId
                  ? activityById.get(account.nextActivityId) ?? null
                  : null;
                const activitySummary = accountActivitySummary(account, nextActivity);
                const extraLabel = secondaryAccountLabel(account);
                return (
                  <button
                    type="button"
                    key={account.id}
                    onClick={() => setOpenId(account.primaryContactId)}
                    style={{
                      background: "rgba(255,255,255,0.9)",
                      border: "0.5px solid rgba(239, 224, 218, 0.92)",
                      borderRadius: 18,
                      padding: 16,
                      transition: ".18s",
                      cursor: "pointer",
                      display: "flex",
                      gap: 13,
                      boxShadow: "0 14px 34px -30px rgba(94, 54, 119, 0.42)",
                      textAlign: "left",
                      width: "100%",
                      fontFamily: "inherit",
                    }}
                  >
                    <Avatar name={account.name} bg={account.avatarBg} fg={account.avatarFg} size={44} fontSize={16} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
                        {account.name}
                        {account.starred && (
                          <span style={{ color: "var(--amber)", fontSize: 12 }}>
                            <Icon name="i-star" fill />
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11.5, color: "var(--gray-2)", marginBottom: 8 }}>
                        {businessIdentityLine(account)}
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 9 }}>
                        <span style={{
                          fontSize: 10.5, padding: "3px 8px", borderRadius: 999, fontWeight: 650,
                          background: "var(--heartline-rose-wash)", color: "var(--heartline-purple-deep)",
                        }}>{segmentLabel[accountSegment(account)]}</span>
                        <span style={{
                          fontSize: 10.5, padding: "3px 8px", borderRadius: 999,
                          background: "var(--soft)", color: "var(--gray-1)",
                        }}>{account.relationshipLabel}</span>
                        {extraLabel && (
                          <span style={{
                            fontSize: 10.5, padding: "3px 8px", borderRadius: 999,
                            background: "rgba(255,255,255,0.74)", color: "var(--gray-2)",
                            border: "0.5px solid rgba(239, 224, 218, 0.72)",
                          }}>{extraLabel}</span>
                        )}
                      </div>
                      <div style={{
                        fontSize: 11.5, display: "flex", alignItems: "center", gap: 6,
                        color: metaColor[activitySummary.level], fontWeight: activitySummary.level === "soon" ? 650 : 500,
                        background: "rgba(255, 248, 245, 0.78)",
                        borderRadius: 13,
                        padding: "8px 9px",
                      }}>
                        <span style={{ fontSize: 13 }}><Icon name={activitySummary.icon} /></span>
                        {activitySummary.text}
                      </div>
                      <div style={{
                        display: "grid", gap: 3, marginTop: 8,
                        color: "var(--gray-2)", fontSize: 11.25, lineHeight: 1.35,
                      }}>
                        <span>{account.lastTouchLabel}</span>
                        <span>{account.sourceContext ?? account.contextLabel}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        </div>
      </div>

      <PersonDrawer
        person={drawerPerson}
        relationship={drawerRel}
        culture={drawerCulture}
        occasions={drawerOccasions}
        onClose={() => setOpenId(null)}
      />
      <AddPersonDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdd={handleAddPerson}
      />
    </div>
  );
}

function tabCount(
  id: AccountTab,
  accounts: RemasterDashboardAccount[],
  grouped: Record<ContactSegment, RemasterDashboardAccount[]>,
) {
  if (id === "All") return accounts.length;
  return grouped[id].length;
}

function tabLabel(id: AccountTab) {
  if (id === "All") return "All";
  return segmentPluralLabel[id];
}

function buildCompatibilityAccount(
  person: Person,
  relationship: Relationship,
  cultureLabel: string | null,
): RemasterDashboardAccount {
  return {
    id: `account-${person.id}`,
    primaryContactId: person.id,
    name: person.name,
    mode: "contact-led",
    relationshipType: relationshipTypeByGroup[relationship.group],
    segment: contactSegment(person),
    relationshipLabel: relationship.label,
    organization: person.organization ?? null,
    roleTitle: person.roleTitle ?? null,
    sourceContext: person.sourceContext ?? null,
    starred: person.starred,
    avatarBg: person.avatarBg,
    avatarFg: person.avatarFg,
    contextLabel: person.since ?? person.sourceContext ?? person.identityTags[0] ?? "contact-led account",
    secondaryLabel: person.organization ?? person.identityTags[0] ?? cultureLabel ?? "Contact",
    nextActivityId: person.nextOccasionId,
    lastDeliveryStatus: null,
    lastDeliveryAtISO: null,
    lastTouchLabel: person.lastContactAt
      ? `Last touch · ${person.lastContactAt.slice(0, 10)}`
      : "Last touch · No outreach yet",
    nextFollowUpLabel: person.nextOccasionId
      ? "Next follow-up · Scheduled"
      : "Next follow-up · Not scheduled",
    touchpointSummary: `${segmentLabel[contactSegment(person)]} touchpoints · ${person.sourceContext ?? person.since ?? "Business context not set"}`,
  };
}

function accountActivitySummary(
  account: RemasterDashboardAccount,
  nextActivity: RemasterDashboardActivity | null,
) {
  if (nextActivity && nextActivity.daysUntil !== null) {
    const level = urgencyLevel(nextActivity.daysUntil);
    return {
      text: account.nextFollowUpLabel,
      icon: occasionIcon[nextActivity.occasionKind ?? "check-in"],
      level,
    };
  }

  if (account.lastDeliveryStatus) {
    const badge = deliveryStatusBadge[account.lastDeliveryStatus];
    return {
      text: account.nextFollowUpLabel,
      icon: badge.icon,
      level: "far" as const,
    };
  }

  return {
    text: account.nextFollowUpLabel,
    icon: "i-bulb",
    level: "far" as const,
  };
}

function secondaryAccountLabel(account: RemasterDashboardAccount) {
  const label = (account.sourceContext ?? account.secondaryLabel).trim();
  if (!label) return "";
  const lower = label.toLowerCase();
  const duplicateLabels = [
    account.relationshipLabel,
    relationshipTypeLabel[account.relationshipType],
    segmentLabel[accountSegment(account)],
    account.contextLabel,
    account.organization ?? "",
    account.roleTitle ?? "",
  ].map((value) => value.toLowerCase());
  return duplicateLabels.includes(lower) ? "" : label;
}

function accountSegment(account: RemasterDashboardAccount): ContactSegment {
  return account.segment ?? "personal";
}

function contactSegment(person: Person): ContactSegment {
  return person.segment ?? "personal";
}

function relationshipIdForSegment(segment: ContactSegment): string {
  return segment === "partner" ? "rel-partner" : "rel-friend";
}

function businessIdentityLine(account: RemasterDashboardAccount): string {
  const organization = account.organization?.trim() ?? "";
  const roleTitle = account.roleTitle?.trim() ?? "";
  if (organization && roleTitle) return `${organization} / ${roleTitle}`;
  if (organization) return organization;
  if (roleTitle) return roleTitle;
  return account.sourceContext ?? account.contextLabel;
}

type AddPersonInput = {
  name: string;
  organization: string;
  roleTitle: string;
  segment: ContactSegment;
  sourceContext: string;
  note: string;
  starred: boolean;
};

type AddPersonDialogProps = {
  open: boolean;
  onClose: () => void;
  onAdd: (input: AddPersonInput) => Promise<void>;
};

function AddPersonDialog({
  open,
  onClose,
  onAdd,
}: AddPersonDialogProps) {
  const [name, setName] = useState("");
  const [organization, setOrganization] = useState("");
  const [roleTitle, setRoleTitle] = useState("");
  const [segment, setSegment] = useState<ContactSegment>("client");
  const [sourceContext, setSourceContext] = useState("");
  const [note, setNote] = useState("");
  const [starred, setStarred] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName("");
    setOrganization("");
    setRoleTitle("");
    setSegment("client");
    setSourceContext("");
    setNote("");
    setStarred(false);
    setError(null);
    setSaving(false);
  }, [open]);

  if (!open) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Add a name first.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onAdd({
        name: trimmedName,
        organization,
        roleTitle,
        segment,
        sourceContext,
        note,
        starred,
      });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not add this contact.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 30,
        background: "rgba(47, 37, 50, 0.2)",
        backdropFilter: "blur(10px)",
        display: "flex",
        justifyContent: "flex-end",
        padding: 14,
      }}
    >
      <form
        data-testid="add-person-form"
        onSubmit={submit}
        style={{
          width: 404,
          maxWidth: "calc(100vw - 96px)",
          height: "100%",
          background:
            "linear-gradient(180deg, rgba(255,253,249,0.98) 0%, rgba(255,249,246,0.98) 100%)",
          border: "0.5px solid rgba(239, 224, 218, 0.92)",
          borderRadius: 28,
          boxShadow: "-24px 0 58px rgba(70, 42, 82, 0.16)",
          padding: "24px 24px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          position: "relative",
          overflow: "hidden",
          animation: "heartlinePanelIn 220ms ease-out",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: "0 0 auto 0",
            height: 124,
            background:
              "linear-gradient(180deg, rgba(252,234,240,0.82) 0%, rgba(252,234,240,0.16) 58%, rgba(252,234,240,0) 100%)",
            pointerEvents: "none",
          }}
        />
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: "18px 24px auto",
            height: 1,
            background:
              "linear-gradient(90deg, rgba(204,120,153,0.26) 0%, rgba(135,80,180,0.16) 45%, rgba(135,80,180,0) 100%)",
            pointerEvents: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14 }}>
          <div>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "5px 10px",
                borderRadius: 999,
                background: "rgba(252, 234, 240, 0.92)",
                color: "var(--heartline-purple-deep)",
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: "0.03em",
                marginBottom: 12,
              }}
            >
              <Icon name="i-users" />
              New business contact
            </span>
            <h2 style={{ fontSize: 20, fontWeight: 650, color: "var(--ink)", margin: 0 }}>
              Add business contact
            </h2>
            <p style={{ margin: "6px 0 0", color: "var(--gray-2)", fontSize: 13, lineHeight: 1.45 }}>
              Capture the business context ReMaster should remember for the next follow-up.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 44,
              height: 44,
              minWidth: 44,
              minHeight: 44,
              maxWidth: 44,
              maxHeight: 44,
              aspectRatio: "1 / 1",
              borderRadius: 999,
              border: "0.5px solid rgba(239, 224, 218, 0.92)",
              background: "rgba(255,255,255,0.82)",
              color: "var(--heartline-purple-deep)",
              display: "grid",
              placeItems: "center",
              cursor: "pointer",
              fontSize: 18,
              lineHeight: 0,
              padding: 0,
              flexShrink: 0,
              boxShadow: "0 10px 24px -20px rgba(94, 54, 119, 0.48)",
              transition: "transform 160ms ease, background 160ms ease, box-shadow 160ms ease",
            }}
          >
            <Icon name="i-x" style={{ width: 18, height: 18 }} />
          </button>
        </div>

        <label style={fieldWrapStyle}>
          <span style={fieldLabelStyle}>Name</span>
          <input
            data-testid="add-person-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError(null);
            }}
            placeholder="Helen Zhang"
            autoFocus
            style={inputStyle}
          />
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label style={fieldWrapStyle}>
            <span style={fieldLabelStyle}>Organization</span>
            <input
              value={organization}
              onChange={(event) => setOrganization(event.target.value)}
              placeholder="Northstar Labs"
              style={inputStyle}
            />
          </label>

          <label style={fieldWrapStyle}>
            <span style={fieldLabelStyle}>Role / Title</span>
            <input
              value={roleTitle}
              onChange={(event) => setRoleTitle(event.target.value)}
              placeholder="Head of Partnerships"
              style={inputStyle}
            />
          </label>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "0.86fr 1.14fr", gap: 10 }}>
          <label style={fieldWrapStyle}>
            <span style={fieldLabelStyle}>Segment</span>
            <select
              value={segment}
              onChange={(event) => setSegment(event.target.value as ContactSegment)}
              style={selectStyle}
            >
              {SEGMENT_ORDER.map((item) => (
                <option key={item} value={item}>{segmentLabel[item]}</option>
              ))}
            </select>
          </label>

          <label style={fieldWrapStyle}>
            <span style={fieldLabelStyle}>Context / Source</span>
            <input
              value={sourceContext}
              onChange={(event) => setSourceContext(event.target.value)}
              placeholder="Warm intro from Malaysia launch"
              style={inputStyle}
            />
          </label>
        </div>

        <label style={{ ...fieldWrapStyle, flex: 1, minHeight: 0 }}>
          <span style={fieldLabelStyle}>What should I remember?</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="A preference, open workstream, buying signal, key date, or anything that helps with the next touchpoint."
            style={{
              ...inputStyle,
              minHeight: 120,
              resize: "none",
              lineHeight: 1.5,
              flex: 1,
            }}
          />
        </label>

        <label style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          color: "var(--ink-2)",
          fontSize: 13,
          cursor: "pointer",
        }}>
          <input
            type="checkbox"
            checked={starred}
            onChange={(event) => setStarred(event.target.checked)}
            style={{ width: 16, height: 16, accentColor: "var(--heartline-purple)" }}
          />
          Prioritize this contact
        </label>

        {error && (
          <p role="alert" style={{ margin: 0, color: "#D55C5C", fontSize: 12.5 }}>
            {error}
          </p>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, paddingTop: 4 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "10px 16px",
              borderRadius: 13,
              border: "0.5px solid var(--line)",
              background: "#fff",
              color: "var(--gray-1)",
              fontSize: 13,
              fontWeight: 550,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="heartline-button"
            style={{
              opacity: saving ? 0.72 : 1,
              cursor: saving ? "default" : "pointer",
            }}
          >
            <Icon name="i-plus" /> {saving ? "Adding..." : "Add contact"}
          </button>
        </div>
      </form>
    </div>
  );
}

const fieldWrapStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 7,
} as const;

const fieldLabelStyle = {
  color: "var(--gray-2)",
  fontSize: 11.5,
  fontWeight: 650,
  letterSpacing: "0.03em",
  textTransform: "uppercase",
} as const;

const inputStyle = {
  border: "0.5px solid var(--line)",
  borderRadius: 13,
  background: "rgba(255,255,255,0.86)",
  color: "var(--ink)",
  fontSize: 14,
  outline: "none",
  padding: "11px 12px",
  boxShadow: "0 1px 0 rgba(70, 42, 82, 0.03)",
} as const;

const selectStyle = {
  ...inputStyle,
  appearance: "none",
} as const;

function makeLocalPersonId() {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function mergePeople(base: Person[], extras: Person[]) {
  const normalizedBase = base.map(normalizePerson);
  const normalizedExtras = extras.map(normalizePerson);
  const seen = new Set(normalizedBase.map((person) => person.id));
  return [
    ...normalizedExtras.filter((person) => {
      if (seen.has(person.id)) return false;
      seen.add(person.id);
      return true;
    }),
    ...normalizedBase,
  ];
}

function normalizePerson(person: Person): Person {
  return {
    ...person,
    segment: person.segment ?? "personal",
    organization: person.organization ?? null,
    roleTitle: person.roleTitle ?? null,
    sourceContext: person.sourceContext ?? null,
  };
}

function readLocalPeople(): Person[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_PEOPLE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((person): person is Person => (
      person
      && typeof person.id === "string"
      && person.id.startsWith("local-")
      && typeof person.name === "string"
      && typeof person.relationshipId === "string"
      && typeof person.cultureId === "string"
    ));
  } catch {
    return [];
  }
}

function saveLocalPeople(people: Person[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_PEOPLE_KEY, JSON.stringify(people));
  } catch {
    // Local preview persistence is a convenience; failing to write should not block adding.
  }
}
