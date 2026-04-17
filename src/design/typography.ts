// Typography — typed text-style presets for the Marketify design system.
// Mirrors docs/design.md §1.3 (font pairing table + line-height rules).
//
// Font substitution: docs/design.md names Clash Display (headings) and Satoshi (body).
// Both are Fontshare-hosted and do not ship with Expo Google Fonts; we use the explicit
// fallbacks listed in §1.3 — Outfit for display/headings, Rubik for body/caption — plus
// JetBrains Mono for monospace. Spec-sanctioned per the same section.
//
// `fontFamily` values are the string keys registered with `expo-font.useFonts` in
// `app/_layout.tsx`. They MUST match the constant names imported from
// `@expo-google-fonts/*` so RN can resolve the loaded assets by name.

import {
  Outfit_600SemiBold,
  Outfit_700Bold,
} from '@expo-google-fonts/outfit';
import {
  Rubik_500Medium,
  Rubik_700Bold,
} from '@expo-google-fonts/rubik';
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono';
import type { TextStyle } from 'react-native';

export const fontFamilies = {
  displayBold: 'Outfit_700Bold',
  displaySemi: 'Outfit_600SemiBold',
  bodyMedium: 'Rubik_500Medium',
  bodyBold: 'Rubik_700Bold',
  mono: 'JetBrainsMono_500Medium',
} as const;

// Map consumed by `useFonts` — values are the numeric asset handles exported by
// @expo-google-fonts/*, keys are the runtime font-family names.
export const fontAssets = {
  [fontFamilies.displayBold]: Outfit_700Bold,
  [fontFamilies.displaySemi]: Outfit_600SemiBold,
  [fontFamilies.bodyMedium]: Rubik_500Medium,
  [fontFamilies.bodyBold]: Rubik_700Bold,
  [fontFamilies.mono]: JetBrainsMono_500Medium,
} as const;

// Line heights per §1.3: 1.15 for display, ~1.55 for body. Caption + mono tighten
// to 1.4 for dense data rows.
export const textStyles = {
  display: {
    fontFamily: fontFamilies.displayBold,
    fontSize: 28,
    lineHeight: 32,
  },
  h1: {
    fontFamily: fontFamilies.displaySemi,
    fontSize: 22,
    lineHeight: 25,
  },
  h2: {
    fontFamily: fontFamilies.displaySemi,
    fontSize: 20,
    lineHeight: 23,
  },
  body: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 15,
    lineHeight: 23,
  },
  caption: {
    fontFamily: fontFamilies.bodyMedium,
    fontSize: 13,
    lineHeight: 18,
  },
  mono: {
    fontFamily: fontFamilies.mono,
    fontSize: 14,
    lineHeight: 20,
  },
} as const satisfies Record<string, TextStyle>;

export type TextStyleToken = keyof typeof textStyles;
export type FontFamilyToken = keyof typeof fontFamilies;
