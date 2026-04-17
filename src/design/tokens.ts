// Design tokens — single source of truth for the Marketify visual language.
// Mirrors docs/design.md §1.2 (palette), §1.5 (corners/borders/shadow), and §4 (16px gutter, 12px vertical rhythm).
// Values are `as const` so downstream code gets literal types, not widened string/number.

export const colors = {
  primary: '#EC4899',
  primarySoft: '#FDF2F8',
  primaryDeep: '#831843',

  cta: '#F97316',
  ctaDeep: '#9A3412',

  ink: '#0F172A',
  ink70: '#475569',
  ink40: '#94A3B8',

  surface: '#FFFFFF',
  canvas: '#FFF9F2',
  hairline: '#E5E7EB',

  success: '#16A34A',
  successSoft: '#DCFCE7',
  danger: '#DC2626',
  dangerSoft: '#FEE2E2',
  warning: '#F59E0B',
  warningSoft: '#FEF3C7',
  cancelled: '#6B7280',
  cancelledSoft: '#F3F4F6',

  // Shadow color is always ink per spec §1.2 row "Shadow" — kept as a named alias for palette completeness.
  shadow: '#0F172A',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radii = {
  card: 12,
  button: 10,
  input: 10,
  image: 8,
  pill: 999,
} as const;

// Neubrutalist hard shadow — solid ink offset (3,3), opacity 1, radius 0.
// RN android uses `elevation`; the hard-shadow look is iOS-primary, android gets a matching elevation hint.
export const shadows = {
  hard: {
    shadowColor: colors.ink,
    shadowOffset: { width: 3, height: 3 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 4,
  },
  none: {
    shadowColor: 'transparent',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
} as const;

export type ColorToken = keyof typeof colors;
export type SpacingToken = keyof typeof spacing;
export type RadiusToken = keyof typeof radii;
export type ShadowToken = keyof typeof shadows;
