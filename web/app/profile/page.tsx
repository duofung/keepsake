import Icon from "@/components/Icon";
import { requireSessionUserOrRedirect } from "@/lib/server/auth/require-session.server";
import {
  getProfileChannelAccounts,
  type ProfileChannelAccount,
  type ProfileChannelAccountsView,
} from "@/lib/server/channel-accounts/profile.server";

export const dynamic = "force-dynamic";

const CONNECT_HREF = "/api/oauth/gmail/start?returnTo=/profile";
const DISCONNECT_ACTION = "/api/gmail/disconnect";
const SIGNOUT_ACTION = "/api/auth/signout";
const MOCK_CHANNEL_LINK_ACTION = "/api/channels/mock/link";
const TELEGRAM_CHANNEL_LINK_ACTION = "/api/channels/telegram/link";

const channelProviderLabel: Record<string, string> = {
  mock: "Mock",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  slack: "Slack",
};

function channelRevokeAction(provider: string) {
  return provider === "telegram"
    ? "/api/channels/telegram/revoke"
    : "/api/channels/mock/revoke";
}

export default async function ProfilePage() {
  const user = await requireSessionUserOrRedirect("/profile");
  const channels = await getProfileChannelAccounts();

  return (
    <div className="ks-page">
      <div className="ks-page-inner ks-page-inner--profile">
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 26 }}>
        <div style={{
          width: 62, height: 62, fontSize: 24, background: "linear-gradient(145deg, #F1BAC9, #8750B4)", color: "#fff",
          borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 600,
          boxShadow: "0 14px 30px -20px rgba(94, 54, 119, 0.72)",
        }}>
          {user.initials}
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--gray-2)", letterSpacing: "0.08em", marginBottom: 5 }}>
            REMASTER WORKSPACE
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, color: "var(--ink-2)" }}>{user.name}</div>
          <div style={{ fontSize: 12.5, color: "var(--gray-2)", marginTop: 3 }}>{user.email}</div>
        </div>
        <div style={{
          marginLeft: "auto", fontSize: 11.5, fontWeight: 650, color: "var(--heartline-purple-deep)",
          background: "var(--heartline-rose-wash)", padding: "7px 13px", borderRadius: 999,
          display: "inline-flex", alignItems: "center", gap: 5,
        }}>
          <span style={{ fontSize: 13 }}><Icon name="i-crown" /></span>
          ReMaster
        </div>
      </div>

      <Section label="OUTREACH DELIVERY">
        <Row
          icon="i-mail"
          title="Outreach sender"
          desc={user.sendingAccount ? `Client and partner outreach sends from ${user.sendingAccount.email}` : "No outbound sender connected for reviewed outreach yet"}
          right={<SendingEmailControls sendingAccount={user.sendingAccount} />}
        />
        <Row icon="i-truck" title="Direct mail return details" desc="Default return identity for gifts, print, and physical outreach" right={<Chev />} last />
      </Section>

      <CommandChannelsSection channels={channels} />

      <Section label="OUTREACH WORKFLOW">
        <Row icon="i-bell" title="Reminder cadence" desc="How far ahead ReMaster surfaces account follow-ups" right={<><Val>7 days before</Val><Chev /></>} />
        <Row icon="i-pencil" title="Drafting voice" desc="How ReMaster drafts client and partner outreach in your voice" right={<><Val>Learning</Val><Chev /></>} />
        <Row icon="i-palette2" title="Print style" desc="Default look for gifts, cards, and physical outreach" right={<><Val>Warm</Val><Chev /></>} last />
      </Section>

      <Section label="PLAN & PRIVACY">
        <Row icon="i-crown" title="ReMaster subscription" desc="Renews 14 May 2027 · account outreach, voice drafting" right={<Chev />} />
        <Row icon="i-shield" title="Privacy & data" desc="Your contact, partner, and client records stay yours, encrypted" right={<Chev />} />
        <SignOutRow />
      </Section>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <p style={{ fontSize: 11.5, fontWeight: 700, color: "var(--gray-2)", letterSpacing: "0.08em", marginBottom: 12 }}>
        {label}
      </p>
      <div style={{
        background: "rgba(255,255,255,0.9)", border: "0.5px solid rgba(239, 224, 218, 0.92)", borderRadius: 18,
        overflow: "hidden", marginBottom: 18,
        boxShadow: "0 14px 34px -32px rgba(94, 54, 119, 0.42)",
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
        width: 34, height: 34, borderRadius: 11, background: "var(--heartline-rose-wash)",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "var(--heartline-purple-deep)", fontSize: 17, flexShrink: 0,
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

function SendingEmailControls({ sendingAccount }: {
  sendingAccount: { email: string; status: "connected" | "expired" } | null;
}) {
  if (!sendingAccount) {
    return (
      <>
        <span style={{ fontSize: 11, color: "var(--gray-2)", fontWeight: 500 }}>
          Not connected
        </span>
        <ConnectLink label="Connect Gmail" />
      </>
    );
  }

  const connected = sendingAccount.status === "connected";

  return (
    <>
      <span style={{
        fontSize: 11,
        color: connected ? "#3F9E78" : "var(--amber)",
        display: "flex",
        alignItems: "center",
        gap: 5,
        fontWeight: 500,
      }}>
        {connected && <span style={{ fontSize: 13 }}><Icon name="i-check-plain" /></span>}
        {connected ? "Connected" : "Expired"}
      </span>
      {!connected && <ConnectLink label="Reconnect Gmail" />}
      <DisconnectButton />
    </>
  );
}

function ConnectLink({ label }: { label: string }) {
  return (
    <a
      href={CONNECT_HREF}
      style={{
        fontSize: 11,
        fontWeight: 500,
        color: "var(--heartline-purple-deep)",
        background: "var(--heartline-rose-wash)",
        padding: "5px 11px",
        borderRadius: 10,
        textDecoration: "none",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </a>
  );
}

function CommandChannelsSection({ channels }: { channels: ProfileChannelAccountsView }) {
  if (channels.dataSource !== "db") {
    return (
      <div
        id="command-channels"
        data-testid="profile-channels-section"
        data-channel-data-source="mock"
      >
        <p style={{
          fontSize: 11.5, fontWeight: 700, color: "var(--gray-2)",
          letterSpacing: "0.08em", marginBottom: 12,
        }}>
          COMMAND CHANNELS
        </p>
        <div style={{
          background: "rgba(255,255,255,0.9)", border: "0.5px solid rgba(239, 224, 218, 0.92)", borderRadius: 18,
          overflow: "hidden", marginBottom: 18,
          boxShadow: "0 14px 34px -32px rgba(94, 54, 119, 0.42)",
        }}>
          <div
            data-testid="profile-channels-placeholder"
            style={{
              display: "flex", alignItems: "center", gap: 13, padding: "14px 16px",
            }}
          >
            <div style={{
              width: 34, height: 34, borderRadius: 11, background: "var(--heartline-rose-wash)",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "var(--heartline-purple-deep)", fontSize: 17, flexShrink: 0,
            }}>
              <Icon name="i-bulb" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink)" }}>
                Command channels are available in DB mode
              </div>
              <div style={{ fontSize: 11.5, color: "var(--gray-3)", marginTop: 1 }}>
                Set <code>KEEPSAKE_DATA_SOURCE=db</code> to link WhatsApp / Telegram / Slack stand-ins as inbound business workflow assistants.
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const accounts = channels.accounts;
  return (
    <div
      id="command-channels"
      data-testid="profile-channels-section"
      data-channel-data-source="db"
    >
      <p style={{
        fontSize: 11.5, fontWeight: 700, color: "var(--gray-2)",
        letterSpacing: "0.08em", marginBottom: 12,
      }}>
        COMMAND CHANNELS
      </p>
      <div style={{
        background: "rgba(255,255,255,0.9)", border: "0.5px solid rgba(239, 224, 218, 0.92)", borderRadius: 18,
        overflow: "hidden", marginBottom: 18,
        boxShadow: "0 14px 34px -32px rgba(94, 54, 119, 0.42)",
      }}>
        {accounts.length === 0 ? (
          <div
            data-testid="profile-channels-empty"
            style={{
              display: "flex", alignItems: "center", gap: 13, padding: "14px 16px",
              borderBottom: "0.5px solid var(--line)",
            }}
          >
            <div style={{
              width: 34, height: 34, borderRadius: 11, background: "var(--heartline-rose-wash)",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "var(--heartline-purple-deep)", fontSize: 17, flexShrink: 0,
            }}>
              <Icon name="i-bulb" />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink)" }}>
                No command channels linked yet
              </div>
              <div style={{ fontSize: 11.5, color: "var(--gray-3)", marginTop: 1 }}>
                Link a Telegram or mock identity so inbound commands can route to this workspace.
              </div>
            </div>
          </div>
        ) : (
          accounts.map((account, idx) => (
            <ChannelRow
              key={account.id}
              account={account}
              last={false /* link form always follows */}
              dividerTop={idx > 0}
            />
          ))
        )}
        <TelegramStartLinkRow link={channels.telegramStartLink} />
        <ChannelLinkForm
          provider="telegram"
          title="Link Telegram user"
          action={TELEGRAM_CHANNEL_LINK_ACTION}
          externalUserPlaceholder="e.g. 123456789"
          displayNamePlaceholder="Telegram display name"
          submitLabel="Link Telegram"
          description="Operator fallback: paste the numeric Telegram user id for this workspace."
          testIdPrefix="profile-channels-telegram-link"
        />
        <ChannelLinkForm
          provider="mock"
          title="Link a mock business assistant identity"
          action={MOCK_CHANNEL_LINK_ACTION}
          externalUserPlaceholder="e.g. mock-user-1"
          displayNamePlaceholder="Assistant identity label"
          submitLabel="Link mock channel"
          testIdPrefix="profile-channels-link"
        />
      </div>
    </div>
  );
}

function TelegramStartLinkRow({
  link,
}: {
  link: ProfileChannelAccountsView["telegramStartLink"];
}) {
  return (
    <div
      data-testid="profile-channels-telegram-start"
      style={{
        display: "flex", alignItems: "center", gap: 13, padding: "14px 16px",
        borderTop: "0.5px solid var(--line)", background: "rgba(255, 248, 245, 0.78)",
      }}
    >
      <div style={{
        width: 34, height: 34, borderRadius: 11, background: "var(--heartline-rose-wash)",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "var(--heartline-purple-deep)", fontSize: 17, flexShrink: 0,
      }}>
        <Icon name="i-send" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink)" }}>
          Start Telegram bot
        </div>
        <div style={{ fontSize: 11.5, color: "var(--gray-3)", marginTop: 1 }}>
          {link?.status === "ready"
            ? "Opens Telegram with a short-lived workspace link token."
            : (link?.detail ?? "Telegram start links are not configured.")}
        </div>
      </div>
      {link?.status === "ready" ? (
        <a
          href={link.url}
          data-testid="profile-channels-telegram-start-link"
          style={{
            fontSize: 11, fontWeight: 650, color: "var(--heartline-purple-deep)",
            background: "var(--heartline-rose-wash)", padding: "5px 11px", borderRadius: 999,
            textDecoration: "none", whiteSpace: "nowrap",
          }}
        >
          Open bot
        </a>
      ) : (
        <span
          data-testid="profile-channels-telegram-start-unavailable"
          style={{ fontSize: 11, color: "var(--gray-2)", fontWeight: 500 }}
        >
          Not configured
        </span>
      )}
    </div>
  );
}

function ChannelRow({
  account,
  last,
  dividerTop,
}: {
  account: ProfileChannelAccount;
  last: boolean;
  dividerTop: boolean;
}) {
  const providerLabel = channelProviderLabel[account.provider] ?? account.provider;
  const isRevoked = account.status === "revoked";
  return (
    <div
      data-testid="profile-channels-row"
      data-channel-account-id={account.id}
      data-channel-status={account.status}
      data-channel-provider={account.provider}
      style={{
        display: "flex", alignItems: "center", gap: 13, padding: "14px 16px",
        borderTop: dividerTop ? "0.5px solid var(--line)" : "none",
        borderBottom: last ? "none" : "0.5px solid var(--line)",
        opacity: isRevoked ? 0.55 : 1,
      }}
    >
      <div style={{
        width: 34, height: 34, borderRadius: 11, background: "var(--heartline-rose-wash)",
        display: "flex", alignItems: "center", justifyContent: "center",
        color: "var(--heartline-purple-deep)", fontSize: 17, flexShrink: 0,
      }}>
        <Icon name="i-send" />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13.5, fontWeight: 500, color: "var(--ink)",
          display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        }}>
          <span>{account.displayName ?? `${providerLabel} channel`}</span>
          <span style={{
            fontSize: 10, fontWeight: 650, padding: "2px 7px", borderRadius: 999,
            background: "var(--soft)", color: "var(--gray-1)",
          }}>
            {providerLabel}
          </span>
          <span
            style={{
              fontSize: 10, fontWeight: 650, padding: "2px 7px", borderRadius: 999,
              background: isRevoked ? "#FBEAE8" : "#E5F2EB",
              color: isRevoked ? "#B83A30" : "#2F7A56",
            }}
          >
            {isRevoked ? "Revoked" : "Active"}
          </span>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--gray-3)", marginTop: 2 }}>
          <span data-testid="profile-channels-row-external-id">{account.externalUserId}</span>
        </div>
      </div>
      {!isRevoked && (
        <form
          method="post"
          action={channelRevokeAction(account.provider)}
          style={{ margin: 0 }}
          data-testid="profile-channels-revoke-form"
        >
          <input type="hidden" name="accountId" value={account.id} />
          <button
            type="submit"
            data-testid="profile-channels-revoke-button"
            style={{
              fontSize: 11, fontWeight: 500, color: "var(--gray-1)",
              background: "transparent", padding: "5px 11px", borderRadius: 10,
              border: "0.5px solid var(--line)", cursor: "pointer",
              fontFamily: "inherit", whiteSpace: "nowrap",
            }}
          >
            Revoke
          </button>
        </form>
      )}
    </div>
  );
}

