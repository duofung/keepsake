// Maps domain values to UI tokens (icon names, gradients, badge backgrounds).
// Kept out of domain.ts so the DB shape stays clean and these can change freely.

import type { Channel, OccasionKind, Tone } from "./domain";

export const occasionIcon: Record<OccasionKind, string> = {
  anniversary: "i-heart",
  birthday: "i-cake",
  "hari-raya": "i-moon",
  "lunar-new-year": "i-leaf",
  deepavali: "i-lamp",
  qingming: "i-leaf",
  "check-in": "i-bulb",
  custom: "i-heart",
};

export const occasionTintBg: Record<OccasionKind, string> = {
  anniversary: "#FBEAF0",
  birthday: "#FCE9DE",
  "hari-raya": "#E3F2EC",
  "lunar-new-year": "#F4E7E5",
  deepavali: "#FCE9DE",
  qingming: "#E5EFE3",
  "check-in": "#F0F3F6",
  custom: "#F0F3F6",
};

export const toneIcon: Record<Tone, string> = {
  "tender-intimate": "i-heart",
  playful: "i-heart",
  heartfelt: "i-heart",
  "warm-caring": "i-heart",
  "warm-festive": "i-moon",
  "warm-easy": "i-heart",
  "light-warm": "i-heart",
};

export const toneHumanLabel: Record<Tone, string> = {
  "tender-intimate": "Tender & intimate",
  playful: "Playful",
  heartfelt: "Heartfelt",
  "warm-caring": "Warm & caring",
  "warm-festive": "Warm & festive",
  "warm-easy": "Warm & easy",
  "light-warm": "Light & warm",
};

export const cardGradientByHint: Record<string, string> = {
  rose: "linear-gradient(150deg,#E59ABF,#B5538C)",
  "warm-pastel": "linear-gradient(150deg,#FBD9C4,#F3A9C2)",
  "festive-green": "linear-gradient(150deg,#F6C99A,#E88B5A)",
  "calm-blue": "linear-gradient(150deg,#9FC9E8,#5C8BD1)",
  soft: "linear-gradient(150deg,#CDE7F7,#A9C2F3)",
  // History thumbnails
  "festive-red": "linear-gradient(150deg,#E8746B,#C23A42)",
  "deepavali-amber": "linear-gradient(150deg,#E08A2E,#C25A1E)",
};

export const channelBadge: Record<Channel, { bg: string; fg: string; label: string; icon: string }> = {
  email: { bg: "var(--blue-wash)", fg: "var(--blue-deep)", label: "Email", icon: "i-mail" },
  post: { bg: "#FBEFE4", fg: "#B5832E", label: "Card", icon: "i-truck" },
};

// "in 12 days" → soon; "in 4 months" → mid; "Last note · 2 mo ago" → far.
export function urgencyLevel(daysUntil: number): "soon" | "mid" | "far" {
  if (daysUntil < 0) return "far";
  if (daysUntil <= 12) return "soon";
  return "mid";
}

// Format the small chip text shown on cards and the workspace bar.
export function nodeChipText(
  occasionLabel: string,
  daysUntil: number,
): string {
  if (daysUntil < 0) {
    const months = Math.round(Math.abs(daysUntil) / 30);
    if (months >= 1) return `Last note · ${months} mo ago`;
    return `Last note · ${Math.abs(daysUntil)}d ago`;
  }
  if (daysUntil <= 30) return `${occasionLabel} · in ${daysUntil} days`;
  const months = Math.round(daysUntil / 30);
  return `${occasionLabel} · in ${months} months`;
}
