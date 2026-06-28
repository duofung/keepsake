import type {
  ContactSegment,
  ContactTouchpointType,
  Delivery,
  DeliveryStatus,
  ID,
  OccasionNode,
  OccasionKind,
  PeoplePayload,
  Person,
  RelationshipGroup,
} from "@/lib/domain";

export type RemasterAccountMode = "contact-led";
export type RemasterRelationshipType = "partner" | "personal" | "network" | "colleague";
export type RemasterActivityType = "milestone" | "follow_up_due" | "outbound_delivery";
export type RemasterActivityStatus = "upcoming" | "completed" | "failed";

export interface RemasterDashboardAccount {
  id: ID;
  primaryContactId: ID;
  name: string;
  mode: RemasterAccountMode;
  relationshipType: RemasterRelationshipType;
  segment: ContactSegment;
  relationshipLabel: string;
  organization: string | null;
  roleTitle: string | null;
  sourceContext: string | null;
  starred: boolean;
  avatarBg: string;
  avatarFg: string;
  contextLabel: string;
  secondaryLabel: string;
  nextActivityId: ID | null;
  lastDeliveryStatus: DeliveryStatus | null;
  lastDeliveryAtISO: string | null;
  lastTouchLabel: string;
  nextFollowUpLabel: string;
  touchpointSummary: string;
}

export interface RemasterDashboardContact {
  id: ID;
  accountId: ID;
  displayName: string;
  segment: ContactSegment;
  organization: string | null;
  roleTitle: string | null;
  sourceContext: string | null;
  cultureLabel: string | null;
  contextLines: string[];
}

export interface RemasterDashboardActivity {
  id: ID;
  accountId: ID;
  contactId: ID | null;
  type: RemasterActivityType;
  status: RemasterActivityStatus;
  title: string;
  subtitle: string;
  dateISO: string;
  daysUntil: number | null;
  occasionKind: OccasionKind | null;
  deliveryStatus: DeliveryStatus | null;
  touchpointLabel: string;
  touchpointSummary: string;
}

export interface RemasterDashboardOverview {
  accounts: RemasterDashboardAccount[];
  contacts: RemasterDashboardContact[];
  upcomingActivities: RemasterDashboardActivity[];
  recentActivities: RemasterDashboardActivity[];
  stats: {
    accountsCount: number;
    contactsCount: number;
    upcomingActivitiesCount: number;
  };
}

const relationshipTypeByGroup: Record<RelationshipGroup, RemasterRelationshipType> = {
  Partner: "partner",
  Family: "personal",
  Friends: "network",
  Colleagues: "colleague",
};

