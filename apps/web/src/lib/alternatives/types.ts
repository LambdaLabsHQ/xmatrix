export type AlternativeCategoryId = "workspaces" | "control-planes" | "platforms";

export interface AlternativeCategory {
  id: AlternativeCategoryId;
  label: string;
  description: string;
}

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
  category: AlternativeCategoryId;
  verifiedDate: string;
  statusNote?: string;
  metaTitle: string;
  metaDescription: string;
  eyebrow: string;
  headline: string;
  lead: string;
  indexSummary: string;
  painPoints: readonly AlternativePainPoint[];
  comparisonRows: readonly AlternativeComparisonRow[];
  stayWhen: readonly string[];
  switchWhen: readonly string[];
  migrationSteps: readonly { title: string; detail: string }[];
  faqs: readonly AlternativeFaq[];
  relatedSlugs: readonly string[];
}

export interface AlternativePage extends AlternativeEntry {
  href: string;
}
