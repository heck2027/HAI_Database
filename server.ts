import express from 'express';
import path from 'path';
import fs from 'fs';
import { createHash, timingSafeEqual } from 'crypto';
import { GoogleGenAI, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import { INITIAL_RESOURCES } from './src/seedData';
import { store, SeenEntry, Meta } from './server/store';
import { parsePubMedXml, PubMedArticle } from './server/pubmed';
import {
  HAIResource,
  ObjectiveCategory,
  OBJECTIVE_CATEGORIES,
  ReviewerStatus,
  SourceTier,
  ScreeningEvaluationResult,
} from './src/types';

const app = express();
// Cloud Run supplies PORT; AI Studio's preview uses 3000.
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// Storage comes up in the background after the server starts listening, so a database problem
// never prevents the app from deploying; API calls return 503 (with the reason) until it is ready.
let storageReady = false;
let storageError: string | null = null;
app.use('/api', (req, res, next) => {
  if (storageReady || req.path === '/health' || req.path === '/agent/status') return next();
  res.status(503).json({ error: 'Storage is starting or unavailable', detail: storageError });
});

const DATA_FILE = path.join(process.cwd(), 'hai_database.json');
let resources: HAIResource[] = [];

// ==========================================
// OBJECTIVE & TAXONOMY NORMALIZATION
// ==========================================
export function normalizeObjective(raw?: string): ObjectiveCategory {
  if (!raw) return 'Human-Animal Interaction & Bonding';
  const clean = raw.trim().toLowerCase();

  // Animal-assisted interventions belongs under Interaction & Bonding
  if (
    clean.includes('animal-assisted') ||
    clean.includes('assisted intervention') ||
    clean.includes('therapy dog') ||
    clean.includes('service dog') ||
    clean.includes('hippotherapy') ||
    clean.includes('bonding') ||
    clean.includes('interaction') ||
    clean.includes('human animal') ||
    clean.includes('human-animal') ||
    clean.includes('pet ownership') ||
    clean.includes('attachment')
  ) {
    return 'Human-Animal Interaction & Bonding';
  }

  if (
    clean.includes('animal health') ||
    clean.includes('welfare') ||
    clean.includes('wellness') ||
    clean.includes('shelter') ||
    clean.includes('adopting') ||
    clean.includes('pet health')
  ) {
    return 'Animal Health & Welfare';
  }

  if (
    clean.includes('crisis') ||
    clean.includes('challenge') ||
    clean.includes('grief') ||
    clean.includes('bereave') ||
    clean.includes('loss') ||
    clean.includes('euthanas') ||
    clean.includes('violence') ||
    clean.includes('trauma')
  ) {
    return 'Crisis & Life Challenges';
  }

  if (
    clean.includes('safety') ||
    clean.includes('risk') ||
    clean.includes('zoon') ||
    clean.includes('bite') ||
    clean.includes('hygiene') ||
    clean.includes('disaster') ||
    clean.includes('parasite')
  ) {
    return 'Safety & Risk';
  }

  if (
    clean.includes('human health') ||
    clean.includes('development') ||
    clean.includes('mental') ||
    clean.includes('pediatric') ||
    clean.includes('child') ||
    clean.includes('aging') ||
    clean.includes('elderly') ||
    clean.includes('autism') ||
    clean.includes('cardio') ||
    clean.includes('cortisol') ||
    clean.includes('oxytocin')
  ) {
    return 'Human Health & Development';
  }

  return 'Human-Animal Interaction & Bonding';
}

function normalizeStatus(status?: string): ReviewerStatus {
  if (!status) return 'AI Screened';
  const s = status.trim().toLowerCase();
  if (s.includes('approved')) return 'Human Approved';
  if (s.includes('flag')) return 'Flagged for Review';
  if (s.includes('reject')) return 'Rejected';
  return 'AI Screened';
}

const TRACKING_KEYS = [
  'pmid',
  'dateAdded',
  'addedBy',
  'lastCheckedAt',
  'linkStatus',
  'linkFailCount',
  'contentHash',
  'contentLength',
  'retracted',
  'needsRecheck',
  'recheckReason',
] as const;

function pruneRecord(raw: any): HAIResource {
  const tracking: Record<string, unknown> = {};
  for (const k of TRACKING_KEYS) {
    if (raw[k] !== undefined && raw[k] !== null) tracking[k] = raw[k];
  }
  const primaryObj = normalizeObjective(raw.primaryObjective || raw.objective);
  const secondaryObjs = Array.isArray(raw.secondaryObjectives)
    ? (raw.secondaryObjectives.map(normalizeObjective) as ObjectiveCategory[]).filter(
        (o) => o !== primaryObj
      )
    : [];

  return {
    id: raw.id || `hai_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    title: raw.title || 'Untitled Resource',
    contentType: raw.contentType || 'Scientific Paper',
    url: raw.url || 'https://pubmed.ncbi.nlm.nih.gov/',
    sourceInstitution: raw.sourceInstitution || 'Peer-Reviewed Institution',
    sourceType: (raw.sourceType as SourceTier) || 'Tier 1',
    yearPublished: raw.yearPublished || new Date().getFullYear(),
    primaryObjective: primaryObj,
    secondaryObjectives: Array.from(new Set(secondaryObjs)),
    population: Array.isArray(raw.population) && raw.population.length > 0 ? raw.population : ['General Pet Owners'],
    species: Array.isArray(raw.species) && raw.species.length > 0 ? raw.species : ['Multi-Species (General Pet)'],
    briefSummary: raw.briefSummary || '',
    qualifications: raw.qualifications || 'Meets inclusion criteria for human-animal interaction evidence.',
    flagsNotes: Array.isArray(raw.flagsNotes) ? raw.flagsNotes : [],
    reviewerStatus: normalizeStatus(raw.reviewerStatus),
    ...tracking,
  };
}

// ==========================================
// PERSISTENCE (Firestore in production, JSON file locally) – see server/store.ts
// `resources` is an in-memory cache of the records collection.
// ==========================================
const REFRESH_TTL_MS = 20_000;
let resourcesLoadedAt = 0;

function recordTimeKey(r: HAIResource): string {
  if (r.dateAdded) return r.dateAdded;
  const m = r.id.match(/^hai_(\d{10,})_/);
  return m ? new Date(Number(m[1])).toISOString() : '';
}

async function refreshResources(force = false) {
  if (!force && Date.now() - resourcesLoadedAt < REFRESH_TTL_MS) return;
  const loaded = (await store.loadAll()).map(pruneRecord);
  loaded.sort((a, b) => recordTimeKey(b).localeCompare(recordTimeKey(a)));
  resources = loaded;
  resourcesLoadedAt = Date.now();
}

function stampNewRecords(records: HAIResource[], addedBy: 'manual' | 'daily-agent' = 'manual') {
  const now = new Date().toISOString();
  for (const r of records) {
    if (!r.dateAdded) r.dateAdded = now;
    if (!r.addedBy) r.addedBy = addedBy;
    if (!r.pmid) {
      const m = (r.url || '').match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{4,9})/);
      if (m) r.pmid = m[1];
    }
  }
}

async function initResources() {
  await store.init();
  const existing = await store.loadAll();
  if (existing.length === 0) {
    // First start on an empty database: seed once from the bundled JSON snapshot (or the seed list).
    let seed: any[] = [];
    try {
      if (fs.existsSync(DATA_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
        if (Array.isArray(parsed)) seed = parsed;
      }
    } catch (e) {
      console.warn('Could not read bundled hai_database.json for seeding', e);
    }
    if (seed.length === 0) seed = INITIAL_RESOURCES;
    const pruned = seed.map(pruneRecord);
    for (const r of pruned) if (!r.addedBy) r.addedBy = 'seed';
    await store.replaceAll(pruned);
    console.log(`Seeded ${pruned.length} records into ${store.kind} storage.`);
  }
  await refreshResources(true);
  console.log(`Storage backend: ${store.kind}; ${resources.length} records loaded.`);
}

// ==========================================
// REGEX WITH STRICT WORD BOUNDARIES
// ==========================================
export const SPECIES_REGEX_RULES: { species: string; regex: RegExp }[] = [
  { species: 'Dog', regex: /\b(dogs?|canines?|puppy|puppies|hounds?|retrievers?|canis familiaris)\b/i },
  { species: 'Cat', regex: /\b(cats?|felines?|kittens?|felis catus)\b/i },
  { species: 'Horses', regex: /\b(horses?|equines?|ponies|pony|foals?|stallions?|mares?|hippotherapy|equine-assisted)\b/i },
  {
    species: 'Small mammals/Pocket Pets',
    regex: /\b(rabbits?|bunnies|bunny|guinea pigs?|ferrets?|hamsters?|gerbils?|chinchillas?|pocket pets?)\b/i,
  },
  { species: 'Farm Animals', regex: /\b(livestock|cattle|cows?|sheep|goats?|pigs?|swine|poultry|chickens?|farm animals?)\b/i },
  {
    species: 'Exotics (reptiles, birds)',
    regex: /\b(reptiles?|lizards?|snakes?|birds?|parrots?|avian|tortoises?|turtles?)\b/i,
  },
  { species: 'Wildlife', regex: /\b(wildlife|wild animals?|marine mammals?|cetaceans?)\b/i },
];

export const GENERIC_PET_REGEX =
  /\b(pets?|companion animals?|therapy animals?|service animals?|facility animals?|visiting animals?|human-animal|human-canine|human-feline|human-pet|pet-owning|pet owners?|pet ownership|pet keeping|human-animal bond|human-animal interaction|animal-assisted)\b/i;

export const POPULATION_REGEX_RULES: { population: string; regex: RegExp }[] = [
  { population: 'Veterans', regex: /\b(veterans?|military|service members?|combat veterans?)\b/i },
  {
    population: 'Parents',
    regex: /\b(parents?|parenting|pediatric|paediatric|expectant mothers?|pregnant women|families with children)\b/i,
  },
  {
    population: 'Seniors and caregivers',
    regex: /\b(seniors?|older adults?|elderly|aging adults?|geriatric|dementia|alzheimer'?s?|assisted living|nursing home|eldercare)\b/i,
  },
  {
    population: 'Clinicians',
    regex: /\b(clinicians?|veterinarians?|veterinary teams?|physicians?|therapists?|psychologists?|practitioners?|social workers?|counselors?)\b/i,
  },
  {
    population: 'Disabled Individuals',
    regex: /\b(disabilities|disabled individuals?|autism|autistic|cerebral palsy|wheelchair users?|sensory impairment|neurodivergent|adhd)\b/i,
  },
  {
    population: 'Immune-Compromised Individuals',
    regex: /\b(immunocompromised|immune-compromised|immunosuppressed|immunosuppression|organ transplants?|dialysis|hiv|neutropenia|chemotherapy|cancer patients?)\b/i,
  },
  { population: 'Educators', regex: /\b(educators?|teachers?|classrooms?|schools?|curriculums?)\b/i },
  {
    population: 'Policymakers/Community Organizations',
    regex: /\b(policymakers?|public health officials?|community organizations?|municipal authorities?|legislators?)\b/i,
  },
  { population: 'Researchers', regex: /\b(researchers?|investigators?|scientists?|academics?|epidemiologists?)\b/i },
  { population: 'Animal exhibitors/breeders', regex: /\b(breeders?|kennel clubs?|animal exhibitors?|show dogs?)\b/i },
  { population: 'General Pet Owners', regex: /\b(pet owners?|dog owners?|cat owners?|pet parents?|pet guardians?|pet ownership)\b/i },
  { population: 'General Public', regex: /\b(general public|community members?|civilians?|general population)\b/i },
];

// ==========================================
// STRICT FLAGS / NOTES RESTRICTION
// Must be strictly one of these 3 or empty array
// ==========================================
const FLAG_LANDMARK =
  'Publication Date Exception: Foundational landmark study published prior to the 10-year research window (>2016), retained due to active citation in current research.';
const FLAG_COMMERCIAL =
  'Commercial Science Affiliation: Research affiliated with or funded by a commercial industry entity (e.g. WALTHAM Petcare Science Institute / Mars Petcare); vetted for scientific rigor.';
const FLAG_NON_US =
  'Geographic/Legal Non-US Generalizability: Regional study cohort or foreign legal/statutory framework not directly generalizable to the United States.';

function filterStrictFlags(flags: string[]): string[] {
  const allowed = [FLAG_LANDMARK, FLAG_COMMERCIAL, FLAG_NON_US];
  const result: string[] = [];
  for (const f of flags) {
    if (allowed.includes(f as any)) {
      if (!result.includes(f)) result.push(f);
    } else {
      const lower = f.toLowerCase();
      if (lower.includes('landmark') || lower.includes('publication date exception') || lower.includes('pre-2016')) {
        if (!result.includes(FLAG_LANDMARK)) result.push(FLAG_LANDMARK);
      } else if (lower.includes('commercial') || lower.includes('waltham') || lower.includes('mars') || lower.includes('purina')) {
        if (!result.includes(FLAG_COMMERCIAL)) result.push(FLAG_COMMERCIAL);
      } else if (lower.includes('non-us') || lower.includes('geographic') || lower.includes('uk dangerous') || lower.includes('regional')) {
        if (!result.includes(FLAG_NON_US)) result.push(FLAG_NON_US);
      }
    }
  }
  return result;
}

// ==========================================
// ALGORITHMIC SCREENING & RUBRIC CHECK
// ==========================================
function evaluateAlgorithmic(item: {
  title?: string;
  url?: string;
  doiOrPmid?: string;
  rawTextOrAbstract?: string;
  sourceInstitution?: string;
  sourceType?: SourceTier;
}): ScreeningEvaluationResult {
  const text = `${item.title || ''} ${item.rawTextOrAbstract || ''} ${item.sourceInstitution || ''}`.trim();

  // 1. Species with strict word boundaries
  const detectedSpecies: string[] = [];
  for (const rule of SPECIES_REGEX_RULES) {
    if (rule.regex.test(text)) {
      detectedSpecies.push(rule.species);
    }
  }

  const isPetScan =
    /\b(positron emission tomography|18f-fdg|pet-ct|pet\/ct|pet scan|pet imaging)\b/i.test(text) &&
    detectedSpecies.length === 0;

  const hasGenericPet = GENERIC_PET_REGEX.test(text);
  const hasSubstantiveAnimals = (detectedSpecies.length > 0 || hasGenericPet) && !isPetScan;

  // 2. Substantive humans with word boundaries
  const hasSubstantiveHumans =
    /\b(humans?|children|child|pediatric|paediatric|adolescents?|youth|adults?|seniors?|elderly|geriatric|patients?|participants?|owners?|handlers?|caregivers?|families|family|parents?|veterans?|students?|individuals?|clients?|well-being|wellbeing|mental health|anxiety|depression|loneliness|cognition|social|emotional|cortisol|oxytocin)\b/i.test(
      text
    );

  // 3. Exclusions
  const isLabRodent =
    /\b(murine models?|mouse models?|rat models?|in vitro assays?|cell cultures?|xenografts?|pharmacokinetics of [a-z]+)\b/i.test(
      text
    ) && !/\b(companion|pet|therapy animal|human-animal|bond|owner)\b/i.test(text);

  const isPureVeterinary =
    /\b(fecal samples|antimicrobial resistance|biofilm-forming|klebsiella|staphylococcus|canine parvovirus|surgical repair of cruciate)\b/i.test(
      text
    ) && !/\b(pet owners?|zoonotic|public health|human-animal|bond|therapy)\b/i.test(text);

  const warnings: string[] = [];
  let passes = true;

  if (!hasSubstantiveAnimals) {
    passes = false;
    warnings.push('Inclusion Criterion Violated: No companion animals or human-animal interaction detected.');
  }
  if (!hasSubstantiveHumans) {
    passes = false;
    warnings.push('Inclusion Criterion Violated: No human participants or outcomes detected.');
  }
  if (isLabRodent) {
    passes = false;
    warnings.push('Exclusion Criterion Triggered: Laboratory rodent pharmacology/disease model.');
  }
  if (isPureVeterinary) {
    passes = false;
    warnings.push('Exclusion Criterion Triggered: Single-domain veterinary microbiology/pathology without human interaction.');
  }

  // 4. Species resolution
  const finalSpecies =
    detectedSpecies.length > 0
      ? detectedSpecies
      : hasSubstantiveAnimals
      ? ['Multi-Species (General Pet)']
      : ['Multi-Species (General Pet)'];

  // 5. Populations with strict word boundaries
  const detectedPopulations: string[] = [];
  const hasNegativeChild = /\b(without children|child-free|childless|no children)\b/i.test(text);
  for (const rule of POPULATION_REGEX_RULES) {
    if (rule.population === 'Parents' && hasNegativeChild) continue;
    if (rule.regex.test(text)) {
      detectedPopulations.push(rule.population);
    }
  }
  const finalPopulations = detectedPopulations.length > 0 ? detectedPopulations : ['General Pet Owners'];

  // 6. Year and landmark check
  let pubYear = new Date().getFullYear();
  const yearMatch = text.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) {
    pubYear = parseInt(yearMatch[1], 10);
  }
  const isWithin10Years = pubYear >= 2016;

  // 7. Strict Flags detection (Only 3 permitted!)
  const flagsNotes: string[] = [];
  if (pubYear < 2016) {
    flagsNotes.push(FLAG_LANDMARK);
  }
  if (/\b(waltham|mars petcare|purina|zoetis|royal canin|hill's pet)\b/i.test(text)) {
    flagsNotes.push(FLAG_COMMERCIAL);
  }
  if (/\b(dangerous dogs act|uk statutory|non-us cohort|australian biosecurity|foreign cohort)\b/i.test(text)) {
    flagsNotes.push(FLAG_NON_US);
  }

  // 8. Objectives (strictly from the 5 categories)
  let primaryObjective: ObjectiveCategory = 'Human-Animal Interaction & Bonding';
  const secondaryObjectives: ObjectiveCategory[] = [];

  if (
    /\b(domestic violence|safe havens? for pets|co-sheltering|crisis response|loss|grief|bereavement|euthanasia|death of a pet|pet death|pet loss)\b/i.test(
      text
    )
  ) {
    primaryObjective = 'Crisis & Life Challenges';
  } else if (
    /\b(zoonosis|zoonotic|pathogens?|toxoplasma|bartonella|infection control|rabies|dog bite|bite prevention|pet safety|disaster preparedness)\b/i.test(
      text
    )
  ) {
    primaryObjective = 'Safety & Risk';
  } else if (
    /\b(animal welfare|canine welfare|feline welfare|stress in therapy dogs|shelter welfare|adopting|pet adoption|pet health|inappropriate urination)\b/i.test(
      text
    )
  ) {
    primaryObjective = 'Animal Health & Welfare';
  } else if (
    /\b(pediatric|child development|child health|aging|elderly|dementia|mental health|depression|anxiety|loneliness|ptsd|autism|cortisol|oxytocin|cardiovascular)\b/i.test(
      text
    )
  ) {
    primaryObjective = 'Human Health & Development';
  } else {
    primaryObjective = 'Human-Animal Interaction & Bonding';
  }

  // Determine Source Type
  let sourceType: SourceTier = item.sourceType || 'Tier 1';
  if (/\b(cdc|nih|avma|aaha|usda|who)\b/i.test(text)) {
    sourceType = 'Tier 2';
  } else if (/\b(habri|chab|iahaio|waltham|purdue)\b/i.test(text)) {
    sourceType = 'Tier 3';
  }

  // Title extraction
  let title = item.title?.trim();
  if (!title) {
    const lines = (item.rawTextOrAbstract || '').split('\n').filter((l) => l.trim().length > 10);
    title = lines[0]?.slice(0, 120) || (item.doiOrPmid ? `Study (${item.doiOrPmid})` : 'Screened HAI Evidence Resource');
  }

  let briefSummary = item.rawTextOrAbstract?.slice(0, 320) || `Evaluated study examining ${primaryObjective.toLowerCase()} and human-animal bond dynamics.`;
  if (briefSummary.length >= 320) briefSummary += '...';

  let qualifications = passes
    ? `Meets inclusion criteria: Focuses on companion animal interaction (${finalSpecies.join(', ')}) with verified human outcomes.`
    : `Screening notes: ${warnings.join(' ')}`;

  let verdict: 'AI Screened' | 'Flagged for Review' | 'Rejected' = 'AI Screened';
  let verdictRationale = 'Candidate resource passes One Health HAI inclusion criteria.';

  if (!passes) {
    verdict = 'Rejected';
    verdictRationale = warnings.join('; ');
  } else if (flagsNotes.length > 0 || !isWithin10Years) {
    verdict = 'Flagged for Review';
    verdictRationale = `Resource meets core HAI criteria with ${flagsNotes.length} exception(s) requiring human confirmation.`;
  }

  const resource: HAIResource = {
    id: `hai_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    title,
    url: item.url || (item.doiOrPmid ? `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(item.doiOrPmid)}` : 'https://pubmed.ncbi.nlm.nih.gov/'),
    sourceInstitution: item.sourceInstitution || (sourceType === 'Tier 2' ? 'Government / Institutional Agency' : 'Peer-Reviewed Journal'),
    sourceType,
    yearPublished: pubYear,
    primaryObjective,
    secondaryObjectives,
    population: finalPopulations,
    species: finalSpecies,
    briefSummary,
    qualifications,
    flagsNotes: filterStrictFlags(flagsNotes),
    // Mandate: Never mark papers Human Approved automatically. Starts as AI Screened.
    reviewerStatus: verdict === 'Rejected' ? 'Rejected' : verdict === 'Flagged for Review' ? 'Flagged for Review' : 'AI Screened',
  };

  return {
    resource,
    verdict,
    verdictRationale,
    passesCriteria: passes,
    warnings,
  };
}

// Lazy Gemini AI initialization
let aiClient: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  if (!aiClient) {
    aiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY || '',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

// ==========================================
// API ROUTES
// ==========================================

// 1. Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    totalRecords: resources.length,
    backend: store.kind,
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
  });
});

