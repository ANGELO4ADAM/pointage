/**
 * Base de données locale IndexedDB (100 % hors-ligne sur le téléphone).
 * Stores :
 * - events   : tous les pointages scellés
 * - photos   : clichés originaux (Blob) + métadonnées EXIF + SHA-256
 * - settings : configuration applicative & paramètres Google Drive
 */

import { DEFAULT_SETTINGS } from './constants.js';
import { parseTimestampMs } from './csv_io.js';

const DB_NAME = 'pointage_prudhommes_mobile_v1';
const DB_VERSION = 1;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('events')) {
        const store = db.createObjectStore('events', { keyPath: 'id' });
        store.createIndex('by_date', 'date', { unique: false });
        store.createIndex('by_hash', 'hash', { unique: false });
        store.createIndex('by_synced', 'synced', { unique: false });
      }
      if (!db.objectStoreNames.contains('photos')) {
        const pStore = db.createObjectStore('photos', { keyPath: 'name' });
        pStore.createIndex('by_hash', 'hash', { unique: false });
        pStore.createIndex('by_synced', 'synced', { unique: false });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// --- SETTINGS ---
export async function getSettings() {
  const db = await openDB();
  const tx = db.transaction('settings', 'readonly');
  const all = await reqPromise(tx.objectStore('settings').getAll());
  const merged = { ...DEFAULT_SETTINGS };
  for (const item of all) {
    merged[item.key] = item.value;
  }
  return merged;
}

export async function saveSettings(partial) {
  const db = await openDB();
  const tx = db.transaction('settings', 'readwrite');
  const store = tx.objectStore('settings');
  for (const [key, value] of Object.entries(partial)) {
    store.put({ key, value });
  }
  await txDone(tx);
  return getSettings();
}

// --- EVENTS ---
export async function getAllEvents() {
  const db = await openDB();
  const tx = db.transaction('events', 'readonly');
  const rows = await reqPromise(tx.objectStore('events').getAll());
  rows.sort((a, b) => parseTimestampMs(a.dateHeure) - parseTimestampMs(b.dateHeure));
  return rows;
}

export async function putEvent(eventObj) {
  const db = await openDB();
  const tx = db.transaction('events', 'readwrite');
  tx.objectStore('events').put(eventObj);
  await txDone(tx);
  return eventObj;
}

export async function putManyEvents(eventsList) {
  const db = await openDB();
  const tx = db.transaction('events', 'readwrite');
  const store = tx.objectStore('events');
  for (const ev of eventsList) {
    store.put(ev);
  }
  await txDone(tx);
}

export async function deleteEventById(id) {
  const db = await openDB();
  const tx = db.transaction('events', 'readwrite');
  tx.objectStore('events').delete(id);
  await txDone(tx);
}

export async function deleteEventsByDate(dateStr) {
  const all = await getAllEvents();
  const targets = all.filter((e) => e.date === dateStr);
  const db = await openDB();
  const tx = db.transaction(['events', 'photos'], 'readwrite');
  const evStore = tx.objectStore('events');
  const phStore = tx.objectStore('photos');
  for (const ev of targets) {
    evStore.delete(ev.id);
    if (ev.photoName) {
      phStore.delete(ev.photoName);
    }
  }
  await txDone(tx);
  return targets.length;
}

export async function clearAllData() {
  const db = await openDB();
  const tx = db.transaction(['events', 'photos'], 'readwrite');
  tx.objectStore('events').clear();
  tx.objectStore('photos').clear();
  await txDone(tx);
}

export async function hasHashInEvents(hash) {
  if (!hash) return false;
  const all = await getAllEvents();
  const h = hash.toLowerCase();
  return all.some((e) => (e.hash || '').toLowerCase() === h);
}

// --- PHOTOS ---
export async function putPhoto(photoRecord) {
  // photoRecord: { name, blob, hash, date, exifDate, size, synced, driveFileId? }
  const db = await openDB();
  const tx = db.transaction('photos', 'readwrite');
  tx.objectStore('photos').put(photoRecord);
  await txDone(tx);
  return photoRecord;
}

export async function getPhoto(name) {
  if (!name) return null;
  const db = await openDB();
  const tx = db.transaction('photos', 'readonly');
  return reqPromise(tx.objectStore('photos').get(name));
}

export async function getAllPhotosMeta() {
  const db = await openDB();
  const tx = db.transaction('photos', 'readonly');
  const all = await reqPromise(tx.objectStore('photos').getAll());
  return all;
}

export async function getPhotoNamesSet() {
  const db = await openDB();
  const tx = db.transaction('photos', 'readonly');
  const keys = await reqPromise(tx.objectStore('photos').getAllKeys());
  return new Set(keys);
}

export async function getPendingSyncCounts() {
  const [events, photos] = await Promise.all([getAllEvents(), getAllPhotosMeta()]);
  return {
    pendingEvents: events.filter((e) => !e.synced).length,
    pendingPhotos: photos.filter((p) => !p.synced).length,
    totalEvents: events.length,
    totalPhotos: photos.length
  };
}
