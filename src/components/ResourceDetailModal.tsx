import React from 'react';
import { X, ExternalLink, AlertTriangle, CheckCircle2, XCircle, Tag, Building2, Calendar, FileText, Check } from 'lucide-react';
import { HAIResource, ReviewerStatus } from '../types';

interface ResourceDetailModalProps {
  resource: HAIResource;
  onClose: () => void;
  onStatusChange: (id: string, newStatus: ReviewerStatus) => void;
}

export const ResourceDetailModal: React.FC<ResourceDetailModalProps> = ({
  resource,
  onClose,
  onStatusChange,
}) => {
  const statusColors: Record<ReviewerStatus, { bg: string; text: string; border: string; icon: any }> = {
    'Human Approved': { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-300', icon: CheckCircle2 },
    'Flagged for Review': { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-300', icon: AlertTriangle },
    'Rejected': { bg: 'bg-rose-50', text: 'text-rose-700', border: 'border-rose-300', icon: XCircle },
    'AI Screened': { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-300', icon: Check },
  };

  const currentStatusStyle = statusColors[resource.reviewerStatus] || statusColors['AI Screened'];
  const StatusIcon = currentStatusStyle.icon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-xs">
      <div className="relative flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl bg-white shadow-2xl">
        {/* Modal Header */}
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-4">
          <div className="flex-1 pr-4">
            <div className="flex items-center gap-2 mb-1">
              <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${currentStatusStyle.bg} ${currentStatusStyle.text} border ${currentStatusStyle.border}`}>
                <StatusIcon className="w-3.5 h-3.5" />
                {resource.reviewerStatus}
              </span>
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200">
                {resource.sourceType}
              </span>
              <span className="text-xs text-slate-500 font-mono">ID: {resource.id}</span>
            </div>
            <h2 className="text-lg font-bold text-slate-900 leading-snug">{resource.title}</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body - Exactly 12 Fields Display */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5 text-sm">
          {/* Status Changer Bar */}
          <div className="flex items-center justify-between rounded-lg bg-slate-50 p-3 border border-slate-200">
            <span className="text-xs font-medium text-slate-600">Reviewer Status:</span>
            <div className="flex items-center gap-2">
              {(['AI Screened', 'Human Approved', 'Flagged for Review', 'Rejected'] as ReviewerStatus[]).map((status) => (
                <button
                  key={status}
                  onClick={() => onStatusChange(resource.id, status)}
                  className={`px-3 py-1 rounded text-xs font-medium transition-all ${
                    resource.reviewerStatus === status
                      ? 'bg-slate-900 text-white shadow-xs'
                      : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {status}
                </button>
              ))}
            </div>
          </div>

          {/* 1. Title & 2. URL */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-lg border border-slate-200 p-3.5 bg-slate-50/50">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 block mb-1">
                2. Direct URL
              </span>
              <a
                href={resource.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-blue-600 hover:text-blue-800 break-all text-xs font-mono font-medium underline"
              >
                {resource.url}
                <ExternalLink className="w-3.5 h-3.5 shrink-0" />
              </a>
            </div>

            {/* 3. Source Institution & 4. Source Type & 5. Year */}
            <div className="rounded-lg border border-slate-200 p-3.5 bg-slate-50/50">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 block mb-1">
                3. Institution & 5. Year
              </span>
              <div className="flex items-center gap-2 text-slate-800 font-medium">
                <Building2 className="w-4 h-4 text-slate-500" />
                <span>{resource.sourceInstitution}</span>
                <span className="text-slate-400">•</span>
                <Calendar className="w-4 h-4 text-slate-500" />
                <span>{resource.yearPublished}</span>
              </div>
            </div>
          </div>

          {/* 6. Primary Objective & 7. Secondary Objectives */}
          <div className="rounded-lg border border-slate-200 p-3.5 bg-slate-50/50">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 block mb-1.5">
              6. Primary Objective & 7. Secondary Objectives
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                Primary: {resource.primaryObjective}
              </span>
              {resource.secondaryObjectives && resource.secondaryObjectives.length > 0 ? (
                resource.secondaryObjectives.map((obj, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200"
                  >
                    Secondary: {obj}
                  </span>
                ))
              ) : (
                <span className="text-xs text-slate-400 italic">No secondary objectives</span>
              )}
            </div>
          </div>

          {/* 8. Population & 9. Species */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-lg border border-slate-200 p-3.5 bg-slate-50/50">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 block mb-1.5">
                8. Target Population
              </span>
              <div className="flex flex-wrap gap-1.5">
                {resource.population.map((pop, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-200/70 text-slate-700"
                  >
                    {pop}
                  </span>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 p-3.5 bg-slate-50/50">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 block mb-1.5">
                9. Species Included
              </span>
              <div className="flex flex-wrap gap-1.5">
                {resource.species.map((sp, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-50 text-emerald-800 border border-emerald-200"
                  >
                    {sp}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {/* 10. Brief Summary */}
          <div className="rounded-lg border border-slate-200 p-3.5 bg-slate-50/50">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 block mb-1">
              10. Brief Summary
            </span>
            <p className="text-slate-800 leading-relaxed text-sm">{resource.briefSummary}</p>
          </div>

          {/* 11. Qualifications */}
          <div className="rounded-lg border border-slate-200 p-3.5 bg-slate-50/50">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 block mb-1">
              11. Qualifications (Rationale for Inclusion Criteria)
            </span>
            <p className="text-slate-700 text-sm">{resource.qualifications}</p>
          </div>

          {/* 12. Flags / Notes (Exceptions & Caveats) */}
          <div className="rounded-lg border border-slate-200 p-3.5 bg-slate-50/50">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 block mb-1.5">
              12. Flags / Notes (Exceptions & Caveats)
            </span>
            {resource.flagsNotes && resource.flagsNotes.length > 0 ? (
              <div className="space-y-1.5">
                {resource.flagsNotes.map((flag, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 p-2 rounded bg-amber-50/80 border border-amber-200 text-xs text-amber-900"
                  >
                    <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                    <span>{flag}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500 italic">None. Resource meets standard inclusion parameters without exceptions.</p>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-end border-t border-slate-200 px-6 py-3 bg-slate-50">
          <button
            onClick={onClose}
            className="rounded-lg bg-white px-4 py-2 text-xs font-semibold text-slate-700 border border-slate-300 hover:bg-slate-100 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
