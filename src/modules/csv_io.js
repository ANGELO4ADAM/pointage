/**
 * Parseur et sérialiseur pointage.csv (délimiteur ';', UTF-8).
 * Compatibilité bidirectionnelle totale avec le système Python existant.
 */

import { CSV_HEADER } from './constants.js';

export function parseTimestampMs(tsStr) {
  const s = String(tsStr || '').trim();
  const m1 = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m1) {
    return Date.UTC(
      Number(m1[1]),
      Number(m1[2]) - 1,
      Number(m1[3]),
      Number(m1[4] || 0),
      Number(m1[5] || 0),
      Number(m1[6] || 0)
    );
  }
  const m2 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m2) {
    return Date.UTC(
      Number(m2[3]),
      Number(m2[2]) - 1,
      Number(m2[1]),
      Number(m2[4] || 0),
      Number(m2[5] || 0),
      Number(m2[6] || 0)
    );
  }
  return 0;
}

export function extractPhotoName(detailStr) {
  const tokens = String(detailStr || '').split(/\s+/);
  for (const raw of tokens) {
    const clean = raw.replace(/^Fichier:/i, '').replace(/^preuves_photos\//i, '').trim();
    if (
      (clean.startsWith('ticket_preuve_') || clean.startsWith('timeline_google_')) &&
      /\.(jpg|jpeg|png)$/i.test(clean)
    ) {
      return clean;
    }
  }
  return null;
}

/**
 * Parse une ligne CSV délimitée par ';' en gérant les guillemets RFC 4180.
 */
function splitCsvLine(line, delimiter = ';') {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function escapeCsvCell(val) {
  const s = String(val ?? '').replace(/\r?\n/g, ' ');
  if (s.includes(';') || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Parse un fichier pointage.csv complet en tableau d'objets événements triés.
 */
export function parsePointageCsv(csvText) {
  if (!csvText) return [];
  const cleanText = csvText.replace(/^\uFEFF/, '');
  const lines = cleanText.split(/\r?\n/);
  const events = [];
  const seenKeys = new Set();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = splitCsvLine(line, ';');
    if (cols.length < 2) continue;
    const dateHeure = cols[0].trim();
    if (!dateHeure || dateHeure.includes('Date_Heure')) continue;

    const action = cols[1].trim();
    const detail = (cols[2] || '').trim();
    const hash = (cols[3] || '').trim();
    if (!action) continue;

    const dedupKey = `${dateHeure}|${action}|${detail}`;
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);

    events.push({
      id: `${dateHeure}__${action}__${hash.slice(0, 12) || events.length}`,
      dateHeure,
      date: dateHeure.split(/\s+/)[0],
      action,
      detail,
      hash,
      photoName: extractPhotoName(detail),
      synced: true,
      source: 'csv_import'
    });
  }

  events.sort((a, b) => parseTimestampMs(a.dateHeure) - parseTimestampMs(b.dateHeure));
  return events;
}

/**
 * Sérialise les événements au format strict pointage.csv (UTF-8, délimiteur ';', tri chronologique).
 */
export function serializePointageCsv(events) {
  const sorted = [...events].sort((a, b) => parseTimestampMs(a.dateHeure) - parseTimestampMs(b.dateHeure));
  const rows = [CSV_HEADER.join(';')];
  for (const ev of sorted) {
    rows.push([
      escapeCsvCell(ev.dateHeure),
      escapeCsvCell(ev.action),
      escapeCsvCell(ev.detail),
      escapeCsvCell(ev.hash || '')
    ].join(';'));
  }
  return rows.join('\r\n') + '\r\n';
}
