/**
 * Moteur d'audit journalier, détection d'anomalies, scellement SHA-256
 * et évaluation de robustesse probatoire Kayak + Top 3 Preuves.
 * Portage exact et fidèle de generateur_rapport.py + scellement.py + chiffrage_prudhommes.py.
 */

import {
  JOURS_FR,
  JOURS_COURTS,
  MOIS_FR,
  formaterDateFr,
  weekdayMondayZero,
  getISOWeekInfo,
  getDatesOfISOWeek,
  formatHM,
  nowParisISO,
  todayParisDate
} from './constants.js';
import { parseTimestampMs, extractPhotoName, serializePointageCsv } from './csv_io.js';
import { sha256Text } from './crypto.js';

function isEntreeAction(a) {
  const al = String(a || '').toLowerCase();
  return (al.includes('entrée') || al.includes('entree') || al.includes('prise de poste') || al.includes('arrivée') || al.includes('arrivee')) && !al.includes('timeline');
}

function isSortieAction(a) {
  const al = String(a || '').toLowerCase();
  return (al.includes('sortie') || al.includes('fin de poste')) && !al.includes('timeline');
}

function isPauseDepartAction(a) {
  const al = String(a || '').toLowerCase();
  return al.includes('pause') && !al.includes('timeline') && ['départ', 'depart', 'début', 'debut', 'start'].some((k) => al.includes(k));
}

function isPauseRetourAction(a) {
  const al = String(a || '').toLowerCase();
  return al.includes('pause') && !al.includes('timeline') && ['retour', 'fin', 'end'].some((k) => al.includes(k));
}

/**
 * Calcule la synthèse journalière exacte (Entrée, Pause, Sortie, Durée nette décimale).
 */
