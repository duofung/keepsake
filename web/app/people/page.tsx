"use client";

import { useMemo, useState } from "react";
import Icon from "@/components/Icon";
import Avatar from "@/components/Avatar";
import PersonDrawer from "@/components/PersonDrawer";
import {
  findCulture, findOccasion, findRelationship,
  occasionsFor, people,
} from "@/lib/mock";
import type { RelationshipGroup } from "@/lib/domain";
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

export default function PeoplePage() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<"All" | RelationshipGroup>("All");

  const grouped = useMemo(() => {
    const out: Record<RelationshipGroup, typeof people> = {
      Partner: [], Family: [], Friends: [], Colleagues: [],
    };
    for (const p of people) {
      const rel = findRelationship(p.relationshipId);
      if (rel) out[rel.group].push(p);
    }
    return out;
  }, []);

  const tabs = useMemo(
    () => TAB_ORDER.map((id) => ({
      id,
      n: id === "All" ? people.length : grouped[id].length,
    })),
    [grouped],
  );

  const visibleEntries = useMemo(() => {
    const all = (["Partner", "Family", "Friends", "Colleagues"] as RelationshipGroup[])
      .map((g) => [g, grouped[g]] as const)
      .filter(([, list]) => list.length > 0);
    return tab === "All" ? all : all.filter(([g]) => g === tab);
  }, [grouped, tab]);

  const drawerPerson = openId ? people.find((p) => p.id === openId) ?? null : null;
  const drawerRel = drawerPerson ? findRelationship(drawerPerson.relationshipId) ?? null : null;
  const drawerCulture = drawerPerson ? findCulture(drawerPerson.cultureId) ?? null : null;
  const drawerOccasions = drawerPerson ? occasionsFor(drawerPerson.id) : [];

  return (
    <>
      <div style={{ padding: "24px 30px 14px", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--ink-2)" }}>People</h1>
          <p style={{ fontSize: 12.5, color: "var(--gray-2)", marginTop: 5 }}>
            {people.length} {people.length === 1 ? "relationship" : "relationships"} · the people you keep close
          </p>
        </div>
        <button style={{
          padding: "10px 17px", fontSize: 13, fontWeight: 500, borderRadius: 13,
          display: "flex", alignItems: "center", gap: 6,
          background: "var(--blue)", color: "#fff", border: "none", cursor: "pointer",
        }}>
          <Icon name="i-plus" /> Add someone
        </button>
      </div>

      <div style={{ padding: "0 30px", display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
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

      <div style={{ flex: 1, overflowY: "auto", padding: "14px 30px 26px" }}>
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
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12 }}>
              {list.map((p) => {
                const rel = findRelationship(p.relationshipId);
                const culture = findCulture(p.cultureId);
                const occ = findOccasion(p.nextOccasionId);
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

      <PersonDrawer
        person={drawerPerson}
        relationship={drawerRel}
        culture={drawerCulture}
        occasions={drawerOccasions}
        onClose={() => setOpenId(null)}
      />
    </>
  );
}

