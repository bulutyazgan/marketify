// US-062 — Illustration registry for the shared `EmptyState` component.
//
// Per docs/design.md §6 the component takes a string-keyed illustration
// (no loose SVGs): each key in `EmptyStateIllustrationKey` maps to a ship-
// in-repo SVG rendered via `react-native-svg`'s `SvgXml`.
//
// Color palette is restricted to the three tokens §1.5 allows for empty-
// state art: primary (#EC4899), cta (#F97316), ink (#0F172A). No soft
// tints, no shadows — just strokes and the three fills.
//
// Why inline strings rather than `assets/illustrations/*.svg` files on
// disk (which §6 recommends): Metro does not transform `.svg` imports
// without `react-native-svg-transformer`, and adding that dependency is
// out of scope for this story. Inline XML ships the same artwork in the
// same git commit and is trivially editable. If a future story introduces
// the transformer we can move these strings into files without churning
// the consumer API.

export type EmptyStateIllustrationKey =
  | 'no_eligible'
  | 'no_applications'
  | 'no_submissions'
  | 'no_campaigns'
  | 'lister_no_campaigns'
  | 'lister_no_applications'
  | 'lister_no_submissions'
  | 'no_notifications'
  | 'network_error'
  | 'not_found';

// Magnifying glass scanning a card — Discover empty (no eligible campaigns).
const NO_ELIGIBLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none">
  <rect x="20" y="22" width="60" height="76" rx="6" stroke="#0F172A" stroke-width="2.5"/>
  <line x1="30" y1="40" x2="70" y2="40" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="30" y1="54" x2="62" y2="54" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="30" y1="68" x2="56" y2="68" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="84" cy="80" r="16" stroke="#EC4899" stroke-width="3"/>
  <line x1="96" y1="92" x2="106" y2="102" stroke="#EC4899" stroke-width="4" stroke-linecap="round"/>
</svg>`;

// Paper airplane above an outbox — Creator "Applied" empty (nothing sent).
const NO_APPLICATIONS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none">
  <rect x="18" y="68" width="84" height="34" rx="6" stroke="#0F172A" stroke-width="2.5"/>
  <path d="M30 68 L42 80 L78 80 L90 68" stroke="#0F172A" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  <path d="M44 46 L92 22 L74 64 L64 50 Z" stroke="#EC4899" stroke-width="3" stroke-linejoin="round"/>
  <line x1="64" y1="50" x2="92" y2="22" stroke="#EC4899" stroke-width="3"/>
</svg>`;

// Empty video frame with play triangle — Creator "Submitted" empty.
const NO_SUBMISSIONS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none">
  <rect x="18" y="28" width="84" height="64" rx="8" stroke="#0F172A" stroke-width="2.5"/>
  <path d="M54 48 L78 60 L54 72 Z" stroke="#EC4899" stroke-width="3" stroke-linejoin="round"/>
  <line x1="18" y1="100" x2="60" y2="100" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="68" y1="100" x2="94" y2="100" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

// Three stacked cards — reserved generic "no campaigns" (creator drafts etc.).
const NO_CAMPAIGNS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none">
  <rect x="22" y="30" width="62" height="44" rx="6" stroke="#0F172A" stroke-width="2.5"/>
  <rect x="32" y="44" width="62" height="44" rx="6" stroke="#EC4899" stroke-width="3" fill="none"/>
  <line x1="44" y1="60" x2="78" y2="60" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="44" y1="72" x2="66" y2="72" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

// Megaphone with plus — Lister "Campaigns" empty (post your first bounty).
const LISTER_NO_CAMPAIGNS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none">
  <path d="M28 52 L28 76 L44 76 L84 94 L84 34 L44 52 Z" stroke="#0F172A" stroke-width="2.5" stroke-linejoin="round"/>
  <line x1="44" y1="52" x2="44" y2="76" stroke="#0F172A" stroke-width="2.5"/>
  <circle cx="92" cy="36" r="10" stroke="#EC4899" stroke-width="3"/>
  <line x1="92" y1="32" x2="92" y2="40" stroke="#EC4899" stroke-width="3" stroke-linecap="round"/>
  <line x1="88" y1="36" x2="96" y2="36" stroke="#EC4899" stroke-width="3" stroke-linecap="round"/>