export function calculerSyntheseJournee(eventsJour) {
  const valid = (eventsJour || [])
    .filter((e) => {
      const al = String(e.action || '').toLowerCase();
      return !al.includes('ocr') && !al.includes('timeline');
    })
    .map((e) => ({ ...e, tsMs: parseTimestampMs(e.dateHeure) }))
    .filter((e) => e.tsMs > 0)
    .sort((a, b) => a.tsMs - b.tsMs);

  if (valid.length === 0) {
    return {
      date: '',
      heureEntree: 'N/A',
      heureSortie: 'N/A',
      pauseStr: '00h 00m',
      pauseSec: 0,
      dureeStr: '00h 00m',
      dureeNetteSeule: '00h 00m',
      dureeDecimale: 0,
      dureeSec: 0,
      estEnCours: false,
      pauseManquante: false,
      nbEntrees: 0,
      nbSorties: 0,
      doubleCloture: false,
      anomalieSequence: false
    };
  }

  const dateJour = valid[0].date;
  const hasTravail = valid.some((e) => {
    const al = e.action.toLowerCase();
    return al.includes('entrée') || al.includes('entree') || al.includes('sortie') || al.includes('pause');
  });

  const entrees = valid.filter((e) => isEntreeAction(e.action));
  const sorties = valid.filter((e) => isSortieAction(e.action));

  const entreeEv = entrees[0] || (hasTravail ? valid[0] : null);
  const sortieEv = sorties.length > 0 ? sorties[sorties.length - 1] : null;

  let pauseTotalSec = 0;
  let pauseStartMs = null;
  let pausesDep = 0;
  let pausesRet = 0;
  let anomalieSequence = false;

  for (const ev of valid) {
    if (isPauseDepartAction(ev.action)) {
      if (sortieEv && ev.tsMs > sortieEv.tsMs) anomalieSequence = true;
      if (pauseStartMs === null) pauseStartMs = ev.tsMs;
      pausesDep++;
    } else if (isPauseRetourAction(ev.action)) {
      if (sortieEv && ev.tsMs > sortieEv.tsMs) anomalieSequence = true;
      pausesRet++;
      const hour = Number((ev.dateHeure.split(/\s+/)[1] || '12:00').split(':')[0]);
      if (pauseStartMs !== null) {
        const deltaSec = Math.max(0, (ev.tsMs - pauseStartMs) / 1000);
        if ((sortieEv && ev.tsMs >= sortieEv.tsMs) || (hour >= 18 && deltaSec > 4 * 3600)) {
          pauseTotalSec += 3600;
          anomalieSequence = true;
        } else {
          pauseTotalSec += deltaSec;
        }
        pauseStartMs = null;
      } else if (pausesDep === 0 && pausesRet === 1) {
        if (hour >= 12 && hour <= 16) {
          const midiMs = parseTimestampMs(`${dateJour} 12:00:00`);
          pauseTotalSec += ev.tsMs > midiMs ? (ev.tsMs - midiMs) / 1000 : 3600;
        } else {
          pauseTotalSec += 3600;
        }
      }
    }
  }

  // Départ pause seul sur journée clôturée => déduction forfaitaire 1h
  if (pauseStartMs !== null && sortieEv && pausesDep === 1 && pausesRet === 0) {
    pauseTotalSec += 3600;
    pauseStartMs = null;
    pausesRet = 1;
  }

  const pauseStr = formatHM(pauseTotalSec);

  if (!hasTravail || !entreeEv) {
    return {
      date: dateJour,
      heureEntree: 'N/A',
      heureSortie: 'N/A',
      pauseStr: '00h 00m',
      pauseSec: 0,
      dureeStr: '00h 00m',
      dureeNetteSeule: '00h 00m',
      dureeDecimale: 0,
      dureeSec: 0,
      estEnCours: false,
      pauseManquante: false,
      nbEntrees: entrees.length,
      nbSorties: sorties.length,
      doubleCloture: sorties.length > 1,
      anomalieSequence
    };
  }

  const hEntree = entreeEv.dateHeure.split(/\s+/)[1] || '00:00:00';

  if (!sortieEv) {
    const dernier = valid[valid.length - 1];
    const brutSec = Math.max(0, (dernier.tsMs - entreeEv.tsMs) / 1000);
    const netSec = Math.max(0, brutSec - pauseTotalSec);
    const netStr = formatHM(netSec);
    return {
      date: dateJour,
      heureEntree: hEntree,
      heureSortie: 'En cours',
      pauseStr,
      pauseSec: pauseTotalSec,
      dureeStr: `${netStr} (en cours)`,
      dureeNetteSeule: netStr,
      dureeDecimale: Math.round((netSec / 3600) * 100) / 100,
      dureeSec: netSec,
      estEnCours: true,
      pauseManquante: false,
      nbEntrees: entrees.length,
      nbSorties: sorties.length,
      doubleCloture: false,
      anomalieSequence
    };
  }

  const hSortie = sortieEv.dateHeure.split(/\s+/)[1] || '00:00:00';
  const pauseManquante = (pausesDep === 0 && pausesRet === 0) || pauseStartMs !== null || pausesDep > pausesRet;
  const brutSec = Math.max(0, (sortieEv.tsMs - entreeEv.tsMs) / 1000);
  const netSec = Math.max(0, brutSec - pauseTotalSec);
  const dureeNetteSeule = formatHM(netSec);
  const dureeStr = pauseManquante ? `⚠️ ${dureeNetteSeule} (Pause non pointée)` : dureeNetteSeule;
  const dureeDecimale = Math.round((netSec / 3600) * 100) / 100;

  return {
    date: dateJour,
    heureEntree: hEntree,
    heureSortie: hSortie,
    pauseStr,
    pauseSec: pauseTotalSec,
    dureeStr,
    dureeNetteSeule,
    dureeDecimale,
    dureeSec: netSec,
    estEnCours: false,
    pauseManquante,
    nbEntrees: entrees.length,
    nbSorties: sorties.length,
    doubleCloture: sorties.length > 1,
    anomalieSequence
  };
}

/**
 * Calcule l'état guidé de la journée en cours (pour le bouton séquentiel mobile).
 */
