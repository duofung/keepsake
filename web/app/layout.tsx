import type { Metadata } from "next";
import "./globals.css";
import IconSprite from "@/components/IconSprite";
import Rail from "@/components/Rail";

export const metadata: Metadata = {
  title: "Keepsake",
  description: "The right email, to the right person, at the right time.",
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
        <div
          style={{
            width: "100%",
            maxWidth: 1080,
            height: 680,
            background: "#FFFFFF",
            borderRadius: 22,
            border: "0.5px solid #E3E8ED",
            overflow: "hidden",
            display: "flex",
            boxShadow: "0 12px 48px -16px rgba(20,32,43,0.18)",
            position: "relative",
          }}
        >
          <Rail />
          <main style={{ flex: 1, position: "relative", overflow: "hidden", display: "flex", flexDirection: "column" }}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
