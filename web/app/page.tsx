import Link from "next/link";
import Icon from "@/components/Icon";
import Avatar from "@/components/Avatar";
import { requireSessionUserOrRedirect } from "@/lib/server/auth/require-session.server";
import { getPeoplePayload } from "@/lib/server/people-payload/index.server";
import { nodeChipText, urgencyLevel } from "@/lib/presentation";

const SOON_WINDOW_DAYS = 30;

export const dynamic = "force-dynamic";

const metaColor: Record<string, string> = {
  soon: "var(--blue-deep)",
  mid: "var(--gray-1)",
  far: "var(--gray-3)",
};

export default async function HomePage() {
  // The auth guard must complete BEFORE we hit the people payload — in
  // KEEPSAKE_DATA_SOURCE=db mode, getPeoplePayload() reaches into
  // currentUserIdOrThrow() inside its own transaction, and a concurrent
  // Promise.all would race a `redirect()` against a 500 unauthenticated
  // throw. The redirect must always win.
  const user = await requireSessionUserOrRedirect("/");
  const { people, occasions } = await getPeoplePayload();
  const occasionById = (id: string | null | undefined) =>
    id ? occasions.find((o) => o.id === id) : undefined;

  const peopleCount = people.length;
  const datesComingUp = occasions.filter(
    (o) => o.daysUntil >= 0 && o.daysUntil <= SOON_WINDOW_DAYS,
  ).length;
  const linAnniversaryDays = occasionById("occ-lin-anniv")?.daysUntil ?? null;

  return (
    <div className="ks-page">
      <div className="ks-page-inner">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 22 }}>
        <div>
          <h1 style={{ fontSize: 19, fontWeight: 600, color: "var(--ink-2)", letterSpacing: "-0.01em" }}>
            Good evening, {user.name}
          </h1>
          <p style={{ fontSize: 12.5, color: "var(--gray-2)", marginTop: 5 }}>
            Watching over {peopleCount} {peopleCount === 1 ? "person" : "people"} · {datesComingUp} {datesComingUp === 1 ? "date" : "dates"} coming up
          </p>
        </div>
        <div
          style={{
            width: 34, height: 34, borderRadius: "50%", background: "var(--soft-2)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--gray-1)", fontSize: 18, cursor: "pointer",
          }}
        >
          <Icon name="i-bell" />
        </div>
      </div>

      {/* Focus card */}
      <div style={{ background: "var(--blue-wash)", borderRadius: 16, padding: 22, display: "flex", gap: 22, marginBottom: 28 }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 11 }}>
            <span style={{ fontSize: 11, fontWeight: 500, color: "var(--blue-deep)", background: "var(--blue-chip)", padding: "4px 10px", borderRadius: 10 }}>
              {linAnniversaryDays !== null ? `Coming up · ${linAnniversaryDays} days` : "Coming up"}
            </span>
            <span style={{ color: "var(--amber)", display: "flex", alignItems: "center", gap: 3, fontSize: 13 }}>
              <Icon name="i-star" fill />
              Closest circle
            </span>
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 600, color: "var(--ink)", letterSpacing: "-0.01em", marginBottom: 6 }}>
            Your anniversary with Lin
          </h2>
          <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--gray-1)", marginBottom: 18, maxWidth: 360 }}>
            Twelve years together. I can draft something tender, and have it ready to send on the day.
          </p>
          <div style={{ marginTop: "auto", display: "flex", gap: 9 }}>
            <Link href="/workspace?person=p-lin" style={btnPri}>
              <Icon name="i-edit" /> Write it with me
            </Link>
            <button style={btnGhost}>
              <Icon name="i-clock" /> Later
            </button>
          </div>
        </div>
        <div
          style={{
            width: 210, flexShrink: 0, background: "#fff", borderRadius: 13, padding: 14,
            display: "flex", flexDirection: "column", justifyContent: "center",
            boxShadow: "0 6px 20px -10px rgba(20,32,43,0.15)",
          }}
        >
          <FsRow icon="i-cake" text="Mom's birthday · 5d" />
          <div style={{ height: "0.5px", background: "var(--line)", margin: "5px 0" }} />
          <FsRow icon="i-moon" text="Aisha · Hari Raya · 18d" />
          <div style={{ height: "0.5px", background: "var(--line)", margin: "5px 0" }} />
          <FsRow icon="i-lamp" text="Priya · Deepavali · 26d" />
        </div>
      </div>

      <p style={sectionLabel}>PEOPLE YOU'RE WATCHING OVER</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
        {people.map((p) => {
          const occ = occasionById(p.nextOccasionId);
          const days = occ?.daysUntil ?? -60;
          const label = occ?.label ?? "Last note";
          const text = nodeChipText(label, days);
          const lvl = urgencyLevel(days);
          return (
            <Link key={p.id} href={`/workspace?person=${p.id}`} style={personCard}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 11 }}>
                <Avatar name={p.name} bg={p.avatarBg} fg={p.avatarFg} size={36} />
                <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)", display: "flex", alignItems: "center", gap: 4 }}>
                  {p.name}
                  {p.starred && (
                    <span style={{ color: "var(--amber)", fontSize: 11, display: "inline-flex" }}>
                      <Icon name="i-star" fill />
                    </span>
                  )}
                </div>
              </div>
              <p style={{ fontSize: 11, margin: 0, color: metaColor[lvl], fontWeight: lvl === "soon" ? 500 : 400 }}>
                {text}
              </p>
            </Link>
          );
        })}
        <Link href="/people" style={{ ...personCard, background: "#F7F9FB", border: "0.5px dashed #D4DBE2", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 86, color: "var(--gray-3)" }}>
          <span style={{ fontSize: 20 }}><Icon name="i-plus" /></span>
          <span style={{ fontSize: 11 }}>See all people</span>
        </Link>
      </div>
      </div>
    </div>
  );
}

function FsRow({ icon, text }: { icon: string; text: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--gray-1)", padding: "5px 0" }}>
      <span style={{ fontSize: 15, color: "var(--blue-deep)" }}><Icon name={icon} /></span>
      {text}
    </div>
  );
}

const sectionLabel: React.CSSProperties = {
  fontSize: 11.5, fontWeight: 600, color: "var(--gray-2)",
  letterSpacing: "0.04em", marginBottom: 12,
};

const btnPri: React.CSSProperties = {
  padding: "10px 17px", fontSize: 13, fontWeight: 500, borderRadius: 13,
  display: "inline-flex", alignItems: "center", gap: 6, transition: ".18s",
  background: "var(--blue)", color: "#fff", textDecoration: "none",
};
const btnGhost: React.CSSProperties = {
  padding: "10px 17px", fontSize: 13, fontWeight: 500, borderRadius: 13,
  display: "inline-flex", alignItems: "center", gap: 6, transition: ".18s",
  background: "#fff", color: "var(--gray-1)", border: "none", cursor: "pointer",
};
const personCard: React.CSSProperties = {
  background: "#fff", borderRadius: 13, padding: 14,
  border: "0.5px solid var(--line)", transition: ".18s", cursor: "pointer",
  textDecoration: "none", display: "block",
};
