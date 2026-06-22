import type { Metadata } from "next";
import "./globals.css";
import IconSprite from "@/components/IconSprite";
import Rail from "@/components/Rail";

export const metadata: Metadata = {
  title: "Heartline",
  description: "Nurture every connection with timely, meaningful notes.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <IconSprite />
        {/* App shell: fills the viewport on desktop / MacBook fullscreen.
            The 1080×680 prototype card has been retired — visual language
            (colours, type, spacing inside each view) stays the same. */}
        <div
          style={{
            width: "100vw",
            height: "100dvh",
            minHeight: "100vh",
            background: "var(--heartline-bg)",
            overflow: "hidden",
            display: "flex",
            position: "relative",
          }}
        >
          <Rail />
          <main style={{ flex: 1, position: "relative", overflow: "hidden", display: "flex", flexDirection: "column", background: "var(--heartline-bg)" }}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
