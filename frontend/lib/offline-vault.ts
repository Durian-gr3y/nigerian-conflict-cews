/**
 * offline-vault.ts
 * IndexedDB-backed offline report storage for Nigeria CEWS.
 * Uses the `idb` library for a promise-based API.
 */

import { openDB as idbOpenDB, DBSchema, IDBPDatabase } from 'idb';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AlertType =
  | 'armed_conflict'
  | 'communal_violence'
  | 'kidnapping'
  | 'mass_atrocity'
  | 'banditry'
  | 'terrorism'
  | 'protest'
  | 'other';

export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'failed';

export interface ReportMetadata {
  id: string;
  zone: string;
  state: string;
  lga: string;
  alert_type: AlertType;
  incident_occurred_at: string; // ISO 8601
  created_at: string;           // ISO 8601
  sync_status: SyncStatus;
  sync_attempts: number;
  last_sync_attempt?: string;   // ISO 8601
  expires_at: string;           // ISO 8601 — 72 h after creation
}

export interface OfflineReport extends ReportMetadata {
  /** AES-256-GCM encrypted payload (base64url), nonce prepended as first 16 bytes */
  encrypted_payload: string;
  /** Serialised MediaFile references stored as data-URLs or object-URL refs */
  media_refs: string[];
  /** ECDH ephemeral public key (base64url) for key derivation on the server */
  ephemeral_public_key: string;
  /** Checksum (SHA-256 hex) of the plaintext JSON before encryption */
  checksum: string;
}

// ─── DB Schema ────────────────────────────────────────────────────────────────

interface CEWSSchema extends DBSchema {
  offline_reports: {
    key: string; // report id
    value: OfflineReport;
    indexes: {
      by_sync_status: SyncStatus;
      by_expires_at: string;
      by_created_at: string;
    };
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DB_NAME = 'cews-offline-vault';
const DB_VERSION = 1;
const REPORT_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

// ─── DB initialisation ───────────────────────────────────────────────────────

let dbPromise: Promise<IDBPDatabase<CEWSSchema>> | null = null;

export function openDB(): Promise<IDBPDatabase<CEWSSchema>> {
  if (!dbPromise) {
    dbPromise = idbOpenDB<CEWSSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const store = db.createObjectStore('offline_reports', { keyPath: 'id' });
          store.createIndex('by_sync_status', 'sync_status');
          store.createIndex('by_expires_at', 'expires_at');
          store.createIndex('by_created_at', 'created_at');
        }
      },
      blocked() {
        console.warn('[CEWS Vault] DB upgrade blocked — please close other tabs.');
      },
      blocking() {
        dbPromise = null;
      },
      terminated() {
        console.error('[CEWS Vault] DB connection terminated unexpectedly.');
        dbPromise = null;
      },
    });
  }
  return dbPromise;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

function expiresAt(createdAt: string): string {
  return new Date(new Date(createdAt).getTime() + REPORT_TTL_MS).toISOString();
}

function isQuotaError(err: unknown): boolean {
  if (err instanceof DOMException) {
    return (
      err.name === 'QuotaExceededError' ||
      err.name === 'NS_ERROR_DOM_INDEXEDDB_QUOTA_ERR'
    );
  }
  return false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Persist an encrypted report to IndexedDB.
 * On QuotaExceededError, prunes expired reports and retries once.
 */
export async function storeOfflineReport(
  report: Omit<OfflineReport, 'sync_status' | 'sync_attempts' | 'created_at' | 'expires_at'>
): Promise<OfflineReport> {
  const created_at = nowISO();
  const full: OfflineReport = {
    ...report,
    created_at,
    expires_at: expiresAt(created_at),
    sync_status: 'pending',
    sync_attempts: 0,
  };

  const db = await openDB();

  const attemptWrite = async () => {
    const tx = db.transaction('offline_reports', 'readwrite');
    await tx.store.put(full);
    await tx.done;
  };

  try {
    await attemptWrite();
  } catch (err) {
    if (isQuotaError(err)) {
      console.warn('[CEWS Vault] QuotaExceededError — pruning expired reports and retrying…');
      await pruneExpiredReports();
      try {
        await attemptWrite();
      } catch (retryErr) {
        if (isQuotaError(retryErr)) {
          throw new Error(
            'Device storage is full. Please free up space or sync pending reports.'
          );
        }
        throw retryErr;
      }
    } else {
      throw err;
    }
  }

  return full;
}

/**
 * Retrieve all reports with sync_status === 'pending', ordered by created_at ascending.
 */
export async function getPendingReports(): Promise<OfflineReport[]> {
  const db = await openDB();
  const reports = await db.getAllFromIndex(
    'offline_reports',
    'by_sync_status',
    'pending'
  );
  return reports.sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
}

/**
 * Retrieve ALL reports regardless of sync status.
 */
export async function getAllReports(): Promise<OfflineReport[]> {
  const db = await openDB();
  return db.getAll('offline_reports');
}

/**
 * Mark a report as successfully synced.
 */
export async function markReportSynced(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('offline_reports', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    await tx.done;
    return;
  }
  await tx.store.put({
    ...existing,
    sync_status: 'synced',
    last_sync_attempt: nowISO(),
  });
  await tx.done;
}

/**
 * Increment the sync_attempts counter and mark as 'failed' if attempts >= maxAttempts.
 */
export async function incrementSyncAttempt(
  id: string,
  maxAttempts = 5
): Promise<OfflineReport | null> {
  const db = await openDB();
  const tx = db.transaction('offline_reports', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    await tx.done;
    return null;
  }

  const newAttempts = existing.sync_attempts + 1;
  const updated: OfflineReport = {
    ...existing,
    sync_attempts: newAttempts,
    last_sync_attempt: nowISO(),
    sync_status: newAttempts >= maxAttempts ? 'failed' : 'pending',
  };

  await tx.store.put(updated);
  await tx.done;
  return updated;
}

/**
 * Delete all reports whose expires_at is in the past.
 * Returns the number of pruned records.
 */
export async function pruneExpiredReports(): Promise<number> {
  const db = await openDB();
  const now = nowISO();
  const tx = db.transaction('offline_reports', 'readwrite');
  const index = tx.store.index('by_expires_at');

  // IDBKeyRange: all keys <= now (i.e. already expired)
  const range = IDBKeyRange.upperBound(now);
  let pruned = 0;

  let cursor = await index.openCursor(range);
  while (cursor) {
    await cursor.delete();
    pruned++;
    cursor = await cursor.continue();
  }

  await tx.done;
  if (pruned > 0) {
    console.info(`[CEWS Vault] Pruned ${pruned} expired report(s).`);
  }
  return pruned;
}

/**
 * Delete a specific report by ID.
 */
export async function deleteReport(id: string): Promise<void> {
  const db = await openDB();
  await db.delete('offline_reports', id);
}

/**
 * Returns a count summary: { pending, synced, failed, total }
 */
export async function getVaultStats(): Promise<{
  pending: number;
  synced: number;
  failed: number;
  total: number;
}> {
  const db = await openDB();
  const all = await db.getAll('offline_reports');
  const pending = all.filter((r) => r.sync_status === 'pending').length;
  const synced = all.filter((r) => r.sync_status === 'synced').length;
  const failed = all.filter((r) => r.sync_status === 'failed').length;
  return { pending, synced, failed, total: all.length };
}
