import Image from "next/image";
import Link from "next/link";
import type { CSSProperties } from "react";
import Icon from "@/components/Icon";
import Avatar from "@/components/Avatar";
import { requireSessionUserOrRedirect } from "@/lib/server/auth/require-session.server";
import { getRemasterDashboardOverview } from "@/lib/server/remaster-overview/index.server";
import { deliveryStatusBadge, occasionIcon, urgencyLevel } from "@/lib/presentation";

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
  const overview = await getRemasterDashboardOverview();

  const activityById = new Map(
    [...overview.upcomingActivities, ...overview.recentActivities].map((activity) => [activity.id, activity]),
  );

  const accountsCount = overview.stats.accountsCount;
  const contactsCount = overview.stats.contactsCount;
  const upcomingActivitiesCount = overview.stats.upcomingActivitiesCount;
  const focusAccount = overview.accounts.find((account) => account.primaryContactId === "p-lin")
    ?? overview.accounts[0]
    ?? null;
  const focusActivity = focusAccount?.nextActivityId
    ? activityById.get(focusAccount.nextActivityId) ?? null
    : null;
  const upcoming = overview.upcomingActivities
    .filter((activity) => activity.daysUntil !== null && activity.daysUntil <= SOON_WINDOW_DAYS)
    .slice(0, 3);
  const recentOutreach = overview.recentActivities.slice(0, 2);
  const needsFollowUp = overview.accounts
    .filter((account) => !account.nextActivityId)
    .slice(0, 2);

  return (
    <div className="ks-page">
      <div className="ks-page-inner" style={{ width: "min(100%, 1060px)" }}>
        <div style={headerRow}>
          <div>
            <p style={eyebrow}>ReMaster dashboard</p>
            <h1 style={pageTitle}>
              Good evening, {user.name}
            </h1>
            <p style={pageSubcopy}>
              Track upcoming milestones, recent outreach, and follow-up gaps across {accountsCount} {accountsCount === 1 ? "account" : "accounts"}
              {" / "}{contactsCount} {contactsCount === 1 ? "contact" : "contacts"}.
              {" "}{upcomingActivitiesCount} upcoming {upcomingActivitiesCount === 1 ? "activity needs" : "activities need"} attention soon.
            </p>
          </div>
          <Link href="/people" className="heartline-button" style={{ whiteSpace: "nowrap" }}>
            <Icon name="i-plus" /> Add contact
          </Link>
        </div>

        <div style={homeGrid}>
          <section className="heartline-card" style={heroCard}>
            <div style={heroCopy}>
              <span className="heartline-pill">
                <Icon name="i-users" />
                {focusActivity?.daysUntil !== null && focusActivity?.daysUntil !== undefined
                  ? timingText(focusActivity.daysUntil)
                  : "Priority account"}
              </span>
              <h2 style={heroTitle}>
                {focusAccount && focusActivity
                  ? `Prepare ${focusActivity.touchpointLabel.toLowerCase()} for ${focusAccount.name}`
                  : focusAccount
                    ? `Plan the next touchpoint for ${focusAccount.name}`
                    : "Start with a priority account"}
              </h2>
              <p style={heroBody}>
                {focusAccount
                  ? focusAccount.touchpointSummary
                  : "Use ReMaster to turn static contacts into an ongoing touchpoint rhythm."}
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
                <Link href={`/workspace?person=${focusAccount?.primaryContactId ?? ""}`} className="heartline-button">
                  <Icon name="i-edit" /> Draft outreach
                </Link>
                <Link href="/people" className="heartline-button heartline-button--soft">
                  <Icon name="i-users" /> Review contacts
                </Link>
              </div>
            </div>
            <div style={heroImageWrap}>
              <Image
                src="/images/heartline-hero.png"
                alt="A desk with notes, a calendar, and correspondence planning materials"
                fill
                priority
                sizes="(min-width: 1000px) 520px, 100vw"
                style={{ objectFit: "cover" }}
              />
            </div>
          </section>

          <aside style={{ display: "grid", gap: 14 }}>
            <section className="heartline-card" style={sideCard}>
              <p className="heartline-section-label">FOLLOW-UP DASHBOARD</p>
              <div style={{ display: "grid", gap: 12 }}>
                <div style={touchpointGroupLabel}>Upcoming milestone</div>
                {upcoming.length === 0 ? (
                  <p style={{ margin: 0, fontSize: 12.5, color: "var(--gray-2)", lineHeight: 1.6 }}>
                    Nothing urgent in the next 30 days. Review your accounts to plan proactive outreach.
                  </p>
                ) : upcoming.map((activity) => {
                  return (
                    <Link
                      key={activity.id}
                      href={`/workspace?person=${activity.contactId ?? ""}`}
                      style={momentRow}
                    >
                      <span style={momentIcon}>
                        <Icon name={occasionIcon[activity.occasionKind ?? "check-in"]} />
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={momentTitle}>{activity.subtitle.split(" · ")[0] ?? "Priority account"}</span>
                        <span style={momentMeta}>
                          {activity.touchpointLabel} · {activity.title}
                          {activity.daysUntil !== null ? ` · ${timingText(activity.daysUntil)}` : ""}
                        </span>
                      </span>
                      <span style={momentArrow}><Icon name="i-chev" /></span>
                    </Link>
                  );
                })}

                <div style={touchpointGroupLabel}>Recent outreach</div>
                {recentOutreach.length === 0 ? (
                  <p style={emptyTouchpointText}>No outreach logged yet.</p>
                ) : recentOutreach.map((activity) => {
                  const badge = activity.deliveryStatus ? deliveryStatusBadge[activity.deliveryStatus] : null;
                  return (
                    <div key={activity.id} style={momentRow}>
                      <span style={momentIcon}>
                        <Icon name={badge?.icon ?? "i-send"} />
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={momentTitle}>{activity.subtitle.split(" · ")[0] ?? "Contact"}</span>
                        <span style={momentMeta}>{activity.touchpointSummary}</span>
                      </span>
                    </div>
                  );
                })}

                <div style={touchpointGroupLabel}>Needs follow-up</div>
                {needsFollowUp.length === 0 ? (
                  <p style={emptyTouchpointText}>Every account has a next touchpoint.</p>
                ) : needsFollowUp.map((account) => (
                  <Link
                    key={account.id}
                    href={`/workspace?person=${account.primaryContactId}`}
                    style={momentRow}
                  >
                    <span style={momentIcon}>
                      <Icon name="i-bulb" />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={momentTitle}>{account.name}</span>
                      <span style={momentMeta}>{account.nextFollowUpLabel}</span>
                    </span>
                    <span style={momentArrow}><Icon name="i-chev" /></span>
                  </Link>
                ))}
              </div>
            </section>

            <section className="heartline-card" style={quoteCard}>
              <span style={quoteMark}>“</span>
              <p style={quoteText}>
                The best business relationship systems make follow-up feel timely, prepared, and personal.
              </p>
              <p style={quoteMeta}>ReMaster operating principle</p>
            </section>
          </aside>
        </div>

        <div style={{ marginTop: 28 }}>
          <p className="heartline-section-label">TOUCHPOINTS TO REVIEW</p>
          <div style={peopleGrid}>
            {overview.accounts.map((account) => {
              const nextActivity = account.nextActivityId
                ? activityById.get(account.nextActivityId) ?? null
                : null;
              const lvl = nextActivity?.daysUntil !== null && nextActivity?.daysUntil !== undefined
                ? urgencyLevel(nextActivity.daysUntil)
                : "far";
              const icon = nextActivity?.occasionKind
                ? occasionIcon[nextActivity.occasionKind]
                : account.lastDeliveryStatus
                  ? deliveryStatusBadge[account.lastDeliveryStatus].icon
                  : "i-bulb";
              return (
                <Link key={account.id} href={`/workspace?person=${account.primaryContactId}`} style={personCard}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <Avatar name={account.name} bg={account.avatarBg} fg={account.avatarFg} size={44} fontSize={16} />
                    <div style={{ minWidth: 0 }}>
                      <div style={personName}>
                        {account.name}
                        {account.starred && (
                          <span style={{ color: "var(--amber)", fontSize: 12, display: "inline-flex" }}>
                            <Icon name="i-star" fill />
                          </span>
                        )}
                      </div>
                      <div style={personTags}>
                        <span style={{ ...miniTag, background: "var(--heartline-rose-wash)", color: "var(--heartline-purple-deep)" }}>
                          {account.relationshipLabel}
                        </span>
                        <span style={miniTagMuted}>{account.secondaryLabel}</span>
                      </div>
                    </div>
                  </div>
                  <div style={nextNode}>
                    <span style={{ color: metaColor[lvl], fontSize: 14 }}>
                      <Icon name={icon} />
                    </span>
                    <span style={{ color: metaColor[lvl] }}>{account.nextFollowUpLabel}</span>
                  </div>
                  <div style={lastTouchLine}>{account.lastTouchLabel}</div>
                  <div style={contextLine}>{account.sourceContext ?? account.contextLabel}</div>
                  <div style={quickActions}>
                    <span>Open touchpoint</span>
                    <span>Draft follow-up</span>
                  </div>
                </Link>
              );
            })}
            <Link href="/people" style={addCard}>
              <span style={{ fontSize: 22 }}><Icon name="i-plus" /></span>
              <span style={{ fontWeight: 650 }}>See all contacts</span>
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
  gap: 20,
  marginBottom: 20,
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
  fontSize: 27,
  fontWeight: 700,
  color: "var(--ink-2)",
  letterSpacing: "0",
  margin: 0,
};