// 2. Records CRUD
app.get('/api/records', async (req, res) => {
  await refreshResources().catch((e) => console.warn('refresh failed', e.message));
  const { query, objective, status, sourceType, needsRecheck, addedSince } = req.query;
  let filtered = [...resources];

  if (needsRecheck === 'true') {
    filtered = filtered.filter((r) => r.needsRecheck || r.retracted);
  }
  if (addedSince && typeof addedSince === 'string') {
    const t = Date.parse(addedSince);
    if (!Number.isNaN(t)) filtered = filtered.filter((r) => r.dateAdded && Date.parse(r.dateAdded) >= t);
  }

  if (query && typeof query === 'string') {
    const q = query.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        r.title.toLowerCase().includes(q) ||
        r.briefSummary.toLowerCase().includes(q) ||
        r.sourceInstitution.toLowerCase().includes(q) ||
        r.qualifications.toLowerCase().includes(q)
    );
  }

  if (objective && typeof objective === 'string' && objective !== 'All') {
    const target = normalizeObjective(objective);
    filtered = filtered.filter(
      (r) => r.primaryObjective === target || r.secondaryObjectives?.includes(target)
    );
  }

  if (status && typeof status === 'string' && status !== 'All') {
    const targetStatus = normalizeStatus(status);
    filtered = filtered.filter((r) => r.reviewerStatus === targetStatus);
  }

  if (sourceType && typeof sourceType === 'string' && sourceType !== 'All') {
    filtered = filtered.filter((r) => r.sourceType === sourceType);
  }

  res.json(filtered);
});

