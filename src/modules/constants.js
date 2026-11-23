/**
 * Constantes centralisées de l'application Android Pointage Prud'hommes.
 * Compatibles à 100 % avec le registre pointage.csv existant.
 */

export const APP_VERSION = '1.0.0';
export const TIMEZONE_PARIS = 'Europe/Paris';

export const SALARIE_NOM = 'Hamid HOUSSAINI';
export const SALARIE_ID = '1177593529';
export const ENTREPRISE_NOM = 'SAS TANGER MARCHE';
export const ENTREPRISE_ADRESSE = '166 Av. Gallieni / 41 Rue Roger Salengro, 93140 Bondy (RCS Bobigny)';

// Géofencing magasin Tanger Marché (Bondy)
export const GPS_MAGASIN = {
  lat: 48.9065,
  lon: 2.4864,
  rayonMetres: 200
};

export const ACTIONS = {
  ENTREE: '🟢 Entrée (Matin)',
  PAUSE_DEPART: '🍔 Pause Midi (Départ)',
  PAUSE_RETOUR: '🍔 Pause Midi (Retour)',
  SORTIE: '🔴 Sortie (Soir)',
  GPS: '📍 Validation GPS',
  PHOTO: '📸 Dépôt Preuve Photo',
  INCIDENT: '⚠️ INCIDENT',
  OBSERVATION: '📝 OBSERVATION',
  TIMELINE: '🗺️ Preuve Google Timeline'
};

export const CSV_HEADER = ['Date_Heure', 'Action', 'Détail', 'Empreinte_SHA256'];

export const JOURS_FR = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
export const JOURS_COURTS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
export const MOIS_FR = [
  '', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'
];

export const DEFAULT_SETTINGS = {
  salarieNom: SALARIE_NOM,
  entrepriseNom: ENTREPRISE_NOM,
  gpsLat: GPS_MAGASIN.lat,
  gpsLon: GPS_MAGASIN.lon,
  gpsRayon: GPS_MAGASIN.rayonMetres,
  joursReposHebdo: [0], // 0 = Lundi par défaut
  tauxHoraireBrut: 12.0,
  salaireMensuelBrut: 1820.04,
  anneesArrieres: 3,
  driveScriptUrl: '',
  driveSecretToken: '',
  autoSyncDrive: true,
  pinHash: '',
  pinSalt: ''
};

/**
 * Retourne l'horodatage courant en fuseau Europe/Paris au format 'YYYY-MM-DD HH:MM:SS'
 */
export function nowParisISO(dateObj = new Date()) {
  const parts = new Intl.DateTimeFormat('fr-CA', {
    timeZone: TIMEZONE_PARIS,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(dateObj);

  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const h = map.hour === '24' ? '00' : map.hour;
  return `${map.year}-${map.month}-${map.day} ${h}:${map.minute}:${map.second}`;
}

export function todayParisDate(dateObj = new Date()) {
  return nowParisISO(dateObj).slice(0, 10);
}

/**
 * Formate 'YYYY-MM-DD' en 'Lundi 23 Novembre 2026'
 */
export function formaterDateFr(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return dateStr || '';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const wd = (dt.getUTCDay() + 6) % 7; // 0 = Lundi .. 6 = Dimanche
  return `${JOURS_FR[wd]} ${d} ${MOIS_FR[mo]} ${y}`;
}

export function weekdayMondayZero(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return 0;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  return (dt.getUTCDay() + 6) % 7;
}

/**
 * Calcule (year, week) ISO-8601 pour une date 'YYYY-MM-DD'
 */
export function getISOWeekInfo(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return { year: 2026, week: 1, key: '2026-W01' };
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
  const year = dt.getUTCFullYear();
  return { year, week, key: `${year}-W${String(week).padStart(2, '0')}` };
}

/**
 * Retourne les 7 dates 'YYYY-MM-DD' (Lundi..Dimanche) d'une semaine ISO
 */
export function getDatesOfISOWeek(isoYear, isoWeek) {
  const simple = new Date(Date.UTC(isoYear, 0, 1 + (isoWeek - 1) * 7));
  const dow = simple.getUTCDay();
  const monday = new Date(simple);
  if (dow <= 4 && dow > 0) {
    monday.setUTCDate(simple.getUTCDate() - dow + 1);
  } else if (dow === 0) {
    monday.setUTCDate(simple.getUTCDate() - 6);
  } else {
    monday.setUTCDate(simple.getUTCDate() + 8 - dow);
  }
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Distance géodésique Haversine en mètres
 */
export function calculerDistanceMetres(lat1, lon1, lat2 = GPS_MAGASIN.lat, lon2 = GPS_MAGASIN.lon) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export function formatHM(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m`;
}