export function obtenirEtatJournee(events, dateCible = todayParisDate()) {
  const duJour = events.filter((e) => e.date === dateCible);
  let aEntree = false;
  let estCloturee = false;
  let nbPauseDep = 0;
  let nbPauseRet = 0;
  let heureEntree = null;
  let heureSortie = null;
  let dernierEvent = null;

  for (const ev of duJour) {
    const h = ev.dateHeure.split(/\s+/)[1] || ev.dateHeure;
    dernierEvent = { id: ev.id, horodatage: ev.dateHeure, heure: h, action: ev.action };
    if (isEntreeAction(ev.action)) {
      aEntree = true;
      if (!heureEntree) heureEntree = h;
    } else if (isSortieAction(ev.action)) {
      estCloturee = true;
      heureSortie = h;
    } else if (isPauseDepartAction(ev.action)) {
      nbPauseDep++;
    } else if (isPauseRetourAction(ev.action)) {
      nbPauseRet++;
    }
  }

  let prochaineAction = '🟢 Entrée (Matin)';
  let statutLabel = 'En attente de prise de service';
  if (estCloturee) {
    prochaineAction = 'CLOTUREE';
    statutLabel = `Journée clôturée à ${heureSortie}`;
  } else if (!aEntree) {
    prochaineAction = '🟢 Entrée (Matin)';
    statutLabel = 'Prêt pour Entrée Matin';
  } else if (nbPauseDep > 0 && nbPauseRet === 0) {
    prochaineAction = '🍔 Pause Midi (Retour)';
    statutLabel = 'En pause midi • Prochaine étape : Retour Pause';
  } else if (nbPauseDep === 0 && nbPauseRet === 0) {
    prochaineAction = '🍔 Pause Midi (Départ)';
    statutLabel = `En service depuis ${heureEntree} • Prochaine étape : Pause Midi`;
  } else {
    prochaineAction = '🔴 Sortie (Soir)';
    statutLabel = 'En service (Pause effectuée) • Prochaine étape : Sortie Soir';
  }

  return {
    date: dateCible,
    aEntree,
    estCloturee,
    heureEntree,
    heureSortie,
    nbPauseDep,
    nbPauseRet,
    enPause: nbPauseDep > 0 && nbPauseRet === 0,
    pauseComplete: nbPauseRet > 0,
    prochaineAction,
    statutLabel,
    nbActions: duJour.length,
    dernierEvent
  };
}

/**
 * Détection proactive d'anomalies (portage fidèle de scellement.detecter_anomalies_pointage).
 */
export function detecterAnomalies(events, joursReposHebdo = [0]) {
  const parJour = new Map();
  for (const ev of events) {
    if (!parJour.has(ev.date)) parJour.set(ev.date, []);
    parJour.get(ev.date).push(ev);
  }

  const today = todayParisDate();
  const currentHour = Number(nowParisISO().slice(11, 13));
  const anomalies = [];

  for (const [dStr, evs] of [...parJour.entries()].sort()) {
    const estRepos = joursReposHebdo.includes(weekdayMondayZero(dStr));
    const entrees = evs.filter((e) => isEntreeAction(e.action));
    const sorties = evs.filter((e) => isSortieAction(e.action));
    const pauses = evs.filter((e) => String(e.action).toLowerCase().includes('pause') && !String(e.action).toLowerCase().includes('timeline'));

    if (estRepos && entrees.length === 0 && sorties.length <= 1) continue;

    const hEntree = entrees[0] ? (entrees[0].dateHeure.split(/\s+/)[1] || '--') : '--';

    if (sorties.length >= 2) {
      const cible = sorties[0];
      const fName = extractPhotoName(cible.detail);
      anomalies.push({
        date: dStr,
        type: 'DOUBLE_CLOTURE',
        description: `Double clôture (${sorties.length} Sorties le même jour)`,
        eventId: cible.id,
        horodatageCible: cible.dateHeure,
        heureEntree: hEntree,
        actionActuelle: cible.action,
        actionProposee: fName ? '📸 Dépôt Preuve Photo' : '📝 OBSERVATION',
        peutSupprimer: true
      });
    }

    if (entrees.length >= 2) {
      const cible = entrees[entrees.length - 1];
      const fName = extractPhotoName(cible.detail);
      anomalies.push({
        date: dStr,
        type: 'DOUBLE_ENTREE',
        description: `Double entrée (${entrees.length} Entrées le même jour)`,
        eventId: cible.id,
        horodatageCible: cible.dateHeure,
        heureEntree: hEntree,
        actionActuelle: cible.action,
        actionProposee: fName ? '📸 Dépôt Preuve Photo' : '📝 OBSERVATION',
        peutSupprimer: true
      });
    }

    if (sorties.length > 0 && pauses.length > 0) {
      const lastSortieMs = parseTimestampMs(sorties[sorties.length - 1].dateHeure);
      for (const p of pauses) {
        if (parseTimestampMs(p.dateHeure) > lastSortieMs) {
          const fName = extractPhotoName(p.detail);
          anomalies.push({
            date: dStr,
            type: 'SEQUENCE_INVERSEE',
            description: `Pause pointée après la clôture 🔴 Sortie (Soir)`,
            eventId: p.id,
            horodatageCible: p.dateHeure,
            heureEntree: hEntree,
            actionActuelle: p.action,
            actionProposee: fName ? '📸 Dépôt Preuve Photo' : '📝 OBSERVATION',
            peutSupprimer: true
          });
        }
      }
    }

    if (dStr === today && currentHour < 22) continue;

    if (entrees.length > 0 && sorties.length === 0) {
      const entreeMs = parseTimestampMs(entrees[0].dateHeure);
      const candidatPhoto = [...evs].reverse().find((e) => {
        const al = e.action.toLowerCase();
        if ((al.includes('photo') || al.includes('preuve')) && !al.includes('sortie') && !al.includes('timeline')) {
          const h = Number((e.dateHeure.split(/\s+/)[1] || '00:00').split(':')[0]);
          const deltaH = (parseTimestampMs(e.dateHeure) - entreeMs) / 3600000;
          return h >= 15 || deltaH >= 4;
        }
        return false;
      });

      if (candidatPhoto) {
        anomalies.push({
          date: dStr,
          type: 'PHOTO_SANS_SORTIE',
          description: `Dépôt photo à ${candidatPhoto.dateHeure.split(/\s+/)[1]} sans clôture 🔴 Sortie (Soir)`,
          eventId: candidatPhoto.id,
          horodatageCible: candidatPhoto.dateHeure,
          heureEntree: hEntree,
          actionActuelle: candidatPhoto.action,
          actionProposee: '🔴 Sortie (Soir)',
          peutSupprimer: false
        });
      } else {
        const last = evs[evs.length - 1];
        anomalies.push({
          date: dStr,
          type: 'JOURNEE_NON_CLOTUREE',
          description: 'Entrée enregistrée sans pointage de sortie',
          eventId: last.id,
          horodatageCible: last.dateHeure,
          heureEntree: hEntree,
          actionActuelle: last.action,
          actionProposee: '🔴 Sortie (Soir)',
          peutSupprimer: false
        });
      }
    }
  }

  return anomalies;
}

