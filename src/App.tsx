import React, { useState, useEffect, useMemo } from 'react';
import {
  ShieldCheck,
  Search,
  Download,
  RotateCcw,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Eye,
  Trash2,
  Sparkles,
  RefreshCw,
  Layers,
  BookOpen,
  Compass,
  FileText,
  Check,
  Filter,
  Flame,
  Globe,
  Database,
  ArrowRight,
  ChevronDown,
} from 'lucide-react';
import {
  HAIResource,
  ReviewerStatus,
  ObjectiveCategory,
  OBJECTIVE_CATEGORIES,
  SPECIES_LIST,
  SEARCH_TOPICS_BY_OBJECTIVE,
  SOURCE_TIER_OPTIONS,
  SourceTier,
  CandidateScreeningInput,
  ScreeningEvaluationResult,
  PullAllCategoriesResult,
} from './types';
import { INITIAL_RESOURCES } from './seedData';
import { ResourceDetailModal } from './components/ResourceDetailModal';
import { RubricModal } from './components/RubricModal';

export default function App() {
  const [resources, setResources] = useState<HAIResource[]>(INITIAL_RESOURCES);
  const [selectedResource, setSelectedResource] = useState<HAIResource | null>(null);
  const [isRubricOpen, setIsRubricOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // Left Pane Mode: 'all-categories' (Pull across all 5 categories) vs 'direct' (Single paper screen)
  const [activeTab, setActiveTab] = useState<'all-categories' | 'direct'>('all-categories');

  // Pull All Categories Config State
  const [batchSize, setBatchSize] = useState<number>(10);
  const [tierSelection, setTierSelection] = useState<'All' | SourceTier>('All');
  const [isPullingAll, setIsPullingAll] = useState(false);
  const [pullAllResult, setPullAllResult] = useState<PullAllCategoriesResult | null>(null);

  // Direct Screening Form State
  const [directForm, setDirectForm] = useState<CandidateScreeningInput>({
    url: '',
    doiOrPmid: '',
    rawTextOrAbstract: '',
    title: '',
    sourceInstitution: '',
    sourceType: 'Tier 1',
  });
  const [isScreeningDirect, setIsScreeningDirect] = useState(false);
  const [lastDirectResult, setLastDirectResult] = useState<ScreeningEvaluationResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Table Filters State for Right Pane
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('All');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [sourceTypeFilter, setSourceTypeFilter] = useState<string>('All');
  const [speciesFilter, setSpeciesFilter] = useState<string>('All');
  const [monitorFilter, setMonitorFilter] = useState<'All' | 'recheck' | 'new'>('All');

  // Daily agent status (last run, items needing a second look)
  const [agentStatus, setAgentStatus] = useState<{
    backend: string;
    lastRunAt: string | null;
    needsRecheck: number;
    retracted: number;
    addedLast7Days: number;
    dailyRunEnabled: boolean;
    storageReady?: boolean;
    storageError?: string | null;
  } | null>(null);
  const fetchAgentStatus = async () => {
    try {
      const res = await fetch('/api/agent/status');
      if (res.ok) setAgentStatus(await res.json());
    } catch {
      /* status is optional */
    }
  };

  // Load records from server
  const fetchRecords = async () => {
    try {
      const res = await fetch('/api/records');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          setResources(data);
        }
      }
    } catch (err) {
      console.error('Failed to fetch records, using initial fallback', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRecords();
    fetchAgentStatus();
  }, []);

  // Reviewer dismisses the agent's "needs recheck" flag after looking at the record
  const clearRecheckFlag = async (id: string) => {
    setResources((prev) => prev.map((r) => (r.id === id ? { ...r, needsRecheck: false, recheckReason: '' } : r)));
    try {
      await fetch(`/api/records/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ needsRecheck: false, recheckReason: '' }),
      });
      fetchAgentStatus();
    } catch (err) {
      console.error('Failed to clear recheck flag', err);
    }
  };

  // Update record status (Human Approved, AI Screened, Flagged for Review, Rejected)
  const handleStatusChange = async (id: string, newStatus: ReviewerStatus) => {
    setResources((prev) =>
      prev.map((r) => (r.id === id ? { ...r, reviewerStatus: newStatus } : r))
    );
    if (selectedResource?.id === id) {
      setSelectedResource((prev) => (prev ? { ...prev, reviewerStatus: newStatus } : null));
    }

    try {
      const res = await fetch(`/api/records/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewerStatus: newStatus }),
      });
      if (!res.ok) {
        fetchRecords();
      }
    } catch (err) {
      console.error('Failed to update status', err);
      fetchRecords();
    }
  };

  // Delete a record
  const handleDeleteResource = async (id: string) => {
    if (!window.confirm('Are you sure you want to remove this record from the database?')) {
      return;
    }
    setResources((prev) => prev.filter((r) => r.id !== id));
    if (selectedResource?.id === id) {
      setSelectedResource(null);
    }
    try {
      await fetch(`/api/records/${id}`, { method: 'DELETE' });
    } catch (err) {
      console.error('Failed to delete record', err);
      fetchRecords();
    }
  };

  // Reset to initial seed dataset (all 56 records across all 5 categories)
  const handleResetData = async () => {
    if (!window.confirm('Reset database to the complete 56-paper verified baseline across all categories?')) {
      return;
    }
    try {
      const res = await fetch('/api/records/reset', { method: 'POST' });
      if (res.ok) {
        await fetchRecords();
        setPullAllResult(null);
        setLastDirectResult(null);
      }
    } catch (err) {
      console.error('Failed to reset', err);
    }
  };

  // 1. PULL RESOURCES FROM ALL CATEGORIES ACTION
  const handlePullAllCategories = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setIsPullingAll(true);
    setPullAllResult(null);

    try {
      const res = await fetch('/api/agent/pull-all-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batchSize,
          tier: tierSelection,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Server responded with status ${res.status}`);
      }

      const data: PullAllCategoriesResult = await res.json();
      setPullAllResult(data);

      // Refresh database records to display newly ingested items in table
      await fetchRecords();
    } catch (err: any) {
      setFormError(err.message || 'Failed to pull resources from all categories.');
    } finally {
      setIsPullingAll(false);
    }
  };

  // 2. DIRECT PAPER SCREENING ACTION
  const handleDirectScreen = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (
      !directForm.url?.trim() &&
      !directForm.doiOrPmid?.trim() &&
      !directForm.rawTextOrAbstract?.trim() &&
      !directForm.title?.trim()
    ) {
      setFormError('Please enter a URL, DOI/PMID, or Abstract/Text to screen.');
      return;
    }

    setIsScreeningDirect(true);
    setLastDirectResult(null);

    try {
      const res = await fetch('/api/agent/screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(directForm),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `Server responded with status ${res.status}`);
      }

      const result: ScreeningEvaluationResult = await res.json();
      setLastDirectResult(result);

      // Automatically persist to database
      try {
        const addRes = await fetch('/api/records', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(result.resource),
        });
        if (addRes.ok) {
          const created: HAIResource = await addRes.json();
          setResources((prev) => [created, ...prev.filter((r) => r.id !== created.id)]);
        }
      } catch (addErr) {
        console.warn('Failed auto-saving to backend, updating locally', addErr);
        setResources((prev) => [result.resource, ...prev]);
      }
    } catch (err: any) {
      setFormError(err.message || 'Failed to screen resource.');
    } finally {
      setIsScreeningDirect(false);
    }
  };

  // CSV Export: Downloads all 12 columns strictly per page 4 specification
  const handleExportCSV = () => {
    if (filteredResources.length === 0) {
      alert('No records match your current filter to export.');
      return;
    }

    const headers = [
      '1. Title',
      '2. URL',
      '3. Source Institution',
      '4. Source Type',
      '5. Year Published',
      '6. Objective',
      '7. Secondary Objectives',
      '8. Population',
      '9. Species',
      '10. Brief Summary',
      '11. Qualifications',
      '12. Flags/Notes',
      'Reviewer Status',
    ];

    const escapeCsv = (str?: string | number | null) => {
      if (str === undefined || str === null) return '""';
      const clean = String(str).replace(/"/g, '""');
      return `"${clean}"`;
    };

    const rows = filteredResources.map((r) => [
      escapeCsv(r.title),
      escapeCsv(r.url),
      escapeCsv(r.sourceInstitution),
      escapeCsv(r.sourceType),
      escapeCsv(r.yearPublished),
      escapeCsv(r.primaryObjective),
      escapeCsv(r.secondaryObjectives?.join('; ') || ''),
      escapeCsv(r.population?.join('; ') || ''),
      escapeCsv(r.species?.join('; ') || ''),
      escapeCsv(r.briefSummary),
      escapeCsv(r.qualifications),
      escapeCsv(r.flagsNotes?.join('; ') || ''),
      escapeCsv(r.reviewerStatus),
    ]);

    const csvContent = [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute(
      'download',
      `HAI_All_Categories_Database_${new Date().toISOString().split('T')[0]}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Filtered resources for Right Pane
  const filteredResources = useMemo(() => {
    return resources.filter((r) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesQuery =
          r.title.toLowerCase().includes(q) ||
          r.briefSummary.toLowerCase().includes(q) ||
          r.sourceInstitution.toLowerCase().includes(q) ||
          r.qualifications.toLowerCase().includes(q) ||
          r.species.some((sp) => sp.toLowerCase().includes(q)) ||
          r.population.some((pop) => pop.toLowerCase().includes(q));
        if (!matchesQuery) return false;
      }

      if (categoryFilter !== 'All') {
        const matchesObj =
          r.primaryObjective === categoryFilter ||
          r.secondaryObjectives?.includes(categoryFilter as ObjectiveCategory);
        if (!matchesObj) return false;
      }

      if (speciesFilter !== 'All') {
        if (!r.species.includes(speciesFilter) && !r.species.includes('Multi-Species (General Pet)')) {
          return false;
        }
      }

      if (statusFilter !== 'All' && r.reviewerStatus !== statusFilter) {
        return false;
      }

      if (sourceTypeFilter !== 'All' && r.sourceType !== sourceTypeFilter) {
        return false;
      }

      if (monitorFilter === 'recheck' && !(r.needsRecheck || r.retracted)) {
        return false;
      }
      if (monitorFilter === 'new' && !(r.dateAdded && Date.now() - Date.parse(r.dateAdded) < 7 * 86400000)) {
        return false;
      }

      return true;
    });
  }, [resources, searchQuery, categoryFilter, speciesFilter, statusFilter, sourceTypeFilter, monitorFilter]);

  // Status Counts
  const stats = useMemo(() => {
    const approved = resources.filter((r) => r.reviewerStatus === 'Human Approved').length;
    const aiScreened = resources.filter((r) => r.reviewerStatus === 'AI Screened').length;
    const flagged = resources.filter((r) => r.reviewerStatus === 'Flagged for Review').length;
    const rejected = resources.filter((r) => r.reviewerStatus === 'Rejected').length;
    return { total: resources.length, approved, aiScreened, flagged, rejected };
  }, [resources]);

  // Counts by the 5 Objective Categories
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {
      'Human Health & Development': 0,
      'Animal Health & Welfare': 0,
      'Human-Animal Interaction & Bonding': 0,
      'Safety & Risk': 0,
      'Crisis & Life Challenges': 0,
    };
    for (const r of resources) {
      if (counts[r.primaryObjective] !== undefined) {
        counts[r.primaryObjective]++;
      }
    }
    return counts;
  }, [resources]);

  // Objective category badge styling
  const getObjectiveBadgeClass = (obj: ObjectiveCategory) => {
    switch (obj) {
      case 'Human Health & Development':
        return 'bg-indigo-50 text-indigo-700 border-indigo-200';
      case 'Animal Health & Welfare':
        return 'bg-emerald-50 text-emerald-700 border-emerald-200';
      case 'Human-Animal Interaction & Bonding':
        return 'bg-sky-50 text-sky-700 border-sky-200';
      case 'Safety & Risk':
        return 'bg-amber-50 text-amber-700 border-amber-200';
      case 'Crisis & Life Challenges':
        return 'bg-purple-50 text-purple-700 border-purple-200';
      default:
        return 'bg-slate-50 text-slate-700 border-slate-200';
    }
  };

  return (
    <div className="min-h-screen bg-slate-100/70 font-sans text-slate-900 antialiased flex flex-col">
      {/* Top Header Bar */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-30 shadow-xs">
        <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-xs">
              <Database className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold text-slate-900 leading-tight">
                  HAI Resource Project Papers Only
                </h1>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-100 text-indigo-800 border border-indigo-200">
                  All Categories Database
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                Large unfiltered repository of human-animal interaction papers screened against One Health evidence rubric
              </p>
            </div>
          </div>

          <div className="flex items-center flex-wrap gap-2.5">
            {/* Counts Badges */}
            <div className="flex items-center rounded-lg bg-slate-100 p-1 text-xs font-medium border border-slate-200 text-slate-600">
              <span className="px-2 py-0.5 font-bold text-slate-900">
                {stats.total} Total Papers
              </span>
              <span className="px-2 py-0.5 text-blue-700 border-l border-slate-200">
                AI Screened: <strong>{stats.aiScreened}</strong>
              </span>
              <span className="px-2 py-0.5 text-emerald-700 border-l border-slate-200">
                Approved: <strong>{stats.approved}</strong>
              </span>
              <span className="px-2 py-0.5 text-amber-700 border-l border-slate-200">
                Flagged: <strong>{stats.flagged}</strong>
              </span>
            </div>

            {/* Rubric Info Button */}
            <button
              onClick={() => setIsRubricOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:text-indigo-600 shadow-xs transition-colors cursor-pointer"
            >
              <BookOpen className="w-3.5 h-3.5 text-indigo-500" />
              Inclusion/Exclusion Rubric
            </button>

            {/* Reset Seeds Button */}
            <button
              onClick={handleResetData}
              title="Reset to 56-paper verified baseline"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Baseline
            </button>
          </div>
        </div>
      </header>

      {agentStatus && agentStatus.storageReady === false && (
        <div className="bg-red-50 border-b border-red-200 text-red-800 text-xs px-4 py-2">
          Database not connected{agentStatus.storageError ? `: ${agentStatus.storageError}` : ' yet'}. The app keeps retrying; reload in a minute.
        </div>
      )}

      {/* Daily agent status strip */}
      {agentStatus && (
        <div className="border-b border-slate-200 bg-slate-50">
          <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate-600">
            <span className="inline-flex items-center gap-1.5 font-semibold text-slate-700">
              <RefreshCw className="w-3 h-3 text-indigo-500" />
              Daily agent
            </span>
            <span>
              {agentStatus.lastRunAt
                ? `Last run ${new Date(agentStatus.lastRunAt).toLocaleString()}`
                : agentStatus.dailyRunEnabled
                ? 'Has not run yet'
                : 'Not scheduled (set CRON_SECRET to enable)'}
            </span>
            <button
              onClick={() => setMonitorFilter(monitorFilter === 'new' ? 'All' : 'new')}
              className={`px-2 py-0.5 rounded border cursor-pointer ${
                monitorFilter === 'new'
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white border-slate-200 hover:border-indigo-300'
              }`}
            >
              New this week: <strong>{agentStatus.addedLast7Days}</strong>
            </button>
            <button
              onClick={() => setMonitorFilter(monitorFilter === 'recheck' ? 'All' : 'recheck')}
              className={`px-2 py-0.5 rounded border cursor-pointer ${
                monitorFilter === 'recheck'
                  ? 'bg-amber-600 text-white border-amber-600'
                  : agentStatus.needsRecheck > 0
                  ? 'bg-amber-50 border-amber-300 text-amber-800 hover:border-amber-500'
                  : 'bg-white border-slate-200 hover:border-indigo-300'
              }`}
            >
              Needs recheck: <strong>{agentStatus.needsRecheck}</strong>
              {agentStatus.retracted > 0 && ` (${agentStatus.retracted} retracted)`}
            </button>
            <span className="text-slate-400">Storage: {agentStatus.backend}</span>
          </div>
        </div>
      )}

      {/* Main Two-Pane Layout */}
      <main className="mx-auto max-w-7xl flex-1 px-4 py-5 sm:px-6 lg:px-8 w-full">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* ======================================================== */}
          {/* LEFT PANE: PULL RESOURCES FROM ALL CATEGORIES */}
          {/* ======================================================== */}
          <div className="lg:col-span-4 bg-white rounded-xl border border-slate-200 shadow-xs p-5 space-y-4 sticky lg:top-20">
            {/* Mode Switcher Tabs */}
            <div className="flex rounded-lg bg-slate-100 p-1 border border-slate-200">
              <button
                type="button"
                onClick={() => {
                  setActiveTab('all-categories');
                  setFormError(null);
                }}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${
                  activeTab === 'all-categories'
                    ? 'bg-white text-indigo-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Layers className="w-3.5 h-3.5 text-indigo-600" />
                Pull All Categories
              </button>
              <button
                type="button"
                onClick={() => {
                  setActiveTab('direct');
                  setFormError(null);
                }}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 text-xs font-bold rounded-md transition-all cursor-pointer ${
                  activeTab === 'direct'
                    ? 'bg-white text-indigo-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <FileText className="w-3.5 h-3.5 text-slate-600" />
                Single Paper Screen
              </button>
            </div>

            {/* TAB 1: PULL FROM ALL CATEGORIES */}
            {activeTab === 'all-categories' && (
              <div className="space-y-4">
                <div>
                  <h2 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-indigo-600" />
                    Multi-Category Harvest Engine
                  </h2>
                  <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                    Pulls research papers across <strong className="text-slate-800">all 5 objective categories</strong> simultaneously. Every candidate is evaluated through the inclusion/exclusion rubric before ingesting into the unfiltered database.
                  </p>
                </div>

                {/* 5 Categories Overview Badge List */}
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    Harvesting Across All 5 Categories:
                  </div>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-slate-700 font-medium">
                        <span className="w-2 h-2 rounded-full bg-indigo-500"></span>
                        1. Human Health & Development
                      </span>
                      <span className="text-[11px] font-semibold text-slate-500 bg-white px-1.5 py-0.5 rounded border border-slate-200">
                        {categoryCounts['Human Health & Development'] || 0} papers
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-slate-700 font-medium">
                        <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                        2. Animal Health & Welfare
                      </span>
                      <span className="text-[11px] font-semibold text-slate-500 bg-white px-1.5 py-0.5 rounded border border-slate-200">
                        {categoryCounts['Animal Health & Welfare'] || 0} papers
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-slate-700 font-medium">
                        <span className="w-2 h-2 rounded-full bg-sky-500"></span>
                        3. Human-Animal Interaction & Bonding
                      </span>
                      <span className="text-[11px] font-semibold text-slate-500 bg-white px-1.5 py-0.5 rounded border border-slate-200">
                        {categoryCounts['Human-Animal Interaction & Bonding'] || 0} papers
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-slate-700 font-medium">
                        <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                        4. Safety & Risk
                      </span>
                      <span className="text-[11px] font-semibold text-slate-500 bg-white px-1.5 py-0.5 rounded border border-slate-200">
                        {categoryCounts['Safety & Risk'] || 0} papers
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-slate-700 font-medium">
                        <span className="w-2 h-2 rounded-full bg-purple-500"></span>
                        5. Crisis & Life Challenges
                      </span>
                      <span className="text-[11px] font-semibold text-slate-500 bg-white px-1.5 py-0.5 rounded border border-slate-200">
                        {categoryCounts['Crisis & Life Challenges'] || 0} papers
                      </span>
                    </div>
                  </div>
                </div>

                <form onSubmit={handlePullAllCategories} className="space-y-3.5">
                  {/* Batch Size Selector */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-800 mb-1">
                      Batch Pull Size (Distributed Evenly Across All Categories)
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { size: 10, label: '+10 Papers', per: '2 / category' },
                        { size: 15, label: '+15 Papers', per: '3 / category' },
                        { size: 25, label: '+25 Papers', per: '5 / category' },
                      ].map((opt) => (
                        <button
                          key={opt.size}
                          type="button"
                          onClick={() => setBatchSize(opt.size)}
                          className={`p-2 rounded-lg border text-left cursor-pointer transition-colors ${
                            batchSize === opt.size
                              ? 'border-indigo-600 bg-indigo-50/70 text-indigo-950 font-bold'
                              : 'border-slate-200 hover:border-slate-300 bg-white text-slate-700'
                          }`}
                        >
                          <div className="text-xs font-bold">{opt.label}</div>
                          <div className="text-[10px] text-slate-500 font-normal">{opt.per}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Source Tier Filter */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-800 mb-1">
                      Target Source Tiers
                    </label>
                    <select
                      value={tierSelection}
                      onChange={(e) => setTierSelection(e.target.value as any)}
                      className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-hidden"
                    >
                      <option value="All">All Tiers (Tier 1 Primary Research, Tier 2 Institutional, Tier 3 Syntheses)</option>
                      <option value="Tier 1">Tier 1: Primary Research Only (Peer-reviewed journals, trials, reviews)</option>
                      <option value="Tier 2">Tier 2: Government and Institutional (CDC, NIH, AVMA, USDA)</option>
                      <option value="Tier 3">Tier 3: University and Nonprofit Syntheses (HABRI, Tufts, Purdue)</option>
                    </select>
                  </div>

                  {/* Action Button */}
                  <button
                    type="submit"
                    disabled={isPullingAll}
                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white px-4 py-2.5 text-xs font-bold transition-all shadow-xs cursor-pointer disabled:opacity-60"
                  >
                    {isPullingAll ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Pulling & Screening Across All 5 Categories...
                      </>
                    ) : (
                      <>
                        <Layers className="w-4 h-4" />
                        Pull Resources From All Categories ({batchSize})
                      </>
                    )}
                  </button>
                </form>

                {/* Form Error Message */}
                {formError && (
                  <div className="rounded-lg bg-rose-50 border border-rose-200 p-3 text-xs text-rose-700 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-rose-500" />
                    <div>{formError}</div>
                  </div>
                )}

                {/* Multi-Category Pull Results Summary Card */}
                {pullAllResult && (
                  <div className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3.5 space-y-2.5 text-xs animate-in fade-in">
                    <div className="flex items-center justify-between border-b border-indigo-100 pb-2">
                      <span className="font-bold text-indigo-950 flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                        All-Category Pull Complete
                      </span>
                      <span className="font-bold text-xs bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full border border-emerald-200">
                        +{pullAllResult.totalAdded} Added
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-600">
                      <div>
                        Screened: <strong>{pullAllResult.totalScreened}</strong>
                      </div>
                      <div>
                        Excluded: <strong>{pullAllResult.totalExcluded}</strong>
                      </div>
                    </div>

                    {/* Breakdown by category */}
                    <div className="space-y-1 pt-1 border-t border-indigo-100/70">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
                        Added per category:
                      </div>
                      {pullAllResult.categories.map((c) => (
                        <div key={c.category} className="flex items-center justify-between text-[11px]">
                          <span className="truncate text-slate-700 max-w-[200px]">{c.category}</span>
                          <span className="font-semibold text-indigo-900 bg-white px-1.5 py-0.5 rounded border border-indigo-100">
                            +{c.addedCount}
                          </span>
                        </div>
                      ))}
                    </div>

                    {pullAllResult.excludedReasons.length > 0 && (
                      <div className="pt-2 border-t border-indigo-100 text-[10px] text-slate-500">
                        <span className="font-semibold text-slate-700">Rubric Exclusions:</span>{' '}
                        {pullAllResult.excludedReasons[0].title} (
                        {pullAllResult.excludedReasons[0].reason})
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: DIRECT SINGLE PAPER SCREEN */}
            {activeTab === 'direct' && (
              <div className="space-y-4">
                <div>
                  <h2 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                    <FileText className="w-4 h-4 text-indigo-600" />
                    Direct Paper Screening
                  </h2>
                  <p className="text-xs text-slate-500 mt-1">
                    Screen an individual paper, PubMed ID, or text extract directly against the One Health HAI rubric.
                  </p>
                </div>

                <form onSubmit={handleDirectScreen} className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-800 mb-1">
                      URL or DOI / PubMed ID
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. 29369663 or https://pubmed.ncbi.nlm.nih.gov/..."
                      value={directForm.doiOrPmid || directForm.url || ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val.startsWith('http')) {
                          setDirectForm({ ...directForm, url: val, doiOrPmid: '' });
                        } else {
                          setDirectForm({ ...directForm, doiOrPmid: val, url: '' });
                        }
                      }}
                      className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-hidden"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-800 mb-1">
                      Paper Title (Optional)
                    </label>
                    <input
                      type="text"
                      placeholder="Title of paper or resource"
                      value={directForm.title || ''}
                      onChange={(e) => setDirectForm({ ...directForm, title: e.target.value })}
                      className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-hidden"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-800 mb-1">
                      Abstract or Text Excerpt (Optional)
                    </label>
                    <textarea
                      rows={3}
                      placeholder="Paste abstract or research summary..."
                      value={directForm.rawTextOrAbstract || ''}
                      onChange={(e) =>
                        setDirectForm({ ...directForm, rawTextOrAbstract: e.target.value })
                      }
                      className="w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-hidden"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={isScreeningDirect}
                    className="w-full flex items-center justify-center gap-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 text-xs font-bold transition-all shadow-xs cursor-pointer disabled:opacity-60"
                  >
                    {isScreeningDirect ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Evaluating Against Rubric...
                      </>
                    ) : (
                      <>
                        <ShieldCheck className="w-4 h-4" />
                        Screen & Ingest Paper
                      </>
                    )}
                  </button>
                </form>

                {lastDirectResult && (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-900">Screening Result:</span>
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          lastDirectResult.verdict === 'Rejected'
                            ? 'bg-rose-100 text-rose-800'
                            : lastDirectResult.verdict === 'Flagged for Review'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        {lastDirectResult.verdict}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-600">{lastDirectResult.verdictRationale}</p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ======================================================== */}
          {/* RIGHT PANE: LARGE UNFILTERED PAPERS DATABASE */}
          {/* ======================================================== */}
          <div className="lg:col-span-8 space-y-4">
            {/* Database Header Bar */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-xs p-4 space-y-3">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                    <Database className="w-4 h-4 text-indigo-600" />
                    Large Database of Papers
                    <span className="text-xs font-normal text-slate-500">
                      ({filteredResources.length} of {resources.length} papers showing)
                    </span>
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Evidenced-backed human-animal interaction papers spanning all 5 categories
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={handleExportCSV}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:text-indigo-600 shadow-xs transition-colors cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export CSV (12 Columns)
                  </button>
                </div>
              </div>

              {/* Category Quick Filter Chips */}
              <div className="flex flex-wrap gap-1.5 pt-1 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setCategoryFilter('All')}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer transition-colors ${
                    categoryFilter === 'All'
                      ? 'bg-indigo-600 text-white font-bold shadow-xs'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  All Categories ({resources.length})
                </button>
                {OBJECTIVE_CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setCategoryFilter(cat)}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer transition-colors ${
                      categoryFilter === cat
                        ? 'bg-indigo-600 text-white font-bold shadow-xs'
                        : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >
                    {cat} ({categoryCounts[cat] || 0})
                  </button>
                ))}
              </div>

              {/* Secondary Filter Row: Search, Species, Source Tier, Reviewer Status */}
              <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 pt-2 border-t border-slate-100">
                {/* Search Input */}
                <div className="sm:col-span-5 relative">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search titles, summaries, institutions, authors..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 pl-8 pr-3 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-hidden"
                  />
                </div>

                {/* Species Filter */}
                <div className="sm:col-span-3">
                  <select
                    value={speciesFilter}
                    onChange={(e) => setSpeciesFilter(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-hidden"
                  >
                    <option value="All">All Species</option>
                    {SPECIES_LIST.map((sp) => (
                      <option key={sp} value={sp}>
                        {sp}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Source Tier Filter */}
                <div className="sm:col-span-2">
                  <select
                    value={sourceTypeFilter}
                    onChange={(e) => setSourceTypeFilter(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-hidden"
                  >
                    <option value="All">All Tiers</option>
                    <option value="Tier 1">Tier 1 (Research)</option>
                    <option value="Tier 2">Tier 2 (Gov/Inst)</option>
                    <option value="Tier 3">Tier 3 (Synthesis)</option>
                  </select>
                </div>

                {/* Status Filter */}
                <div className="sm:col-span-2">
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs text-slate-900 focus:border-indigo-500 focus:outline-hidden"
                  >
                    <option value="All">All Statuses</option>
                    <option value="AI Screened">AI Screened</option>
                    <option value="Human Approved">Human Approved</option>
                    <option value="Flagged for Review">Flagged</option>
                    <option value="Rejected">Rejected</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Papers Table Container */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
              {isLoading ? (
                <div className="p-12 text-center text-slate-500 text-xs">
                  <RefreshCw className="w-6 h-6 animate-spin mx-auto text-indigo-600 mb-2" />
                  Loading database papers...
                </div>
              ) : filteredResources.length === 0 ? (
                <div className="p-12 text-center text-slate-500 text-xs space-y-2">
                  <Database className="w-8 h-8 mx-auto text-slate-400" />
                  <div className="font-semibold text-slate-700">No papers found matching criteria</div>
                  <p className="text-[11px] text-slate-400 max-w-sm mx-auto">
                    Try adjusting your search query, selecting "All Categories", or use "Pull Resources From All Categories" in the left panel.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-bold uppercase tracking-wider text-slate-600">
                        <th className="py-3 px-4">Title & Source</th>
                        <th className="py-3 px-3">Category & Scope</th>
                        <th className="py-3 px-3">Species & Pop.</th>
                        <th className="py-3 px-3">Inclusion Rationale</th>
                        <th className="py-3 px-3 text-center">Status</th>
                        <th className="py-3 px-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredResources.map((rec) => (
                        <tr
                          key={rec.id}
                          className="hover:bg-slate-50/80 transition-colors group cursor-pointer"
                          onClick={() => setSelectedResource(rec)}
                        >
                          {/* Title & Source Institution */}
                          <td className="py-3 px-4 max-w-xs sm:max-w-sm">
                            <div className="font-semibold text-slate-900 line-clamp-2 leading-snug group-hover:text-indigo-600 transition-colors">
                              {rec.title}
                            </div>
                            <div className="flex items-center gap-2 mt-1 text-[11px] text-slate-500">
                              <span className="truncate max-w-[180px] font-medium text-slate-600">
                                {rec.sourceInstitution}
                              </span>
                              <span>•</span>
                              <span>{rec.yearPublished}</span>
                              <span>•</span>
                              <span className="font-semibold text-indigo-600">{rec.sourceType}</span>
                            </div>
                          </td>

                          {/* Primary Objective Category */}
                          <td className="py-3 px-3 align-top whitespace-nowrap">
                            <span
                              className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold border ${getObjectiveBadgeClass(
                                rec.primaryObjective
                              )}`}
                            >
                              {rec.primaryObjective}
                            </span>
                            {rec.secondaryObjectives && rec.secondaryObjectives.length > 0 && (
                              <div className="text-[10px] text-slate-400 mt-1 truncate max-w-[140px]">
                                + {rec.secondaryObjectives.join(', ')}
                              </div>
                            )}
                          </td>

                          {/* Species & Population */}
                          <td className="py-3 px-3 align-top text-[11px] text-slate-600">
                            <div className="font-medium text-slate-800 truncate max-w-[130px]">
                              {rec.species?.join(', ')}
                            </div>
                            <div className="text-[10px] text-slate-500 truncate max-w-[130px] mt-0.5">
                              {rec.population?.slice(0, 2).join(', ')}
                            </div>
                          </td>

                          {/* Qualifications & Flags */}
                          <td className="py-3 px-3 align-top max-w-xs text-[11px]">
                            <p className="line-clamp-2 text-slate-600">{rec.qualifications}</p>
                            {rec.flagsNotes && rec.flagsNotes.length > 0 && (
                              <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200 w-fit">
                                <AlertTriangle className="w-3 h-3 shrink-0" />
                                <span className="truncate max-w-[160px]">Flagged Exception</span>
                              </div>
                            )}
                            {rec.retracted && (
                              <div className="mt-1 flex items-center gap-1 text-[10px] font-semibold text-red-700 bg-red-50 px-1.5 py-0.5 rounded border border-red-200 w-fit">
                                <XCircle className="w-3 h-3 shrink-0" />
                                <span>Retracted per PubMed</span>
                              </div>
                            )}
                            {rec.needsRecheck && !rec.retracted && (
                              <div className="mt-1 flex items-center gap-1 text-[10px] text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-300 w-fit">
                                <AlertTriangle className="w-3 h-3 shrink-0" />
                                <span className="truncate max-w-[150px]" title={rec.recheckReason}>
                                  {rec.recheckReason || 'Needs recheck'}
                                </span>
                                <button
                                  onClick={() => clearRecheckFlag(rec.id)}
                                  className="underline ml-1 cursor-pointer"
                                  title="Dismiss this flag after reviewing"
                                >
                                  dismiss
                                </button>
                              </div>
                            )}
                            {rec.dateAdded && rec.addedBy === 'daily-agent' && Date.now() - Date.parse(rec.dateAdded) < 7 * 86400000 && (
                              <div className="mt-1 text-[10px] font-semibold text-indigo-600">New</div>
                            )}
                          </td>

                          {/* Reviewer Status */}
                          <td
                            className="py-3 px-3 align-top text-center whitespace-nowrap"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <select
                              value={rec.reviewerStatus}
                              onChange={(e) =>
                                handleStatusChange(rec.id, e.target.value as ReviewerStatus)
                              }
                              className={`text-[10px] font-bold px-2 py-1 rounded-md border cursor-pointer ${
                                rec.reviewerStatus === 'Human Approved'
                                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                                  : rec.reviewerStatus === 'Flagged for Review'
                                  ? 'bg-amber-50 text-amber-800 border-amber-200'
                                  : rec.reviewerStatus === 'Rejected'
                                  ? 'bg-rose-50 text-rose-800 border-rose-200'
                                  : 'bg-blue-50 text-blue-800 border-blue-200'
                              }`}
                            >
                              <option value="AI Screened">AI Screened</option>
                              <option value="Human Approved">Human Approved</option>
                              <option value="Flagged for Review">Flagged</option>
                              <option value="Rejected">Rejected</option>
                            </select>
                          </td>

                          {/* Actions */}
                          <td
                            className="py-3 px-3 align-top text-right whitespace-nowrap"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="flex items-center justify-end gap-1.5">
                              <a
                                href={rec.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Open Full Article"
                                className="p-1 rounded text-slate-400 hover:text-indigo-600 hover:bg-slate-100 transition-colors"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                              <button
                                onClick={() => setSelectedResource(rec)}
                                title="View Details"
                                className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors cursor-pointer"
                              >
                                <Eye className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleDeleteResource(rec.id)}
                                title="Delete Record"
                                className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-slate-100 transition-colors cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Resource Detail Modal */}
      {selectedResource && (
        <ResourceDetailModal
          resource={selectedResource}
          onClose={() => setSelectedResource(null)}
          onStatusChange={(status) => handleStatusChange(selectedResource.id, status)}
        />
      )}

      {/* Comprehensive Rubric Modal (All 4 pages of user document) */}
      {isRubricOpen && <RubricModal onClose={() => setIsRubricOpen(false)} />}
    </div>
  );
}
