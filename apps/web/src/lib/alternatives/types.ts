export const ALTERNATIVE_SLUGS = [
  "raft",
  "lody",
  "multica",
  "paradev",
  "conductor",
  "orca",
  "lobehub",
  "cumora",
  "t3-code",
  "herdr",
  "seedmux",
  "linear",
  "notion",
  "slack-code",
  "nowledge-mem",
  "everos",
  "youmind",
  "jules",
] as const;

export type AlternativeSlug = (typeof ALTERNATIVE_SLUGS)[number];

export interface AlternativeSource {
  label: string;
  href: string;
}

interface AlternativePainPoint {
  title: string;
  problem: string;
  xmatrixAnswer: string;
  sources?: readonly AlternativeSource[];
}

interface AlternativeComparisonRow {
  dimension: string;
  xmatrix: string;
  competitor: string;
}

interface AlternativeFaq {
  question: string;
  answer: string;
}

export interface AlternativeLocaleCopy {
  alsoKnownAs?: string;
  verifiedDate: string;
  statusNote?: string;
  metaTitle: string;
  metaDescription: string;
  eyebrow: string;
  headline: string;
  lead: string;
  productCaption: string;
  painPoints: readonly AlternativePainPoint[];
  comparisonRows: readonly AlternativeComparisonRow[];
  stayWhen: readonly string[];
  switchWhen: readonly string[];
  migrationSteps: readonly { title: string; detail: string }[];
  faqs: readonly AlternativeFaq[];
}

export interface AlternativeEntry extends AlternativeLocaleCopy {
  slug: AlternativeSlug;
  name: string;
  relatedSlugs: readonly AlternativeSlug[];
}

export interface AlternativePage extends AlternativeEntry {
  routeSlug: string;
  basePath: string;
  href: string;
  verifiedDateIso: string;
}