const pageSubcopy: CSSProperties = {
  fontSize: 13,
  color: "var(--gray-1)",
  lineHeight: 1.58,
  margin: "8px 0 0",
  maxWidth: 560,
};

const homeGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1.08fr) minmax(270px, 0.72fr)",
  gap: 14,
  alignItems: "start",
};

const heroCard: CSSProperties = {
  borderRadius: 18,
  display: "grid",
  gridTemplateColumns: "minmax(238px, 0.92fr) minmax(230px, 0.78fr)",
  gap: 10,
  overflow: "hidden",
  padding: 10,
  boxSizing: "border-box",
  height: 232,
  minHeight: 0,
  alignSelf: "start",
};

const heroCopy: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  padding: "6px 2px 6px 8px",
};

const heroTitle: CSSProperties = {
  color: "var(--ink-2)",
  fontSize: 22,
  fontWeight: 700,
  letterSpacing: "0",
  lineHeight: 1.14,
  margin: "10px 0 6px",
};

const heroBody: CSSProperties = {
  color: "var(--gray-1)",
  fontSize: 11.75,
  lineHeight: 1.45,
  margin: 0,
  maxWidth: 300,
};

const heroImageWrap: CSSProperties = {
  position: "relative",
  height: "100%",
  minHeight: 0,
  borderRadius: 13,
  overflow: "hidden",
  border: "0.5px solid rgba(239, 224, 218, 0.74)",
  background: "#F9EDE8",
};