function ChannelLinkForm({
  provider,
  title,
  action,
  externalUserPlaceholder,
  displayNamePlaceholder,
  submitLabel,
  description,
  testIdPrefix,
}: {
  provider: "mock" | "telegram";
  title: string;
  action: string;
  externalUserPlaceholder: string;
  displayNamePlaceholder: string;
  submitLabel: string;
  description?: string;
  testIdPrefix: string;
}) {
  return (
    <form
      method="post"
      action={action}
      style={{
        display: "flex", flexDirection: "column", gap: 9,
        padding: "14px 16px", margin: 0,
        borderTop: "0.5px solid var(--line)", background: "rgba(255, 248, 245, 0.78)",
      }}
      data-testid={`${testIdPrefix}-form`}
      data-channel-link-provider={provider}
    >
      <div style={{
        fontSize: 12, fontWeight: 500, color: "var(--ink)",
      }}>
        {title}
      </div>
      {description && (
        <div style={{ fontSize: 11.5, color: "var(--gray-3)", marginTop: -4 }}>
          {description}
        </div>
      )}
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 11, color: "var(--gray-2)" }}>External user id</span>
        <input
          type="text"
          name="externalUserId"
          required
          placeholder={externalUserPlaceholder}
          data-testid={`${testIdPrefix}-external-id`}
          style={{
            fontSize: 12.5, padding: "7px 10px", borderRadius: 8,
            border: "0.5px solid var(--line)", background: "rgba(255,255,255,0.86)",
            fontFamily: "inherit",
          }}
        />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 11, color: "var(--gray-2)" }}>Display name (optional)</span>
        <input
          type="text"
          name="displayName"
          placeholder={displayNamePlaceholder}
          data-testid={`${testIdPrefix}-display-name`}
          style={{
            fontSize: 12.5, padding: "7px 10px", borderRadius: 8,
            border: "0.5px solid var(--line)", background: "rgba(255,255,255,0.86)",
            fontFamily: "inherit",
          }}
        />
      </label>
      <button
        type="submit"
        data-testid={`${testIdPrefix}-submit`}
        className="heartline-button"
        style={{
          alignSelf: "flex-start",
          fontSize: 12,
          padding: "7px 14px",
        }}
      >
        {submitLabel}
      </button>
    </form>
  );
}