export function buildRemasterDashboardOverview(
  payload: PeoplePayload,
  deliveries: Delivery[],
): RemasterDashboardOverview {
  const relationshipById = new Map(payload.relationships.map((relationship) => [relationship.id, relationship]));
  const cultureById = new Map(payload.cultures.map((culture) => [culture.id, culture]));
  const personById = new Map(payload.people.map((person) => [person.id, person]));
  const primaryOccasionByPersonId = new Map(
    payload.occasions
      .filter((occasion) => occasion.isPrimary)
      .map((occasion) => [occasion.personId, occasion]),
  );

  const latestDeliveryByPersonId = new Map<ID, Delivery>();
  for (const delivery of deliveries) {
    if (!delivery.personId) continue;
    const current = latestDeliveryByPersonId.get(delivery.personId);
    if (!current || current.sentAtISO < delivery.sentAtISO) {
      latestDeliveryByPersonId.set(delivery.personId, delivery);
    }
  }

  const accounts = payload.people.map((person) => {
    const relationship = relationshipById.get(person.relationshipId);
    const culture = cultureById.get(person.cultureId);
    const latestDelivery = latestDeliveryByPersonId.get(person.id) ?? null;
    const nextOccasion = primaryOccasionByPersonId.get(person.id) ?? null;
    return buildAccount(person, relationship?.label ?? "Contact", relationship?.group ?? "Friends", {
      cultureLabel: culture?.label ?? null,
      latestDelivery,
      nextOccasion,
    });
  });

  const contacts = payload.people.map((person) => {
    const culture = cultureById.get(person.cultureId);
    return {
      id: person.id,
      accountId: accountIdForPerson(person.id),
      displayName: person.name,
      segment: contactSegment(person),
      organization: person.organization ?? null,
      roleTitle: person.roleTitle ?? null,
      sourceContext: person.sourceContext ?? null,
      cultureLabel: culture?.label ?? null,
      contextLines: [
        person.organization,
        person.roleTitle,
        person.sourceContext,
        ...person.identityTags,
        ...person.knownFacts.map((fact) => fact.text),
      ].filter((line): line is string => Boolean(line)).slice(0, 4),
    } satisfies RemasterDashboardContact;
  });

  const upcomingActivities = payload.occasions
    .filter((occasion) => occasion.daysUntil >= 0)
    .sort((left, right) => left.daysUntil - right.daysUntil)
    .map((occasion) => {
      const person = personById.get(occasion.personId);
      return buildOccasionActivity(occasion.id, occasion.kind, occasion.label, occasion.dateISO, occasion.daysUntil, {
        accountId: accountIdForPerson(occasion.personId),
        contactId: occasion.personId,
        subjectName: person?.name ?? "Contact",
        detail: occasion.detail ?? null,
      });
    });

  const recentActivities = deliveries
    .filter((delivery) => !delivery.personId || personById.has(delivery.personId))
    .slice()
    .sort((left, right) => right.sentAtISO.localeCompare(left.sentAtISO))
    .map((delivery) => {
      const person = delivery.personId ? personById.get(delivery.personId) : null;
      return buildDeliveryActivity(delivery, person?.name ?? delivery.recipientName);
    });

  return {
    accounts,
    contacts,
    upcomingActivities,
    recentActivities,
    stats: {
      accountsCount: accounts.length,
      contactsCount: contacts.length,
      upcomingActivitiesCount: upcomingActivities.filter((activity) => {
        const days = activity.daysUntil;
        return days !== null && days >= 0 && days <= 30;
      }).length,
    },
  };
}

function buildAccount(
  person: Person,
  relationshipLabel: string,
  relationshipGroup: RelationshipGroup,
  options: {
    cultureLabel: string | null;
    latestDelivery: Delivery | null;
    nextOccasion: OccasionNode | null;
  },
): RemasterDashboardAccount {
  const segment = contactSegment(person);
  const lastTouchLabel = buildLastTouchLabel(person, options.latestDelivery);
  const nextFollowUpLabel = buildNextFollowUpLabel(person, options.nextOccasion, options.latestDelivery);
  return {
    id: accountIdForPerson(person.id),
    primaryContactId: person.id,
    name: person.name,
    mode: "contact-led",
    relationshipType: relationshipTypeByGroup[relationshipGroup],
    segment,
    relationshipLabel,
    organization: person.organization ?? null,
    roleTitle: person.roleTitle ?? null,
    sourceContext: person.sourceContext ?? null,
    starred: person.starred,
    avatarBg: person.avatarBg,
    avatarFg: person.avatarFg,
    contextLabel: person.since ?? person.sourceContext ?? person.identityTags[0] ?? "contact-led account",
    secondaryLabel: person.organization ?? person.identityTags[0] ?? options.cultureLabel ?? "Contact",
    nextActivityId: person.nextOccasionId,
    lastDeliveryStatus: options.latestDelivery?.status ?? null,
    lastDeliveryAtISO: options.latestDelivery?.sentAtISO ?? null,
    lastTouchLabel,
    nextFollowUpLabel,
    touchpointSummary: buildTouchpointSummary(segment, nextFollowUpLabel, lastTouchLabel, person.sourceContext),
  };
}

