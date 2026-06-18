import { redirect } from "next/navigation";
import { AuthError, currentSessionUserOrThrow } from "@/lib/server/auth/current-user.server";
import { isDevSessionRoutesEnabled } from "@/lib/server/auth/session.server";
import { safeReturnTo } from "@/lib/server/auth/require-session.server";

export const dynamic = "force-dynamic";

interface SignInPageProps {
  readonly searchParams: Promise<{ readonly returnTo?: string }>;
}

export default async function SignInPage({ searchParams }: SignInPageProps) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.returnTo ?? null);

  // If the visitor already has a valid session, bounce them straight
  // home. A misconfigured auth seam still surfaces as a 500.
  try {
    await currentSessionUserOrThrow();
    redirect(returnTo);
  } catch (error) {
    if (error instanceof AuthError) {
      if (error.kind === "misconfigured") throw error;
      // unauthenticated — fall through to render the page
    } else {
      // The redirect() helper throws — re-raise so Next can handle it.
      throw error;
    }
  }

  const devEnabled = isDevSessionRoutesEnabled();
  const googleHref = `/api/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`;
  const devAction = `/api/auth/dev-session/start?returnTo=${encodeURIComponent(returnTo)}`;

  return (
    <main
      data-testid="signin-page"
      style={{
        maxWidth: 380,
        margin: "0 auto",
        padding: "72px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 20,
      }}
    >
      <header>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--ink-2)" }}>
          Sign in to Keepsake
        </h1>
        <p
          style={{
            marginTop: 8,
            fontSize: 13,
            color: "var(--gray-2)",
            lineHeight: 1.5,
          }}
        >
          We use Google to identify your account. You can connect a Gmail
          sending address separately, later.
        </p>
      </header>

      <a
        href={googleHref}
        data-testid="signin-google-cta"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "11px 16px",
          fontSize: 14,
          fontWeight: 500,
          borderRadius: 10,
          background: "var(--blue)",
          color: "#fff",
          textDecoration: "none",
        }}
      >
        Continue with Google
      </a>

      {devEnabled && (
        <form
          method="POST"
          action={devAction}
          data-testid="signin-dev-form"
          style={{ display: "flex", flexDirection: "column", gap: 6 }}
        >
          <button
            type="submit"
            data-testid="signin-dev-cta"
            style={{
              padding: "10px 16px",
              fontSize: 13,
              fontWeight: 500,
              borderRadius: 10,
              border: "0.5px solid var(--line)",
              background: "#fff",
              color: "var(--gray-1)",
              cursor: "pointer",
            }}
          >
            Continue as dev owner
          </button>
          <p style={{ fontSize: 11, color: "var(--gray-3)", marginTop: 0 }}>
            Dev-only shortcut. Visible because
            <code style={{ marginLeft: 4 }}>ENABLE_DEV_SESSION_ROUTES=1</code>
            .
          </p>
        </form>
      )}
    </main>
  );
}