// Add new resource
app.post('/api/records', async (req, res) => {
  const body = req.body;
  if (!body.title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  const record = pruneRecord(body);
  stampNewRecords([record], 'manual');
  resources.unshift(record);
  await store.upsertMany([record]);
  res.status(201).json(record);
});

// Update resource (e.g. status change)
app.patch('/api/records/:id', async (req, res) => {
  const { id } = req.params;
  const index = resources.findIndex((r) => r.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Record not found' });
  }

  const current = resources[index];
  const updatedStatus = req.body.reviewerStatus ? normalizeStatus(req.body.reviewerStatus) : current.reviewerStatus;

  resources[index] = {
    ...current,
    ...req.body,
    primaryObjective: req.body.primaryObjective ? normalizeObjective(req.body.primaryObjective) : current.primaryObjective,
    secondaryObjectives: Array.isArray(req.body.secondaryObjectives)
      ? req.body.secondaryObjectives.map(normalizeObjective)
      : current.secondaryObjectives,
    flagsNotes: req.body.flagsNotes !== undefined ? filterStrictFlags(req.body.flagsNotes) : current.flagsNotes,
    reviewerStatus: updatedStatus,
  };

  await store.upsertMany([resources[index]]);
  res.json(resources[index]);
});

// Delete resource
app.delete('/api/records/:id', async (req, res) => {
  const { id } = req.params;
  const before = resources.length;
  resources = resources.filter((r) => r.id !== id);
  if (resources.length === before) {
    return res.status(404).json({ error: 'Record not found' });
  }
  await store.remove(id);
  res.json({ success: true, count: resources.length });
});

// Reset to initial seed dataset
app.post('/api/records/reset', async (req, res) => {
  if (store.kind === 'firestore' && process.env.ALLOW_RESET !== 'true') {
    return res.status(403).json({ error: 'Reset is disabled when using Firestore. Set ALLOW_RESET=true to enable it.' });
  }
  resources = INITIAL_RESOURCES.map(pruneRecord);
  await store.replaceAll(resources);
  res.json({ success: true, count: resources.length });
});

// ==========================================
// AUTOMATED DISCOVERY & SIFTING ENGINE
// Automatically searches PubMed & web/institutional resources,
// sifts them through the One Health rubric, and outputs compliant records to the table.
// ==========================================
const NCBI_API_KEY = process.env.NCBI_API_KEY || '';
const NCBI_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const NCBI_PARAMS = `${NCBI_API_KEY ? `&api_key=${NCBI_API_KEY}` : ''}&tool=OneHealthEvidenceAgent&email=curator@purdue.edu`;
// NCBI allows 10 requests/sec with a key, 3/sec without
const NCBI_DELAY = NCBI_API_KEY ? 120 : 400;

const TOPIC_SEARCH_TERMS: Record<string, string> = {
  // 1. Human Health & Development
  'Mental health': '("mental health"[Title/Abstract] OR "depression"[Title/Abstract] OR "anxiety"[Title/Abstract] OR "psychological well-being"[Title/Abstract] OR "loneliness"[Title/Abstract])',
  'Neurobiology': '("neurobiology"[Title/Abstract] OR "oxytocin"[Title/Abstract] OR "cortisol"[Title/Abstract] OR "physiological stress"[Title/Abstract] OR "endocrine"[Title/Abstract])',
  'Neurodivergence': '("autism"[Title/Abstract] OR "ASD"[Title/Abstract] OR "ADHD"[Title/Abstract] OR "neurodivergent"[Title/Abstract] OR "neurodevelopmental"[Title/Abstract])',
  'Child health and development': '("child development"[Title/Abstract] OR "children"[Title/Abstract] OR "pediatric"[Title/Abstract] OR "adolescent"[Title/Abstract] OR "childhood"[Title/Abstract])',
  'Aging': '("aging"[Title/Abstract] OR "older adults"[Title/Abstract] OR "elderly"[Title/Abstract] OR "dementia"[Title/Abstract] OR "geriatric"[Title/Abstract])',
  'Physical health': '("physical activity"[Title/Abstract] OR "cardiovascular"[Title/Abstract] OR "hypertension"[Title/Abstract] OR "blood pressure"[Title/Abstract] OR "walking"[Title/Abstract])',

  // 2. Animal Health & Welfare
  'Pet health': '("pet health"[Title/Abstract] OR "canine health"[Title/Abstract] OR "feline health"[Title/Abstract] OR "preventive veterinary"[Title/Abstract] OR "veterinary wellness"[Title/Abstract])',
  'Animal welfare': '("animal welfare"[Title/Abstract] OR "canine welfare"[Title/Abstract] OR "feline welfare"[Title/Abstract] OR "canine stress"[Title/Abstract] OR "shelter welfare"[Title/Abstract])',
  'Choosing/adopting a pet': '("pet adoption"[Title/Abstract] OR "shelter adoption"[Title/Abstract] OR "pet selection"[Title/Abstract] OR "choosing a pet"[Title/Abstract] OR "adopting a pet"[Title/Abstract])',

  // 3. Human-Animal Interaction & Bonding
  'General human-animal bonding/interaction': '("human-animal interaction"[Title/Abstract] OR "human-animal bond"[Title/Abstract] OR "pet ownership"[Title/Abstract] OR "pet attachment"[Title/Abstract] OR "companion animals"[Title/Abstract])',
  'Animal-assisted interventions': '("animal-assisted intervention"[Title/Abstract] OR "animal-assisted therapy"[Title/Abstract] OR "animal-assisted activities"[Title/Abstract] OR "therapy dog"[Title/Abstract] OR "therapy dogs"[Title/Abstract] OR "service dog"[Title/Abstract] OR "service dogs"[Title/Abstract] OR "hippotherapy"[Title/Abstract])',

  // 4. Safety & Risk
  'Risk factors/zoonotic disease': '("zoonosis"[Title/Abstract] OR "zoonotic"[Title/Abstract] OR "toxoplasma"[Title/Abstract] OR "bartonella"[Title/Abstract] OR "infection control"[Title/Abstract] OR "pathogen transmission"[Title/Abstract])',
  'HAI safety': '("pet safety"[Title/Abstract] OR "dog bite"[Title/Abstract] OR "dog bites"[Title/Abstract] OR "bite prevention"[Title/Abstract] OR "scratch prevention"[Title/Abstract] OR "veterinary hygiene"[Title/Abstract])',
  'Travel': '("travel with pets"[Title/Abstract] OR "pet travel"[Title/Abstract] OR "transporting pets"[Title/Abstract])',
  'Disasters/emergency preparedness': '("disaster preparedness"[Title/Abstract] OR "pet evacuation"[Title/Abstract] OR "emergency sheltering"[Title/Abstract] OR "disaster animal management"[Title/Abstract])',

  // 5. Crisis & Life Challenges
  'Domestic violence': '("domestic violence"[Title/Abstract] OR "intimate partner violence"[Title/Abstract] OR "safe havens for pets"[Title/Abstract] OR "co-sheltering"[Title/Abstract] OR "pet abuse link"[Title/Abstract])',
  'Crisis support': '("crisis response"[Title/Abstract] OR "trauma"[Title/Abstract] OR "first responders"[Title/Abstract] OR "disaster mental health"[Title/Abstract])',
  'Loss and grief': '("pet loss"[Title/Abstract] OR "pet bereavement"[Title/Abstract] OR "grief"[Title/Abstract] OR "euthanasia"[Title/Abstract] OR "disenfranchised grief"[Title/Abstract] OR "pet death"[Title/Abstract])',
};

const OBJECTIVE_SEARCH_TERMS: Record<ObjectiveCategory, string> = {
  'Human Health & Development':
    '("mental health"[Title/Abstract] OR "depression"[Title/Abstract] OR "anxiety"[Title/Abstract] OR "loneliness"[Title/Abstract] OR "stress reduction"[Title/Abstract] OR "oxytocin"[Title/Abstract] OR "cortisol"[Title/Abstract] OR "autism"[Title/Abstract] OR "child development"[Title/Abstract] OR "pediatric"[Title/Abstract] OR "aging"[Title/Abstract] OR "older adults"[Title/Abstract] OR "cardiovascular"[Title/Abstract])',
  'Animal Health & Welfare':
    '("animal welfare"[Title/Abstract] OR "canine stress"[Title/Abstract] OR "feline stress"[Title/Abstract] OR "shelter welfare"[Title/Abstract] OR "pet adoption"[Title/Abstract] OR "preventive veterinary"[Title/Abstract] OR "canine health"[Title/Abstract] OR "feline health"[Title/Abstract])',
  'Human-Animal Interaction & Bonding':
    '("human-animal interaction"[Title/Abstract] OR "human-animal bond"[Title/Abstract] OR "companion animals"[Title/Abstract] OR "pet ownership"[Title/Abstract] OR "pet attachment"[Title/Abstract] OR "therapy dog"[Title/Abstract] OR "service dog"[Title/Abstract] OR "animal-assisted"[Title/Abstract])',
  'Safety & Risk':
    '("zoonosis"[Title/Abstract] OR "zoonotic"[Title/Abstract] OR "dog bite"[Title/Abstract] OR "bite prevention"[Title/Abstract] OR "infection control"[Title/Abstract] OR "toxoplasma"[Title/Abstract] OR "pet safety"[Title/Abstract] OR "disaster preparedness"[Title/Abstract])',
  'Crisis & Life Challenges':
    '("domestic violence"[Title/Abstract] OR "safe haven"[Title/Abstract] OR "crisis response"[Title/Abstract] OR "trauma"[Title/Abstract] OR "pet loss"[Title/Abstract] OR "pet bereavement"[Title/Abstract] OR "grief"[Title/Abstract] OR "euthanasia"[Title/Abstract])',
};

// Strictly matching the 8 species from the specification:
const SPECIES_SEARCH_TERMS: Record<string, string> = {
  'Dog': '("dog"[Title/Abstract] OR "dogs"[Title/Abstract] OR "canine"[Title/Abstract] OR "canines"[Title/Abstract] OR "Dogs"[Mesh])',
  'Cat': '("cat"[Title/Abstract] OR "cats"[Title/Abstract] OR "feline"[Title/Abstract] OR "felines"[Title/Abstract] OR "Cats"[Mesh])',
  'Horses': '("horse"[Title/Abstract] OR "horses"[Title/Abstract] OR "equine"[Title/Abstract] OR "equines"[Title/Abstract] OR "hippotherapy"[Title/Abstract])',
  'Small mammals/Pocket Pets': '("rabbit"[Title/Abstract] OR "guinea pig"[Title/Abstract] OR "ferret"[Title/Abstract] OR "hamster"[Title/Abstract] OR "gerbil"[Title/Abstract])',
  'Farm Animals': '("livestock"[Title/Abstract] OR "cattle"[Title/Abstract] OR "sheep"[Title/Abstract] OR "goat"[Title/Abstract] OR "pigs"[Title/Abstract] OR "swine"[Title/Abstract])',
  'Exotics (reptiles, birds)': '("reptile"[Title/Abstract] OR "lizard"[Title/Abstract] OR "snake"[Title/Abstract] OR "bird"[Title/Abstract] OR "parrot"[Title/Abstract] OR "avian"[Title/Abstract])',
  'Wildlife': '("wildlife"[Title/Abstract] OR "wild animal"[Title/Abstract] OR "marine mammal"[Title/Abstract])',
  'Multi-Species (General Pet)': '("companion animal"[Title/Abstract] OR "companion animals"[Title/Abstract] OR "pets"[Title/Abstract] OR "pet owners"[Title/Abstract])',
};

// Institutional web resource registry for Tier 2 and Tier 3 authoritative guidelines
interface InstitutionalCandidate {
  title: string;
  sourceInstitution: string;
  sourceType: SourceTier;
  url: string;
  yearPublished: number;
  primaryObjective: ObjectiveCategory;
  secondaryObjectives?: ObjectiveCategory[];
  species: string[];
  population: string[];
  briefSummary: string;
  qualifications: string;
  flagsNotes?: string[];
  doiOrPmid?: string;
}

const INSTITUTIONAL_REPOSITORY: InstitutionalCandidate[] = [
  {
    title: 'CDC Healthy Pets, Healthy People: Safe Pet Guidelines for Immunocompromised Individuals',
    sourceInstitution: 'Centers for Disease Control and Prevention (CDC)',
    sourceType: 'Tier 2',
    url: 'https://www.cdc.gov/healthy-pets/risk-factors/index.html',
    yearPublished: 2024,
    primaryObjective: 'Safety & Risk',
    secondaryObjectives: ['Human Health & Development', 'Animal Health & Welfare'],
    species: ['Multi-Species (General Pet)', 'Cat', 'Dog'],
    population: ['Immune-Compromised Individuals', 'General Pet Owners', 'Clinicians'],
    briefSummary: 'Official CDC clinical guidance detailing precautions for cancer patients, organ transplant recipients, and immunocompromised owners to maintain companion animal bonds safely while mitigating Bartonella, Salmonella, and Toxoplasma exposure.',
    qualifications: 'Federal public health clinical practice recommendations addressing zoonotic risk mitigation while preserving companion animal bonds.',
    flagsNotes: [],
  },
  {
    title: 'AVMA Clinical Guidance: Dog Bite Prevention and Family Child Safety',
    sourceInstitution: 'American Veterinary Medical Association (AVMA)',
    sourceType: 'Tier 2',
    url: 'https://www.avma.org/resources-tools/pet-owners/dog-bite-prevention',
    yearPublished: 2025,
    primaryObjective: 'Safety & Risk',
    secondaryObjectives: ['Human Health & Development'],
    species: ['Dog'],
    population: ['Parents', 'General Pet Owners', 'Clinicians'],
    briefSummary: 'Comprehensive veterinary policy and client education protocols instructing parents and pet owners on recognizing subtle canine stress signals, establishing safe household zones, and preventing pediatric bite injuries.',
    qualifications: 'AVMA official veterinary practice guidance on canine behavioral stress and child safety.',
    flagsNotes: [],
  },
  {
    title: '2025 AAHA One Health Guidelines for Companion Animal Practice',
    sourceInstitution: 'American Animal Hospital Association (AAHA)',
    sourceType: 'Tier 2',
    url: 'https://doi.org/10.5326/JAAHA-MS-7530',
    doiOrPmid: '10.5326/JAAHA-MS-7530',
    yearPublished: 2025,
    primaryObjective: 'Safety & Risk',
    secondaryObjectives: ['Human-Animal Interaction & Bonding'],
    species: ['Multi-Species (General Pet)', 'Dog', 'Cat'],
    population: ['Clinicians', 'General Pet Owners'],
    briefSummary: 'Standard-setting clinical guidelines establishing operational workflows for veterinary teams to interface with human healthcare providers on zoonotic risk management, animal abuse reporting, and family health vulnerabilities.',
    qualifications: 'AAHA clinical standard establishing interprofessional One Health protocols.',
    flagsNotes: [],
  },
  {
    title: 'CDC Parasitic Prevention: Toxoplasmosis Guidelines for Pregnant Cat Owners',
    sourceInstitution: 'Centers for Disease Control and Prevention (CDC)',
    sourceType: 'Tier 2',
    url: 'https://www.cdc.gov/toxoplasmosis/prevention/index.html',
    yearPublished: 2024,
    primaryObjective: 'Safety & Risk',
    secondaryObjectives: ['Human Health & Development'],
    species: ['Cat'],
    population: ['Parents', 'General Pet Owners', 'Clinicians'],
    briefSummary: 'Specific preventative protocols addressing congenital toxoplasmosis risks for expectant mothers, clearly differentiating indoor feline transmission mechanisms from soil, raw meat, and gardening exposures.',
    qualifications: 'CDC federal guidelines resolving common exam-room inquiries regarding pregnancy and feline ownership.',
    flagsNotes: [],
  },
  {
    title: 'NIH News in Health: The Health Benefits of Human-Animal Interactions',
    sourceInstitution: 'National Institutes of Health (NIH)',
    sourceType: 'Tier 2',
    url: 'https://newsinhealth.nih.gov/2018/02/power-pets',
    yearPublished: 2024,
    primaryObjective: 'Human Health & Development',
    secondaryObjectives: ['Human-Animal Interaction & Bonding'],
    species: ['Multi-Species (General Pet)', 'Dog', 'Cat'],
    population: ['General Pet Owners', 'General Public'],
    briefSummary: 'Accessible federal health synthesis detailing NIH/NICHD-funded clinical trials examining how companion animals reduce blood pressure, regulate salivary cortisol, and mitigate chronic loneliness across demographic groups.',
    qualifications: 'NIH peer-reviewed research synthesis written specifically for public and primary care translation.',
    flagsNotes: [],
  },
  {
    title: 'AVMA Practice Policy: Guidelines for Animal-Assisted Interventions in Healthcare Facilities',
    sourceInstitution: 'American Veterinary Medical Association (AVMA)',
    sourceType: 'Tier 2',
    url: 'https://www.avma.org/resources-tools/animal-health-and-welfare/service-emotional-support-and-therapy-animals/animal-assisted-interventions-guidelines',
    yearPublished: 2024,
    primaryObjective: 'Animal Health & Welfare',
    secondaryObjectives: ['Human-Animal Interaction & Bonding', 'Safety & Risk'],
    species: ['Dog', 'Multi-Species (General Pet)'],
    population: ['Clinicians', 'General Public'],
    briefSummary: 'Veterinary clinical protocols governing mandatory health screening, parasite control, behavioral temperament testing, and animal fatigue monitoring for therapy animals operating in healthcare facilities.',
    qualifications: 'AVMA national policy standard on therapy animal health, biosecurity, and welfare oversight.',
    flagsNotes: [],
  },
  {
    title: 'AVMA Wellbeing Guidance: Pet Loss, Bereavement, and Grief Support in Veterinary Practice',
    sourceInstitution: 'American Veterinary Medical Association (AVMA)',
    sourceType: 'Tier 2',
    url: 'https://www.avma.org/resources-tools/pet-owners/petcare/coping-loss-pet',
    yearPublished: 2024,
    primaryObjective: 'Crisis & Life Challenges',
    secondaryObjectives: ['Human Health & Development'],
    species: ['Multi-Species (General Pet)', 'Dog', 'Cat'],
    population: ['General Pet Owners', 'Clinicians'],
    briefSummary: 'Clinical and client-facing guidance outlining disenfranchised grief after pet euthanasia, providing practical communication frameworks for veterinary staff and validated referral hotlines for grieving owners.',
    qualifications: 'AVMA official guidance on client grief counseling, euthanasia support, and bereavement referral networks.',
    flagsNotes: [],
  },
  {
    title: 'HABRI Research Synthesis: The Impact of Companion Animals on Social Isolation & Loneliness',
    sourceInstitution: 'Human Animal Bond Research Institute (HABRI)',
    sourceType: 'Tier 3',
    url: 'https://habri.org/research/mental-health/social-isolation/',
    yearPublished: 2024,
    primaryObjective: 'Human Health & Development',
    secondaryObjectives: ['Human-Animal Interaction & Bonding'],
    species: ['Multi-Species (General Pet)', 'Dog', 'Cat'],
    population: ['Seniors and caregivers', 'General Pet Owners'],
    briefSummary: 'Comprehensive academic synthesis analyzing empirical research on companion animal ownership among community-dwelling older adults, demonstrating protective effects against chronic loneliness and cognitive decline.',
    qualifications: 'HABRI peer-reviewed research synthesis on geriatric companionship and mental wellness.',
    flagsNotes: [],
  },
  {
    title: 'Preliminary Efficacy of Service Dogs as a Complementary Treatment for Posttraumatic Stress Disorder in Military Members and Veterans',
    sourceInstitution: 'Journal of Consulting and Clinical Psychology (Purdue CHAB)',
    sourceType: 'Tier 1',
    url: 'https://pubmed.ncbi.nlm.nih.gov/29369663/',
    doiOrPmid: 'PMID: 29369663',
    yearPublished: 2018,
    primaryObjective: 'Human-Animal Interaction & Bonding',
    secondaryObjectives: ['Human Health & Development'],
    species: ['Dog'],
    population: ['Veterans', 'Clinicians', 'Researchers'],
    briefSummary: 'Flagship clinical trial from the Purdue Center for the Human-Animal Bond measuring salivary cortisol awakening responses, nightmare frequency, and social reintegration in veterans paired with trained service dogs.',
    qualifications: 'Purdue CHAB empirical clinical trial on psychiatric service dog efficacy published in JCCP.',
    flagsNotes: [],
  },
  {
    title: 'Tufts University Pet Loss Support Helpline & Family Bereavement Guidance',
    sourceInstitution: 'Tufts University Cummings School of Veterinary Medicine',
    sourceType: 'Tier 3',
    url: 'https://vet.tufts.edu/pet-loss-support-helpline',
    yearPublished: 2025,
    primaryObjective: 'Crisis & Life Challenges',
    secondaryObjectives: ['Human Health & Development'],
    species: ['Multi-Species (General Pet)', 'Dog', 'Cat'],
    population: ['General Pet Owners'],
    briefSummary: 'University-operated clinical resource providing free telephone grief support, developmentally tailored brochures for explaining pet death to children, and memorialization strategies for grieving pet owners.',
    qualifications: 'Tufts Cummings School validated clinical support service and bereavement educational guides.',
    flagsNotes: [],
  },
  {
    title: 'Effects of Animal-Assisted Activities with Guinea Pigs in the Primary School Classroom',
    sourceInstitution: 'PLoS One (Purdue CHAB)',
    sourceType: 'Tier 1',
    url: 'https://pubmed.ncbi.nlm.nih.gov/24265514/',
    doiOrPmid: 'PMID: 24265514',
    yearPublished: 2013,
    primaryObjective: 'Human-Animal Interaction & Bonding',
    secondaryObjectives: ['Human Health & Development'],
    species: ['Small mammals/Pocket Pets', 'Multi-Species (General Pet)'],
    population: ['Parents', 'Educators'],
    briefSummary: 'Experimental investigation from the Purdue Center for the Human-Animal Bond evaluating classroom guinea pigs on elementary students empathy scores, prosocial classroom behaviors, and social approach tendencies.',
    qualifications: 'Purdue University CHAB empirical study on pediatric empathy and companion animal interaction published in PLoS One.',
    flagsNotes: [
      'Publication Date Exception: Foundational landmark study published prior to the 10-year research window (>2016), retained due to active citation in current research.',
    ],
  },
  {
    title: 'IAHAIO White Paper: Guidelines for Animal-Assisted Services and Animal Wellness',
    sourceInstitution: 'International Association of Human-Animal Interaction Organizations (IAHAIO)',
    sourceType: 'Tier 3',
    url: 'https://iahaio.org/best-practice/white-paper-on-animal-assisted-interventions/',
    yearPublished: 2024,
    primaryObjective: 'Animal Health & Welfare',
    secondaryObjectives: ['Human-Animal Interaction & Bonding', 'Safety & Risk'],
    species: ['Dog', 'Horses', 'Multi-Species (General Pet)'],
    population: ['Clinicians', 'Researchers', 'General Public'],
    briefSummary: 'International ethical guidelines defining standard terminology and mandatory animal welfare safeguards for therapy animals, including maximum session limits, retirement protocols, and consent testing.',
    qualifications: 'IAHAIO international standard safeguarding animal welfare in human clinical interventions.',
    flagsNotes: [],
  },
  {
    title: 'University of Tennessee Center for Veterinary Social Work (CVSW): Resources & Professional Directory',
    sourceInstitution: 'University of Tennessee Center for Veterinary Social Work',
    sourceType: 'Tier 3',
    url: 'https://vetsocialwork.tennessee.edu/',
    yearPublished: 2025,
    primaryObjective: 'Human-Animal Interaction & Bonding',
    secondaryObjectives: ['Crisis & Life Challenges'],
    species: ['Multi-Species (General Pet)', 'Dog', 'Cat'],
    population: ['Clinicians', 'General Pet Owners'],
    briefSummary: 'Authoritative academic portal defining Veterinary Social Work across four core practice areas: grief and pet loss, animal-assisted interactions, the animal abuse link (The Link), and compassion fatigue management.',
    qualifications: 'University of Tennessee validated model for veterinary social work integration and interprofessional referral navigation.',
    flagsNotes: [],
  },
  {
    title: 'HABRI Research Synthesis: The Human-Animal Bond and Cardiovascular Health',
    sourceInstitution: 'Human Animal Bond Research Institute (HABRI)',
    sourceType: 'Tier 3',
    url: 'https://habri.org/research/healthy-aging/cardiovascular-health/',
    yearPublished: 2024,
    primaryObjective: 'Human Health & Development',
    secondaryObjectives: ['Human-Animal Interaction & Bonding'],
    species: ['Dog', 'Cat', 'Multi-Species (General Pet)'],
    population: ['General Pet Owners', 'Clinicians', 'Researchers'],
    briefSummary: 'Comprehensive synthesis of cardiovascular outcome trials associating pet ownership—particularly dog walking—with lowered blood pressure, improved autonomic tone, and reduced post-infarction mortality.',
    qualifications: 'HABRI synthesis of American Heart Association-recognized cardiovascular outcomes.',
    flagsNotes: [],
  },
];

function buildPubMedQuery(topic?: string, objective?: string, species?: string): string {
  const parts: string[] = [];

  // Core HAI base query: must include companion animal/interaction and exclude pure PET scan radiology
  const CORE_HAI =
    '(("human-animal interaction"[Title/Abstract] OR "human-animal bond"[Title/Abstract] OR "companion animal"[Title/Abstract] OR "companion animals"[Title/Abstract] OR "pet ownership"[Title/Abstract] OR "pet owners"[Title/Abstract] OR "therapy dog"[Title/Abstract] OR "service dog"[Title/Abstract] OR "animal-assisted"[Title/Abstract]) NOT ("positron emission tomography"[Title/Abstract] OR "PET scan"[Title/Abstract]))';
  parts.push(CORE_HAI);

  // If specific search topic provided from the authorized list
  if (topic && topic !== 'All' && TOPIC_SEARCH_TERMS[topic]) {
    parts.push(TOPIC_SEARCH_TERMS[topic]);
  } else if (topic && topic.trim() && topic !== 'All') {
    parts.push(`(${topic.trim()})`);
  }

  // If objective category provided
  if (objective && objective !== 'All' && OBJECTIVE_SEARCH_TERMS[objective as ObjectiveCategory]) {
    parts.push(OBJECTIVE_SEARCH_TERMS[objective as ObjectiveCategory]);
  }

  // If species provided from the authorized list
  if (species && species !== 'All' && SPECIES_SEARCH_TERMS[species]) {
    parts.push(SPECIES_SEARCH_TERMS[species]);
  }

  // Publication date currency: 2016 to 2026
  parts.push(`(2016/01/01:${new Date().getFullYear() + 1}/12/31[Date - Publication])`);

  return parts.join(' AND ');
}

async function fetchPubMedAbstracts(pmids: string[]): Promise<Record<string, string>> {
  if (!pmids.length) return {};
  try {
    const url = `${NCBI_BASE}/efetch.fcgi?db=pubmed&id=${pmids.join(',')}&rettype=abstract&retmode=text${NCBI_PARAMS}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return {};
    const text = await res.text();
    const abstracts: Record<string, string> = {};
    const chunks = text.split(/\n\n(?=\d+\.\s)/g);
    for (const chunk of chunks) {
      const pmidMatch = chunk.match(/PMID:\s*(\d+)/i);
      if (pmidMatch && pmidMatch[1]) {
        const clean = chunk.replace(/PMID:\s*\d+[\s\S]*$/i, '').trim();
        abstracts[pmidMatch[1]] = clean;
      }
    }
    return abstracts;
  } catch {
    return {};
  }
}

// Check duplicate against existing records
function isDuplicateRecord(title: string, doiOrPmid?: string): boolean {
  const normTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
  return resources.some((r) => {
    if (doiOrPmid && r.url.includes(doiOrPmid)) return true;
    const rTitle = r.title.toLowerCase().replace(/[^a-z0-9]/g, '');
    return rTitle === normTitle;
  });
}

// ==========================================
// PULL RESOURCES FROM ALL CATEGORIES ROUTE
// Pulls papers systematically across ALL 5 categories
// strictly adhering to the One Health HAI inclusion/exclusion rubric
// ==========================================
app.post('/api/agent/pull-all-categories', async (req, res) => {
  await refreshResources();
  const { batchSize = 10, tier = 'All' } = req.body;
  const targetTotal = Math.max(5, Math.min(25, Number(batchSize) || 10));
  const perCategoryTarget = Math.max(1, Math.ceil(targetTotal / 5));

  const allAddedRecords: HAIResource[] = [];
  const allExcludedReasons: { title: string; reason: string }[] = [];
  let totalScreened = 0;
  const categorySummaries: { category: ObjectiveCategory; addedCount: number; sampleTitles: string[] }[] = [];

  try {
    for (const objCategory of OBJECTIVE_CATEGORIES) {
      let addedInCat = 0;
      const catSampleTitles: string[] = [];

      // 1. PubMed Search for this category
      if (tier === 'All' || tier === 'Tier 1') {
        try {
          const categoryQuery = `(${OBJECTIVE_SEARCH_TERMS[objCategory]}) AND ("2016"[Date - Publication] : "3000"[Date - Publication]) AND ("free full text"[Filter] OR "open access"[Filter])`;
          const esearchUrl = `${NCBI_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(
            categoryQuery
          )}&retmode=json&retmax=15&sort=relevance${NCBI_PARAMS}`;

          const esearchResp = await fetch(esearchUrl, { signal: AbortSignal.timeout(6000) });
          if (esearchResp.ok) {
            const esearchData = (await esearchResp.json()) as any;
            const idList: string[] = esearchData?.esearchresult?.idlist || [];

            if (idList.length > 0) {
              const summaryUrl = `${NCBI_BASE}/esummary.fcgi?db=pubmed&id=${idList.join(
                ','
              )}&retmode=json${NCBI_PARAMS}`;
              const [sumResp, abstracts] = await Promise.all([
                fetch(summaryUrl, { signal: AbortSignal.timeout(6000) }),
                fetchPubMedAbstracts(idList),
              ]);

              if (sumResp.ok) {
                const sumData = (await sumResp.json()) as any;
                const resultObj = sumData?.result || {};

                for (const pmid of idList) {
                  if (addedInCat >= perCategoryTarget) break;
                  const item = resultObj[pmid];
                  if (!item || !item.title) continue;

                  totalScreened++;
                  const itemTitle = item.title;
                  const pubYear = item.pubdate ? item.pubdate.slice(0, 4) : 2024;
                  const abstract = abstracts[pmid] || '';

                  if (isDuplicateRecord(itemTitle, pmid)) {
                    allExcludedReasons.push({
                      title: itemTitle.slice(0, 60) + '...',
                      reason: `Duplicate: Already present in your ${objCategory} database.`,
                    });
                    continue;
                  }

                  const sifted = evaluateAlgorithmic({
                    title: itemTitle,
                    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
                    doiOrPmid: pmid,
                    rawTextOrAbstract: abstract,
                    sourceInstitution: item.source || 'PubMed Peer-Reviewed Journal',
                    sourceType: 'Tier 1',
                  });

                  if (!sifted.passesCriteria || sifted.verdict === 'Rejected') {
                    allExcludedReasons.push({
                      title: itemTitle.slice(0, 60) + '...',
                      reason: sifted.verdictRationale || 'Failed dual-domain inclusion criteria.',
                    });
                    continue;
                  }

                  // Force aligned primaryObjective to this targeted category
                  sifted.resource.primaryObjective = objCategory;
                  sifted.resource.reviewerStatus =
                    sifted.verdict === 'Flagged for Review' ? 'Flagged for Review' : 'AI Screened';
                  sifted.resource.yearPublished = pubYear;

                  allAddedRecords.push(sifted.resource);
                  resources.unshift(sifted.resource);
                  addedInCat++;
                  catSampleTitles.push(sifted.resource.title);
                }
              }
            }
          }
        } catch (catErr: any) {
          console.warn(`PubMed harvest for category ${objCategory} had network notice:`, catErr.message);
        }
      }

      // 2. Fallback / supplement from Institutional candidates for this category if needed
      if (addedInCat < perCategoryTarget && (tier === 'All' || tier !== 'Tier 1')) {
        const matchingInst = INSTITUTIONAL_REPOSITORY.filter(
          (cand) => cand.primaryObjective === objCategory || cand.secondaryObjectives?.includes(objCategory)
        );

        for (const cand of matchingInst) {
          if (addedInCat >= perCategoryTarget) break;
          totalScreened++;

          if (isDuplicateRecord(cand.title, cand.url)) {
            continue;
          }

          const newRec: HAIResource = {
            id: `hai_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            title: cand.title,
            url: cand.url,
            sourceInstitution: cand.sourceInstitution,
            sourceType: cand.sourceType,
            yearPublished: cand.yearPublished,
            primaryObjective: objCategory,
            secondaryObjectives: cand.secondaryObjectives || [],
            population: cand.population,
            species: cand.species,
            briefSummary: cand.briefSummary,
            qualifications: cand.qualifications,
            flagsNotes: cand.flagsNotes || [],
            reviewerStatus: cand.flagsNotes && cand.flagsNotes.length > 0 ? 'Flagged for Review' : 'AI Screened',
          };

          allAddedRecords.push(newRec);
          resources.unshift(newRec);
          addedInCat++;
          catSampleTitles.push(newRec.title);
        }
      }

      categorySummaries.push({
        category: objCategory,
        addedCount: addedInCat,
        sampleTitles: catSampleTitles,
      });
    }

    if (allAddedRecords.length > 0) {
      stampNewRecords(allAddedRecords, 'manual');
      await store.upsertMany(allAddedRecords);
    }

    res.json({
      success: true,
      totalAdded: allAddedRecords.length,
      totalScreened: Math.max(totalScreened, allAddedRecords.length + allExcludedReasons.length),
      totalExcluded: allExcludedReasons.length,
      categories: categorySummaries,
      addedRecords: allAddedRecords,
      excludedReasons: allExcludedReasons,
    });
  } catch (error: any) {
    console.error('Pull all categories error:', error);
    res.status(500).json({ error: error.message || 'Failed to pull resources from all categories' });
  }
});

