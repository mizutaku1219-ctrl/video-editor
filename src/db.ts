import type { ProjectData } from './types';

const DB_NAME = 'video-editor';
const DB_VERSION = 2;
const STORE = 'project';
const KEY = 'current';

export interface StoredProject {
  data: ProjectData;
  /** 動画ソースID → 動画ファイル */
  videoBlobs: Record<string, Blob>;
  audioBlob: Blob | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export async function saveProject(
  data: ProjectData,
  videoBlobs: Record<string, Blob>,
  audioBlob: Blob | null,
): Promise<void> {
  const payload: StoredProject = { data, videoBlobs, audioBlob };
  await tx('readwrite', (s) => s.put(payload, KEY));
}

export async function loadProject(): Promise<StoredProject | null> {
  try {
    const v = await tx<StoredProject | undefined>('readonly', (s) => s.get(KEY));
    if (!v || !v.data || !v.videoBlobs) return null;
    return v;
  } catch {
    return null;
  }
}

export async function clearProject(): Promise<void> {
  await tx('readwrite', (s) => s.delete(KEY));
}