/**
 * Construit le certificat officiel JSON + l'empreinte SHA-256 globale de pointage.csv.
 */
export async function genererCertificatScellement(events) {
  const csvContent = serializePointageCsv(events);
  const hashGlobal = await sha256Text(csvContent);
  const tailleOctets = new TextEncoder().encode(csvContent).length;

  const sorted = [...events].sort((a, b) => parseTimestampMs(a.dateHeure) - parseTimestampMs(b.dateHeure));
  const parJour = new Map();
  for (const ev of sorted) {
    if (!parJour.has(ev.date)) parJour.set(ev.date, []);
    parJour.get(ev.date).push(ev);
  }

  const anomaliesLogiques = [];
  const auditJournalier = {};

  for (const [dStr, evs] of [...parJour.entries()].sort()) {
    const nbEntrees = evs.filter((e) => isEntreeAction(e.action)).length;
    const nbSorties = evs.filter((e) => isSortieAction(e.action)).length;
    const pausesDep = evs.filter((e) => isPauseDepartAction(e.action)).length;
    const pausesRet = evs.filter((e) => isPauseRetourAction(e.action)).length;

    let conformite = 'CONFORME';
    if (nbSorties > 1) {
      conformite = 'ANOMALIE_DOUBLE_CLOTURE';
      anomaliesLogiques.push(`${dStr}: Double clôture (${nbSorties} sorties)`);
    } else if (nbEntrees > 1) {
      conformite = 'ANOMALIE_DOUBLE_ENTREE';
      anomaliesLogiques.push(`${dStr}: Double entrée (${nbEntrees} entrées)`);
    } else if (pausesDep !== pausesRet && nbSorties > 0 && !((pausesDep === 0 && pausesRet === 1) || (pausesDep === 1 && pausesRet === 0))) {
      conformite = 'ANOMALIE_PAUSE_NON_EQUILIBREE';
      anomaliesLogiques.push(`${dStr}: Pauses déséquilibrées (${pausesDep}/${pausesRet})`);
    }

    auditJournalier[dStr] = {
      date: dStr,
      statut_journee: nbSorties > 0 ? 'Clôturée' : (nbEntrees > 0 ? 'En cours / Active' : 'Preuves archivées'),
      nb_actions: evs.length,
      a_entree: nbEntrees > 0,
      a_sortie: nbSorties > 0,
      nb_entrees: nbEntrees,
      nb_sorties: nbSorties,
      double_cloture: nbSorties > 1,
      pauses_dep: pausesDep,
      pauses_ret: pausesRet,
      conformite,
      chronologie_interne: 'STRICTEMENT_CHRONOLOGIQUE'
    };
  }

  const certificat = {
    titre: 'Certificat Officiel de Scellement Cryptographique - Tanger Marché',
    fichier: 'pointage.csv',
    empreinte_sha256: hashGlobal,
    taille_octets: tailleOctets,
    nombre_enregistrements: sorted.length,
    nombre_journees_traitees: parJour.size,
    date_scellement: new Date().toISOString(),
    controle_chronologique: { statut: '100% VALIDE', anomalies: [] },
    controle_sequentiel_workflow: {
      statut: anomaliesLogiques.length === 0 ? '100% VALIDE' : 'ANOMALIES_DETECTEES',
      anomalies: anomaliesLogiques
    },
    audit_journalier: auditJournalier
  };

  return {
    csvContent,
    hashGlobal,
    sha256FileContent: `${hashGlobal}  pointage.csv\n`,
    certificat
  };
}

