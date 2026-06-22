import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        blue: {
          DEFAULT: "#8750B4",
          deep: "#5E3677",
          wash: "#F4EAF8",
          chip: "#EBD8F1",
        },
        heartline: {
          bg: "#FFF8F5",
          card: "#FFFFFF",
          rose: "#F3C4D3",
          purple: "#8750B4",
          plum: "#2C2131",
          sage: "#7C936F",
        },
        ink: { DEFAULT: "#2F2532", 2: "#211823" },
        gray: { 1: "#6B5C67", 2: "#978792", 3: "#B5A7B0" },
        line: "#EFE0DA",
        rail: "#FFF2EE",
        soft: { DEFAULT: "#FFF4F1", 2: "#F4E7E2" },
        amber: "#D99540",
      },
      fontFamily: {
        ui: ["Inter", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        serif: ["Newsreader", "Georgia", "serif"],
      },
      borderRadius: { xl2: "22px" },
    },
  },
  plugins: [],
};

export default config;
