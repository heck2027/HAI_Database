export type SourceTier = 'Tier 1' | 'Tier 2' | 'Tier 3';

export type ReviewerStatus = 'AI Screened' | 'Human Approved' | 'Flagged for Review' | 'Rejected';

export type LinkStatus = 'ok' | 'redirected' | 'broken' | 'unreachable' | 'unchecked';

export type ObjectiveCategory =
  | 'Human Health & Development'
  | 'Animal Health & Welfare'
  | 'Human-Animal Interaction & Bonding'
  | 'Safety & Risk'
  | 'Crisis & Life Challenges';

export const OBJECTIVE_CATEGORIES: ObjectiveCategory[] = [
  'Human Health & Development',
  'Animal Health & Welfare',
  'Human-Animal Interaction & Bonding',
  'Safety & Risk',
  'Crisis & Life Challenges',
];

// Species list strictly matching the specification:
export const SPECIES_LIST = [
  'Multi-Species (General Pet)',
  'Dog',
  'Cat',
  'Small mammals/Pocket Pets',
  'Horses',
  'Farm Animals',
  'Exotics (reptiles, birds)',
  'Wildlife',
] as const;

// Search Topics strictly organized under each Objective Category:
export const SEARCH_TOPICS_BY_OBJECTIVE: Record<ObjectiveCategory, string[]> = {
  'Human Health & Development': [
    'Mental health',
    'Neurobiology',
    'Neurodivergence',
    'Child health and development',
    'Aging',
    'Physical health',
  ],
  'Animal Health & Welfare': [
    'Pet health',
    'Animal welfare',
    'Choosing/adopting a pet',
  ],
  'Human-Animal Interaction & Bonding': [
    'General human-animal bonding/interaction',
    'Animal-assisted interventions',
  ],
  'Safety & Risk': [
    'Risk factors/zoonotic disease',
    'HAI safety',
    'Travel',
    'Disasters/emergency preparedness',
  ],
  'Crisis & Life Challenges': [
    'Domestic violence',
    'Crisis support',
    'Loss and grief',
  ],
};

export const ALL_SEARCH_TOPICS: string[] = [
  'Mental health',
  'Neurobiology',
  'Neurodivergence',
  'Child health and development',
  'Aging',
  'Physical health',
  'Pet health',
  'Animal welfare',
  'Choosing/adopting a pet',
  'General human-animal bonding/interaction',
  'Animal-assisted interventions',
  'Risk factors/zoonotic disease',
  'HAI safety',
  'Travel',
  'Disasters/emergency preparedness',
  'Domestic violence',
  'Crisis support',
  'Loss and grief',
];

export const SOURCE_TIER_OPTIONS = [
  { value: 'Tier 1', label: 'Tier 1: Primary Research' },
  { value: 'Tier 2', label: 'Tier 2: Government and Institutional Sources' },
  { value: 'Tier 3', label: 'Tier 3: University and Nonprofit Sources/General Sources and Practical Guidance' },
] as const;

export const POPULATION_CATEGORIES = [
  'General Public',
  'General Pet Owners',
  'Parents',
  'Educators',
  'Immune-Compromised Individuals',
  'Disabled Individuals',
  'Policymakers/Community Organizations',
  'Clinicians',
  'Seniors and caregivers',
  'Veterans',
  'Researchers',
  'Animal exhibitors/breeders',
] as const;

/**
 * Flags/Notes are restricted strictly to these three caveats:
 * 1. Landmark exception for pre-2016 publication
 * 2. Commercial Science Affiliation
 * 3. Geographic/Legal Non-US Generalizability
 */
export const ALLOWED_FLAG_TYPES = [
  'Publication Date Exception: Foundational landmark study published prior to the 10-year research window (>2016), retained due to active citation in current research.',
  'Commercial Science Affiliation: Research affiliated with or funded by a commercial industry entity (e.g. WALTHAM Petcare Science Institute / Mars Petcare); vetted for scientific rigor.',
  'Geographic/Legal Non-US Generalizability: Regional study cohort or foreign legal/statutory framework not directly generalizable to the United States.',
] as const;

/**
 * Pruned 12-field HAI Resource Database Schema
 */
export interface HAIResource {
  id: string;
  // 1. Title
  title: string;
  // 2. URL
  url: string;
  // 3. Source Institution
  sourceInstitution: string;
  // 4. Source Type (Tier 1, Tier 2, Tier 3)
  sourceType: SourceTier;
  // 5. Year Published
  yearPublished: number | string;
  // 6. Primary Objective (strictly 1 of the 5 categories)
  primaryObjective: ObjectiveCategory;
  // 7. Secondary Objectives
  secondaryObjectives: ObjectiveCategory[];
  // 8. Population
  population: string[];
  // 9. Species
  species: string[];
  // 10. Brief Summary
  briefSummary: string;
  // 11. Qualifications (Rationale for meeting inclusion criteria)
  qualifications: string;
  // 12. Flags/Notes (Strictly restricted to the 3 permitted exceptions)
  flagsNotes: string[];
  // Status state: AI Screened, Human Approved, Flagged for Review, or Rejected
  reviewerStatus: ReviewerStatus;

  // ---- Monitoring fields (maintained by the daily agent; NOT part of the 12-field rubric schema) ----
  pmid?: string;
  dateAdded?: string; // ISO timestamp
  addedBy?: 'daily-agent' | 'manual' | 'seed';
  lastCheckedAt?: string; // ISO timestamp of last daily re-check
  linkStatus?: LinkStatus;
  linkFailCount?: number; // consecutive failed checks
  contentHash?: string; // hash of page text (Tier 2/3 web pages)
  contentLength?: number;
  retracted?: boolean; // PubMed lists this paper as retracted
  needsRecheck?: boolean; // agent wants a human to look again
  recheckReason?: string;
}

export interface CandidateScreeningInput {
  url?: string;
  doiOrPmid?: string;
  rawTextOrAbstract?: string;
  title?: string;
  sourceInstitution?: string;
  sourceType?: SourceTier;
}

export interface ScreeningEvaluationResult {
  resource: HAIResource;
  verdict: 'AI Screened' | 'Flagged for Review' | 'Rejected';
  verdictRationale: string;
  passesCriteria: boolean;
  warnings?: string[];
}

export interface DiscoverySiftRequest {
  topic?: string;
  objective?: string;
  species?: string;
  sourceType?: string;
  limit?: number;
}

export interface DiscoverySiftResult {
  addedCount: number;
  screenedCount: number;
  excludedCount: number;
  addedRecords: HAIResource[];
  excludedReasons: { title: string; reason: string }[];
  queryUsed: string;
}

export interface CategoryHarvestSummary {
  category: ObjectiveCategory;
  addedCount: number;
  sampleTitles: string[];
}

export interface PullAllCategoriesRequest {
  batchSize?: number;
  tier?: 'All' | SourceTier;
}

export interface PullAllCategoriesResult {
  success: boolean;
  totalAdded: number;
  totalScreened: number;
  totalExcluded: number;
  categories: CategoryHarvestSummary[];
  addedRecords: HAIResource[];
  excludedReasons: { title: string; reason: string }[];
}
