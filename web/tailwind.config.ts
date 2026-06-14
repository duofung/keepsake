import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        blue: {
          DEFAULT: "#38A8F5",
          deep: "#2C90DE",
          wash: "#F0F8FE",
          chip: "#DCEFFB",
        },
        ink: { DEFAULT: "#14202B", 2: "#0E1620" },
        gray: { 1: "#5A6573", 2: "#8A95A1", 3: "#98A2AD" },
        line: "#EDF0F3",
        rail: "#F4F7FA",
        soft: { DEFAULT: "#F5F7FA", 2: "#F0F3F6" },
        amber: "#E0A92E",
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
