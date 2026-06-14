// In-memory mock store, typed against domain types.
// Will be replaced by Postgres queries; the shape stays.

import type {
  CultureRule,
  Delivery,
  OccasionNode,
  PeoplePayload,
  Person,
  Relationship,
} from "./domain";

export const relationships: Relationship[] = [
  { id: "rel-partner", kind: "partner", group: "Partner", label: "Partner", paletteBg: "#FBE7EE", paletteFg: "#C24E78" },
  { id: "rel-mother", kind: "mother", group: "Family", label: "Mother", paletteBg: "#FDEBD6", paletteFg: "#B5832E" },
  { id: "rel-father", kind: "father", group: "Family", label: "Father", paletteBg: "#FDEBD6", paletteFg: "#B5832E" },
  { id: "rel-close-friend", kind: "close-friend", group: "Friends", label: "Close friend", paletteBg: "#E2EEF9", paletteFg: "#4E80B5" },
  { id: "rel-friend", kind: "friend", group: "Friends", label: "Friend", paletteBg: "#E2EEF9", paletteFg: "#4E80B5" },
];

export const cultures: CultureRule[] = [
  {
    id: "chinese",
    label: "Chinese",
    dotColor: "#E0A92E",
    festivals: ["lunar-new-year", "qingming"],
    palette: ["#C23A42", "#E8746B", "#E0A92E"],
    greetings: ["Gong Xi Fa Cai", "Happy Lunar New Year"],
    taboos: ["Avoid black for celebrations (associated with mourning)"],
  },
  {
    id: "malay-muslim",
    label: "Malay · Muslim",
    dotColor: "#3F9E78",
    festivals: ["hari-raya"],
    palette: ["#3F9E78", "#E3F2EC", "#F6C99A"],
    greetings: ["Selamat Hari Raya", "Selamat Hari Raya, maaf zahir dan batin"],
    taboos: ["No Christmas greetings", "Keep gifts halal"],
  },
  {
    id: "indian-hindu",
    label: "Indian · Hindu",
    dotColor: "#E08A2E",
    festivals: ["deepavali"],
    palette: ["#E08A2E", "#C25A1E", "#FCE9DE"],
    greetings: ["Happy Deepavali", "Vanakkam"],
    taboos: [],
  },
  {
    id: "none",
    label: "No date set",
    dotColor: "#888888",
    festivals: [],
    palette: [],
    greetings: [],
    taboos: [],
  },
];

export const occasions: OccasionNode[] = [
  { id: "occ-lin-anniv", personId: "p-lin", kind: "anniversary", label: "Anniversary", detail: "12 years today", dateISO: "2026-06-26", daysUntil: 12, isPrimary: true },
  { id: "occ-lin-bday", personId: "p-lin", kind: "birthday", label: "Birthday", detail: "August 2", dateISO: "2026-08-02", daysUntil: 120, isPrimary: false },
  { id: "occ-mom-bday", personId: "p-mom", kind: "birthday", label: "Birthday", detail: "turning 62", dateISO: "2026-06-19", daysUntil: 5, isPrimary: true },
  { id: "occ-mom-lny", personId: "p-mom", kind: "lunar-new-year", label: "Lunar New Year", detail: "reunion dinner", dateISO: "2027-02-06", daysUntil: 38, isPrimary: false },
  { id: "occ-aisha-raya", personId: "p-aisha", kind: "hari-raya", label: "Hari Raya Aidilfitri", detail: "the day that matters most to her", dateISO: "2026-07-02", daysUntil: 18, isPrimary: true },
  { id: "occ-aisha-bday", personId: "p-aisha", kind: "birthday", label: "Birthday", detail: "March 14", dateISO: "2027-03-14", daysUntil: 273, isPrimary: false },
  { id: "occ-dad-bday", personId: "p-dad", kind: "birthday", label: "Birthday", detail: "December", dateISO: "2026-12-10", daysUntil: 120, isPrimary: true },
];

