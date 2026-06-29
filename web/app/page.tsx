import Image from "next/image";
import Link from "next/link";
import type { CSSProperties } from "react";
import Icon from "@/components/Icon";
import Avatar from "@/components/Avatar";
import { requireSessionUserOrRedirect } from "@/lib/server/auth/require-session.server";
import { getRemasterDashboardOverview } from "@/lib/server/remaster-overview/index.server";
import { deliveryStatusBadge, occasionIcon, urgencyLevel } from "@/lib/presentation";
import type { RemasterDashboardAccount, RemasterFollowUpRhythmStatus } from "@/lib/remaster/read-model";

const SOON_WINDOW_DAYS = 30;

export const dynamic = "force-dynamic";

const metaColor: Record<string, string> = {
  soon: "var(--heartline-purple-deep)",
  mid: "var(--heartline-sage)",
  far: "var(--gray-3)",
};

const rhythmColor: Record<RemasterFollowUpRhythmStatus, string> = {
  overdue: "#B94F4F",
  today: "var(--heartline-purple-deep)",
  this_week: "var(--heartline-rose-strong)",
  unscheduled: "#9A6B43",
  later: "var(--gray-3)",
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
  const reviewAccounts = overview.reviewAccounts.length > 0 ? overview.reviewAccounts : overview.accounts;
  const reviewQueueCount = overview.stats.reviewQueueCount;
  const focusAccount = reviewAccounts[0]
    ?? null;
  const focusActivity = focusAccount?.nextActivityId
    ? activityById.get(focusAccount.nextActivityId) ?? null
    : null;
  const upcoming = overview.upcomingActivities
    .filter((activity) => activity.daysUntil !== null && activity.daysUntil <= SOON_WINDOW_DAYS)
    .slice(0, 3);
  const recentOutreach = overview.recentActivities.slice(0, 2);
  const reviewQueue = reviewAccounts
    .filter((account) => account.followUpRhythm.isAttention)
    .slice(0, 4);
  const primaryReviewAccount = reviewQueue[0] ?? null;
  const primaryUpcoming = upcoming[0] ?? null;
  const latestOutreach = recentOutreach[0] ?? null;
  const latestOutreachBadge = latestOutreach?.deliveryStatus
    ? deliveryStatusBadge[latestOutreach.deliveryStatus]
    : null;
  const laterRhythm = reviewAccounts.filter((account) => account.followUpRhythm.status === "later").slice(0, 2);

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
              {" "}{reviewQueueCount} {reviewQueueCount === 1 ? "relationship is" : "relationships are"} in the active review queue.
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
                {focusAccount?.followUpRhythm.label ?? "Priority account"}
              </span>
              <h2 style={heroTitle}>
                {focusAccount && focusAccount.followUpRhythm.status !== "later"
                  ? `Review ${focusAccount.followUpRhythm.label.toLowerCase()} follow-up for ${focusAccount.name}`
                  : focusAccount && focusActivity
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
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: "auto" }}>
                <Link href={`/workspace?person=${focusAccount?.primaryContactId ?? ""}`} className="heartline-button" style={heroActionButton}>
                  <Icon name="i-edit" /> Draft outreach
                </Link>
                <Link
                  href={focusAccount ? `/people?review=${focusAccount.primaryContactId}` : "/people"}
                  className="heartline-button heartline-button--soft"
                  style={heroActionButton}
                >
                  <Icon name="i-users" /> Open dossier
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

          <aside style={{ display: "grid", gap: 12, alignContent: "start" }}>
            <section className="heartline-card" style={sideCard}>
              <p className="heartline-section-label">FOLLOW-UP DASHBOARD</p>
              <div style={dashboardPanel}>
                <div style={touchpointGroupLabel}>Priority review queue</div>
                {primaryReviewAccount === null ? (
                  <div style={dashboardPrimaryRow}>
                    <span style={dashboardIcon}>
                      <Icon name="i-check" />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={dashboardTitle}>No active review items</span>
                      <span style={dashboardMeta}>No overdue, due-today, or unscheduled contacts right now.</span>
                    </span>
                  </div>
                ) : (
                  <Link
                    href={`/people?review=${primaryReviewAccount.primaryContactId}`}
                    aria-label={`Review contact dossier for ${primaryReviewAccount.name}`}
                    data-action-target="dossier"
                    data-review-rhythm={primaryReviewAccount.followUpRhythm.status}
                    data-review-rank={1}
                    style={{
                      ...dashboardPrimaryRow,
                      borderColor: rhythmBorderColor(primaryReviewAccount.followUpRhythm.status),
                      background: primaryReviewAccount.followUpRhythm.status === "overdue"
                        ? "#FFF6F0"
                        : "rgba(255, 248, 245, 0.82)",
                    }}
                  >
                    <span style={{
                      ...dashboardIcon,
                      color: rhythmColor[primaryReviewAccount.followUpRhythm.status],
                      background: primaryReviewAccount.followUpRhythm.status === "overdue"
                        ? "rgba(213, 92, 92, 0.1)"
                        : "var(--heartline-rose-wash)",
                    }}>
                      <Icon name={rhythmIcon(primaryReviewAccount)} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{
                        ...touchpointGroupLabel,
                        color: rhythmColor[primaryReviewAccount.followUpRhythm.status],
                      }}>{primaryReviewAccount.followUpRhythm.label}</span>
                      <span style={dashboardTitle}>{primaryReviewAccount.name}</span>
                      <span style={dashboardMeta}>
                        {followUpDetail(primaryReviewAccount)}
                        {reviewQueue.length > 1 ? ` · +${reviewQueue.length - 1} more` : ""}
                      </span>
                    </span>
                    <span style={dashboardActionPill}>Review contact</span>
                    <span style={momentArrow}><Icon name="i-chev" /></span>
                  </Link>
                )}

                <div style={dashboardTileGrid}>
                  <div style={dashboardTile}>
                    <span style={touchpointGroupLabel}>Upcoming milestone</span>
                    {primaryUpcoming ? (
                      <>
                        <span style={dashboardTitle}>{primaryUpcoming.subtitle.split(" · ")[0] ?? "Priority account"}</span>
                        <span style={dashboardMeta}>
                          {primaryUpcoming.title}
                          {primaryUpcoming.daysUntil !== null ? ` · ${timingText(primaryUpcoming.daysUntil)}` : ""}
                        </span>
                      </>
                    ) : (
                      <>
                        <span style={dashboardTitle}>No urgent milestone</span>
                        <span style={dashboardMeta}>Plan proactive outreach when ready.</span>
                      </>
                    )}
                  </div>

                  <div style={dashboardTile}>
                    <span style={touchpointGroupLabel}>Recent outreach</span>
                    {latestOutreach ? (
                      <>
                        <span style={dashboardTitle}>{latestOutreach.subtitle.split(" · ")[0] ?? "Contact"}</span>
                        <span style={dashboardMeta}>
                          <Icon name={latestOutreachBadge?.icon ?? "i-send"} /> {latestOutreach.touchpointSummary}
                        </span>
                      </>
                    ) : (
                      <>
                        <span style={dashboardTitle}>No outreach yet</span>
                        <span style={dashboardMeta}>Draft a thoughtful first touch.</span>
                      </>
                    )}
                  </div>

                  {laterRhythm.length === 0 ? (
                    <div style={dashboardTile}>
                      <span style={touchpointGroupLabel}>Later rhythm</span>
                      <span style={dashboardTitle}>Nothing later</span>
                      <span style={dashboardMeta}>The active queue is fully near-term.</span>
                    </div>
                  ) : (
                    <Link
                      href={`/workspace?person=${laterRhythm[0].primaryContactId}`}
                      data-review-rhythm={laterRhythm[0].followUpRhythm.status}
                      style={dashboardTileLink}
                    >
                      <span style={touchpointGroupLabel}>Later rhythm</span>
                      <span style={dashboardTitle}>{laterRhythm[0].name}</span>
                      <span style={dashboardMeta}>{laterRhythm[0].followUpRhythm.label}</span>
                    </Link>
                  )}
                </div>
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
            {reviewAccounts.map((account) => {
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
                <Link
                  key={account.id}
                  href={`/people?review=${account.primaryContactId}`}
                  aria-label={`Open dossier for ${account.name}`}
                  data-action-target="dossier"
                  data-review-rhythm={account.followUpRhythm.status}
                  style={{
                    ...personCard,
                    borderColor: account.followUpRhythm.isAttention
                      ? rhythmBorderColor(account.followUpRhythm.status)
                      : "rgba(239, 224, 218, 0.92)",
                  }}
                >
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
                    <span style={{ color: rhythmColor[account.followUpRhythm.status] ?? metaColor[lvl], fontSize: 14 }}>
                      <Icon name={icon} />
                    </span>
                    <span style={{ color: rhythmColor[account.followUpRhythm.status] ?? metaColor[lvl] }}>
                      {account.followUpRhythm.label} · {account.nextFollowUpLabel}
                    </span>
                  </div>
                  <div style={lastTouchLine}>{account.lastTouchLabel}</div>
                  <div style={contextLine}>{account.sourceContext ?? account.contextLabel}</div>
                  <div style={quickActions}>
                    <span>Open dossier</span>
                    <span>Draft from drawer</span>
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

function followUpDetail(account: RemasterDashboardAccount): string {
  const next = account.nextFollowUpLabel.replace(/^Next follow-up ·\s*/, "");
  const last = account.lastTouchLabel.replace(/^Last touch ·\s*/, "");
  return `${next} · ${last}`;
}

function rhythmIcon(account: RemasterDashboardAccount): string {
  if (account.followUpRhythm.status === "overdue") return "i-alert";
  if (account.followUpRhythm.status === "today") return "i-bell";
  if (account.followUpRhythm.status === "unscheduled") return "i-bulb";
  if (account.nextActivityId) return "i-clock";
  if (account.lastDeliveryStatus) return deliveryStatusBadge[account.lastDeliveryStatus].icon;
  return "i-clock";
}

function rhythmBorderColor(status: RemasterFollowUpRhythmStatus): string {
  if (status === "overdue") return "rgba(213, 92, 92, 0.3)";
  if (status === "today") return "rgba(135, 80, 180, 0.26)";
  if (status === "this_week") return "rgba(204, 120, 153, 0.3)";
  if (status === "unscheduled") return "rgba(217, 138, 78, 0.26)";
  return "rgba(239, 224, 218, 0.92)";
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
  height: 360,
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

const heroActionButton: CSSProperties = {
  padding: "9px 11px",
  whiteSpace: "nowrap",
};

const sideCard: CSSProperties = {
  borderRadius: 18,
  boxSizing: "border-box",
  height: 232,
  padding: 12,
};

const dashboardPanel: CSSProperties = {
  display: "grid",
  gap: 8,
};

const dashboardPrimaryRow: CSSProperties = {
  alignItems: "center",
  background: "rgba(255, 248, 245, 0.84)",
  border: "0.5px solid rgba(239, 224, 218, 0.86)",
  borderRadius: 15,
  color: "inherit",
  display: "flex",
  gap: 8,
  minHeight: 64,
  padding: "8px 9px",
  textDecoration: "none",
};

const dashboardTileGrid: CSSProperties = {
  display: "grid",
  gap: 8,
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
};

const dashboardTile: CSSProperties = {
  background: "rgba(255, 248, 245, 0.68)",
  border: "0.5px solid rgba(239, 224, 218, 0.72)",
  borderRadius: 14,
  color: "inherit",
  display: "grid",
  gap: 2,
  minHeight: 66,
  padding: 8,
  textDecoration: "none",
};

const dashboardTileLink: CSSProperties = {
  ...dashboardTile,
};

const dashboardIcon: CSSProperties = {
  alignItems: "center",
  background: "var(--heartline-rose-wash)",
  borderRadius: 12,
  color: "var(--heartline-purple-deep)",
  display: "flex",
  flexShrink: 0,
  fontSize: 13,
  height: 30,
  justifyContent: "center",
  width: 30,
};

const dashboardTitle: CSSProperties = {
  color: "var(--ink)",
  display: "block",
  fontSize: 12,
  fontWeight: 750,
  lineHeight: 1.22,
  marginTop: 2,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const dashboardMeta: CSSProperties = {
  alignItems: "center",
  color: "var(--gray-2)",
  display: "flex",
  fontSize: 10.25,
  gap: 4,
  lineHeight: 1.3,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const dashboardActionPill: CSSProperties = {
  alignItems: "center",
  alignSelf: "center",
  background: "#fff",
  border: "0.5px solid rgba(239, 224, 218, 0.9)",
  borderRadius: 999,
  color: "var(--heartline-purple-deep)",
  display: "inline-flex",
  flexShrink: 0,
  fontSize: 10.5,
  fontWeight: 760,
  padding: "5px 8px",
  whiteSpace: "nowrap",
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
  borderRadius: 18,
  boxSizing: "border-box",
  minHeight: 108,
  padding: "14px 16px 15px",
  position: "relative",
};

const quoteMark: CSSProperties = {
  color: "var(--heartline-rose)",
  fontFamily: "Newsreader, Georgia, serif",
  fontSize: 34,
  left: 16,
  lineHeight: 1,
  position: "absolute",
  top: 9,
};

const quoteText: CSSProperties = {
  color: "var(--ink)",
  fontFamily: "Newsreader, Georgia, serif",
  fontSize: 15.5,
  lineHeight: 1.28,
  margin: "22px 0 8px",
};

const quoteMeta: CSSProperties = {
  color: "var(--gray-2)",
  fontSize: 11,
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
