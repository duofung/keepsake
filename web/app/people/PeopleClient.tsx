"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Icon from "@/components/Icon";
import Avatar from "@/components/Avatar";
import PersonDrawer, { type PersonMaintenanceInput, type TouchpointLogInput } from "@/components/PersonDrawer";
import type { FormEvent } from "react";
import type {
  ContactSegment,
  ContactTouchpointType,
  OccasionNode,
  Person,
  PeoplePayload,
  Relationship,
  RelationshipGroup,
} from "@/lib/domain";
import {
  classifyFollowUpRhythm,
  compareRemasterAccountsByRhythm,
} from "@/lib/remaster/read-model";
import type {
  RemasterDashboardAccount,
  RemasterDashboardActivity,
  RemasterDashboardOverview,
  RemasterRelationshipType,
} from "@/lib/remaster/read-model";
import { deliveryStatusBadge, occasionIcon, urgencyLevel } from "@/lib/presentation";

type AccountTab = "All" | ContactSegment;
type ContactArchiveView = "active" | "archived";
type ReviewMode = "all" | "attention";

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

const rhythmTone = {
  overdue: "#B94F4F",
  today: "var(--heartline-purple-deep)",
  this_week: "var(--heartline-rose-strong)",
  unscheduled: "#9A6B43",
  later: "var(--gray-3)",
} as const;

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
  const searchParams = useSearchParams();
  const reviewPersonId = searchParams.get("review");
  const { relationships, cultures, occasions } = payload;
  const [people, setPeople] = useState<Person[]>(() => payload.people.map(normalizePerson));
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<AccountTab>("All");
  const [contactView, setContactView] = useState<ContactArchiveView>("active");
  const [reviewMode, setReviewMode] = useState<ReviewMode>("all");
  const [handledReviewPersonId, setHandledReviewPersonId] = useState<string | null>(null);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [archiveViewError, setArchiveViewError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    setPeople((current) => mergePeople(payload.people, [
      ...readLocalPeople(),
      ...current.filter((person) => Boolean(person.archivedAt)),
    ]));
  }, [payload.people]);

  useEffect(() => {
    if (contactView !== "archived" || archivedLoaded) return;
    const controller = new AbortController();
    setLoadingArchived(true);
    setArchiveViewError(null);
    fetch("/api/people?view=archived", { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as PeoplePayload | { error?: string } | null;
        if (!response.ok) {
          throw new Error((body && "error" in body ? body.error : null) ?? "Could not load archived contacts.");
        }
        return body as PeoplePayload;
      })
      .then((archivedPayload) => {
        setPeople((current) => mergePeople(current, archivedPayload.people));
        setArchivedLoaded(true);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setArchiveViewError(error instanceof Error ? error.message : "Could not load archived contacts.");
      })
      .finally(() => setLoadingArchived(false));
    return () => controller.abort();
  }, [archivedLoaded, contactView]);

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

  const primaryOccasionByPersonId = useMemo(
    () => new Map(
      occasions
        .filter((occasion) => occasion.isPrimary)
        .map((occasion) => [occasion.personId, occasion]),
    ),
    [occasions],
  );

  const activePeople = useMemo(
    () => people.filter((person) => !person.archivedAt),
    [people],
  );

  const archivedPeople = useMemo(
    () => people.filter((person) => Boolean(person.archivedAt)),
    [people],
  );

  useEffect(() => {
    if (!reviewPersonId || handledReviewPersonId === reviewPersonId) return;
    const targetIsActive = activePeople.some((person) => person.id === reviewPersonId);
    setHandledReviewPersonId(reviewPersonId);
    if (!targetIsActive) return;
    setContactView("active");
    setReviewMode("all");
    setTab("All");
    setOpenId(reviewPersonId);
  }, [activePeople, handledReviewPersonId, reviewPersonId]);

  const viewPeople = contactView === "archived" ? archivedPeople : activePeople;

  const viewPersonById = useMemo(
    () => new Map(viewPeople.map((person) => [person.id, person])),
    [viewPeople],
  );

  const accounts = useMemo(() => {
    const serverAccountByContactId = new Map(
      overview.accounts.map((account) => [account.primaryContactId, account]),
    );
    return viewPeople.flatMap((person) => {
      const relationship = relationshipById.get(person.relationshipId);
      const culture = cultureById.get(person.cultureId);
      const primaryOccasion = primaryOccasionByPersonId.get(person.id) ?? null;
      if (!relationship) return [];
      const base = serverAccountByContactId.get(person.id) ?? null;
      return [
        base
          ? mergeAccountWithPerson(base, person, relationship, culture?.label ?? null, primaryOccasion)
          : buildCompatibilityAccount(person, relationship, culture?.label ?? null, primaryOccasion),
      ];
    }).sort(compareRemasterAccountsByRhythm);
  }, [cultureById, overview.accounts, primaryOccasionByPersonId, relationshipById, viewPeople]);

  const attentionCount = useMemo(
    () => accounts.filter((account) => account.followUpRhythm.isAttention).length,
    [accounts],
  );

  const reviewAccounts = useMemo(
    () => accounts.filter((account) => account.followUpRhythm.isAttention).slice(0, 3),
    [accounts],
  );

  const filteredAccounts = useMemo(
    () => (contactView === "active" && reviewMode === "attention"
      ? accounts.filter((account) => account.followUpRhythm.isAttention)
      : accounts),
    [accounts, contactView, reviewMode],
  );

  const grouped = useMemo(() => {
    const out: Record<ContactSegment, RemasterDashboardAccount[]> = {
      client: [],
      partner: [],
      prospect: [],
      investor: [],
      personal: [],
    };
    for (const account of filteredAccounts) {
      out[accountSegment(account)].push(account);
    }
    return out;
  }, [filteredAccounts]);

  const tabs = useMemo(
    () => TAB_ORDER.map((id) => ({
      id,
      n: tabCount(id, filteredAccounts, grouped),
    })),
    [filteredAccounts, grouped],
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
  const drawerAccount = drawerPerson
    ? accounts.find((account) => account.primaryContactId === drawerPerson.id) ?? null
    : null;
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
    setContactView("active");
    setTab("All");
    setAdding(false);
    setOpenId(person.id);
  }

  async function handleUpdatePerson(personId: string, input: PersonMaintenanceInput): Promise<Person> {
    const existing = people.find((person) => person.id === personId);
    if (existing?.archivedAt) {
      throw new Error("Restore this contact before editing the dossier.");
    }

    if (personId.startsWith("local-")) {
      if (!existing) throw new Error("Person not found.");
      const updated = applyMaintenanceInput(existing, input);
      updatePersonInState(updated);
      return updated;
    }

    const response = await fetch(`/api/people/${encodeURIComponent(personId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = await response.json().catch(() => null) as Person | { error?: string } | null;
    if (!response.ok) {
      throw new Error((body && "error" in body ? body.error : null) ?? "Could not update this contact.");
    }

    const updated = normalizePerson(body as Person);
    updatePersonInState(updated);
    return updated;
  }

  async function handleArchivePerson(personId: string): Promise<void> {
    if (personId.startsWith("local-")) {
      const current = people.find((person) => person.id === personId);
      if (!current) throw new Error("Person not found.");
      updatePersonInState(normalizePerson({ ...current, archivedAt: new Date().toISOString() }));
      setOpenId(null);
      return;
    }

    const response = await fetch(`/api/people/${encodeURIComponent(personId)}/archive`, {
      method: "POST",
    });
    const body = await response.json().catch(() => null) as { person?: Person; error?: string } | null;
    if (!response.ok) {
      throw new Error(body?.error ?? "Could not archive this contact.");
    }

    if (body?.person) updatePersonInState(normalizePerson(body.person));
    setOpenId(null);
  }

  async function handleRestorePerson(personId: string): Promise<Person> {
    if (personId.startsWith("local-")) {
      const current = people.find((person) => person.id === personId);
      if (!current) throw new Error("Person not found.");
      const restored = normalizePerson({ ...current, archivedAt: undefined });
      updatePersonInState(restored);
      setContactView("active");
      setOpenId(restored.id);
      return restored;
    }

    const response = await fetch(`/api/people/${encodeURIComponent(personId)}/restore`, {
      method: "POST",
    });
    const body = await response.json().catch(() => null) as { person?: Person; error?: string } | null;
    if (!response.ok) {
      throw new Error(body?.error ?? "Could not restore this contact.");
    }

    if (!body?.person) throw new Error("Restore did not return a contact.");
    const restored = normalizePerson(body.person);
    updatePersonInState(restored);
    setContactView("active");
    setOpenId(restored.id);
    return restored;
  }

  async function handleSetNextFollowUp(personId: string, date: string): Promise<Person> {
    return runPersonAction(personId, "follow-up", { nextFollowUpAt: date }, (person) => ({
      ...person,
      nextFollowUpAt: date,
    }));
  }

  async function handleMarkFollowUpDone(personId: string): Promise<Person> {
    const date = todayISO();
    return runPersonAction(personId, "follow-up/done", null, (person) => ({
      ...person,
      lastContactAt: date,
      lastTouchpointType: "note",
      nextFollowUpAt: undefined,
    }));
  }

  async function handleSnoozeFollowUp(personId: string, date: string): Promise<Person> {
    return runPersonAction(personId, "follow-up/snooze", { nextFollowUpAt: date }, (person) => ({
      ...person,
      nextFollowUpAt: date,
    }));
  }

  async function handleLogTouchpoint(personId: string, input: TouchpointLogInput): Promise<Person> {
    return runPersonAction(personId, "touchpoints", input, (person) => ({
      ...person,
      lastContactAt: input.occurredAt,
      lastTouchpointType: input.touchType,
    }));
  }

  async function runPersonAction(
    personId: string,
    path: string,
    body: Record<string, unknown> | null,
    localUpdate: (person: Person) => Person,
  ): Promise<Person> {
    const existing = people.find((person) => person.id === personId);
    if (existing?.archivedAt) {
      throw new Error("Restore this contact before managing follow-up actions.");
    }

    if (personId.startsWith("local-")) {
      if (!existing) throw new Error("Person not found.");
      const updated = normalizePerson(localUpdate(existing));
      updatePersonInState(updated);
      return updated;
    }

    const response = await fetch(`/api/people/${encodeURIComponent(personId)}/${path}`, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const responseBody = await response.json().catch(() => null) as { person?: Person; error?: string } | null;
    if (!response.ok) {
      throw new Error(responseBody?.error ?? "Could not update follow-up action.");
    }
    if (!responseBody?.person) throw new Error("Follow-up action did not return a contact.");

    const updated = normalizePerson(responseBody.person);
    updatePersonInState(updated);
    return updated;
  }

  function updatePersonInState(updated: Person) {
    setPeople((current) => (
      current.some((person) => person.id === updated.id)
        ? current.map((person) => (person.id === updated.id ? updated : person))
        : [updated, ...current]
    ));
    if (updated.id.startsWith("local-")) {
      const stored = readLocalPeople();
      const nextLocal = stored.some((person) => person.id === updated.id)
        ? stored.map((person) => (person.id === updated.id ? updated : person))
        : [updated, ...stored];
      saveLocalPeople(nextLocal);
    }
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
              {activePeople.length} active {activePeople.length === 1 ? "contact" : "contacts"}
              {" · "}{archivedLoaded || archivedPeople.length > 0 ? `${archivedPeople.length} archived` : "archived view available"}
              {contactView === "active" ? ` · ${attentionCount} need attention` : ""}
              {" · "}client, partner, prospect, investor, and personal segments
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

      <div className="ks-page-inner ks-page-inner--people" style={{ paddingTop: 0, paddingBottom: 8, width: "min(100%, 1000px)" }}>
        <div style={{
          display: "inline-flex",
          gap: 4,
          padding: 4,
          borderRadius: 16,
          background: "rgba(255,255,255,0.74)",
          border: "0.5px solid rgba(239, 224, 218, 0.88)",
        }}>
          {(["active", "archived"] as const).map((view) => (
            <button
              key={view}
              type="button"
              aria-pressed={contactView === view}
              onClick={() => {
                setContactView(view);
                setTab("All");
                if (view === "archived") setReviewMode("all");
              }}
              style={{
                border: "none",
                borderRadius: 12,
                background: contactView === view ? "var(--heartline-rose-wash)" : "transparent",
                color: contactView === view ? "var(--heartline-purple-deep)" : "var(--gray-2)",
                fontSize: 12.75,
                fontWeight: contactView === view ? 700 : 560,
                padding: "8px 13px",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Icon name={view === "active" ? "i-users" : "i-clock"} />
              {view === "active" ? "Active" : "Archived"}
              <span style={{ fontSize: 11, color: contactView === view ? "var(--heartline-rose-strong)" : "var(--gray-3)" }}>
                {view === "active" ? activePeople.length : archivedPeople.length}
              </span>
            </button>
          ))}
        </div>
      </div>

      {contactView === "active" && (
        <div className="ks-page-inner ks-page-inner--people" style={{ paddingTop: 0, paddingBottom: 8, width: "min(100%, 1000px)" }}>
          <div
            data-testid="people-review-queue"
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(220px, 0.68fr) minmax(0, 1fr)",
              gap: 10,
              alignItems: "stretch",
            }}
          >
            <div style={{
              display: "inline-flex",
              gap: 4,
              padding: 4,
              borderRadius: 16,
              background: "rgba(255,255,255,0.74)",
              border: "0.5px solid rgba(239, 224, 218, 0.88)",
              alignSelf: "start",
            }}>
              {(["all", "attention"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={reviewMode === mode}
                  onClick={() => {
                    setReviewMode(mode);
                    setTab("All");
                  }}
                  style={{
                    border: "none",
                    borderRadius: 12,
                    background: reviewMode === mode ? "var(--heartline-rose-wash)" : "transparent",
                    color: reviewMode === mode ? "var(--heartline-purple-deep)" : "var(--gray-2)",
                    fontSize: 12.25,
                    fontWeight: reviewMode === mode ? 700 : 560,
                    padding: "8px 11px",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    whiteSpace: "nowrap",
                  }}
                >
                  <Icon name={mode === "attention" ? "i-bell" : "i-users"} />
                  {mode === "attention" ? "Needs attention" : "All active"}
                  <span style={{ fontSize: 11, color: reviewMode === mode ? "var(--heartline-rose-strong)" : "var(--gray-3)" }}>
                    {mode === "attention" ? attentionCount : activePeople.length}
                  </span>
                </button>
              ))}
            </div>

            <div style={{
              display: "grid",
              gap: 8,
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            }}>
              {reviewAccounts.length === 0 ? (
                <div style={{
                  gridColumn: "1 / -1",
                  borderRadius: 16,
                  background: "rgba(255,255,255,0.72)",
                  border: "0.5px solid rgba(239, 224, 218, 0.86)",
                  padding: "10px 12px",
                  color: "var(--gray-2)",
                  fontSize: 12.25,
                }}>
                  Review queue is clear. Later follow-ups stay in All active.
                </div>
              ) : reviewAccounts.map((account, index) => (
                <button
                  key={account.id}
                  type="button"
                  aria-label={`Open dossier for ${account.name}`}
                  data-testid="people-review-action"
                  data-action-target="dossier"
                  data-review-rhythm={account.followUpRhythm.status}
                  data-review-rank={index + 1}
                  onClick={() => setOpenId(account.primaryContactId)}
                  style={{
                    border: `0.5px solid ${rhythmBorderColor(account.followUpRhythm.status)}`,
                    borderRadius: 16,
                    background: account.followUpRhythm.status === "overdue" ? "#FFF6F0" : "rgba(255,255,255,0.78)",
                    padding: "10px 11px",
                    textAlign: "left",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    minWidth: 0,
                  }}
                >
                  <span style={{
                    display: "block",
                    color: rhythmColor(account.followUpRhythm.status),
                    fontSize: 10.5,
                    fontWeight: 780,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    marginBottom: 3,
                  }}>
                    {account.followUpRhythm.label}
                  </span>
                  <span style={{ display: "block", color: "var(--ink)", fontSize: 12.5, fontWeight: 720, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {account.name}
                  </span>
                  <span style={{ display: "block", color: "var(--gray-2)", fontSize: 11, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {account.nextFollowUpLabel.replace(/^Next follow-up ·\s*/, "")}
                  </span>
                  <span style={{
                    alignItems: "center",
                    color: "var(--heartline-purple-deep)",
                    display: "inline-flex",
                    fontSize: 11,
                    fontWeight: 760,
                    gap: 5,
                    marginTop: 8,
                  }}>
                    <Icon name="i-edit" /> Open dossier
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

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
        {contactView === "archived" && loadingArchived && (
          <div style={{
            background: "rgba(255,255,255,0.82)",
            border: "0.5px solid rgba(239, 224, 218, 0.92)",
            borderRadius: 18,
            padding: 18,
            color: "var(--gray-2)",
            fontSize: 13,
            marginBottom: 14,
          }}>
            Loading archived contacts...
          </div>
        )}
        {archiveViewError && (
          <div role="alert" style={{
            background: "#FFF6F0",
            border: "0.5px solid rgba(213, 92, 92, 0.22)",
            borderRadius: 18,
            padding: 18,
            color: "#B94F4F",
            fontSize: 13,
            marginBottom: 14,
          }}>
            {archiveViewError}
          </div>
        )}
        {visibleEntries.length === 0 && (
          <div style={{
            background: "rgba(255,255,255,0.82)",
            border: "0.5px solid rgba(239, 224, 218, 0.92)",
            borderRadius: 18,
            padding: 18,
            color: "var(--gray-2)",
            fontSize: 13,
          }}>
            {contactView === "archived"
              ? "No archived contacts in this segment. Active relationships stay in the default view."
              : reviewMode === "attention"
                ? "No active contacts need attention in this segment. Switch to All active to see later follow-ups."
              : "No active contacts in this segment yet."}
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
                const contact = viewPersonById.get(account.primaryContactId) ?? null;
                const archived = Boolean(contact?.archivedAt);
                return (
                  <button
                    type="button"
                    key={account.id}
                    aria-label={`Open dossier for ${account.name}`}
                    data-action-target="dossier"
                    data-review-rhythm={account.followUpRhythm.status}
                    onClick={() => setOpenId(account.primaryContactId)}
                    style={{
                      background: "rgba(255,255,255,0.9)",
                      border: `0.5px solid ${account.followUpRhythm.isAttention && !archived
                        ? rhythmBorderColor(account.followUpRhythm.status)
                        : "rgba(239, 224, 218, 0.92)"}`,
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
                        {archived && (
                          <span style={{
                            fontSize: 10.5, padding: "3px 8px", borderRadius: 999,
                            background: "#FFF6F0", color: "#B94F4F",
                            border: "0.5px solid rgba(213, 92, 92, 0.2)",
                          }}>Archived</span>
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
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        marginTop: 8,
                        color: rhythmColor(account.followUpRhythm.status),
                        fontSize: 11.25,
                        fontWeight: 720,
                      }}>
                        <Icon name={account.followUpRhythm.status === "unscheduled" ? "i-bulb" : "i-clock"} />
                        {account.followUpRhythm.label}
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
        account={drawerAccount}
        relationship={drawerRel}
        culture={drawerCulture}
        occasions={drawerOccasions}
        onUpdate={handleUpdatePerson}
        onArchive={handleArchivePerson}
        onRestore={handleRestorePerson}
        onSetNextFollowUp={handleSetNextFollowUp}
        onMarkFollowUpDone={handleMarkFollowUpDone}
        onSnoozeFollowUp={handleSnoozeFollowUp}
        onLogTouchpoint={handleLogTouchpoint}
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
  primaryOccasion: OccasionNode | null,
): RemasterDashboardAccount {
  const segment = contactSegment(person);
  const lastTouchLabel = lastTouchLabelForPerson(person, "Last touch · No outreach yet");
  const nextFollowUpLabel = nextFollowUpLabelForPerson(person, person.nextOccasionId
    ? "Next follow-up · Scheduled"
    : "Next follow-up · Not scheduled");
  const followUpRhythm = classifyFollowUpRhythm(person, {
    fallbackDateISO: primaryOccasion?.dateISO ?? null,
    fallbackDaysUntil: primaryOccasion?.daysUntil ?? null,
  });
  return {
    id: `account-${person.id}`,
    primaryContactId: person.id,
    name: person.name,
    mode: "contact-led",
    relationshipType: relationshipTypeByGroup[relationship.group],
    segment,
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
    lastTouchLabel,
    nextFollowUpLabel,
    touchpointSummary: `${segmentLabel[segment]} touchpoints · ${nextFollowUpLabel} · ${lastTouchLabel} · ${person.sourceContext ?? person.since ?? "Business context not set"}`,
    followUpRhythm,
  };
}

function mergeAccountWithPerson(
  account: RemasterDashboardAccount,
  person: Person,
  relationship: Relationship,
  cultureLabel: string | null,
  primaryOccasion: OccasionNode | null,
): RemasterDashboardAccount {
  const segment = contactSegment(person);
  const lastTouchLabel = lastTouchLabelForPerson(person, account.lastTouchLabel);
  const nextFollowUpLabel = nextFollowUpLabelForPerson(person, account.nextFollowUpLabel);
  const followUpRhythm = classifyFollowUpRhythm(person, {
    fallbackDateISO: primaryOccasion?.dateISO ?? account.followUpRhythm.dueDateISO,
    fallbackDaysUntil: primaryOccasion?.daysUntil ?? account.followUpRhythm.daysUntil,
  });
  return {
    ...account,
    name: person.name,
    relationshipType: relationshipTypeByGroup[relationship.group],
    segment,
    relationshipLabel: relationship.label,
    organization: person.organization ?? null,
    roleTitle: person.roleTitle ?? null,
    sourceContext: person.sourceContext ?? null,
    starred: person.starred,
    avatarBg: person.avatarBg,
    avatarFg: person.avatarFg,
    contextLabel: person.since ?? person.sourceContext ?? person.identityTags[0] ?? account.contextLabel,
    secondaryLabel: person.organization ?? person.identityTags[0] ?? cultureLabel ?? account.secondaryLabel,
    lastTouchLabel,
    nextFollowUpLabel,
    touchpointSummary: `${segmentLabel[segment]} touchpoints · ${nextFollowUpLabel} · ${lastTouchLabel}${person.sourceContext ? ` · ${person.sourceContext}` : ""}`,
    followUpRhythm,
  };
}

function applyMaintenanceInput(person: Person, input: PersonMaintenanceInput): Person {
  const note = input.note.trim();
  return normalizePerson({
    ...person,
    name: input.name.trim(),
    segment: input.segment,
    organization: input.organization.trim() || null,
    roleTitle: input.roleTitle.trim() || null,
    sourceContext: input.sourceContext.trim() || null,
    since: input.sourceContext.trim() || person.since,
    knownFacts: note ? [{ text: note, isLead: true }] : [],
    lastContactAt: input.lastContactAt || undefined,
    nextFollowUpAt: input.nextFollowUpAt || undefined,
  });
}

function lastTouchLabelForPerson(person: Person, fallback: string): string {
  if (!person.lastContactAt) return fallback;
  const dateISO = person.lastContactAt.slice(0, 10);
  return person.lastTouchpointType
    ? `Last touch · ${touchpointTypeLabel(person.lastTouchpointType)} · ${dateISO}`
    : `Last touch · ${dateISO}`;
}

function nextFollowUpLabelForPerson(person: Person, fallback: string): string {
  return person.nextFollowUpAt ? `Next follow-up · ${person.nextFollowUpAt.slice(0, 10)}` : fallback;
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

function rhythmColor(status: RemasterDashboardAccount["followUpRhythm"]["status"]): string {
  return rhythmTone[status];
}

function rhythmBorderColor(status: RemasterDashboardAccount["followUpRhythm"]["status"]): string {
  if (status === "overdue") return "rgba(213, 92, 92, 0.3)";
  if (status === "today") return "rgba(135, 80, 180, 0.26)";
  if (status === "this_week") return "rgba(204, 120, 153, 0.3)";
  if (status === "unscheduled") return "rgba(217, 138, 78, 0.26)";
  return "rgba(239, 224, 218, 0.92)";
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
    lastTouchpointType: person.lastTouchpointType ?? undefined,
    nextFollowUpAt: person.nextFollowUpAt ?? undefined,
    archivedAt: person.archivedAt ?? undefined,
  };
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function touchpointTypeLabel(touchType: ContactTouchpointType): string {
  const labels: Record<ContactTouchpointType, string> = {
    call: "Call",
    email: "Email",
    meeting: "Meeting",
    message: "Message",
    note: "Note",
    other: "Other touchpoint",
  };
  return labels[touchType];
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
