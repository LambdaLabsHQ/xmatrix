interface AlternativePainPoint {
  title: string;
  problem: string;
  xmatrixAnswer: string;
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

export interface AlternativeEntry {
  slug: string;
  name: string;
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
  relatedSlugs: readonly string[];
}

export interface AlternativePage extends AlternativeEntry {
  routeSlug: string;
  href: string;
}
