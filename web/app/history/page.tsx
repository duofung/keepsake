import Icon from "@/components/Icon";
import { getDeliveryHistory } from "@/lib/server/delivery-history/mock.server";
import { cardGradientByHint, channelBadge, occasionIcon } from "@/lib/presentation";
import type { Delivery, OccasionKind } from "@/lib/domain";

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

function groupByMonth(items: Delivery[]): { month: string; items: Delivery[] }[] {
  const map = new Map<string, Delivery[]>();
  for (const d of items) {
    const date = new Date(d.sentAtISO);
    const month = date
      .toLocaleString("en-US", { month: "long", year: "numeric" })
      .toUpperCase();
    if (!map.has(month)) map.set(month, []);
    map.get(month)!.push(d);
  }
  return Array.from(map.entries()).map(([month, list]) => ({ month, items: list }));
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric" });
}

export default async function HistoryPage() {
  const history = await getDeliveryHistory();
  const groups = groupByMonth(history);
  const deliveryCount = history.length;

  return (
    <div className="ks-page">
      <div className="ks-page-inner ks-page-inner--history">
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--ink-2)" }}>History</h1>
        <p style={{ fontSize: 12.5, color: "var(--gray-2)", marginTop: 5 }}>
          Everything you've sent · {deliveryCount} {deliveryCount === 1 ? "keepsake" : "keepsakes"} and counting
        </p>
      </div>
        {groups.map((g) => (
          <div key={g.month}>
            <div style={{
              fontSize: 11.5, fontWeight: 600, color: "var(--gray-2)",
              letterSpacing: "0.04em", margin: "14px 0 12px",
            }}>
              {g.month}
            </div>
            {g.items.map((it) => {
              const badge = channelBadge[it.channel];
              const statusLabel = it.status === "opened" ? "Opened"
                : it.status === "delivered" ? "Delivered"
                : it.status === "sent" ? "Sent" : "Queued";
              return (
                <div key={it.id} style={{
                  display: "flex", alignItems: "center", gap: 14, padding: 13,
                  background: "#fff", border: "0.5px solid var(--line)",
                  borderRadius: 13, marginBottom: 10,
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
                      {it.recipientName}
                    </div>
                    <div style={{
                      fontSize: 12, color: "var(--gray-2)", marginTop: 2,
                      display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap",
                    }}>
                      {it.occasionLabel}
                      <span style={{
                        fontSize: 10, padding: "2px 8px", borderRadius: 7,
                        display: "flex", alignItems: "center", gap: 4,
                        background: badge.bg, color: badge.fg,
                      }}>
                        <span style={{ fontSize: 11 }}><Icon name={badge.icon} /></span>
                        {badge.label}
                      </span>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11.5, color: "var(--gray-3)", textAlign: "right" }}>
                      {shortDate(it.sentAtISO)}
                    </div>
                    <div style={{
                      fontSize: 10.5, color: "#3F9E78", display: "flex",
                      alignItems: "center", gap: 4, justifyContent: "flex-end", marginTop: 3,
                    }}>
                      <span style={{ fontSize: 12 }}><Icon name="i-check-plain" /></span>
                      {statusLabel}
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