export const people: Person[] = [
  {
    id: "p-lin", name: "Lin", starred: true,
    avatarBg: "#DCEAF7", avatarFg: "#5286B8",
    relationshipId: "rel-partner", cultureId: "chinese",
    since: "together 12 years",
    identityTags: ["met at university"],
    knownFacts: [
      { text: "Loves quiet mornings and bad puns.", isLead: true },
      { text: "Stressed about a work deadline this month." },
      { text: "Always picks the window seat." },
    ],
    personalTaboos: [],
    nextOccasionId: "occ-lin-anniv",
  },
  {
    id: "p-mom", name: "Mom", starred: true,
    avatarBg: "#FCE2D6", avatarFg: "#C57A52",
    relationshipId: "rel-mother", cultureId: "chinese",
    since: "Mom",
    identityTags: ["just moved house"],
    knownFacts: [
      { text: "Just moved into a new home.", isLead: true },
      { text: "Her knees have been bothering her." },
      { text: "Loves gardening — finally has a south-facing balcony." },
    ],
    personalTaboos: [],
    nextOccasionId: "occ-mom-bday",
  },
  {
    id: "p-aisha", name: "Aisha", starred: false,
    avatarBg: "#E3DCF2", avatarFg: "#7E6BB5",
    relationshipId: "rel-close-friend", cultureId: "malay-muslim",
    since: "since 2019",
    identityTags: ["university friend"],
    knownFacts: [
      { text: "Loves homemade kuih.", isLead: true },
      { text: "Just got a new job in KL." },
      { text: "Her mother isn't well — she's been flying back to Penang on weekends." },
    ],
    personalTaboos: [
      "A warm \"Selamat Hari Raya\" lands far better than a generic note.",
    ],
    nextOccasionId: "occ-aisha-raya",
  },
  {
    id: "p-dad", name: "Dad", starred: false,
    avatarBg: "#DCF0E8", avatarFg: "#4E9B7E",
    relationshipId: "rel-father", cultureId: "chinese",
    since: "Dad",
    identityTags: [],
    knownFacts: [
      { text: "Keen gardener and angler.", isLead: true },
      { text: "Retired last year, still adjusting to the quiet." },
    ],
    personalTaboos: [],
    nextOccasionId: "occ-dad-bday",
  },
  {
    id: "p-kira", name: "Kira", starred: false,
    avatarBg: "#F7E2EC", avatarFg: "#B96089",
    relationshipId: "rel-friend", cultureId: "none",
    since: "old friend",
    identityTags: ["drifted a little"],
    knownFacts: [
      { text: "Haven't spoken in 2 months.", isLead: true },
      { text: "Was going through a job change last you heard." },
    ],
    personalTaboos: [],
    nextOccasionId: null,
    lastContactAt: "2026-04-14",
  },
];

export const deliveries: Delivery[] = [
  { id: "d-1", personId: "p-other-ahma", recipientName: "Ah Ma", occasionKind: "lunar-new-year", occasionLabel: "Lunar New Year", channel: "post", sentAtISO: "2026-03-02", status: "delivered" },
  { id: "d-2", personId: "p-lin", recipientName: "Lin", occasionKind: "custom", occasionLabel: "Valentine's note", channel: "email", sentAtISO: "2026-02-14", status: "opened" },
  { id: "d-3", personId: "p-other-jun", recipientName: "Jun", occasionKind: "birthday", occasionLabel: "Birthday", channel: "email", sentAtISO: "2026-01-20", status: "opened" },
  { id: "d-4", personId: "p-other-priya", recipientName: "Priya", occasionKind: "deepavali", occasionLabel: "Deepavali", channel: "post", sentAtISO: "2026-01-08", status: "delivered" },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (pure)
// ─────────────────────────────────────────────────────────────────────────────

export function findPerson(id: string): Person | undefined {
  return people.find((p) => p.id === id);
}
export function findRelationship(id: string): Relationship | undefined {
  return relationships.find((r) => r.id === id);
}
export function findCulture(id: string): CultureRule | undefined {
  return cultures.find((c) => c.id === id);
}
export function findOccasion(id: string | null): OccasionNode | undefined {
  if (!id) return undefined;
  return occasions.find((o) => o.id === id);
}
export function occasionsFor(personId: string): OccasionNode[] {
  return occasions.filter((o) => o.personId === personId);
}

export function peoplePayload(): PeoplePayload {
  return { people, relationships, cultures, occasions };
}