const sideCard: CSSProperties = {
  borderRadius: 20,
  padding: 16,
};

const momentRow: CSSProperties = {
  alignItems: "center",
  background: "rgba(255, 248, 245, 0.78)",
  border: "0.5px solid rgba(239, 224, 218, 0.85)",
  borderRadius: 15,
  color: "inherit",
  display: "flex",
  gap: 10,
  padding: 10,
  textDecoration: "none",
};

const touchpointGroupLabel: CSSProperties = {
  color: "var(--heartline-rose-strong)",
  fontSize: 10.5,
  fontWeight: 800,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const emptyTouchpointText: CSSProperties = {
  color: "var(--gray-2)",
  fontSize: 12,
  lineHeight: 1.5,
  margin: 0,
};

const momentIcon: CSSProperties = {
  alignItems: "center",
  background: "var(--heartline-rose-wash)",
  borderRadius: 12,
  color: "var(--heartline-purple-deep)",
  display: "flex",
  flexShrink: 0,
  fontSize: 15,
  height: 34,
  justifyContent: "center",
  width: 34,
};

const momentTitle: CSSProperties = {
  color: "var(--ink)",
  display: "block",
  fontSize: 12.5,
  fontWeight: 700,
};

const momentMeta: CSSProperties = {
  color: "var(--gray-2)",
  display: "block",
  fontSize: 11,
  marginTop: 2,
};

const momentArrow: CSSProperties = {
  color: "var(--gray-3)",
  display: "inline-flex",
  fontSize: 16,
};

const quoteCard: CSSProperties = {
  borderRadius: 20,
  minHeight: 142,
  padding: 18,
  position: "relative",
};

const quoteMark: CSSProperties = {
  color: "var(--heartline-rose)",
  fontFamily: "Newsreader, Georgia, serif",
  fontSize: 46,
  left: 16,
  lineHeight: 1,
  position: "absolute",
  top: 8,
};

const quoteText: CSSProperties = {
  color: "var(--ink)",
  fontFamily: "Newsreader, Georgia, serif",
  fontSize: 18,
  lineHeight: 1.3,
  margin: "30px 0 12px",
};

const quoteMeta: CSSProperties = {
  color: "var(--gray-2)",
  fontSize: 11.5,
  fontWeight: 650,
  margin: 0,
};

const peopleGrid: CSSProperties = {
  display: "grid",
  gap: 12,
  gridTemplateColumns: "repeat(auto-fill, minmax(208px, 1fr))",
};

const personCard: CSSProperties = {
  background: "rgba(255, 255, 255, 0.9)",
  border: "0.5px solid rgba(239, 224, 218, 0.92)",
  borderRadius: 16,
  boxShadow: "0 14px 34px -30px rgba(94, 54, 119, 0.42)",
  color: "inherit",
  display: "grid",
  gap: 12,
  minHeight: 150,
  padding: 13,
  textDecoration: "none",
};

const personName: CSSProperties = {
  alignItems: "center",
  color: "var(--ink)",
  display: "flex",
  fontSize: 13.5,
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
  borderRadius: 13,
  display: "flex",
  fontSize: 11.5,
  fontWeight: 650,
  gap: 7,
  padding: "8px 9px",
};

const lastTouchLine: CSSProperties = {
  color: "var(--gray-1)",
  fontSize: 11.5,
  fontWeight: 600,
  lineHeight: 1.35,
};

const contextLine: CSSProperties = {
  color: "var(--gray-3)",
  fontSize: 11,
  lineHeight: 1.35,
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
  borderRadius: 16,
  color: "var(--heartline-purple-deep)",
  display: "flex",
  flexDirection: "column",
  gap: 7,
  justifyContent: "center",
  minHeight: 150,
  padding: 13,
  textDecoration: "none",
};