function buildOccasionActivity(
  id: ID,
  kind: OccasionKind,
  label: string,
  dateISO: string,
  daysUntil: number,
  options: {
    accountId: ID;
    contactId: ID;
    subjectName: string;
    detail: string | null;
  },
): RemasterDashboardActivity {
  return {
    id,
    accountId: options.accountId,
    contactId: options.contactId,
    type: kind === "check-in" ? "follow_up_due" : "milestone",
    status: daysUntil >= 0 ? "upcoming" : "completed",
    title: label,
    subtitle: `${options.subjectName}${options.detail ? ` · ${options.detail}` : ""}`,
    dateISO,
    daysUntil,
    occasionKind: kind,
    deliveryStatus: null,
    touchpointLabel: kind === "check-in" ? "Needs follow-up" : "Upcoming milestone",
    touchpointSummary: `${options.subjectName} · ${label} · ${daysUntilText(daysUntil)}`,
  };
}

function buildDeliveryActivity(
  delivery: Delivery,
  subjectName: string,
): RemasterDashboardActivity {
  return {
    id: `activity-${delivery.id}`,
    accountId: delivery.personId ? accountIdForPerson(delivery.personId) : `account-external-${delivery.id}`,
    contactId: delivery.personId ?? null,
    type: "outbound_delivery",
    status: delivery.status === "failed" ? "failed" : "completed",
    title: delivery.occasionLabel,
    subtitle: `${subjectName} · ${delivery.channel}`,
    dateISO: delivery.sentAtISO,
    daysUntil: null,
    occasionKind: delivery.occasionKind,
    deliveryStatus: delivery.status,
    touchpointLabel: "Recent outreach",
    touchpointSummary: `${subjectName} · ${delivery.channel} · ${deliveryStatusLabel(delivery.status)}`,
  };
}

function accountIdForPerson(personId: ID): ID {
  return `account-${personId}`;
}

function contactSegment(person: Person): ContactSegment {
  return person.segment ?? "personal";
}

function buildLastTouchLabel(person: Person, latestDelivery: Delivery | null): string {
  const manualTouchDate = person.lastContactAt?.slice(0, 10) ?? null;
  if (manualTouchDate && (!latestDelivery || manualTouchDate >= latestDelivery.sentAtISO.slice(0, 10))) {
    return manualLastTouchLabel(manualTouchDate, person.lastTouchpointType);
  }

  if (latestDelivery) {
    return `Last touch · ${deliveryStatusLabel(latestDelivery.status)} · ${latestDelivery.sentAtISO.slice(0, 10)}`;
  }
  if (manualTouchDate) {
    return manualLastTouchLabel(manualTouchDate, person.lastTouchpointType);
  }
  return "Last touch · No outreach yet";
}

function buildNextFollowUpLabel(
  person: Person,
  nextOccasion: OccasionNode | null,
  latestDelivery: Delivery | null,
): string {
  if (person.nextFollowUpAt) {
    return `Next follow-up · ${person.nextFollowUpAt}`;
  }
  if (nextOccasion) {
    return `Next follow-up · ${nextOccasion.label} · ${daysUntilText(nextOccasion.daysUntil)}`;
  }
  if (latestDelivery) {
    return "Next follow-up · Review after recent outreach";
  }
  return "Next follow-up · Not scheduled";
}

function buildTouchpointSummary(
  segment: ContactSegment,
  nextFollowUpLabel: string,
  lastTouchLabel: string,
  sourceContext: string | null,
): string {
  const context = sourceContext ? ` · ${sourceContext}` : "";
  return `${segmentLabel(segment)} touchpoints · ${nextFollowUpLabel} · ${lastTouchLabel}${context}`;
}

function manualLastTouchLabel(dateISO: string, touchType?: ContactTouchpointType): string {
  return touchType
    ? `Last touch · ${touchpointTypeLabel(touchType)} · ${dateISO}`
    : `Last touch · ${dateISO}`;
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

function segmentLabel(segment: ContactSegment): string {
  switch (segment) {
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

function deliveryStatusLabel(status: DeliveryStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "sending":
      return "Sending";
    case "sent":
      return "Sent";
    case "delivered":
      return "Delivered";
    case "opened":
      return "Opened";
    case "failed":
      return "Failed";
  }
}

function daysUntilText(daysUntil: number): string {
  if (daysUntil < 0) return `${Math.abs(daysUntil)} days ago`;
  if (daysUntil === 0) return "today";
  if (daysUntil === 1) return "tomorrow";
  return `in ${daysUntil} days`;
}
