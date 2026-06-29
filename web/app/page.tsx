import Link from "next/link";
import type { CSSProperties } from "react";
import Icon from "@/components/Icon";
import Avatar from "@/components/Avatar";
import { requireSessionUserOrRedirect } from "@/lib/server/auth/require-session.server";
import { getRemasterDashboardOverview } from "@/lib/server/remaster-overview/index.server";
import type { ContactSegment } from "@/lib/domain";
import type {
  RemasterDashboardAccount,
  RemasterDashboardActivity,
  RemasterDashboardContact,
} from "@/lib/remaster/read-model";

export const dynamic = "force-dynamic";

type RelationshipTone = "Needs context" | "Going quiet" | "Moment coming up" | "Ready to draft" | "Steady";

type RelationshipIssue = {
  account: RemasterDashboardAccount;
  tone: RelationshipTone;
  issue: string;
  detail: string;
  priority: number;
  isMaintenance: boolean;
};

type ProfileGroup = {
  label: string;
  segments: ContactSegment[];
  icon: string;
};

const profileGroups: ProfileGroup[] = [
  { label: "Clients / prospects", segments: ["client", "prospect"], icon: "i-users" },
  { label: "Partners", segments: ["partner"], icon: "i-heart-handshake" },
  { label: "Investors", segments: ["investor"], icon: "i-star" },
  { label: "Personal", segments: ["personal"], icon: "i-heart" },
];

const segmentLabel: Record<ContactSegment, string> = {
  client: "Client",
  partner: "Partner",
  prospect: "Prospect",
  investor: "Investor",
  personal: "Personal",
};

