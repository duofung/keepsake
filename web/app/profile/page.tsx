import Icon from "@/components/Icon";

export default function ProfilePage() {
  return (
    <div className="ks-page">
      <div className="ks-page-inner ks-page-inner--profile">
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 26 }}>
        <div style={{
          width: 62, height: 62, fontSize: 24, background: "var(--blue)", color: "#fff",
          borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 600,
        }}>
          A
        </div>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600, color: "var(--ink-2)" }}>Arthur</div>
          <div style={{ fontSize: 12.5, color: "var(--gray-2)", marginTop: 3 }}>arthur@keepsake.app</div>
        </div>
        <div style={{
          marginLeft: "auto", fontSize: 11.5, fontWeight: 500, color: "var(--blue-deep)",
          background: "var(--blue-wash)", padding: "7px 13px", borderRadius: 12,
          display: "inline-flex", alignItems: "center", gap: 5,
        }}>
          <span style={{ fontSize: 13 }}><Icon name="i-crown" /></span>
          Keepsake+
        </div>
      </div>

      <Section label="SENDING">
        <Row icon="i-mail" title="Sending email" desc="Emails are sent from your connected address" right={<Connected />} />
        <Row icon="i-truck" title="Mailing address book" desc="Where printed cards get sent from" right={<Chev />} last />
      </Section>

      <Section label="PREFERENCES">
        <Row icon="i-bell" title="Reminders" desc="How far ahead Keepsake nudges you" right={<><Val>7 days before</Val><Chev /></>} />
        <Row icon="i-pencil" title="My voice" desc="How Keepsake learns to write like you" right={<><Val>Learning</Val><Chev /></>} />
        <Row icon="i-palette2" title="Card style" desc="Your default look for designed cards" right={<><Val>Warm</Val><Chev /></>} last />
      </Section>

      <Section label="ACCOUNT">
        <Row icon="i-crown" title="Keepsake+ subscription" desc="Renews 14 May 2026 · designed cards, your voice" right={<Chev />} />
        <Row icon="i-shield" title="Privacy & data" desc="Your relationships stay yours, encrypted" right={<Chev />} />
        <Row icon="i-logout" title="Sign out" last />
      </Section>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <p style={{ fontSize: 11.5, fontWeight: 600, color: "var(--gray-2)", letterSpacing: "0.04em", marginBottom: 12 }}>
        {label}
      </p>
      <div style={{
        background: "#fff", border: "0.5px solid var(--line)", borderRadius: 14,
        overflow: "hidden", marginBottom: 18,
      }}>
        {children}
      </div>
    </>
  );
}

function Row({ icon, title, desc, right, last }: {
  icon: string; title: string; desc?: string; right?: React.ReactNode; last?: boolean;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 13, padding: "14px 16px",
      borderBottom: last ? "none" : "0.5px solid var(--line)", cursor: "pointer",
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: 10, background: "var(--soft)",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "var(--gray-1)", fontSize: 17, flexShrink: 0,
      }}>
        <Icon name={icon} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink)" }}>{title}</div>
        {desc && <div style={{ fontSize: 11.5, color: "var(--gray-3)", marginTop: 1 }}>{desc}</div>}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>{right}</div>
    </div>
  );
}

function Val({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 12.5, color: "var(--gray-2)" }}>{children}</span>;
}
function Chev() {
  return <span style={{ color: "var(--gray-3)", fontSize: 17 }}><Icon name="i-chev" /></span>;
}
function Connected() {
  return (
    <span style={{ fontSize: 11, color: "#3F9E78", display: "flex", alignItems: "center", gap: 5, fontWeight: 500 }}>
      <span style={{ fontSize: 13 }}><Icon name="i-check-plain" /></span>
      Connected
    </span>
  );
}