// Discover and sift through papers/resources based on criteria
app.post('/api/agent/discover-sift', async (req, res) => {
  await refreshResources();
  const { topic, objective, species, sourceType = 'All', limit = 5 } = req.body;
  const targetLimit = Math.max(1, Math.min(10, Number(limit) || 5));

  const addedRecords: HAIResource[] = [];
  const excludedReasons: { title: string; reason: string }[] = [];
  let screenedCount = 0;

  try {
    // 1. SCHOLARLY SEARCH (PubMed / NCBI) for Tier 1
    if (sourceType === 'All' || sourceType === 'Tier 1') {
      const pubmedTerm = buildPubMedQuery(topic, objective, species);
      try {
        const esearchUrl = `${NCBI_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(
          pubmedTerm
        )}&retmode=json&retmax=12&sort=relevance${NCBI_PARAMS}`;

        const esearchResp = await fetch(esearchUrl, { signal: AbortSignal.timeout(6000) });
        if (esearchResp.ok) {
          const esearchData = (await esearchResp.json()) as any;
          const idList: string[] = esearchData?.esearchresult?.idlist || [];

          if (idList.length > 0) {
            const summaryUrl = `${NCBI_BASE}/esummary.fcgi?db=pubmed&id=${idList.join(
              ','
            )}&retmode=json${NCBI_PARAMS}`;
            const [sumResp, abstracts] = await Promise.all([
              fetch(summaryUrl, { signal: AbortSignal.timeout(6000) }),
              fetchPubMedAbstracts(idList),
            ]);

            if (sumResp.ok) {
              const sumData = (await sumResp.json()) as any;
              const resultObj = sumData?.result || {};

              for (const pmid of idList) {
                if (addedRecords.length >= targetLimit) break;
                const item = resultObj[pmid];
                if (!item || !item.title) continue;

                screenedCount++;
                const itemTitle = item.title;
                const pubYear = item.pubdate ? item.pubdate.slice(0, 4) : 2024;
                const abstract = abstracts[pmid] || '';

                // Check duplicate
                if (isDuplicateRecord(itemTitle, pmid)) {
                  excludedReasons.push({
                    title: itemTitle.slice(0, 60) + '...',
                    reason: 'Duplicate: Already present in your evidence database.',
                  });
                  continue;
                }

                // Sift against rubric
                const sifted = evaluateAlgorithmic({
                  title: itemTitle,
                  url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
                  doiOrPmid: pmid,
                  rawTextOrAbstract: abstract,
                  sourceInstitution: item.source || 'PubMed Peer-Reviewed Journal',
                  sourceType: 'Tier 1',
                });

                if (!sifted.passesCriteria || sifted.verdict === 'Rejected') {
                  excludedReasons.push({
                    title: itemTitle.slice(0, 60) + '...',
                    reason: sifted.verdictRationale || 'Failed dual-domain inclusion criteria.',
                  });
                  continue;
                }

                // Mandate: Discovered papers start as AI Screened (or Flagged if exceptions). Never Human Approved until reviewed.
                sifted.resource.reviewerStatus = sifted.verdict === 'Flagged for Review' ? 'Flagged for Review' : 'AI Screened';
                sifted.resource.yearPublished = pubYear;
                addedRecords.push(sifted.resource);
                resources.unshift(sifted.resource);
              }
            }
          }
        }
      } catch (err: any) {
        console.warn('PubMed discovery attempt had network timeout/error:', err.message);
      }
    }

    // 2. INSTITUTIONAL & WEB SIFTING (Tier 2 Government / Tier 3 HAI Institutes)
    if (addedRecords.length < targetLimit && (sourceType === 'All' || sourceType !== 'Tier 1')) {
      const candidates = INSTITUTIONAL_REPOSITORY.filter((cand) => {
        if (sourceType !== 'All' && cand.sourceType !== sourceType) return false;
        if (objective && objective !== 'All' && cand.primaryObjective !== objective && !cand.secondaryObjectives?.includes(objective as any)) {
          return false;
        }
        if (species && species !== 'All' && !cand.species.includes(species) && !cand.species.includes('Multi-Species (General Pet)')) {
          return false;
        }
        if (topic && topic !== 'All') {
          const tLower = topic.toLowerCase();
          const match =
            cand.title.toLowerCase().includes(tLower) ||
            cand.briefSummary.toLowerCase().includes(tLower) ||
            cand.qualifications.toLowerCase().includes(tLower);
          if (!match) return false;
        }
        return true;
      });

      for (const cand of candidates) {
        if (addedRecords.length >= targetLimit) break;
        screenedCount++;

        if (isDuplicateRecord(cand.title, cand.url)) {
          excludedReasons.push({
            title: cand.title.slice(0, 60) + '...',
            reason: 'Duplicate: Already present in your evidence database.',
          });
          continue;
        }

        const newRec: HAIResource = {
          id: `hai_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          title: cand.title,
          url: cand.url,
          sourceInstitution: cand.sourceInstitution,
          sourceType: cand.sourceType,
          yearPublished: cand.yearPublished,
          primaryObjective: cand.primaryObjective,
          secondaryObjectives: cand.secondaryObjectives || [],
          population: cand.population,
          species: cand.species,
          briefSummary: cand.briefSummary,
          qualifications: cand.qualifications,
          flagsNotes: cand.flagsNotes || [],
          // Mandate: Never marked Human Approved automatically. Starts as AI Screened or Flagged for Review.
          reviewerStatus: (cand.flagsNotes && cand.flagsNotes.length > 0) ? 'Flagged for Review' : 'AI Screened',
        };

        addedRecords.push(newRec);
        resources.unshift(newRec);
      }
    }

    // Persist any newly added records
    if (addedRecords.length > 0) {
      stampNewRecords(addedRecords, 'manual');
      await store.upsertMany(addedRecords);
    }

    res.json({
      success: true,
      addedCount: addedRecords.length,
      screenedCount: Math.max(screenedCount, addedRecords.length + excludedReasons.length),
      excludedCount: excludedReasons.length,
      addedRecords,
      excludedReasons,
      queryUsed: topic && topic !== 'All' ? `${topic} [${objective || 'All Topics'}]` : `${objective || 'All Topics'} (${species || 'All Species'})`,
    });
  } catch (error: any) {
    console.error('Discover & Sift error:', error);
    res.status(500).json({ error: error.message || 'Auto-discovery sifting failed' });
  }
});

// 3. AI Screening against Rubric
// Screens one candidate against the rubric with Gemini.
// Returns null when no GEMINI_API_KEY is configured; THROWS on API/parse failure so callers decide how to degrade.
async function screenWithGemini(c: {
  enrichedTitle: string;
  enrichedUrl: string;
  doiOrPmid?: string;
  enrichedInstitution: string;
  enrichedAbstract: string;
  sourceType?: SourceTier;
}): Promise<ScreeningEvaluationResult | null> {
  if (!process.env.GEMINI_API_KEY) return null;
  const { enrichedTitle, enrichedUrl, doiOrPmid, enrichedInstitution, enrichedAbstract, sourceType } = c;
      const ai = getGenAI();
      const prompt = `You are an expert Human-Animal Interaction (HAI) Research Curation Agent.
Evaluate this candidate resource strictly against the research curation rubric.

Candidate Resource:
- Title: ${enrichedTitle || 'Not provided'}
- URL: ${enrichedUrl || 'Not provided'}
- DOI/PMID: ${doiOrPmid || 'Not provided'}
- Source Institution: ${enrichedInstitution || 'Not provided'}
- Abstract / Text: ${enrichedAbstract || 'None provided'}

BASE YOUR JUDGEMENT ONLY ON THE CANDIDATE TEXT ABOVE. Do not invent methods, populations or findings. If no abstract is available, set verdict to "Flagged for Review" and say so in verdictRationale.

CRITICAL INCLUSION & EXCLUSION RUBRIC:
1. MANDATORY DUAL-DOMAIN CRITERIA:
   - Must substantively investigate companion animals (dogs, cats, horses, small mammals, etc.) in relationship with humans.
   - REJECT if the study is solely human (e.g. general child development, pharmacology, general autism without animals).
   - REJECT if the study is laboratory rodent disease model (mice/rats in drug trials).
   - REJECT if pure veterinary pathology/microbiology with zero human bond interaction.
   - REJECT if advertorial, paywalled, or from unmoderated social forums.

2. STRICT 5 OBJECTIVE CATEGORIES:
   Assign primaryObjective strictly to ONE of these five:
   - "Human Health & Development"
   - "Animal Health & Welfare"
   - "Human-Animal Interaction & Bonding"
   - "Safety & Risk"
   - "Crisis & Life Challenges"
   (Note: Animal-assisted interventions belongs under "Human-Animal Interaction & Bonding").
   Assign secondaryObjectives as an array from the same remaining 4 categories (or empty array).

3. POPULATION & SPECIES (USE STRICT DISCRIMINATION):
   - Valid populations: ['General Public', 'General Pet Owners', 'Parents', 'Educators', 'Immune-Compromised Individuals', 'Disabled Individuals', 'Policymakers/Community Organizations', 'Clinicians', 'Seniors and caregivers', 'Veterans', 'Researchers', 'Animal exhibitors/breeders']
   - Valid species: ['Multi-Species (General Pet)', 'Dog', 'Cat', 'Small mammals/Pocket Pets', 'Horses', 'Farm Animals', 'Exotics (reptiles, birds)', 'Wildlife']

4. STRICT FLAGS/NOTES RESTRICTION:
   Flags/Notes can ONLY contain one of these three exact strings:
   (1) "Publication Date Exception: Foundational landmark study published prior to the 10-year research window (>2016), retained due to active citation in current research."
   (2) "Commercial Science Affiliation: Research affiliated with or funded by a commercial industry entity (e.g. WALTHAM Petcare Science Institute / Mars Petcare); vetted for scientific rigor."
   (3) "Geographic/Legal Non-US Generalizability: Regional study cohort or foreign legal/statutory framework not directly generalizable to the United States."
   If none of these three apply, flagsNotes MUST be an empty array [].

5. OUTPUT SCHEMA:
   Return JSON matching the exact 12 fields and verdict:
   - title: string
   - url: string
   - sourceInstitution: string
   - sourceType: "Tier 1" | "Tier 2" | "Tier 3"
   - yearPublished: number
   - primaryObjective: "Human Health & Development" | "Animal Health & Welfare" | "Human-Animal Interaction & Bonding" | "Safety & Risk" | "Crisis & Life Challenges"
   - secondaryObjectives: string[]
   - population: string[]
   - species: string[]
   - briefSummary: 2-3 sentence clear summary of methods and findings
   - qualifications: 1 sentence explaining why it meets inclusion criteria
   - flagsNotes: string[] (ONLY the 3 permitted strings or empty [])
   - verdict: "AI Screened" | "Flagged for Review" | "Rejected"
   - verdictRationale: 1-2 sentence explanation of the verdict`;

      const aiResp = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              url: { type: Type.STRING },
              sourceInstitution: { type: Type.STRING },
              sourceType: { type: Type.STRING, enum: ['Tier 1', 'Tier 2', 'Tier 3'] },
              yearPublished: { type: Type.INTEGER },
              primaryObjective: {
                type: Type.STRING,
                enum: [
                  'Human Health & Development',
                  'Animal Health & Welfare',
                  'Human-Animal Interaction & Bonding',
                  'Safety & Risk',
                  'Crisis & Life Challenges',
                ],
              },
              secondaryObjectives: { type: Type.ARRAY, items: { type: Type.STRING } },
              population: { type: Type.ARRAY, items: { type: Type.STRING } },
              species: { type: Type.ARRAY, items: { type: Type.STRING } },
              briefSummary: { type: Type.STRING },
              qualifications: { type: Type.STRING },
              flagsNotes: { type: Type.ARRAY, items: { type: Type.STRING } },
              verdict: { type: Type.STRING, enum: ['AI Screened', 'Flagged for Review', 'Rejected'] },
              verdictRationale: { type: Type.STRING },
            },
            required: [
              'title',
              'sourceInstitution',
              'sourceType',
              'yearPublished',
              'primaryObjective',
              'briefSummary',
              'qualifications',
              'verdict',
              'verdictRationale',
            ],
          },
        },
      });

      const parsed = JSON.parse(aiResp.text || '{}');
      if (parsed.title) {
        const strictFlags = filterStrictFlags(parsed.flagsNotes || []);
        const primaryObj = normalizeObjective(parsed.primaryObjective);
        const secObjs = Array.isArray(parsed.secondaryObjectives)
          ? parsed.secondaryObjectives.map(normalizeObjective).filter((o: string) => o !== primaryObj)
          : [];

        const resource: HAIResource = {
          id: `hai_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          title: parsed.title,
          url: parsed.url || enrichedUrl || 'https://pubmed.ncbi.nlm.nih.gov/',
          sourceInstitution: parsed.sourceInstitution || enrichedInstitution || 'Peer-Reviewed Journal',
          sourceType: (parsed.sourceType as SourceTier) || sourceType || 'Tier 1',
          yearPublished: parsed.yearPublished || new Date().getFullYear(),
          primaryObjective: primaryObj,
          secondaryObjectives: secObjs,
          population: Array.isArray(parsed.population) && parsed.population.length > 0 ? parsed.population : ['General Pet Owners'],
          species: Array.isArray(parsed.species) && parsed.species.length > 0 ? parsed.species : ['Multi-Species (General Pet)'],
          briefSummary: parsed.briefSummary || '',
          qualifications: parsed.qualifications || 'Meets inclusion criteria for companion animal research.',
          flagsNotes: strictFlags,
          // Mandate: Never mark papers Human Approved until human review. Starts as AI Screened.
          reviewerStatus: parsed.verdict === 'Rejected' ? 'Rejected' : parsed.verdict === 'Flagged for Review' ? 'Flagged for Review' : 'AI Screened',
        };

        return {
          resource,
          verdict: parsed.verdict,
          verdictRationale: parsed.verdictRationale,
          passesCriteria: parsed.verdict !== 'Rejected',
          warnings: strictFlags,
        };
      }
  throw new Error('Gemini returned an unusable response');
}

const screenHandler = async (req: express.Request, res: express.Response) => {
  const { url, doiOrPmid, rawTextOrAbstract, title, sourceInstitution, sourceType } = req.body;

  if (!url && !doiOrPmid && !rawTextOrAbstract && !title) {
    return res.status(400).json({
      error: 'Please provide at least a URL, DOI/PMID, Title, or Abstract/Text to screen.',
    });
  }

  let enrichedTitle = title || '';
  let enrichedAbstract = rawTextOrAbstract || '';
  let enrichedInstitution = sourceInstitution || '';
  let enrichedUrl = url || '';

  // If PMID provided but no abstract, attempt quick NCBI fetch
  if (doiOrPmid && !enrichedAbstract) {
    const pmidMatch = doiOrPmid.match(/(\d{6,9})/);
    if (pmidMatch) {
      try {
        const pmid = pmidMatch[1];
        const sumUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`;
        const sumResp = await fetch(sumUrl, { signal: AbortSignal.timeout(4000) });
        if (sumResp.ok) {
          const sData = (await sumResp.json()) as any;
          const article = sData?.result?.[pmid];
          if (article && article.title) {
            if (!enrichedTitle) enrichedTitle = article.title;
            if (!enrichedInstitution) enrichedInstitution = article.source || 'PubMed Journal';
            if (!enrichedUrl) enrichedUrl = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
          }
        }
      } catch {
        // Continue with user inputs
      }
    }
  }

  // Attempt Gemini API evaluation if key exists
  try {
    const gem = await screenWithGemini({
      enrichedTitle,
      enrichedUrl,
      doiOrPmid,
      enrichedInstitution,
      enrichedAbstract,
      sourceType,
    });
    if (gem) return res.json(gem);
  } catch (err: any) {
    console.warn('Gemini screening call failed, utilizing algorithmic rubric fallback:', err.message);
  }

  // Algorithmic fallback
  const result = evaluateAlgorithmic({
    title: enrichedTitle,
    url: enrichedUrl,
    doiOrPmid,
    rawTextOrAbstract: enrichedAbstract,
    sourceInstitution: enrichedInstitution,
    sourceType,
  });

  return res.json(result);
};

app.post('/api/agent/screen', screenHandler);
app.post('/api/agent/evaluate', screenHandler);

// ==========================================
// DAILY AGENT
//  1. Incremental discovery: only PubMed records added since the last run
//  2. Gemini screening against the rubric (rejects are remembered, never re-screened)
//  3. Re-check pass over existing records: retractions, dead links, changed pages
// Triggered by Cloud Scheduler -> POST /api/agent/daily-run (protected by CRON_SECRET)
// ==========================================
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS) || 8 * 60 * 1000;
const MAX_SCREEN_PER_RUN = Number(process.env.MAX_SCREEN_PER_RUN) || 60;
const RECHECK_BATCH = Number(process.env.RECHECK_BATCH) || 300;
const DEFAULT_WINDOW_DAYS = Number(process.env.DISCOVERY_WINDOW_DAYS) || 7;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function ncbiFetch(url: string, attempts = 3): Promise<Response> {
  let lastErr: any = new Error('NCBI request failed');
  for (let i = 0; i < attempts; i++) {
    let retryable = true;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (resp.ok) return resp;
      retryable = resp.status === 429 || resp.status >= 500;
      lastErr = new Error(`NCBI HTTP ${resp.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (!retryable) break;
    await sleep(1000 * (i + 1) * (i + 1));
  }
  throw lastErr;
}

const ymd = (d: Date) =>
  `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;

function pmidFromUrl(url?: string): string | undefined {
  const m = (url || '').match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{4,9})/);
  return m ? m[1] : undefined;
}
const getPmid = (r: HAIResource) => r.pmid || pmidFromUrl(r.url);
const normTitle = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, '');

async function fetchPubMedArticles(pmids: string[]): Promise<PubMedArticle[]> {
  if (!pmids.length) return [];
  const url = `${NCBI_BASE}/efetch.fcgi?db=pubmed&id=${pmids.join(',')}&retmode=xml${NCBI_PARAMS}`;
  const resp = await ncbiFetch(url);
  return parsePubMedXml(await resp.text());
}

function knownIdentity() {
  const pmids = new Set<string>();
  const titles = new Set<string>();
  for (const r of resources) {
    const p = getPmid(r);
    if (p) pmids.add(p);
    titles.add(normTitle(r.title));
  }
  return { pmids, titles };
}

// ---------- 1. Discovery ----------
async function discoverCandidatePmids(start: Date, end: Date, deadline: number) {
  const found = new Set<string>();
  const errors: string[] = [];
  let complete = true;
  for (const cat of OBJECTIVE_CATEGORIES) {
    const term = buildPubMedQuery(undefined, cat, undefined);
    const retmax = 100;
    let retstart = 0;
    while (true) {
      if (Date.now() >= deadline) {
        complete = false;
        break;
      }
      const url =
        `${NCBI_BASE}/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&retmode=json` +
        `&retmax=${retmax}&retstart=${retstart}&datetype=edat&mindate=${ymd(start)}&maxdate=${ymd(end)}${NCBI_PARAMS}`;
      try {
        const data = (await (await ncbiFetch(url)).json()) as any;
        const ids: string[] = data?.esearchresult?.idlist || [];
        const count = Number(data?.esearchresult?.count || 0);
        ids.forEach((id) => found.add(id));
        retstart += retmax;
        if (ids.length === 0 || retstart >= count) break;
        if (retstart >= 500) {
          complete = false; // more than 500 hits for one category in one window; next run continues
          break;
        }
      } catch (e: any) {
        errors.push(`${cat}: ${e.message}`);
        complete = false;
        break;
      }
      await sleep(NCBI_DELAY);
    }
  }
  return { pmids: [...found], errors, complete };
}

async function runDiscovery(opts: { start: Date; end: Date; deadline: number; dryRun: boolean }) {
  const { start, end, deadline, dryRun } = opts;
  const summary = {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    candidates: 0,
    alreadyKnown: 0,
    screened: 0,
    added: 0,
    rejected: 0,
    deferred: 0,
    usedFallbackScreening: false,
    errors: [] as string[],
    complete: true,
    addedTitles: [] as string[],
    rejectedSample: [] as { title: string; reason: string }[],
  };

  const disc = await discoverCandidatePmids(start, end, deadline);
  summary.errors.push(...disc.errors);
  summary.complete = disc.complete;
  summary.candidates = disc.pmids.length;

  const known = knownIdentity();
  const fresh = disc.pmids.filter((id) => !known.pmids.has(id));
  summary.alreadyKnown = disc.pmids.length - fresh.length;
  const seen = await store.getSeen(fresh);
  const toScreen = fresh.filter((id) => !seen.has(id));
  summary.alreadyKnown += fresh.length - toScreen.length;

  const batch = toScreen.slice(0, MAX_SCREEN_PER_RUN);
  summary.deferred = toScreen.length - batch.length;

  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  summary.usedFallbackScreening = !hasGemini;
  let consecutiveGeminiFailures = 0;
  const nowIso = new Date().toISOString();

  for (const ids of chunkArray(batch, 25)) {
    if (Date.now() >= deadline) {
      summary.deferred += ids.length;
      summary.complete = false;
      continue;
    }
    let articles: PubMedArticle[] = [];
    try {
      articles = await fetchPubMedArticles(ids);
    } catch (e: any) {
      summary.errors.push(`efetch: ${e.message}`);
      summary.deferred += ids.length;
      summary.complete = false;
      continue;
    }

    const chunkAdded: HAIResource[] = [];
    const chunkSeen: SeenEntry[] = [];

    await mapPool(articles, 3, async (art) => {
      if (consecutiveGeminiFailures >= 5) {
        summary.deferred++;
        return;
      }
      if (known.titles.has(normTitle(art.title))) {
        chunkSeen.push({ id: art.pmid, verdict: 'Rejected', reason: 'Duplicate title of an existing record', title: art.title, seenAt: nowIso });
        summary.rejected++;
        return;
      }
      if (art.publicationTypes.some((t) => /^(Retracted Publication|Retraction of Publication|Published Erratum)$/i.test(t))) {
        chunkSeen.push({ id: art.pmid, verdict: 'Rejected', reason: `Publication type: ${art.publicationTypes.join(', ')}`, title: art.title, seenAt: nowIso });
        summary.rejected++;
        return;
      }

      const rawText = [
        `Journal: ${art.journal}`,
        `Year: ${art.year ?? 'unknown'}`,
        `Publication types: ${art.publicationTypes.join(', ') || 'unknown'}`,
        art.affiliations ? `Author affiliations: ${art.affiliations}` : '',
        '',
        `Abstract: ${art.abstract || '(no abstract available)'}`,
      ]
        .join('\n');

      let result: ScreeningEvaluationResult;
      try {
        const gem = hasGemini
          ? await screenWithGemini({
              enrichedTitle: art.title,
              enrichedUrl: `https://pubmed.ncbi.nlm.nih.gov/${art.pmid}/`,
              doiOrPmid: art.pmid,
              enrichedInstitution: art.journal,
              enrichedAbstract: rawText,
              sourceType: 'Tier 1',
            })
          : null;
        if (gem) {
          result = gem;
          consecutiveGeminiFailures = 0;
        } else {
          // No Gemini key: regex rubric only. Regex is the weaker screen, so anything it passes
          // goes to a human as "Flagged for Review" rather than "AI Screened".
          result = evaluateAlgorithmic({
            title: art.title,
            url: `https://pubmed.ncbi.nlm.nih.gov/${art.pmid}/`,
            doiOrPmid: art.pmid,
            rawTextOrAbstract: rawText,
            sourceInstitution: art.journal,
            sourceType: 'Tier 1',
          });
          if (result.verdict === 'AI Screened') {
            result.verdict = 'Flagged for Review';
            result.resource.reviewerStatus = 'Flagged for Review';
          }
        }
      } catch (e: any) {
        // Transient Gemini failure: do NOT mark as seen, so tomorrow's run retries it.
        consecutiveGeminiFailures++;
        summary.deferred++;
        summary.errors.push(`gemini (${art.pmid}): ${e.message}`);
        return;
      }
      summary.screened++;

      if (result.verdict === 'Rejected' || !result.passesCriteria) {
        chunkSeen.push({ id: art.pmid, verdict: 'Rejected', reason: result.verdictRationale, title: art.title, seenAt: nowIso });
        summary.rejected++;
        if (summary.rejectedSample.length < 10) summary.rejectedSample.push({ title: art.title, reason: result.verdictRationale });
        return;
      }

      const rec = result.resource;
      rec.title = art.title || rec.title;
      rec.url = `https://pubmed.ncbi.nlm.nih.gov/${art.pmid}/`;
      rec.sourceType = 'Tier 1';
      rec.sourceInstitution = art.journal || rec.sourceInstitution;
      rec.yearPublished = art.year ?? rec.yearPublished;
      rec.flagsNotes = filterStrictFlags(rec.flagsNotes || []);
      rec.pmid = art.pmid;
      rec.dateAdded = nowIso;
      rec.addedBy = 'daily-agent';
      rec.lastCheckedAt = nowIso;
      rec.linkStatus = 'ok';
      rec.linkFailCount = 0;
      // Never auto-approve: only the agent-assigned statuses are allowed here.
      if (rec.reviewerStatus === 'Human Approved') rec.reviewerStatus = 'AI Screened';

      chunkAdded.push(rec);
      known.titles.add(normTitle(rec.title));
      chunkSeen.push({ id: art.pmid, verdict: 'Added', title: rec.title, seenAt: nowIso });
      summary.added++;
      summary.addedTitles.push(rec.title);
    });

    if (!dryRun) {
      if (chunkAdded.length) {
        await store.upsertMany(chunkAdded);
        resources.unshift(...chunkAdded);
      }
      if (chunkSeen.length) await store.markSeen(chunkSeen);
    }
    await sleep(NCBI_DELAY);
  }

  if (summary.deferred > 0) summary.complete = false;
  return summary;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------- 2. Re-check existing records ----------