const toneColor: Record<RelationshipTone, string> = {
  "Needs context": "#9A6B43",
  "Going quiet": "#B94F4F",
  "Moment coming up": "var(--heartline-purple-deep)",
  "Ready to draft": "var(--heartline-rose-strong)",
  Steady: "var(--gray-2)",
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
  const contactByAccountId = new Map(overview.contacts.map((contact) => [contact.accountId, contact]));

  const relationshipIssues = overview.accounts
    .map((account) => buildRelationshipIssue(account, activityById))
    .sort(compareRelationshipIssues);
  const priorityRelationships = relationshipIssues.slice(0, 4);
  const maintenanceCount = relationshipIssues.filter((issue) => issue.isMaintenance).length;
  const recentSignals = buildRecentSignals(overview.recentActivities, relationshipIssues, contactByAccountId).slice(0, 4);

  return (
    <div className="ks-page">
      <div className="ks-page-inner" style={{ width: "min(100%, 1040px)" }}>
        <header style={header}>
          <p style={eyebrow}>ReMaster intelligence</p>
          <div style={headerMain}>
            <div>
              <h1 style={pageTitle}>Good evening, {user.name}</h1>
              <p style={headline}>Relationship profiles need attention</p>
            </div>
            <div style={profileCount}>
              {overview.stats.accountsCount} active profiles · {maintenanceCount} need maintenance
            </div>
          </div>
          <p style={pageSubcopy}>
            A compact operating view for profile gaps, quiet relationships, and the next relationship action.
          </p>
        </header>

        <main style={homeStack}>
          <section aria-labelledby="profile-overview-title">
            <SectionHeader
              id="profile-overview-title"
              eyebrowText="Relationship profile overview"
              title="Where profile intelligence is thin"
            />
            <div data-testid="relationship-profile-overview" style={overviewGrid}>
              {profileGroups.map((group) => {
                const accounts = overview.accounts.filter((account) => group.segments.includes(account.segment));
                const summary = profileGroupSummary(accounts, activityById);
                return (
                  <div key={group.label} data-profile-group={group.label} style={overviewRow}>
                    <span style={overviewIcon}><Icon name={group.icon} /></span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={overviewLabel}>{group.label}</span>
                      <span style={overviewMeta}>
                        {accounts.length} {accounts.length === 1 ? "profile" : "profiles"} · {summary}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </section>

          <section aria-labelledby="priority-relationships-title">
            <SectionHeader
              id="priority-relationships-title"
              eyebrowText="Priority relationships"
              title="One reason to act"
            />
            <div data-testid="priority-relationships" style={priorityList}>
              {priorityRelationships.map((item, index) => (
                <article
                  key={item.account.id}
                  data-relationship-priority={index + 1}
                  data-relationship-tone={item.tone}
                  style={{
                    ...priorityRow,
                    borderColor: index === 0 ? "rgba(204, 120, 153, 0.34)" : "rgba(239, 224, 218, 0.88)",
                  }}
                >
                  <Avatar
                    name={item.account.name}
                    bg={item.account.avatarBg}
                    fg={item.account.avatarFg}
                    size={38}
                    fontSize={14}
                  />
                  <div style={priorityBody}>
                    <div style={priorityTitleRow}>
                      <span style={priorityName}>{item.account.name}</span>
                      <span style={segmentPill}>{segmentLabel[item.account.segment]}</span>
                      <span style={{ ...tonePill, color: toneColor[item.tone] }}>{item.tone}</span>
                    </div>
                    <div style={priorityIssue}>{item.issue}</div>
                    <div style={priorityDetail}>{item.detail}</div>
                  </div>
                  <div style={rowActions}>
                    <Link href={`/people?review=${item.account.primaryContactId}`} style={quietAction}>
                      Open profile
                    </Link>
                    <Link href={`/workspace?person=${item.account.primaryContactId}`} style={draftAction}>
                      Draft outreach
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section aria-labelledby="recent-signals-title">
            <SectionHeader
              id="recent-signals-title"
              eyebrowText="Recent relationship signals"
              title="Small signals, next action"
            />
            <div data-testid="recent-relationship-signals" style={signalList}>
              {recentSignals.map((signal) => (
                <div key={signal} style={signalRow}>
                  <span style={signalDot} />
                  <span>{signal}</span>
                </div>
              ))}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

function SectionHeader({ id, eyebrowText, title }: { id: string; eyebrowText: string; title: string }) {
  return (
    <div style={sectionHeader}>
      <p style={sectionEyebrow}>{eyebrowText}</p>
      <h2 id={id} style={sectionTitle}>{title}</h2>
    </div>
  );
}

function buildRelationshipIssue(
  account: RemasterDashboardAccount,
  activityById: Map<string, RemasterDashboardActivity>,
): RelationshipIssue {
  const daysQuiet = daysSinceLastTouch(account);
  const nextActivity = account.nextActivityId ? activityById.get(account.nextActivityId) ?? null : null;
  const needsContext = needsProfileContext(account);

  if (typeof daysQuiet === "number" && daysQuiet >= 42) {
    return {
      account,
      tone: "Going quiet",
      issue: `No touchpoint in ${daysQuiet} days`,
      detail: "A lightweight outreach draft is probably enough to restart the thread.",
      priority: 0,
      isMaintenance: true,
    };
  }

  if (account.followUpRhythm.status === "unscheduled") {
    return {
      account,
      tone: "Needs context",
      issue: "No next follow-up set",
      detail: "Open the profile and choose the next relationship rhythm.",
      priority: 1,
      isMaintenance: true,
    };
  }

  if (needsContext) {
    return {
      account,
      tone: "Needs context",
      issue: "Needs business context",
      detail: "Add the missing role, organization, or source context before drafting.",
      priority: 2,
      isMaintenance: true,
    };
  }

  if (nextActivity && typeof nextActivity.daysUntil === "number" && nextActivity.daysUntil <= 30) {
    return {
      account,
      tone: "Moment coming up",
      issue: `${nextActivity.title} ${daysUntilPhrase(nextActivity.daysUntil)}`,
      detail: "Draft from the profile so the note stays specific.",
      priority: 3,
      isMaintenance: true,
    };
  }

  if (account.lastDeliveryStatus === "opened") {
    return {
      account,
      tone: "Ready to draft",
      issue: "Opened your last note",
      detail: "A short follow-up can continue the relationship while context is warm.",
      priority: 4,
      isMaintenance: false,
    };
  }

  return {
    account,
    tone: "Steady",
    issue: account.nextFollowUpLabel.replace(/^Next follow-up ·\s*/, ""),
    detail: "No profile maintenance needed right now.",
    priority: 5,
    isMaintenance: false,
  };
}

function compareRelationshipIssues(left: RelationshipIssue, right: RelationshipIssue): number {
  if (left.priority !== right.priority) return left.priority - right.priority;

  const leftRhythm = left.account.followUpRhythm.priority;
  const rightRhythm = right.account.followUpRhythm.priority;
  if (leftRhythm !== rightRhythm) return leftRhythm - rightRhythm;

  if (left.account.starred !== right.account.starred) return left.account.starred ? -1 : 1;
  return left.account.name.localeCompare(right.account.name);
}

function profileGroupSummary(
  accounts: RemasterDashboardAccount[],
  activityById: Map<string, RemasterDashboardActivity>,
): string {
  if (accounts.length === 0) return "No profiles yet";

  const incomplete = accounts.filter(needsProfileContext).length;
  if (incomplete > 0) return `${incomplete} ${incomplete === 1 ? "needs" : "need"} context`;

  const quiet = accounts.filter((account) => {
    const days = daysSinceLastTouch(account);
    return typeof days === "number" && days >= 42;
  }).length;
  if (quiet > 0) return `${quiet} going quiet`;

  const due = accounts.filter((account) => account.followUpRhythm.isAttention).length;
  if (due > 0) return `${due} follow-up ${due === 1 ? "due" : "due"}`;

  const moments = accounts.filter((account) => {
    const activity = account.nextActivityId ? activityById.get(account.nextActivityId) ?? null : null;
    return activity && typeof activity.daysUntil === "number" && activity.daysUntil <= 30;
  }).length;
  if (moments > 0) return `${moments} meaningful ${moments === 1 ? "moment" : "moments"}`;

  return "Profiles steady";
}

function buildRecentSignals(
  recentActivities: RemasterDashboardActivity[],
  issues: RelationshipIssue[],
  contactByAccountId: Map<string, RemasterDashboardContact>,
): string[] {
  const signals: string[] = [];
  const opened = recentActivities.find((activity) => activity.deliveryStatus === "opened");
  if (opened) {
    signals.push(`${signalSubject(opened)} opened your last note`);
  }

  const noFollowUp = issues.find((issue) => issue.account.followUpRhythm.status === "unscheduled");
  if (noFollowUp) {
    signals.push(`${noFollowUp.account.name} has no next follow-up set`);
  }

  const culturalContext = issues.find((issue) => {
    const contact = contactByAccountId.get(issue.account.id);
    return contact?.cultureLabel && contact.cultureLabel !== "None";
  });
  if (culturalContext) {
    signals.push(`${culturalContext.account.name} has cultural context to respect`);
  }

  const needsContext = issues.find((issue) => issue.tone === "Needs context");
  if (needsContext) {
    signals.push(`${needsContext.account.name} needs profile context before the next action`);
  }

  return signals.length > 0 ? signals : ["Profiles are quiet. Review one relationship before drafting."];
}

function needsProfileContext(account: RemasterDashboardAccount): boolean {
  return !account.organization || !account.roleTitle || !account.sourceContext;
}

function daysSinceLastTouch(account: RemasterDashboardAccount): number | null {
  const dateISO = account.lastDeliveryAtISO?.slice(0, 10) ?? extractDate(account.lastTouchLabel);
  if (!dateISO) return null;
  const from = Date.parse(`${dateISO}T00:00:00.000Z`);
  const now = Date.now();
  if (!Number.isFinite(from)) return null;
  return Math.max(0, Math.floor((now - from) / 86_400_000));
}

function extractDate(label: string): string | null {
  return label.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
}

function daysUntilPhrase(daysUntil: number): string {
  if (daysUntil === 0) return "today";
  if (daysUntil === 1) return "tomorrow";
  return `in ${daysUntil} days`;
}

function signalSubject(activity: RemasterDashboardActivity): string {
  return activity.subtitle.split(" · ")[0] ?? "A relationship";
}

const header: CSSProperties = {
  marginBottom: 24,
};

const headerMain: CSSProperties = {
  alignItems: "flex-end",
  display: "flex",
  gap: 18,
  justifyContent: "space-between",
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
  color: "var(--ink-2)",
  fontSize: 27,
  fontWeight: 700,
  letterSpacing: "0",
  margin: 0,
};

const headline: CSSProperties = {
  color: "var(--ink)",
  fontFamily: "Newsreader, Georgia, serif",
  fontSize: 30,
  lineHeight: 1.05,
  margin: "8px 0 0",
};

const profileCount: CSSProperties = {
  background: "rgba(255,255,255,0.72)",
  border: "0.5px solid rgba(239, 224, 218, 0.86)",
  borderRadius: 999,
  color: "var(--heartline-purple-deep)",
  flexShrink: 0,
  fontSize: 12,
  fontWeight: 720,
  padding: "8px 12px",
};

const pageSubcopy: CSSProperties = {
  color: "var(--gray-1)",
  fontSize: 13,
  lineHeight: 1.55,
  margin: "10px 0 0",
  maxWidth: 620,
};

const homeStack: CSSProperties = {
  display: "grid",
  gap: 24,
};

const sectionHeader: CSSProperties = {
  alignItems: "end",
  display: "flex",
  justifyContent: "space-between",
  marginBottom: 10,
};

const sectionEyebrow: CSSProperties = {
  color: "var(--heartline-rose-strong)",
  fontSize: 10.75,
  fontWeight: 800,
  letterSpacing: "0.08em",
  margin: 0,
  textTransform: "uppercase",
};

const sectionTitle: CSSProperties = {
  color: "var(--gray-2)",
  fontSize: 12,
  fontWeight: 620,
  margin: 0,
};

const overviewGrid: CSSProperties = {
  display: "grid",
  gap: 9,
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
};

const overviewRow: CSSProperties = {
  alignItems: "center",
  background: "rgba(255,255,255,0.74)",
  border: "0.5px solid rgba(239, 224, 218, 0.84)",
  borderRadius: 14,
  display: "flex",
  gap: 10,
  minHeight: 68,
  padding: "10px 11px",
};

const overviewIcon: CSSProperties = {
  alignItems: "center",
  background: "var(--heartline-rose-wash)",
  borderRadius: 11,
  color: "var(--heartline-purple-deep)",
  display: "inline-flex",
  flexShrink: 0,
  height: 30,
  justifyContent: "center",
  width: 30,
};

const overviewLabel: CSSProperties = {
  color: "var(--ink)",
  display: "block",
  fontSize: 12.5,
  fontWeight: 760,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const overviewMeta: CSSProperties = {
  color: "var(--gray-2)",
  display: "block",
  fontSize: 11.25,
  lineHeight: 1.35,
  marginTop: 2,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const priorityList: CSSProperties = {
  display: "grid",
  gap: 9,
};

const priorityRow: CSSProperties = {
  alignItems: "center",
  background: "rgba(255,255,255,0.82)",
  border: "0.5px solid rgba(239, 224, 218, 0.88)",
  borderRadius: 15,
  display: "grid",
  gap: 12,
  gridTemplateColumns: "38px minmax(0, 1fr) auto",
  minHeight: 76,
  padding: "11px 12px",
};

const priorityBody: CSSProperties = {
  minWidth: 0,
};

const priorityTitleRow: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
};

const priorityName: CSSProperties = {
  color: "var(--ink)",
  fontSize: 13.5,
  fontWeight: 780,
};

const segmentPill: CSSProperties = {
  background: "var(--soft)",
  borderRadius: 999,
  color: "var(--gray-1)",
  fontSize: 10.5,
  fontWeight: 680,
  padding: "3px 8px",
};

const tonePill: CSSProperties = {
  background: "rgba(255, 248, 245, 0.82)",
  border: "0.5px solid rgba(239, 224, 218, 0.82)",
  borderRadius: 999,
  fontSize: 10.5,
  fontWeight: 780,
  padding: "3px 8px",
};

const priorityIssue: CSSProperties = {
  color: "var(--ink)",
  fontSize: 13,
  fontWeight: 660,
  marginTop: 5,
};

const priorityDetail: CSSProperties = {
  color: "var(--gray-2)",
  fontSize: 11.5,
  lineHeight: 1.35,
  marginTop: 3,
};

const rowActions: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 7,
};

const quietAction: CSSProperties = {
  border: "0.5px solid rgba(239, 224, 218, 0.92)",
  borderRadius: 999,
  color: "var(--heartline-purple-deep)",
  fontSize: 11.5,
  fontWeight: 720,
  padding: "7px 10px",
  textDecoration: "none",
  whiteSpace: "nowrap",
};

const draftAction: CSSProperties = {
  ...quietAction,
  background: "var(--heartline-purple-deep)",
  borderColor: "var(--heartline-purple-deep)",
  color: "#fff",
};

const signalList: CSSProperties = {
  background: "rgba(255,255,255,0.68)",
  border: "0.5px solid rgba(239, 224, 218, 0.84)",
  borderRadius: 15,
  display: "grid",
  padding: "4px 12px",
};

const signalRow: CSSProperties = {
  alignItems: "center",
  borderBottom: "0.5px solid rgba(239, 224, 218, 0.62)",
  color: "var(--gray-1)",
  display: "flex",
  fontSize: 12.5,
  gap: 9,
  minHeight: 40,
};

const signalDot: CSSProperties = {
  background: "var(--heartline-rose-strong)",
  borderRadius: 999,
  display: "inline-flex",
  height: 6,
  width: 6,
};