</svg>`;

// Open inbox with incoming arrow — Lister inbox "Applications" empty.
const LISTER_NO_APPLICATIONS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none">
  <rect x="20" y="54" width="80" height="48" rx="6" stroke="#0F172A" stroke-width="2.5"/>
  <path d="M20 72 L42 72 L50 84 L70 84 L78 72 L100 72" stroke="#0F172A" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  <line x1="60" y1="18" x2="60" y2="44" stroke="#EC4899" stroke-width="3" stroke-linecap="round"/>
  <path d="M52 36 L60 44 L68 36" stroke="#EC4899" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
</svg>`;

// Video frame with dashed outline — Lister inbox "Submissions" empty.
const LISTER_NO_SUBMISSIONS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none">
  <rect x="18" y="26" width="84" height="64" rx="8" stroke="#0F172A" stroke-width="2.5" stroke-dasharray="6 4"/>
  <path d="M54 46 L78 58 L54 70 Z" stroke="#EC4899" stroke-width="3" stroke-linejoin="round"/>
  <circle cx="92" cy="92" r="10" stroke="#EC4899" stroke-width="3"/>
  <line x1="99" y1="99" x2="106" y2="106" stroke="#EC4899" stroke-width="3" stroke-linecap="round"/>
</svg>`;

// Bell with quiet-line — Activity (notifications) empty.
const NO_NOTIFICATIONS = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none">
  <path d="M38 74 L38 58 Q38 40 60 40 Q82 40 82 58 L82 74 L88 82 L32 82 Z" stroke="#0F172A" stroke-width="2.5" stroke-linejoin="round"/>
  <path d="M52 88 Q60 96 68 88" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="60" y1="30" x2="60" y2="36" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="94" y1="52" x2="104" y2="52" stroke="#EC4899" stroke-width="3" stroke-linecap="round"/>
  <line x1="94" y1="62" x2="102" y2="62" stroke="#EC4899" stroke-width="3" stroke-linecap="round"/>
</svg>`;

// Cloud with diagonal slash — network / offline.
const NETWORK_ERROR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none">
  <path d="M30 74 Q20 74 20 62 Q20 50 34 50 Q38 36 54 36 Q72 36 76 52 Q92 52 92 64 Q92 74 82 74 Z" stroke="#0F172A" stroke-width="2.5" stroke-linejoin="round"/>
  <line x1="24" y1="26" x2="100" y2="102" stroke="#F97316" stroke-width="4" stroke-linecap="round"/>
</svg>`;

// Question mark in hard-shadow badge — not found.
const NOT_FOUND = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none">
  <rect x="26" y="26" width="68" height="68" rx="12" stroke="#0F172A" stroke-width="2.5"/>
  <path d="M46 52 Q46 38 60 38 Q74 38 74 50 Q74 60 60 64 L60 72" stroke="#EC4899" stroke-width="3.5" stroke-linecap="round" fill="none"/>
  <circle cx="60" cy="82" r="3" fill="#EC4899"/>
</svg>`;

export const ILLUSTRATIONS: Record<EmptyStateIllustrationKey, string> = {
  no_eligible: NO_ELIGIBLE,
  no_applications: NO_APPLICATIONS,
  no_submissions: NO_SUBMISSIONS,
  no_campaigns: NO_CAMPAIGNS,
  lister_no_campaigns: LISTER_NO_CAMPAIGNS,
  lister_no_applications: LISTER_NO_APPLICATIONS,
  lister_no_submissions: LISTER_NO_SUBMISSIONS,
  no_notifications: NO_NOTIFICATIONS,
  network_error: NETWORK_ERROR,
  not_found: NOT_FOUND,
};