function SignOutRow() {
  return (
    <form
      method="post"
      action={SIGNOUT_ACTION}
      style={{ margin: 0 }}
      data-testid="profile-signout-form"
    >
      <button
        type="submit"
        data-testid="profile-signout-button"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 13,
          padding: "14px 16px",
          width: "100%",
          background: "transparent",
          border: "none",
          borderTop: "0.5px solid var(--line)",
          cursor: "pointer",
          fontFamily: "inherit",
          textAlign: "left",
          color: "var(--ink)",
        }}
      >
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 11,
            background: "var(--heartline-rose-wash)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--heartline-purple-deep)",
            fontSize: 17,
            flexShrink: 0,
          }}
        >
          <Icon name="i-logout" />
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--ink)" }}>
          Sign out
        </span>
      </button>
    </form>
  );
}

function DisconnectButton() {
  return (
    <form method="post" action={DISCONNECT_ACTION} style={{ margin: 0 }}>
      <button
        type="submit"
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: "var(--gray-1)",
          background: "transparent",
          padding: "5px 11px",
          borderRadius: 10,
          border: "0.5px solid var(--line)",
          cursor: "pointer",
          fontFamily: "inherit",
          whiteSpace: "nowrap",
        }}
      >
        Disconnect
      </button>
    </form>
  );
}
