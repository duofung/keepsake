"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icon";
import Avatar from "@/components/Avatar";
import PersonDrawer from "@/components/PersonDrawer";
import type { FormEvent } from "react";
import type { CultureId, Person, PeoplePayload, RelationshipGroup } from "@/lib/domain";
import { nodeChipText, occasionIcon, urgencyLevel } from "@/lib/presentation";

const groupIcon: Record<RelationshipGroup, string> = {
  Partner: "i-heart",
  Family: "i-users",
  Friends: "i-heart-handshake",
  Colleagues: "i-users",
};

const TAB_ORDER: ("All" | RelationshipGroup)[] = [
  "All", "Partner", "Family", "Friends", "Colleagues",
];

const metaColor: Record<string, string> = {
  soon: "var(--blue-deep)",
  mid: "var(--gray-1)",
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
  payload: PeoplePayload;
};

export default function PeopleClient({ payload }: Props) {
  const { relationships, cultures, occasions } = payload;
  const [people, setPeople] = useState<Person[]>(() => payload.people);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<"All" | RelationshipGroup>("All");
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

  const occasionById = useMemo(
    () => new Map(occasions.map((o) => [o.id, o])),
    [occasions],
  );

  const grouped = useMemo(() => {
    const out: Record<RelationshipGroup, typeof people> = {
      Partner: [], Family: [], Friends: [], Colleagues: [],
    };
    for (const p of people) {
      const rel = relationshipById.get(p.relationshipId);
      if (rel) out[rel.group].push(p);
    }
    return out;
  }, [people, relationshipById]);

  const tabs = useMemo(
    () => TAB_ORDER.map((id) => ({
      id,
      n: id === "All" ? people.length : grouped[id].length,
    })),
    [grouped, people.length],
  );

  const visibleEntries = useMemo(() => {
    const all = (["Partner", "Family", "Friends", "Colleagues"] as RelationshipGroup[])
      .map((g) => [g, grouped[g]] as const)
      .filter(([, list]) => list.length > 0);
    return tab === "All" ? all : all.filter(([g]) => g === tab);
  }, [grouped, tab]);

  const drawerPerson = openId ? people.find((p) => p.id === openId) ?? null : null;
  const drawerRel = drawerPerson ? relationshipById.get(drawerPerson.relationshipId) ?? null : null;
  const drawerCulture = drawerPerson ? cultureById.get(drawerPerson.cultureId) ?? null : null;
  const drawerOccasions = drawerPerson
    ? occasions.filter((o) => o.personId === drawerPerson.id)
    : [];

  const defaultRelationshipId = relationships.find((r) => r.id === "rel-friend")?.id
    ?? relationships[0]?.id
    ?? "";
  const defaultCultureId = cultures.find((c) => c.id === "none")?.id
    ?? cultures[0]?.id
    ?? "none";

  function handleAddPerson(input: AddPersonInput) {
    const relationship = relationshipById.get(input.relationshipId) ?? relationships[0];
    const culture = cultureById.get(input.cultureId) ?? cultures.find((c) => c.id === "none") ?? cultures[0];
    if (!relationship || !culture) return;

    const palette = avatarPalette[people.length % avatarPalette.length];
    const note = input.note.trim();
    const since = input.since.trim();
    const person: Person = {
      id: makeLocalPersonId(),
      name: input.name.trim(),
      starred: input.starred,
      avatarBg: palette.bg,
      avatarFg: palette.fg,
      relationshipId: relationship.id,
      cultureId: culture.id,
      since: since || undefined,
      identityTags: since ? [since] : [],
      knownFacts: note
        ? [{ text: note, isLead: true }]
        : [{ text: "New relationship to learn about.", isLead: true }],
      personalTaboos: [],
      nextOccasionId: null,
      lastContactAt: new Date().toISOString().slice(0, 10),
    };

    const nextLocal = [person, ...readLocalPeople().filter((localPerson) => localPerson.id !== person.id)];
    saveLocalPeople(nextLocal);
    setPeople((current) => [person, ...current.filter((p) => p.id !== person.id)]);
    setTab("All");
    setAdding(false);
    setOpenId(person.id);
  }

  return (
    <div className="ks-page ks-page--stack">
      <div className="ks-page-inner ks-page-inner--people" style={{ paddingBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--ink-2)" }}>People</h1>
            <p style={{ fontSize: 12.5, color: "var(--gray-2)", marginTop: 5 }}>
              {people.length} {people.length === 1 ? "relationship" : "relationships"} · the people you keep close
            </p>
          </div>
          <button
            data-testid="add-person-button"
            onClick={() => setAdding(true)}
            style={{
            padding: "10px 17px", fontSize: 13, fontWeight: 500, borderRadius: 13,
            display: "flex", alignItems: "center", gap: 6,
            background: "var(--blue)", color: "#fff", border: "none", cursor: "pointer",
          }}
          >
            <Icon name="i-plus" /> Add someone
          </button>
        </div>
      </div>

      <div className="ks-page-inner ks-page-inner--people" style={{ paddingTop: 0, paddingBottom: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              fontSize: 13, padding: "7px 14px", borderRadius: 13,
              color: tab === t.id ? "var(--blue-deep)" : "var(--gray-1)",
              background: tab === t.id ? "var(--blue-wash)" : "transparent",
              fontWeight: tab === t.id ? 500 : 400,
              display: "flex", alignItems: "center", gap: 6,
              border: "none", cursor: "pointer",
            }}
          >
            {t.id} <span style={{ fontSize: 11, color: tab === t.id ? "var(--blue)" : "var(--gray-3)" }}>{t.n}</span>
          </button>
        ))}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <div className="ks-page-inner ks-page-inner--people" style={{ paddingTop: 14 }}>
        {visibleEntries.map(([g, list]) => (
          <div key={g} style={{ marginBottom: 24 }}>
            <div style={{
              fontSize: 11.5, fontWeight: 600, color: "var(--gray-2)",
              letterSpacing: "0.04em", marginBottom: 12,
              display: "flex", alignItems: "center", gap: 7,
            }}>
              <span style={{ fontSize: 14, color: "var(--gray-3)" }}>
                <Icon name={groupIcon[g]} />
              </span>
              {g.toUpperCase()}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 340px))", gap: 12 }}>
              {list.map((p) => {
                const rel = relationshipById.get(p.relationshipId);
                const culture = cultureById.get(p.cultureId);
                const occ = p.nextOccasionId ? occasionById.get(p.nextOccasionId) : undefined;
                const days = occ?.daysUntil ?? -60;
                const text = nodeChipText(occ?.label ?? "Last note", days);
                const lvl = urgencyLevel(days);
                const occIcon = occ ? occasionIcon[occ.kind] : "i-bulb";
                if (!rel || !culture) return null;
                return (
                  <div
                    key={p.id}
                    onClick={() => setOpenId(p.id)}
                    style={{
                      background: "#fff", border: "0.5px solid var(--line)", borderRadius: 14,
                      padding: 15, transition: ".18s", cursor: "pointer", display: "flex", gap: 13,
                    }}
                  >
                    <Avatar name={p.name} bg={p.avatarBg} fg={p.avatarFg} size={44} fontSize={16} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", display: "flex", alignItems: "center", gap: 5, marginBottom: 3 }}>
                        {p.name}
                        {p.starred && (
                          <span style={{ color: "var(--amber)", fontSize: 12 }}>
                            <Icon name="i-star" fill />
                          </span>
                        )}
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 9 }}>
                        <span style={{
                          fontSize: 10.5, padding: "2px 8px", borderRadius: 8, fontWeight: 500,
                          background: rel.paletteBg, color: rel.paletteFg,
                        }}>{rel.label}</span>
                        <span style={{
                          fontSize: 10.5, padding: "2px 8px", borderRadius: 8,
                          background: "var(--soft)", color: "var(--gray-1)",
                          display: "flex", alignItems: "center", gap: 3,
                        }}>
                          <span style={{ width: 5, height: 5, borderRadius: "50%", background: culture.dotColor }} />
                          {culture.label}
                        </span>
                      </div>
                      <div style={{
                        fontSize: 11.5, display: "flex", alignItems: "center", gap: 5,
                        color: metaColor[lvl], fontWeight: lvl === "soon" ? 500 : 400,
                      }}>
                        <span style={{ fontSize: 13 }}><Icon name={occIcon} /></span>
                        {text}
                      </div>
                    </div>
                  </div>
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
        relationships={relationships}
        cultures={cultures}
        defaultRelationshipId={defaultRelationshipId}
        defaultCultureId={defaultCultureId}
        onClose={() => setAdding(false)}
        onAdd={handleAddPerson}
      />
    </div>
  );
}

type AddPersonInput = {
  name: string;
  relationshipId: string;
  cultureId: CultureId;
  since: string;
  note: string;
  starred: boolean;
};

type AddPersonDialogProps = {
  open: boolean;
  relationships: PeoplePayload["relationships"];
  cultures: PeoplePayload["cultures"];
  defaultRelationshipId: string;
  defaultCultureId: CultureId;
  onClose: () => void;
  onAdd: (input: AddPersonInput) => void;
};

function AddPersonDialog({
  open,
  relationships,
  cultures,
  defaultRelationshipId,
  defaultCultureId,
  onClose,
  onAdd,
}: AddPersonDialogProps) {
  const [name, setName] = useState("");
  const [relationshipId, setRelationshipId] = useState(defaultRelationshipId);
  const [cultureId, setCultureId] = useState<CultureId>(defaultCultureId);
  const [since, setSince] = useState("");
  const [note, setNote] = useState("");
  const [starred, setStarred] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setRelationshipId(defaultRelationshipId);
    setCultureId(defaultCultureId);
    setSince("");
    setNote("");
    setStarred(false);
    setError(null);
  }, [defaultCultureId, defaultRelationshipId, open]);

  if (!open) return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Add a name first.");
      return;
    }
    onAdd({
      name: trimmedName,
      relationshipId,
      cultureId,
      since,
      note,
      starred,
    });
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
        background: "rgba(20, 33, 45, 0.22)",
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <form
        data-testid="add-person-form"
        onSubmit={submit}
        style={{
          width: 390,
          maxWidth: "calc(100vw - 92px)",
          height: "100%",
          background: "#fff",
          borderLeft: "0.5px solid var(--line)",
          boxShadow: "-18px 0 42px rgba(16, 32, 49, 0.11)",
          padding: "24px 24px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14 }}>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 650, color: "var(--ink)", margin: 0 }}>
              Add someone
            </h2>
            <p style={{ margin: "6px 0 0", color: "var(--gray-2)", fontSize: 13, lineHeight: 1.45 }}>
              Keep the first note simple. You can fill in more after they are on your list.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 34,
              height: 34,
              borderRadius: "50%",
              border: "none",
              background: "var(--soft)",
              color: "var(--gray-2)",
              display: "grid",
              placeItems: "center",
              cursor: "pointer",
              fontSize: 18,
            }}
          >
            <Icon name="i-x" />
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
            placeholder="Helen"
            autoFocus
            style={inputStyle}
          />
        </label>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label style={fieldWrapStyle}>
            <span style={fieldLabelStyle}>Relationship</span>
            <select
              value={relationshipId}
              onChange={(event) => setRelationshipId(event.target.value)}
              style={selectStyle}
            >
              {relationships.map((relationship) => (
                <option key={relationship.id} value={relationship.id}>{relationship.label}</option>
              ))}
            </select>
          </label>

          <label style={fieldWrapStyle}>
            <span style={fieldLabelStyle}>Culture</span>
            <select
              value={cultureId}
              onChange={(event) => setCultureId(event.target.value as CultureId)}
              style={selectStyle}
            >
              {cultures.map((culture) => (
                <option key={culture.id} value={culture.id}>{culture.label}</option>
              ))}
            </select>
          </label>
        </div>

        <label style={fieldWrapStyle}>
          <span style={fieldLabelStyle}>Context</span>
          <input
            value={since}
            onChange={(event) => setSince(event.target.value)}
            placeholder="Colleague from the Malaysia launch"
            style={inputStyle}
          />
        </label>

        <label style={{ ...fieldWrapStyle, flex: 1, minHeight: 0 }}>
          <span style={fieldLabelStyle}>What should I remember?</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="A detail, a preference, a date, or anything that makes future messages more personal."
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
            style={{ width: 16, height: 16, accentColor: "var(--blue)" }}
          />
          Mark as close circle
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
              border: "none",
              background: "var(--soft)",
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
            style={{
              padding: "10px 17px",
              borderRadius: 13,
              border: "none",
              background: "var(--blue)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 6,
              cursor: "pointer",
            }}
          >
            <Icon name="i-plus" /> Add person
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
  background: "#fff",
  color: "var(--ink)",
  fontSize: 14,
  outline: "none",
  padding: "11px 12px",
  boxShadow: "0 1px 0 rgba(16, 31, 45, 0.02)",
} as const;

const selectStyle = {
  ...inputStyle,
  appearance: "none",
} as const;

function makeLocalPersonId() {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function mergePeople(base: Person[], extras: Person[]) {
  const seen = new Set(base.map((person) => person.id));
  return [
    ...extras.filter((person) => {
      if (seen.has(person.id)) return false;
      seen.add(person.id);
      return true;
    }),
    ...base,
  ];
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