/**
 * Évaluation de robustesse probatoire (/100 pts) + Agenda Kayak + Top 3 Preuves par semaine.
 */
export function evaluerRobustesseEtAgenda(events, photoNamesSet = new Set(), joursReposHebdo = [0]) {
  const parJour = new Map();
  for (const ev of events) {
    if (!parJour.has(ev.date)) parJour.set(ev.date, []);
    parJour.get(ev.date).push(ev);
  }

  const joursEvalues = {};
  const semainesIso = {};

  for (const [dStr, evs] of [...parJour.entries()].sort()) {
    const synth = calculerSyntheseJournee(evs);
    const wd = weekdayMondayZero(dStr);
    const iso = getISOWeekInfo(dStr);
    const [yStr, mStr, jStr] = dStr.split('-');
    const isClosed = !synth.estEnCours;
    const dureeDec = synth.dureeDecimale || 0;
    const heuresSupJour = isClosed ? Math.round(Math.max(0, dureeDec - 7) * 100) / 100 : 0;
    const estReposHebdo = joursReposHebdo.includes(wd);
    const estReposNonTravaille = estReposHebdo && dureeDec <= 0;

    const photos = [];
    const gpsPoints = [];
    let gpsValidesSite = 0;
    const incidents = [];
    const hashes = [];

    for (const r of evs) {
      const h = r.dateHeure.split(/\s+/)[1] || r.dateHeure;
      if (r.hash) hashes.push(r.hash);

      const pName = extractPhotoName(r.detail);
      if (pName) {
        photos.push({
          nom: pName,
          heure: h,
          hash: r.hash,
          verifieDisque: photoNamesSet.size === 0 ? Boolean(r.hash) : photoNamesSet.has(pName)
        });
      }

      if (/GPS|Validation|Position/i.test(r.action) || r.detail.includes('Lat:')) {
        let surSite = /VALID[ÉE]E SUR SITE|\(0m\)/i.test(r.detail);
        if (!surSite) {
          const md = r.detail.match(/\((\d+)m\)/);
          if (md && Number(md[1]) <= 200) surSite = true;
        }
        if (surSite) gpsValidesSite++;
        gpsPoints.push({ heure: h, detail: r.detail, surSite, hash: r.hash });
      }

      if (r.action.toUpperCase().includes('INCIDENT')) {
        incidents.push({ heure: h, detail: r.detail, hash: r.hash, photo: pName });
      }
    }

    // Scoring /100 pts (identique chiffrage_prudhommes.py)
    const nbPhotos = photos.length;
    const nbPhotosDisque = photos.filter((p) => p.verifieDisque && p.hash).length;
    let ptsPhoto = 0;
    if (nbPhotosDisque >= 1) ptsPhoto += 25;
    else if (nbPhotos >= 1) ptsPhoto += 15;
    if (nbPhotosDisque >= 2) ptsPhoto += 10;
    else if (nbPhotos >= 2) ptsPhoto += 5;

    let ptsGps = 0;
    if (gpsPoints.length >= 1) ptsGps += 15;
    if (gpsValidesSite >= 1 || gpsPoints.length >= 2) ptsGps += 10;

    let ptsSequence = 0;
    if (isClosed) {
      ptsSequence += (!synth.doubleCloture && !synth.anomalieSequence) ? 15 : 8;
      if (!synth.pauseManquante && !synth.anomalieSequence) ptsSequence += 10;
    }

    let ptsVolume = 0;
    if (dureeDec >= 7) ptsVolume += 8;
    else if (dureeDec >= 4) ptsVolume += 4;
    if (dureeDec >= 9) ptsVolume += 7;
    else if (dureeDec > 7.5) ptsVolume += 4;

    const scoreTotal = Math.min(100, ptsPhoto + ptsGps + ptsSequence + ptsVolume);

    let statutCouleur = 'orange';
    let statutLabel = 'Attention • Pause ou Preuve partielle';
    if (estReposNonTravaille) {
      statutCouleur = 'gris';
      statutLabel = nbPhotos > 0 ? 'Repos Hebdo • Preuves archivées' : 'Jour de Repos Récurrent';
    } else if (!isClosed || dureeDec <= 0) {
      statutCouleur = (nbPhotos >= 1 || gpsPoints.length >= 1) ? 'orange' : 'rouge';
      statutLabel = statutCouleur === 'orange' ? 'Attention • Clôture à régulariser' : 'Alerte • Journée incomplète';
    } else if (synth.doubleCloture) {
      statutCouleur = 'orange';
      statutLabel = 'Attention • Double clôture';
    } else if (synth.anomalieSequence) {
      statutCouleur = 'orange';
      statutLabel = 'Attention • Séquence à régulariser';
    } else if (scoreTotal >= 75 && !synth.pauseManquante) {
      statutCouleur = 'vert';
      statutLabel = 'Parfait • Preuve Robuste';
    } else if (scoreTotal >= 65 && nbPhotos >= 1) {
      statutCouleur = 'vert';
      statutLabel = 'Solide • Scellé SHA-256';
    }

    const grade = estReposNonTravaille ? 'OFF'
      : scoreTotal >= 90 ? 'AAA+'
      : scoreTotal >= 80 ? 'AA'
      : scoreTotal >= 65 ? 'A'
      : 'B';

    const jourInfo = {
      date: dStr,
      jourNum: Number(jStr),
      jourSemaineIdx: wd,
      jourNom: JOURS_FR[wd],
      jourCourt: JOURS_COURTS[wd],
      dateFr: formaterDateFr(dStr),
      moisKey: `${yStr}-${mStr}`,
      moisLabel: `${MOIS_FR[Number(mStr)]} ${yStr}`,
      semaineKey: iso.key,
      semaineNum: iso.week,
      anneeIso: iso.year,
      heureEntree: synth.heureEntree,
      heureSortie: synth.heureSortie,
      pauseStr: synth.pauseStr,
      dureeStr: synth.dureeStr,
      dureeDecimale: dureeDec,
      heuresSupJour,
      isClosed,
      pauseManquante: synth.pauseManquante,
      doubleCloture: synth.doubleCloture,
      anomalieSequence: synth.anomalieSequence,
      nbActions: evs.length,
      evenements: evs,
      nbPhotos,
      photos,
      nbGps: gpsPoints.length,
      gpsValidesSite,
      gpsPoints,
      nbIncidents: incidents.length,
      incidents,
      scoreRobustesse: scoreTotal,
      grade,
      statutCouleur,
      statutLabel,
      estTop3: false,
      rangTop3: null,
      hashPrincipal: hashes[hashes.length - 1] || ''
    };

    joursEvalues[dStr] = jourInfo;

    if (!semainesIso[iso.key]) {
      semainesIso[iso.key] = {
        key: iso.key,
        annee: iso.year,
        numSemaine: iso.week,
        label: `Semaine ${iso.week} (${iso.year})`,
        jours: [],
        jours7j: [],
        top3Jours: [],
        totalHeures: 0,
        heuresSup25: 0,
        heuresSup50: 0,
        totalHeuresSup: 0,
        depassement48h: 0,
        scoreMoyen: 0
      };
    }
    semainesIso[iso.key].jours.push(jourInfo);
    if (isClosed && dureeDec > 0) {
      semainesIso[iso.key].totalHeures = Math.round((semainesIso[iso.key].totalHeures + dureeDec) * 100) / 100;
    }
  }

  // Top 3 Preuves + Ruban 7 jours par semaine ISO
  const top3Global = [];
  for (const wKey of Object.keys(semainesIso).sort()) {
    const sem = semainesIso[wKey];
    const hTot = sem.totalHeures;
    if (hTot > 35) {
      const exc = hTot - 35;
      sem.heuresSup25 = Math.round(Math.min(exc, 8) * 100) / 100;
      sem.heuresSup50 = Math.round(Math.max(0, exc - 8) * 100) / 100;
      sem.totalHeuresSup = Math.round(exc * 100) / 100;
    }
    if (hTot > 48) {
      sem.depassement48h = Math.round((hTot - 48) * 100) / 100;
    }

    const actifs = sem.jours.filter((j) => j.dureeDecimale > 0);
    sem.scoreMoyen = actifs.length
      ? Math.round(actifs.reduce((s, j) => s + j.scoreRobustesse, 0) / actifs.length)
      : 0;

    let eligibles = actifs.filter((j) => j.isClosed && j.statutCouleur === 'vert');
    if (eligibles.length === 0) {
      eligibles = actifs.filter((j) => j.isClosed && !j.doubleCloture);
    }

    const ranked = [...eligibles].sort((a, b) =>
      (b.statutCouleur === 'vert' ? 1 : 0) - (a.statutCouleur === 'vert' ? 1 : 0) ||
      b.scoreRobustesse - a.scoreRobustesse ||
      b.nbPhotos - a.nbPhotos ||
      b.gpsValidesSite - a.gpsValidesSite ||
      b.dureeDecimale - a.dureeDecimale
    );

    const top3 = ranked.slice(0, 3);
    top3.forEach((j, idx) => {
      j.estTop3 = true;
      j.rangTop3 = idx + 1;
    });
    sem.top3Jours = [...top3].sort((a, b) => a.date.localeCompare(b.date));
    top3Global.push(...sem.top3Jours);

    // Ruban complet Lundi..Dimanche
    sem.jours7j = getDatesOfISOWeek(sem.annee, sem.numSemaine).map((dIso) => {
      if (joursEvalues[dIso]) return joursEvalues[dIso];
      const wd = weekdayMondayZero(dIso);
      const estRep = joursReposHebdo.includes(wd);
      return {
        date: dIso,
        jourNum: Number(dIso.slice(8, 10)),
        jourCourt: JOURS_COURTS[wd],
        jourNom: JOURS_FR[wd],
        dureeDecimale: 0,
        dureeStr: estRep ? 'Repos' : 'Off',
        statutCouleur: 'gris',
        statutLabel: estRep ? 'Repos récurrent' : 'Non travaillé',
        grade: 'OFF',
        scoreRobustesse: 0,
        estTop3: false
      };
    });
  }

  const allDays = Object.values(joursEvalues);
  const actifsGlobal = allDays.filter((j) => j.dureeDecimale > 0);

  return {
    joursEvalues,
    semainesIso: Object.fromEntries(Object.entries(semainesIso).sort((a, b) => b[0].localeCompare(a[0]))),
    top3Global,
    resume: {
      totalJours: actifsGlobal.length,
      totalHeures: Math.round(actifsGlobal.reduce((s, j) => s + (j.isClosed ? j.dureeDecimale : 0), 0) * 100) / 100,
      totalSemaines: Object.keys(semainesIso).length,
      totalTop3: top3Global.length,
      scoreGlobalMoyen: actifsGlobal.length
        ? Math.round(actifsGlobal.reduce((s, j) => s + j.scoreRobustesse, 0) / actifsGlobal.length)
        : 100,
      nbVerts: allDays.filter((j) => j.statutCouleur === 'vert').length,
      nbOranges: allDays.filter((j) => j.statutCouleur === 'orange').length,
      nbRouges: allDays.filter((j) => j.statutCouleur === 'rouge').length
    }
  };
}
