"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Icon from "./Icon";

const nav = [
  { href: "/", key: "home", icon: "i-home", title: "Home" },
  { href: "/people", key: "people", icon: "i-users", title: "People" },
  { href: "/workspace", key: "workspace", icon: "i-edit", title: "Workspace" },
  { href: "/history", key: "history", icon: "i-history", title: "History" },
];

export default function Rail() {
  const pathname = usePathname();
  const active = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <nav
      style={{
        width: 68,
        background: "var(--rail)",
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "20px 0",
        gap: 8,
        zIndex: 5,
      }}
    >
      <div
        style={{
          width: 36, height: 36, borderRadius: 12, background: "var(--blue)",
          display: "flex", alignItems: "center", justifyContent: "center",
          marginBottom: 14, boxShadow: "0 4px 12px -3px rgba(56,168,245,0.5)",
          color: "#fff", fontSize: 19,
        }}
      >
        <Icon name="i-heart-handshake" />
      </div>

      {nav.map((n) => (
        <Link key={n.key} href={n.href} title={n.title} aria-label={n.title}
          style={{
            width: 42, height: 42, borderRadius: 12,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 21, transition: ".18s",
            color: active(n.href) ? "var(--blue)" : "#AEB8C2",
            background: active(n.href) ? "#fff" : "transparent",
            boxShadow: active(n.href) ? "0 2px 8px -2px rgba(20,32,43,0.1)" : "none",
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
          marginTop: "auto", width: 34, height: 34, borderRadius: "50%",
          background: "var(--blue)", display: "flex", alignItems: "center",
          justifyContent: "center", color: "#fff", fontSize: 13, fontWeight: 600,
          textDecoration: "none",
        }}
      >
        A
      </Link>
    </nav>
  );
}
