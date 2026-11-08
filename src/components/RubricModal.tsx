import React from 'react';
import {
  X,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ShieldCheck,
  BookOpen,
  FileText,
  Layers,
  HelpCircle,
  Users,
  Compass,
} from 'lucide-react';

interface RubricModalProps {
  onClose: () => void;
}

export const RubricModal: React.FC<RubricModalProps> = ({ onClose }) => {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs">
      <div className="relative flex max-h-[90vh] w-full max-w-3xl flex-col rounded-2xl bg-white shadow-2xl overflow-hidden border border-slate-200">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4 bg-slate-50/70">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-900">
                HAI Evidence Rubric & Criteria Specification
              </h2>
              <p className="text-[11px] text-slate-500">
                Full reference for human-animal interaction resource curation & database organization
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Content Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6 text-xs text-slate-700">
          {/* Intended User */}
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-3.5 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-bold text-indigo-950">
              <Users className="w-4 h-4 text-indigo-600" />
              Intended User & Clinical Context
            </div>
            <p className="text-[11px] text-indigo-900 leading-relaxed">
              Client at a primary care veterinarian looking for resources related to human-animal interaction or the human-animal bond. They may have questions specific to their circumstances (e.g. bringing a new baby into the household, wondering how stress in their life affects their pet) or may just want to learn more about the topic.
            </p>
          </div>

          {/* 1. Mandatory Inclusion Criteria */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 mb-2.5 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              Mandatory Inclusion Criteria
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50">
                <div className="font-bold text-slate-900 mb-1">Must be Evidenced-Backed</div>
                <p className="text-[11px] text-slate-600">
                  Must either cite specific research/data/named studies or provide references from credible sources (peer-reviewed journals, government/institutional sources, universities).
                </p>
              </div>

              <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50">
                <div className="font-bold text-slate-900 mb-1">10-Year Publication Window</div>
                <p className="text-[11px] text-slate-600">
                  Must be published within the past 10 years (2016–Current Date), with exceptions strictly flagged for foundational/landmark studies still actively cited.
                </p>
              </div>

              <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50">
                <div className="font-bold text-slate-900 mb-1">Substantive Dual-Domain (Both Humans & Animals)</div>
                <p className="text-[11px] text-slate-600">
                  Must substantively address the human-animal bond/interaction — not merely mention pets in passing. Must fit into one of the 5 objective categories.
                </p>
              </div>

              <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50">
                <div className="font-bold text-slate-900 mb-1">English, Open Access & Reachable Link</div>
                <p className="text-[11px] text-slate-600">
                  Must be in English, full article must be freely accessible (not behind paywall), must have a live reachable link, and must have transparent authorship.
                </p>
              </div>
            </div>
          </div>

          {/* 2. Absolute Exclusion Criteria */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 mb-2.5 flex items-center gap-1.5">
              <XCircle className="w-4 h-4 text-rose-600" />
              Exclusion Criteria (Instant Ineligibility)
            </h3>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-slate-600">
              <li className="flex items-start gap-1.5 p-2 rounded border border-rose-100 bg-rose-50/30">
                <X className="w-3.5 h-3.5 text-rose-500 shrink-0 mt-0.5" />
                <span><strong>No advertorial:</strong> Promotional or pet food marketing content is excluded.</span>
              </li>
              <li className="flex items-start gap-1.5 p-2 rounded border border-rose-100 bg-rose-50/30">
                <X className="w-3.5 h-3.5 text-rose-500 shrink-0 mt-0.5" />
                <span><strong>No paywalls:</strong> Text cannot be blocked behind paywalls.</span>
              </li>
              <li className="flex items-start gap-1.5 p-2 rounded border border-rose-100 bg-rose-50/30">
                <X className="w-3.5 h-3.5 text-rose-500 shrink-0 mt-0.5" />
                <span><strong>No single-domain:</strong> Cannot only address humans or only animals (no general pet-care tips without human bond).</span>
              </li>
              <li className="flex items-start gap-1.5 p-2 rounded border border-rose-100 bg-rose-50/30">
                <X className="w-3.5 h-3.5 text-rose-500 shrink-0 mt-0.5" />
                <span><strong>No unmoderated forums:</strong> Quora, Reddit, Medium, Substack, LinkedIn are excluded.</span>
              </li>
              <li className="flex items-start gap-1.5 p-2 rounded border border-rose-100 bg-rose-50/30">
                <X className="w-3.5 h-3.5 text-rose-500 shrink-0 mt-0.5" />
                <span><strong>No unsourced claims:</strong> Personal anecdotes or unsupported claims without data are excluded.</span>
              </li>
              <li className="flex items-start gap-1.5 p-2 rounded border border-rose-100 bg-rose-50/30">
                <X className="w-3.5 h-3.5 text-rose-500 shrink-0 mt-0.5" />
                <span><strong>No rewritten aggregation:</strong> Reposted summaries with no original reporting or citation are excluded.</span>
              </li>
            </ul>
          </div>

          {/* 3. The 5 Objective Categories & Subtopics */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 mb-2.5 flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-indigo-600" />
              The 5 Objective Categories & Topics
            </h3>
            <div className="space-y-2 text-xs">
              <div className="p-2.5 rounded-lg border border-indigo-200 bg-indigo-50/40">
                <span className="font-bold text-indigo-900">1. Human Health & Development</span>
                <p className="text-[11px] text-slate-600 mt-0.5">
                  Mental health • Neurobiology • Neurodivergence • Child health and development • Aging • Physical health
                </p>
              </div>

              <div className="p-2.5 rounded-lg border border-emerald-200 bg-emerald-50/40">
                <span className="font-bold text-emerald-900">2. Animal Health & Welfare</span>
                <p className="text-[11px] text-slate-600 mt-0.5">
                  Pet health • Animal welfare • Choosing/adopting a pet
                </p>
              </div>

              <div className="p-2.5 rounded-lg border border-sky-200 bg-sky-50/40">
                <span className="font-bold text-sky-900">3. Human-Animal Interaction & Bonding</span>
                <p className="text-[11px] text-slate-600 mt-0.5">
                  General human-animal bonding/interaction • Animal-assisted interventions
                </p>
              </div>

              <div className="p-2.5 rounded-lg border border-amber-200 bg-amber-50/40">
                <span className="font-bold text-amber-900">4. Safety & Risk</span>
                <p className="text-[11px] text-slate-600 mt-0.5">
                  Risk factors/zoonotic disease • HAI safety • Travel • Disasters/emergency preparedness
                </p>
              </div>

              <div className="p-2.5 rounded-lg border border-purple-200 bg-purple-50/40">
                <span className="font-bold text-purple-900">5. Crisis & Life Challenges</span>
                <p className="text-[11px] text-slate-600 mt-0.5">
                  Domestic violence • Crisis support • Loss and grief
                </p>
              </div>
            </div>
          </div>

          {/* 4. Authorized Species & Populations */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50">
              <div className="font-bold text-slate-900 mb-1">Authorized Species</div>
              <p className="text-[11px] text-slate-600 leading-relaxed">
                Multi-Species (General Pet) • Dog • Cat • Small mammals/Pocket Pets • Horses • Farm Animals • Exotics (reptiles, birds) • Wildlife
              </p>
            </div>

            <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/50">
              <div className="font-bold text-slate-900 mb-1">Target Populations</div>
              <p className="text-[11px] text-slate-600 leading-relaxed">
                General Public • General Pet Owners • Parents • Educators • Immune-Compromised Individuals • Disabled Individuals • Policymakers/Community Organizations • Clinicians • Seniors and caregivers • Veterans • Researchers • Animal exhibitors/breeders
              </p>
            </div>
          </div>

          {/* 5. Exceptions & Notes */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-900 mb-2 flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-amber-600" />
              Exceptions & Flags/Notes
            </h3>
            <ul className="space-y-1.5 text-[11px] text-slate-600 list-disc pl-5">
              <li>
                <strong>Publication Date Exception:</strong> Foundational/landmark studies published prior to 2016 still being actively cited in current research are flagged in the database.
              </li>
              <li>
                <strong>Commercial Affiliation:</strong> Content from commercially affiliated but legitimate science entities (e.g. WALTHAM / Mars Petcare) is flagged in the database.
              </li>
              <li>
                <strong>Non-US Generalizability:</strong> Content geographically or legally non-generalizable to the United States is flagged.
              </li>
              <li>
                <strong>Balanced Evidence:</strong> Must provide balanced evidence representing both positive, neutral, and negative/risk findings.
              </li>
              <li>
                <strong>Deduplication:</strong> When multiple sources cover the same finding, retain the highest-tier/most authoritative version rather than duplicating.
              </li>
            </ul>
          </div>

          {/* 6. Database Organization Schema (12 Fields) */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 space-y-2">
            <div className="font-bold text-slate-900 text-xs">
              Database Organization Schema (12 Fields per Document)
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 text-[11px] text-slate-700">
              <div>1. Title</div>
              <div>2. URL</div>
              <div>3. Source Institution</div>
              <div>4. Source Type (Tiers 1-3)</div>
              <div>5. Year Published</div>
              <div>6. Primary Objective</div>
              <div>7. Secondary Objectives</div>
              <div>8. Population</div>
              <div>9. Species</div>
              <div>10. Brief Summary</div>
              <div>11. Qualifications</div>
              <div>12. Flags/Notes</div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-slate-200 px-6 py-3 bg-slate-50 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold cursor-pointer shadow-xs"
          >
            Close Guide
          </button>
        </div>
      </div>
    </div>
  );
};
