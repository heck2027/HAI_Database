import fs from 'fs';
import path from 'path';
import { Firestore } from '@google-cloud/firestore';
import type { HAIResource } from '../src/types';

// ==========================================
// STORAGE LAYER
// Firestore in production (Cloud Run), JSON files for local/offline dev.
//
// Collections:
//   resources/{id}  – one HAIResource per document (your 12-field schema + monitoring fields)
//   seen/{pmid}     – every PubMed ID the agent has screened (so rejects are never re-screened)
//   runs/{auto}     – one summary document per daily run (audit log)
//   meta/state      – lastRunAt, discoveryCursor
//   meta/lock       – prevents two daily runs overlapping
// ==========================================

export interface SeenEntry {
  id: string; // PMID
  verdict: 'Added' | 'Rejected';
  reason?: string;
  title?: string;
  seenAt: string;
}

export interface Meta {
  lastRunAt?: string;
  discoveryCursor?: string; // ISO date: next discovery window starts here (minus 1 day overlap)
}

export interface Store {
  kind: 'firestore' | 'file';
  init(): Promise<void>;
  loadAll(): Promise<HAIResource[]>;
  upsertMany(records: HAIResource[]): Promise<void>;
  remove(id: string): Promise<void>;
  replaceAll(records: HAIResource[]): Promise<void>;
  getSeen(ids: string[]): Promise<Set<string>>;
  markSeen(entries: SeenEntry[]): Promise<void>;
  getMeta(): Promise<Meta>;
  setMeta(patch: Partial<Meta>): Promise<void>;
  addRun(run: Record<string, unknown>): Promise<void>;
  listRuns(limit: number): Promise<Record<string, unknown>[]>;
  acquireLock(ttlMs: number): Promise<boolean>;
  releaseLock(): Promise<void>;
}

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// ------------------------------------------
// Firestore backend
// ------------------------------------------
class FirestoreStore implements Store {
  kind = 'firestore' as const;
  private db: Firestore;

  constructor() {
    this.db = new Firestore({
      projectId: process.env.FIRESTORE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || undefined,
      databaseId: process.env.FIRESTORE_DATABASE_ID || '(default)',
      ignoreUndefinedProperties: true,
    });
  }

  async init() {
    // Fail loudly at startup if credentials / project / database are wrong.
    await this.db.collection('meta').doc('state').get();
  }

  async loadAll() {
    const snap = await this.db.collection('resources').get();
    return snap.docs.map((d) => ({ ...(d.data() as any), id: d.id }) as HAIResource);
  }

  async upsertMany(records: HAIResource[]) {
    for (const part of chunk(records, 400)) {
      const batch = this.db.batch();
      for (const r of part) batch.set(this.db.collection('resources').doc(r.id), r as any);
      await batch.commit();
    }
  }

  async remove(id: string) {
    await this.db.collection('resources').doc(id).delete();
  }

  async replaceAll(records: HAIResource[]) {
    const existing = await this.db.collection('resources').listDocuments();
    for (const part of chunk(existing, 400)) {
      const batch = this.db.batch();
      part.forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
    await this.upsertMany(records);
  }

  async getSeen(ids: string[]) {
    const seen = new Set<string>();
    for (const part of chunk(ids, 300)) {
      const refs = part.map((id) => this.db.collection('seen').doc(id));
      const snaps = await this.db.getAll(...refs);
      snaps.forEach((s) => s.exists && seen.add(s.id));
    }
    return seen;
  }

  async markSeen(entries: SeenEntry[]) {
    for (const part of chunk(entries, 400)) {
      const batch = this.db.batch();
      for (const e of part) batch.set(this.db.collection('seen').doc(e.id), e as any, { merge: true });
      await batch.commit();
    }
  }

  async getMeta() {
    const s = await this.db.collection('meta').doc('state').get();
    return (s.exists ? s.data() : {}) as Meta;
  }

  async setMeta(patch: Partial<Meta>) {
    await this.db.collection('meta').doc('state').set(patch as any, { merge: true });
  }

  async addRun(run: Record<string, unknown>) {
    await this.db.collection('runs').add(run as any);
  }

  async listRuns(limit: number) {
    const snap = await this.db.collection('runs').orderBy('startedAt', 'desc').limit(limit).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  async acquireLock(ttlMs: number) {
    const ref = this.db.collection('meta').doc('lock');
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const now = Date.now();
      if (snap.exists && (snap.data()?.expiresAt || 0) > now) return false;
      tx.set(ref, { acquiredAt: now, expiresAt: now + ttlMs });
      return true;
    });
  }

  async releaseLock() {
    await this.db.collection('meta').doc('lock').delete().catch(() => undefined);
  }
}

// ------------------------------------------
// File backend (local dev / AI Studio preview without Firestore)
// ------------------------------------------
class FileStore implements Store {
  kind = 'file' as const;
  private dataFile = path.join(process.cwd(), 'hai_database.json');
  private stateFile = path.join(process.cwd(), 'hai_state.json');
  private records: HAIResource[] = [];
  private state: { meta: Meta; seen: Record<string, SeenEntry>; runs: Record<string, unknown>[] } = {
    meta: {},
    seen: {},
    runs: [],
  };
  private locked = false;

  async init() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
        if (Array.isArray(parsed)) this.records = parsed;
      }
      if (fs.existsSync(this.stateFile)) {
        this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.stateFile, 'utf-8')) };
      }
    } catch (e) {
      console.warn('FileStore: could not read existing files, starting empty', e);
    }
  }

  private saveRecords() {
    fs.writeFileSync(this.dataFile, JSON.stringify(this.records, null, 2));
  }
  private saveState() {
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  async loadAll() {
    return [...this.records];
  }
  async upsertMany(records: HAIResource[]) {
    const byId = new Map(this.records.map((r) => [r.id, r]));
    for (const r of records) byId.set(r.id, r);
    this.records = [...byId.values()];
    this.saveRecords();
  }
  async remove(id: string) {
    this.records = this.records.filter((r) => r.id !== id);
    this.saveRecords();
  }
  async replaceAll(records: HAIResource[]) {
    this.records = [...records];
    this.saveRecords();
  }
  async getSeen(ids: string[]) {
    return new Set(ids.filter((id) => this.state.seen[id]));
  }
  async markSeen(entries: SeenEntry[]) {
    for (const e of entries) this.state.seen[e.id] = e;
    this.saveState();
  }
  async getMeta() {
    return this.state.meta;
  }
  async setMeta(patch: Partial<Meta>) {
    this.state.meta = { ...this.state.meta, ...patch };
    this.saveState();
  }
  async addRun(run: Record<string, unknown>) {
    this.state.runs.unshift({ id: String(Date.now()), ...run });
    this.state.runs = this.state.runs.slice(0, 100);
    this.saveState();
  }
  async listRuns(limit: number) {
    return this.state.runs.slice(0, limit);
  }
  async acquireLock() {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }
  async releaseLock() {
    this.locked = false;
  }
}

function chooseBackend(): 'firestore' | 'file' {
  const explicit = (process.env.STORAGE_BACKEND || '').toLowerCase();
  if (explicit === 'firestore' || explicit === 'file') return explicit;
  // Cloud Run sets K_SERVICE; GOOGLE_CLOUD_PROJECT / FIRESTORE_PROJECT_ID indicate a configured GCP project.
  if (process.env.K_SERVICE || process.env.GOOGLE_CLOUD_PROJECT || process.env.FIRESTORE_PROJECT_ID) {
    return 'firestore';
  }
  return 'file';
}

export const store: Store = chooseBackend() === 'firestore' ? new FirestoreStore() : new FileStore();
