import Image from "next/image";
import Link from "next/link";
import type { CSSProperties } from "react";
import Icon from "@/components/Icon";
import Avatar from "@/components/Avatar";
import { requireSessionUserOrRedirect } from "@/lib/server/auth/require-session.server";
import { getPeoplePayload } from "@/lib/server/people-payload/index.server";
import { nodeChipText, occasionIcon, urgencyLevel } from "@/lib/presentation";

const SOON_WINDOW_DAYS = 30;

export const dynamic = "force-dynamic";

const metaColor: Record<string, string> = {
  soon: "var(--heartline-purple-deep)",
  mid: "var(--heartline-sage)",
  far: "var(--gray-3)",
};

export default async function HomePage() {
  // The auth guard must complete BEFORE we hit the people payload — in
  // KEEPSAKE_DATA_SOURCE=db mode, getPeoplePayload() reaches into
  // currentUserIdOrThrow() inside its own transaction, and a concurrent
  // Promise.all would race a `redirect()` against a 500 unauthenticated
  // throw. The redirect must always win.
  const user = await requireSessionUserOrRedirect("/");
  const { people, relationships, cultures, occasions } = await getPeoplePayload();

  const occasionById = (id: string | null | undefined) =>
    id ? occasions.find((o) => o.id === id) : undefined;
  const relationshipById = new Map(relationships.map((relationship) => [relationship.id, relationship]));
  const cultureById = new Map(cultures.map((culture) => [culture.id, culture]));
  const personById = new Map(people.map((person) => [person.id, person]));

  const peopleCount = people.length;
  const datesComingUp = occasions.filter(
    (o) => o.daysUntil >= 0 && o.daysUntil <= SOON_WINDOW_DAYS,
  ).length;
  const focusPerson = people.find((p) => p.id === "p-lin") ?? people[0] ?? null;
  const focusOccasion = focusPerson ? occasionById(focusPerson.nextOccasionId) : undefined;
  const upcoming = occasions
    .filter((o) => o.daysUntil >= 0 && o.daysUntil <= SOON_WINDOW_DAYS)
    .sort((a, b) => a.daysUntil - b.daysUntil)
    .slice(0, 3);

  return (
    <div className="ks-page">
      <div className="ks-page-inner" style={{ width: "min(100%, 1180px)" }}>
        <div style={headerRow}>
          <div>
            <p style={eyebrow}>Heartline home</p>
            <h1 style={pageTitle}>
              Good evening, {user.name}
            </h1>
            <p style={pageSubcopy}>
              Nurture every connection with meaningful notes for {peopleCount} {peopleCount === 1 ? "person" : "people"}.
              {" "}{datesComingUp} {datesComingUp === 1 ? "moment" : "moments"} could use your care soon.
            </p>
          </div>
          <Link href="/people" className="heartline-button" style={{ whiteSpace: "nowrap" }}>
            <Icon name="i-plus" /> Add someone
          </Link>
        </div>

        <div style={homeGrid}>
          <section className="heartline-card" style={heroCard}>
            <div style={heroCopy}>
              <span className="heartline-pill">
                <Icon name="i-heart" />
                {focusOccasion ? timingText(focusOccasion.daysUntil) : "Relationship focus"}
              </span>
              <h2 style={heroTitle}>
                {focusPerson && focusOccasion
                  ? `${focusOccasion.label} with ${focusPerson.name}`
                  : "Start with someone close"}
              </h2>
              <p style={heroBody}>
                Heartline helps you turn dates, memories, and small details into thoughtful messages
                that keep meaningful relationships warm.
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: "auto" }}>
                <Link href={`/workspace?person=${focusPerson?.id ?? ""}`} className="heartline-button">
                  <Icon name="i-edit" /> Write it with me
                </Link>
                <Link href="/people" className="heartline-button heartline-button--soft">
                  <Icon name="i-users" /> Review circle
                </Link>
              </div>
            </div>
            <div style={heroImageWrap}>
              <Image
                src="/images/heartline-hero.png"
                alt="A warm tabletop with cards, photos, flowers, and a reminder calendar"
                fill
                priority
                sizes="(min-width: 1000px) 520px, 100vw"
                style={{ objectFit: "cover" }}
              />
            </div>
          </section>

          <aside style={{ display: "grid", gap: 14 }}>
            <section className="heartline-card" style={sideCard}>
              <p className="heartline-section-label">UPCOMING MOMENTS</p>
              <div style={{ display: "grid", gap: 10 }}>
                {upcoming.map((occasion) => {
                  const person = personById.get(occasion.personId);
                  return (
                    <Link
                      key={occasion.id}
                      href={`/workspace?person=${occasion.personId}`}
                      style={momentRow}
                    >
                      <span style={momentIcon}>
                        <Icon name={occasionIcon[occasion.kind]} />
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={momentTitle}>{person?.name ?? "Someone close"}</span>
                        <span style={momentMeta}>{occasion.label} · {timingText(occasion.daysUntil)}</span>
                      </span>
                      <span style={momentArrow}><Icon name="i-chev" /></span>
                    </Link>
                  );
                })}
              </div>
            </section>

            <section className="heartline-card" style={quoteCard}>
              <span style={quoteMark}>“</span>
              <p style={quoteText}>
                Small remembered details become the quiet architecture of meaningful relationships.
              </p>
              <p style={quoteMeta}>Heartline relationship practice</p>
            </section>
          </aside>
        </div>

        <div style={{ marginTop: 28 }}>
          <p className="heartline-section-label">PEOPLE YOU'RE NURTURING</p>
          <div style={peopleGrid}>
            {people.map((p) => {
              const rel = relationshipById.get(p.relationshipId);
              const culture = cultureById.get(p.cultureId);
              const occ = occasionById(p.nextOccasionId);
              const days = occ?.daysUntil ?? -60;
              const label = occ?.label ?? "Last note";
              const text = nodeChipText(label, days);
              const lvl = urgencyLevel(days);
              return (
                <Link key={p.id} href={`/workspace?person=${p.id}`} style={personCard}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Avatar name={p.name} bg={p.avatarBg} fg={p.avatarFg} size={44} fontSize={16} />
                    <div style={{ minWidth: 0 }}>
                      <div style={personName}>
                        {p.name}
                        {p.starred && (
                          <span style={{ color: "var(--amber)", fontSize: 12, display: "inline-flex" }}>
                            <Icon name="i-star" fill />
                          </span>
                        )}
                      </div>
                      <div style={personTags}>
                        {rel && <span style={{ ...miniTag, background: rel.paletteBg, color: rel.paletteFg }}>{rel.label}</span>}
                        <span style={miniTagMuted}>{p.identityTags[0] ?? culture?.label ?? "Relationship"}</span>
                      </div>
                    </div>
                  </div>
                  <div style={nextNode}>
                    <span style={{ color: metaColor[lvl], fontSize: 14 }}>
                      <Icon name={occ ? occasionIcon[occ.kind] : "i-bulb"} />
                    </span>
                    <span style={{ color: metaColor[lvl] }}>{text}</span>
                  </div>
                  <div style={quickActions}>
                    <span>Draft note</span>
                    <span>Remember detail</span>
                  </div>
                </Link>
              );
            })}
            <Link href="/people" style={addCard}>
              <span style={{ fontSize: 22 }}><Icon name="i-plus" /></span>
              <span style={{ fontWeight: 650 }}>See all people</span>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function timingText(daysUntil: number): string {
  if (daysUntil === 0) return "Today";
  if (daysUntil === 1) return "Tomorrow";
  return `In ${daysUntil} days`;
}

const headerRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 24,
  marginBottom: 24,
};

const eyebrow: CSSProperties = {
  color: "var(--heartline-rose-strong)",
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: "0.09em",
  margin: "0 0 8px",
  textTransform: "uppercase",
};

const pageTitle: CSSProperties = {
  fontSize: 30,
  fontWeight: 700,
  color: "var(--ink-2)",
  letterSpacing: "0",
  margin: 0,
};

const pageSubcopy: CSSProperties = {
  fontSize: 13.5,
  color: "var(--gray-1)",
  lineHeight: 1.65,
  margin: "8px 0 0",
  maxWidth: 620,
};

const homeGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1.55fr) minmax(290px, 0.82fr)",
  gap: 16,
  alignItems: "stretch",
};

const heroCard: CSSProperties = {
  borderRadius: 24,
  display: "grid",
  gridTemplateColumns: "minmax(300px, 0.92fr) minmax(330px, 1fr)",
  gap: 18,
  overflow: "hidden",
  padding: 18,
  minHeight: 380,
};

const heroCopy: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  padding: "14px 6px 14px 14px",
};

const heroTitle: CSSProperties = {
  color: "var(--ink-2)",
  fontSize: 32,
  fontWeight: 700,
  letterSpacing: "0",
  lineHeight: 1.12,
  margin: "18px 0 10px",
};