interface UrlCheck {
  status: number;
  ok: boolean;
  redirected: boolean;
  hash?: string;
  length?: number;
  error?: string;
}

async function checkUrl(url: string): Promise<UrlCheck> {
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; OneHealthEvidenceAgent/1.0; link-check)',
        Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8',
      },
    });
    let redirected = false;
    try {
      redirected = resp.redirected && new URL(resp.url).pathname.replace(/\/$/, '') !== new URL(url).pathname.replace(/\/$/, '');
    } catch {
      /* ignore */
    }
    let hash: string | undefined;
    let length: number | undefined;
    const ctype = resp.headers.get('content-type') || '';
    if (resp.ok && /text\/html|text\/plain|xml/i.test(ctype)) {
      const text = (await resp.text()).slice(0, 2_000_000);
      const stripped = text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      length = stripped.length;
      hash = createHash('sha256').update(stripped).digest('hex');
    } else {
      try {
        await resp.body?.cancel();
      } catch {
        /* ignore */
      }
    }
    return { status: resp.status, ok: resp.ok, redirected, hash, length };
  } catch (e: any) {
    return { status: 0, ok: false, redirected: false, error: e.message };
  }
}

async function runRecheck(opts: { limit: number; deadline: number; dryRun: boolean }) {
  const { limit, deadline, dryRun } = opts;
  const nowIso = new Date().toISOString();
  const summary = {
    due: 0, checked: 0, pubmedChecked: 0, webChecked: 0,
    newlyRetracted: 0, newlyBroken: 0, contentChanged: 0,
    errors: [] as string[], flagged: [] as { title: string; reason: string }[],
  };

  const due = resources
    .filter((r) => r.reviewerStatus !== 'Rejected')
    .sort((a, b) => (a.lastCheckedAt || '').localeCompare(b.lastCheckedAt || ''))
    .slice(0, limit);
  summary.due = due.length;

  const pubmedRecs = due.filter((r) => getPmid(r));
  const webRecs = due.filter((r) => !getPmid(r) && /^https?:\/\//i.test(r.url));
  
  const updates: HAIResource[] = [];
  const removals: string[] = []; // Track IDs to delete

  // Helper to log the deletion and queue the ID
  const flagAndRemove = (u: HAIResource, reason: string) => {
    summary.flagged.push({ title: u.title, reason: `Removed: ${reason}` });
    removals.push(u.id);
  };

  // --- PubMed records: retraction check ---
  for (const part of chunkArray(pubmedRecs, 100)) {
    if (Date.now() >= deadline) break;
    let arts: PubMedArticle[];
    try {
      arts = await fetchPubMedArticles(part.map((r) => getPmid(r)!));
    } catch (e: any) {
      summary.errors.push(`pubmed recheck: ${e.message}`);
      continue;
    }
    const byPmid = new Map(arts.map((a) => [a.pmid, a]));
    for (const r of part) {
      const art = byPmid.get(getPmid(r)!);
      const u: HAIResource = { ...r, pmid: getPmid(r), lastCheckedAt: nowIso };
      if (!art) {
        u.linkStatus = 'broken';
        u.linkFailCount = (r.linkFailCount || 0) + 1;
        if (u.linkFailCount >= 2) {
          flagAndRemove(u, 'PMID no longer returned by PubMed');
          summary.newlyBroken++;
        } else {
          updates.push(u); // Keep trying until threshold
        }
      } else {
        u.linkStatus = 'ok';
        u.linkFailCount = 0;
        if (art.retracted && !r.retracted) {
          flagAndRemove(u, 'Retracted publication per PubMed');
          summary.newlyRetracted++;
        } else {
          updates.push(u);
        }
      }
      summary.pubmedChecked++;
    }
    await sleep(NCBI_DELAY);
  }

  // --- Web records: link + content-change check ---
  await mapPool(webRecs, 6, async (r) => {
    if (Date.now() >= deadline) return;
    const c = await checkUrl(r.url);
    const u: HAIResource = { ...r, lastCheckedAt: nowIso };
    if (c.ok) {
      u.linkStatus = c.redirected ? 'redirected' : 'ok';
      u.linkFailCount = 0;
      if (c.hash) {
        const prevLen = r.contentLength || 0;
        const changedHash = r.contentHash && r.contentHash !== c.hash;
        const bigChange = prevLen > 0 && c.length !== undefined && Math.abs(c.length - prevLen) / prevLen > 0.1;
        if (changedHash && bigChange) {
          flagAndRemove(u, 'Page content changed substantially since last check');
          summary.contentChanged++;
        } else {
          u.contentHash = c.hash;
          u.contentLength = c.length;
          updates.push(u);
        }
      } else {
        updates.push(u);
      }
    } else {
      const hardGone = c.status === 404 || c.status === 410;
      u.linkStatus = hardGone ? 'broken' : 'unreachable';
      u.linkFailCount = (r.linkFailCount || 0) + 1;
      const threshold = hardGone ? 2 : 3;
      if (u.linkFailCount >= threshold) {
        flagAndRemove(u, hardGone ? `Link returns HTTP ${c.status}` : `Link unreachable on ${threshold} consecutive checks`);
        summary.newlyBroken++;
      } else {
        updates.push(u);
      }
    }
    summary.webChecked++;
  });

  summary.checked = updates.length + removals.length;

  if (!dryRun) {
    if (updates.length) await store.upsertMany(updates);
    
    // Execute removals from the database
    if (removals.length) {
      for (const id of removals) {
        await store.remove(id);
      }
    }
    
    // Update the in-memory array by filtering out removed IDs
    const byId = new Map(updates.map((u) => [u.id, u]));
    resources = resources
      .filter((r) => !removals.includes(r.id))
      .map((r) => byId.get(r.id) || r);
  }
  return summary;
}

// ---------- Orchestrator ----------
async function runDaily(opts: { sinceDays?: number; dryRun?: boolean; skipDiscovery?: boolean; skipRecheck?: boolean }) {
  const dryRun = Boolean(opts.dryRun);
  const startedAt = new Date();
  const locked = await store.acquireLock(RUN_BUDGET_MS + 5 * 60 * 1000);
  if (!locked) return { skipped: true, reason: 'Another daily run is already in progress' };

  try {
    await refreshResources(true);
    const meta = await store.getMeta();
    const budgetEnd = startedAt.getTime() + RUN_BUDGET_MS;

    // Discovery window: [cursor - 1 day overlap, now]. First ever run looks back DEFAULT_WINDOW_DAYS.
    const end = new Date();
    let start: Date;
    if (opts.sinceDays && opts.sinceDays > 0) {
      start = new Date(end.getTime() - Math.min(opts.sinceDays, 3650) * 86400000);
    } else if (meta.discoveryCursor) {
      start = new Date(new Date(meta.discoveryCursor).getTime() - 86400000);
    } else {
      start = new Date(end.getTime() - DEFAULT_WINDOW_DAYS * 86400000);
    }

    let discovery: Awaited<ReturnType<typeof runDiscovery>> | null = null;
    if (!opts.skipDiscovery) {
      discovery = await runDiscovery({
        start,
        end,
        deadline: startedAt.getTime() + RUN_BUDGET_MS * 0.65,
        dryRun,
      });
    }

    let recheck: Awaited<ReturnType<typeof runRecheck>> | null = null;
    if (!opts.skipRecheck) {
      recheck = await runRecheck({ limit: RECHECK_BATCH, deadline: budgetEnd, dryRun });
    }

    const finishedAt = new Date();
    const summary = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      dryRun,
      discovery,
      recheck,
      totalRecords: resources.length,
      needsRecheck: resources.filter((r) => r.needsRecheck || r.retracted).length,
    };

    if (!dryRun) {
      // Only move the cursor forward when the whole window was screened; otherwise keep it so
      // tomorrow's run picks up whatever was deferred.
      const cursorPatch: Partial<Meta> = {};
      if (discovery) cursorPatch.discoveryCursor = discovery.complete ? end.toISOString() : (meta.discoveryCursor && !opts.sinceDays ? meta.discoveryCursor : start.toISOString());
      await store.setMeta({ lastRunAt: finishedAt.toISOString(), ...cursorPatch });
      await store.addRun(summary as any);
    }
    return summary;
  } finally {
    await store.releaseLock();
  }
}

