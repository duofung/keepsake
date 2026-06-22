"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Icon from "./Icon";

const nav = [
  { href: "/", key: "home", icon: "i-home", title: "Home" },
  { href: "/workspace", key: "workspace", icon: "i-edit", title: "Workspace" },
  { href: "/people", key: "people", icon: "i-users", title: "People" },
  { href: "/history", key: "history", icon: "i-history", title: "History" },
];

export default function Rail() {
  const pathname = usePathname();
  const active = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <nav
      style={{
        width: 78,
        background: "var(--rail)",
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "18px 0",
        gap: 8,
        zIndex: 5,
        borderRight: "0.5px solid rgba(239, 224, 218, 0.86)",
        boxShadow: "10px 0 32px -30px rgba(94, 54, 119, 0.5)",
      }}
    >
      <div
        style={{
          width: 46, height: 46, borderRadius: 16, background: "linear-gradient(145deg, var(--heartline-rose-strong), var(--heartline-purple))",
          display: "flex", alignItems: "center", justifyContent: "center",
          marginBottom: 3, boxShadow: "0 14px 28px -18px rgba(94, 54, 119, 0.75)",
          color: "#fff", fontSize: 22,
        }}
      >
        <Icon name="i-heart-handshake" />
      </div>
      <div
        style={{
          fontSize: 9.5,
          fontWeight: 700,
          color: "var(--heartline-purple-deep)",
          letterSpacing: "0.02em",
          marginBottom: 14,
        }}
      >
        Heartline
      </div>

      {nav.map((n) => (
        <Link key={n.key} href={n.href} title={n.title} aria-label={n.title}
          style={{
            width: 44, height: 44, borderRadius: 15,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 21, transition: ".18s",
            color: active(n.href) ? "var(--heartline-purple-deep)" : "#B6A7B0",
            background: active(n.href) ? "var(--heartline-rose-wash)" : "transparent",
            boxShadow: active(n.href) ? "inset 0 0 0 0.5px rgba(204, 120, 153, 0.18)" : "none",
            textDecoration: "none",
          }}
        >
          <Icon name={n.icon} />
        </Link>
      ))}

      <Link
        href="/profile"
        aria-label="Profile"
        style={{
          marginTop: "auto", width: 38, height: 38, borderRadius: "50%",
          background: "linear-gradient(145deg, #F1BAC9, #8750B4)", display: "flex", alignItems: "center",
          justifyContent: "center", color: "#fff", fontSize: 13, fontWeight: 600,
          textDecoration: "none",
          boxShadow: "0 10px 22px -16px rgba(94, 54, 119, 0.72)",
        }}
      >
        A
      </Link>
    </nav>
  );
}
