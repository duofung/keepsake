import type {
  Delivery,
  DeliveryStatus,
  ID,
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
  relationshipLabel: string;
  starred: boolean;
  avatarBg: string;
  avatarFg: string;
  contextLabel: string;
  secondaryLabel: string;
  nextActivityId: ID | null;
  lastDeliveryStatus: DeliveryStatus | null;
  lastDeliveryAtISO: string | null;
}

export interface RemasterDashboardContact {
  id: ID;
  accountId: ID;
  displayName: string;
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
    return buildAccount(person, relationship?.label ?? "Contact", relationship?.group ?? "Friends", {
      cultureLabel: culture?.label ?? null,
      latestDelivery,
    });
  });

  const contacts = payload.people.map((person) => {
    const culture = cultureById.get(person.cultureId);
    return {
      id: person.id,
      accountId: accountIdForPerson(person.id),
      displayName: person.name,
      cultureLabel: culture?.label ?? null,
      contextLines: [
        ...person.identityTags,
        ...person.knownFacts.map((fact) => fact.text),
      ].filter(Boolean).slice(0, 4),
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
  },
): RemasterDashboardAccount {
  return {
    id: accountIdForPerson(person.id),
    primaryContactId: person.id,
    name: person.name,
    mode: "contact-led",
    relationshipType: relationshipTypeByGroup[relationshipGroup],
    relationshipLabel,
    starred: person.starred,
    avatarBg: person.avatarBg,
    avatarFg: person.avatarFg,
    contextLabel: person.since ?? person.identityTags[0] ?? "contact-led account",
    secondaryLabel: person.identityTags[0] ?? options.cultureLabel ?? "Contact",
    nextActivityId: person.nextOccasionId,
    lastDeliveryStatus: options.latestDelivery?.status ?? null,
    lastDeliveryAtISO: options.latestDelivery?.sentAtISO ?? null,
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
  };
}

function accountIdForPerson(personId: ID): ID {
  return `account-${personId}`;
}