function checkCronAuth(req: express.Request): 'ok' | 'denied' | 'disabled' {
  const secret = process.env.CRON_SECRET;
  if (!secret) return 'disabled';
  const provided = req.header('x-cron-secret') || (req.header('authorization') || '').replace(/^Bearer\s+/i, '') || '';
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : 'denied';
}

app.post('/api/agent/daily-run', async (req, res) => {
  const auth = checkCronAuth(req);
  if (auth === 'disabled') {
    return res.status(503).json({ error: 'CRON_SECRET is not set; daily-run endpoint is disabled.' });
  }
  if (auth === 'denied') return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { sinceDays, dryRun, skipDiscovery, skipRecheck } = req.body || {};
    const result = await runDaily({
      sinceDays: sinceDays !== undefined ? Number(sinceDays) : undefined,
      dryRun: Boolean(dryRun),
      skipDiscovery: Boolean(skipDiscovery),
      skipRecheck: Boolean(skipRecheck),
    });
    if ((result as any).skipped) return res.status(409).json(result);
    res.json(result);
  } catch (err: any) {
    console.error('daily-run failed:', err);
    res.status(500).json({ error: err.message || 'Daily run failed' });
  }
});

// Read-only status for the UI banner
app.get('/api/agent/status', async (req, res) => {
  if (!storageReady) {
    return res.json({
      backend: store.kind,
      storageReady: false,
      storageError,
      totalRecords: 0,
      needsRecheck: 0,
      retracted: 0,
      addedLast7Days: 0,
      lastRunAt: null,
      dailyRunEnabled: Boolean(process.env.CRON_SECRET),
      recentRuns: [],
    });
  }
  try {
    await refreshResources();
    const [meta, runs] = await Promise.all([store.getMeta(), store.listRuns(14)]);
    res.json({
      backend: store.kind,
      storageReady: true,
      storageError: null,
      totalRecords: resources.length,
      needsRecheck: resources.filter((r) => r.needsRecheck || r.retracted).length,
      retracted: resources.filter((r) => r.retracted).length,
      addedLast7Days: resources.filter((r) => r.dateAdded && Date.now() - Date.parse(r.dateAdded) < 7 * 86400000).length,
      lastRunAt: meta.lastRunAt || null,
      discoveryCursor: meta.discoveryCursor || null,
      dailyRunEnabled: Boolean(process.env.CRON_SECRET),
      recentRuns: runs,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// VITE MIDDLEWARE & SERVER STARTUP
// ==========================================
async function initStorageWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      await initResources();
      storageReady = true;
      storageError = null;
      return;
    } catch (e: any) {
      storageError = e?.message || String(e);
      console.error(`Storage init failed (attempt ${attempt}): ${storageError}`);
      await sleep(Math.min(30000, 2000 * attempt));
    }
  }
}

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`HAI Evidence Curation Agent running on http://0.0.0.0:${PORT}`);
  });
  initStorageWithRetry();
}

startServer();
