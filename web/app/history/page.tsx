import Icon from "@/components/Icon";
import { requireSessionUserOrRedirect } from "@/lib/server/auth/require-session.server";
import { getRemasterHistoryCompatibilityView } from "@/lib/server/remaster-overview/index.server";
import {
  cardGradientByHint,
  channelBadge,
  deliveryStatusBadge,
  occasionIcon,
} from "@/lib/presentation";
import type { Delivery, OccasionKind } from "@/lib/domain";
import type { RemasterDashboardOverview } from "@/lib/remaster/read-model";

export const dynamic = "force-dynamic";

const gradientByOccasion: Record<OccasionKind, string> = {
  anniversary: cardGradientByHint.rose,
  birthday: cardGradientByHint["calm-blue"],
  "hari-raya": cardGradientByHint["festive-green"],
  "lunar-new-year": cardGradientByHint["festive-red"],
  deepavali: cardGradientByHint["deepavali-amber"],
  qingming: cardGradientByHint.soft,
  "check-in": cardGradientByHint.soft,
  custom: cardGradientByHint.rose,
};

interface HistoryActivityRow {
  delivery: Delivery;
  accountName: string;
  primaryContactName: string;
  relationshipLabel: string;
  contextLabel: string;
  activityLabel: string;
}

function groupByMonth(items: HistoryActivityRow[]): { month: string; items: HistoryActivityRow[] }[] {
  const map = new Map<string, HistoryActivityRow[]>();
  for (const item of items) {
    const date = new Date(item.delivery.sentAtISO);
    const month = date
      .toLocaleString("en-US", { month: "long", year: "numeric" })
      .toUpperCase();
    if (!map.has(month)) map.set(month, []);
    map.get(month)!.push(item);
  }
  return Array.from(map.entries()).map(([month, list]) => ({ month, items: list }));
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric" });
}

function buildHistoryActivityRows(
  deliveries: Delivery[],
  overview: RemasterDashboardOverview,
): HistoryActivityRow[] {
  const accountByContactId = new Map(
    overview.accounts.map((account) => [account.primaryContactId, account]),
  );
  const contactById = new Map(
    overview.contacts.map((contact) => [contact.id, contact]),
  );
  const activityByDeliveryId = new Map(
    overview.recentActivities.map((activity) => [activity.id.replace(/^activity-/, ""), activity]),
  );

  return deliveries.map((delivery) => {
    const account = delivery.personId ? accountByContactId.get(delivery.personId) ?? null : null;
    const contact = delivery.personId ? contactById.get(delivery.personId) ?? null : null;
    const activity = activityByDeliveryId.get(delivery.id) ?? null;

    return {
      delivery,
      accountName: account?.name ?? delivery.recipientName,
      primaryContactName: contact?.displayName ?? delivery.recipientName,
      relationshipLabel: account ? `${account.relationshipLabel} account` : "Archived contact",
      contextLabel: account?.contextLabel ?? "Delivery history",
      activityLabel: activity?.title ?? delivery.occasionLabel,
    };
  });
}

export default async function HistoryPage() {
  await requireSessionUserOrRedirect("/history");
  const view = await getRemasterHistoryCompatibilityView();
  const rows = buildHistoryActivityRows(view.deliveries, view.overview);
  const groups = groupByMonth(rows);
  const activityCount = rows.length;

  return (
    <div className="ks-page">
      <div className="ks-page-inner ks-page-inner--history">
      <div style={{ marginBottom: 24 }}>
        <p style={{
          margin: "0 0 8px",
          color: "var(--heartline-rose-strong)",
          fontSize: 11,
          fontWeight: 800,
          letterSpacing: "0.09em",
          textTransform: "uppercase",
        }}>
          Activity timeline
        </p>
        <h1 style={{ fontSize: 28, fontWeight: 700, color: "var(--ink-2)", margin: 0 }}>Account activity</h1>
        <p style={{ fontSize: 12.5, color: "var(--gray-2)", marginTop: 5 }}>
          Account/contact outreach history · {activityCount} {activityCount === 1 ? "activity" : "activities"} recorded
        </p>
      </div>
        {groups.length === 0 ? (
          <div style={{
            background: "rgba(255,255,255,0.9)", border: "0.5px solid rgba(239, 224, 218, 0.92)",
            borderRadius: 17, padding: 18, color: "var(--gray-2)", fontSize: 12.5,
          }}>
            No account activity recorded yet. Queued and completed outreach will appear here.
          </div>
        ) : groups.map((g) => (
          <div key={g.month}>
            <div style={{
              fontSize: 11.5, fontWeight: 600, color: "var(--gray-2)",
              letterSpacing: "0.08em", margin: "14px 0 12px",
            }}>
              {g.month}
            </div>
            {g.items.map((row) => {
              const it = row.delivery;
              const badge = channelBadge[it.channel];
              const status = deliveryStatusBadge[it.status];
              return (
                <div key={it.id} style={{
                  display: "flex", alignItems: "center", gap: 14, padding: 13,
                  background: "rgba(255,255,255,0.9)", border: "0.5px solid rgba(239, 224, 218, 0.92)",
                  borderRadius: 17, marginBottom: 10,
                  boxShadow: "0 14px 34px -32px rgba(94, 54, 119, 0.42)",
                }}>
                  <div style={{
                    width: 42, height: 52, borderRadius: 8, flexShrink: 0,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#fff", fontSize: 18, background: gradientByOccasion[it.occasionKind],
                  }}>
                    <Icon name={occasionIcon[it.occasionKind]} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>
                      {row.accountName}
                    </div>
                    <div style={{
                      fontSize: 12, color: "var(--gray-2)", marginTop: 2,
                      display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap",
                    }}>
                      <span>Primary contact: {row.primaryContactName}</span>
                      <span>Outreach: {row.activityLabel}</span>
                      <span style={{
                        fontSize: 10, padding: "2px 8px", borderRadius: 7,
                        display: "flex", alignItems: "center", gap: 4,
                        background: badge.bg, color: badge.fg,
                      }}>
                        <span style={{ fontSize: 11 }}><Icon name={badge.icon} /></span>
                        {badge.label}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--gray-3)", marginTop: 3 }}>
                      {row.relationshipLabel} · {row.contextLabel}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11.5, color: "var(--gray-3)", textAlign: "right" }}>
                      {shortDate(it.sentAtISO)}
                    </div>
                    <div
                      data-delivery-status={it.status}
                      className={`ks-delivery-status ks-delivery-status--${status.tone}`}
                      style={{
                        fontSize: 10.5, color: status.color, display: "flex",
                        alignItems: "center", gap: 4, justifyContent: "flex-end", marginTop: 3,
                        fontWeight: 500,
                      }}
                    >
                      <span style={{ fontSize: 12 }}><Icon name={status.icon} /></span>
                      {status.label}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