const heroBody: CSSProperties = {
  color: "var(--gray-1)",
  fontSize: 14,
  lineHeight: 1.7,
  margin: "0 0 22px",
  maxWidth: 390,
};

const heroImageWrap: CSSProperties = {
  position: "relative",
  minHeight: 338,
  borderRadius: 20,
  overflow: "hidden",
  border: "0.5px solid rgba(239, 224, 218, 0.74)",
  background: "#F9EDE8",
};

const sideCard: CSSProperties = {
  borderRadius: 22,
  padding: 18,
};

const momentRow: CSSProperties = {
  alignItems: "center",
  background: "rgba(255, 248, 245, 0.78)",
  border: "0.5px solid rgba(239, 224, 218, 0.85)",
  borderRadius: 16,
  color: "inherit",
  display: "flex",
  gap: 10,
  padding: 12,
  textDecoration: "none",
};

const momentIcon: CSSProperties = {
  alignItems: "center",
  background: "var(--heartline-rose-wash)",
  borderRadius: 13,
  color: "var(--heartline-purple-deep)",
  display: "flex",
  flexShrink: 0,
  fontSize: 16,
  height: 38,
  justifyContent: "center",
  width: 38,
};

const momentTitle: CSSProperties = {
  color: "var(--ink)",
  display: "block",
  fontSize: 13,
  fontWeight: 700,
};

const momentMeta: CSSProperties = {
  color: "var(--gray-2)",
  display: "block",
  fontSize: 11.5,
  marginTop: 2,
};

const momentArrow: CSSProperties = {
  color: "var(--gray-3)",
  display: "inline-flex",
  fontSize: 16,
};

const quoteCard: CSSProperties = {
  borderRadius: 22,
  minHeight: 168,
  padding: 20,
  position: "relative",
};

const quoteMark: CSSProperties = {
  color: "var(--heartline-rose)",
  fontFamily: "Newsreader, Georgia, serif",
  fontSize: 54,
  left: 18,
  lineHeight: 1,
  position: "absolute",
  top: 10,
};

const quoteText: CSSProperties = {
  color: "var(--ink)",
  fontFamily: "Newsreader, Georgia, serif",
  fontSize: 21,
  lineHeight: 1.28,
  margin: "36px 0 14px",
};

const quoteMeta: CSSProperties = {
  color: "var(--gray-2)",
  fontSize: 11.5,
  fontWeight: 650,
  margin: 0,
};

const peopleGrid: CSSProperties = {
  display: "grid",
  gap: 13,
  gridTemplateColumns: "repeat(auto-fill, minmax(236px, 1fr))",
};

const personCard: CSSProperties = {
  background: "rgba(255, 255, 255, 0.9)",
  border: "0.5px solid rgba(239, 224, 218, 0.92)",
  borderRadius: 18,
  boxShadow: "0 14px 34px -30px rgba(94, 54, 119, 0.42)",
  color: "inherit",
  display: "grid",
  gap: 14,
  minHeight: 172,
  padding: 15,
  textDecoration: "none",
};

const personName: CSSProperties = {
  alignItems: "center",
  color: "var(--ink)",
  display: "flex",
  fontSize: 14,
  fontWeight: 750,
  gap: 5,
};

const personTags: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 5,
  marginTop: 6,
};

const miniTag: CSSProperties = {
  borderRadius: 999,
  fontSize: 10.5,
  fontWeight: 650,
  padding: "3px 8px",
};

const miniTagMuted: CSSProperties = {
  ...miniTag,
  background: "var(--soft)",
  color: "var(--gray-1)",
};

const nextNode: CSSProperties = {
  alignItems: "center",
  background: "rgba(255, 248, 245, 0.78)",
  borderRadius: 14,
  display: "flex",
  fontSize: 12,
  fontWeight: 650,
  gap: 7,
  padding: "9px 10px",
};

const quickActions: CSSProperties = {
  color: "var(--gray-2)",
  display: "flex",
  fontSize: 11.5,
  gap: 8,
};

const addCard: CSSProperties = {
  alignItems: "center",
  background: "rgba(252, 234, 240, 0.72)",
  border: "0.5px dashed rgba(204, 120, 153, 0.42)",
  borderRadius: 18,
  color: "var(--heartline-purple-deep)",
  display: "flex",
  flexDirection: "column",
  gap: 7,
  justifyContent: "center",
  minHeight: 172,
  padding: 15,
  textDecoration: "none",
};
