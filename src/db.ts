import type { ProjectData } from './types';

const DB_NAME = 'video-editor';
const DB_VERSION = 1;
const STORE = 'project';
const KEY = 'current';

interface StoredProject {
  data: ProjectData;
  videoBlob: Blob | null;
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
  videoBlob: Blob | null,
  audioBlob: Blob | null,
): Promise<void> {
  const payload: StoredProject = { data, videoBlob, audioBlob };
  await tx('readwrite', (s) => s.put(payload, KEY));
}

export async function loadProject(): Promise<StoredProject | null> {
  try {
    const v = await tx<StoredProject | undefined>('readonly', (s) => s.get(KEY));
    return v ?? null;
  } catch {
    return null;
  }
}

export async function clearProject(): Promise<void> {
  await tx('readwrite', (s) => s.delete(KEY));
}
