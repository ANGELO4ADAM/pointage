/**
 * Contrôleur principal de l'application Android Pointage Prud'hommes (Local-First + Google Drive).
 */

import {
  ACTIONS,
  JOURS_COURTS,
  SALARIE_ID,
  SALARIE_NOM,
  calculerDistanceMetres,
  formaterDateFr,
  nowParisISO,
  todayParisDate
} from './modules/constants.js';
import {
  calculerHashChaine,
  genererTokenSecret256,
  hasherPinLocal,
  sha256Blob,
  sha256Text,
  verifierPinLocal
} from './modules/crypto.js';
import {
  deleteEventById,
  deleteEventsByDate,
  getAllEvents,
  getPendingSyncCounts,
  getPhoto,
  getPhotoNamesSet,
  getSettings,
  hasHashInEvents,
  putEvent,
  putManyEvents,
  putPhoto,
  saveSettings
} from './modules/db.js';
import {
  detecterAnomalies,
  evaluerRobustesseEtAgenda,
  genererCertificatScellement,
  obtenirEtatJournee
} from './modules/audit.js';
import { auditerEtChiffrerCreances } from './modules/chiffrage.js';
import { parsePointageCsv, serializePointageCsv } from './modules/csv_io.js';
import {
  capturerPhotoNative,
  extraireDateExifBlob,
  extraireDateNomFichier,
  isNativePlatform,
  isOnlineNow,
  obtenirPositionGPS,
  onNetworkReconnect,
  partagerOuTelechargerBlob
} from './modules/native.js';
import {
  restaurerDepuisGoogleDrive,
  synchroniserVersGoogleDrive,
  testerConnexionDrive
} from './modules/drive_sync.js';
import {
  buildChiffragePdfBlob,
  buildRapportPointagePdfBlob,
  buildTop3PdfBlob,
  exporterKitAvocatZip,
  exporterPdfDirect
} from './modules/exports.js';

// --- ÉTAT EN MÉMOIRE DE L'INTERFACE ---
let currentEvents = [];
let currentSettings = null;
let currentPhotoNames = new Set();
let pendingPhoto = null; // { blob, exifDate, hash, previewUrl }
let activeMotifMode = null; // 'INCIDENT' | 'OBSERVATION'
let filterTop3Only = false;
let modalSelectedDate = null;
let actionLock = false;

const $ = (id) => document.getElementById(id);

function showToast(message, type = 'success', durationMs = 4000) {
  const el = $('toastBanner');
  el.textContent = message;
  el.className = `toast ${type === 'error' ? 'error' : type === 'info' ? 'info' : ''}`;
  el.classList.remove('hidden');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => el.classList.add('hidden'), durationMs);
}

function setPendingPhoto(photoObj) {
  if (pendingPhoto?.previewUrl) {
    URL.revokeObjectURL(pendingPhoto.previewUrl);
  }
  pendingPhoto = photoObj;
  const wrap = $('photoPreviewWrap');
  if (!photoObj) {
    wrap.classList.add('hidden');
    return;
  }
  $('photoPreviewImg').src = photoObj.previewUrl;
  $('photoPreviewInfo').innerHTML = `<strong>Photo prête</strong><br>SHA-256 : <code>${photoObj.hash.slice(0, 14)}...</code>${photoObj.exifDate ? `<br>EXIF : ${photoObj.exifDate}` : ''}`;
  wrap.classList.remove('hidden');
}

async function preparePhotoFromBlob(blob) {
  const hash = await sha256Blob(blob);
  const exifDate = await extraireDateExifBlob(blob);
  const previewUrl = URL.createObjectURL(blob);
  setPendingPhoto({ blob, hash, exifDate, previewUrl });
}

// --- ENREGISTREMENT & SCELLEMENT D'UN POINTAGE ---
async function enregistrerPointage(actionLabel, { motif = '', requirePhoto = false, forceGps = true } = {}) {
  if (actionLock) return;
  if (requirePhoto && !pendingPhoto) {
    showToast('Veuillez d’abord prendre ou choisir une photo justificative.', 'error');
    return;
  }

  actionLock = true;
  try {
    showToast('⏳ Géolocalisation & scellement SHA-256...', 'info', 8000);

    // 1. Horodatage (EXIF photo si présent lors d'une photo seule, sinon heure Paris courante)
    const nowStr = nowParisISO();
    const horodatage = nowStr;
    const dateJour = horodatage.slice(0, 10);

    // 2. Anti-doublon photo SHA-256
    let nomPhoto = '';
    let hashPhoto = '';
    if (pendingPhoto) {
      const isDup = await hasHashInEvents(pendingPhoto.hash);
      if (isDup) {
        showToast('⚠️ Doublon détecté : cette photo est déjà scellée dans le registre.', 'error');
        setPendingPhoto(null);
        return;
      }
      const [dPart, tPart] = horodatage.split(' ');
      const [hh, mm, ss] = tPart.split(':');
      nomPhoto = `ticket_preuve_${dPart}_${hh}h${mm}m${ss}s.jpg`;
      hashPhoto = pendingPhoto.hash;

      await putPhoto({
        name: nomPhoto,
        blob: pendingPhoto.blob,
        hash: hashPhoto,
        date: dateJour,
        exifDate: pendingPhoto.exifDate || '',
        size: pendingPhoto.blob.size,
        synced: false
      });
    }

    // 3. Géolocalisation & Géofencing Haversine (200 m)
    let gpsSegment = '';
    if (forceGps) {
      const gps = await obtenirPositionGPS(7000);
      if (gps) {
        const distM = calculerDistanceMetres(
          gps.lat,
          gps.lon,
          currentSettings.gpsLat,
          currentSettings.gpsLon
        );
        const surSite = distM <= currentSettings.gpsRayon;
        const statutSite = surSite
          ? '✅ PRÉSENCE VALIDÉE SUR SITE'
          : (actionLabel === ACTIONS.GPS ? '❌ HORS SITE' : '📍 Position GPS');
        gpsSegment = `${statutSite} (${distM}m) - Lat: ${gps.lat.toFixed(6)}, Lon: ${gps.lon.toFixed(6)}`;
      } else if (actionLabel === ACTIONS.GPS) {
        showToast('Impossible de capter le GPS. Activez la localisation sur votre téléphone.', 'error');
        return;
      }
    }

    // 4. Construction du détail compatible pointage.csv
    const userTag = `Utilisateur: ${currentSettings.salarieNom || SALARIE_NOM} (ID: ${SALARIE_ID} - Android)`;
    const motifClean = String(motif || '').replace(/;/g, ',').replace(/\r?\n/g, ' ').trim();
    let detail = '';

    if (actionLabel === ACTIONS.INCIDENT) {
      const parts = [];
      if (nomPhoto) parts.push(`Fichier: ${nomPhoto}`);
      parts.push(`Motif: ${motifClean || 'Incident constaté sur site'}`);
      if (gpsSegment) parts.push(gpsSegment);
      parts.push(userTag);
      detail = parts.join(' - ');
    } else if (actionLabel === ACTIONS.OBSERVATION) {
      const parts = [motifClean || 'Observation factuelle'];
      if (nomPhoto) parts.push(nomPhoto);
      if (gpsSegment) parts.push(gpsSegment);
      parts.push(userTag);
      detail = parts.join(' - ');
    } else {
      const parts = [];
      if (nomPhoto) parts.push(nomPhoto);
      if (gpsSegment) parts.push(gpsSegment);
      if (parts.length === 0) parts.push('Pointage Mobile Autonome');
      parts.push(userTag);
      detail = parts.join(' - ');
    }

    // 5. Calcul SHA-256 (empreinte photo ou texte) + chaînage cryptographique
    const prevHash = currentEvents.length > 0 ? currentEvents[currentEvents.length - 1].hash : 'GENESIS';
    let hashPreuve = hashPhoto;
    if (!hashPreuve || actionLabel === ACTIONS.INCIDENT || actionLabel === ACTIONS.OBSERVATION) {
      hashPreuve = await sha256Text(`${horodatage}|${actionLabel}|${detail}|${hashPhoto}`);
    }
    const chainHash = await calculerHashChaine(prevHash, horodatage, actionLabel, detail, hashPreuve);

    const newEvent = {
      id: `${horodatage}__${actionLabel}__${hashPreuve.slice(0, 12)}`,
      dateHeure: horodatage,
      date: dateJour,
      action: actionLabel,
      detail,
      hash: hashPreuve,
      chainHash,
      photoName: nomPhoto || null,
      synced: false,
      source: 'android_local'
    };

    await putEvent(newEvent);
    setPendingPhoto(null);
    activeMotifMode = null;
    $('motifDrawer').classList.add('hidden');
    $('motifInput').value = '';

    await refreshAll();
    showToast(`✅ ${actionLabel} scellé à ${horodatage.slice(11)} !`, 'success');

    // 6. Auto-synchronisation silencieuse vers Google Drive si configuré et en ligne
    if (currentSettings.autoSyncDrive && currentSettings.driveScriptUrl && currentSettings.driveSecretToken) {
      synchroniserVersGoogleDrive().then(async (res) => {
        if (res.ok) {
          await refreshAll();
          showToast('☁️ Synchronisé sur votre Google Drive !', 'success', 2500);
        }
      }).catch(() => {});
    }
  } catch (err) {
    showToast(`Erreur : ${err.message || err}`, 'error', 5000);
  } finally {
    actionLock = false;
  }
}

// --- RAFRAÎCHISSEMENT DE TOUTE L'INTERFACE ---
async function refreshAll() {
  [currentEvents, currentSettings, currentPhotoNames] = await Promise.all([
    getAllEvents(),
    getSettings(),
    getPhotoNamesSet()
  ]);

  await renderSyncHeader();
  renderPointerTab();
  renderAgendaTab();
  renderChiffrageTab();
  await renderSyncTab();
}

async function renderSyncHeader() {
  const counts = await getPendingSyncCounts();
  const online = await isOnlineNow();
  const dot = $('syncDot');
  const txt = $('syncPillText');

  if (!online) {
    dot.className = 'dot offline';
    txt.textContent = `Hors-ligne (${counts.pendingEvents + counts.pendingPhotos})`;
  } else if (!currentSettings.driveScriptUrl) {
    dot.className = 'dot';
    txt.textContent = 'Local';
  } else if (counts.pendingEvents + counts.pendingPhotos > 0) {
    dot.className = 'dot pending';
    txt.textContent = `À sync (${counts.pendingEvents + counts.pendingPhotos})`;
  } else {
    dot.className = 'dot online';
    txt.textContent = 'Drive OK';
  }

  $('syncQueueBadge').textContent = `${counts.pendingEvents} ptg · ${counts.pendingPhotos} ph en attente`;
}

function renderPointerTab() {
  const today = todayParisDate();
  const etat = obtenirEtatJournee(currentEvents, today);
  const hourNow = Number(nowParisISO().slice(11, 13));

  $('todayDateBadge').textContent = formaterDateFr(today);
  const stBadge = $('todayStateBadge');
  stBadge.textContent = etat.estCloturee ? 'Clôturée' : (etat.aEntree ? 'En service' : 'Non démarrée');
  stBadge.className = `badge ${etat.estCloturee ? 'badge-ok' : (etat.aEntree ? 'badge-warn' : 'badge-info')}`;
  $('todayStatusLabel').textContent = etat.statutLabel;

  const btnMain = $('btnPrimaryAction');
  const btnSortieSec = $('btnSecondarySortie');
  btnSortieSec.classList.add('hidden');

  btnMain.className = 'btn btn-primary-big mt-12';
  if (etat.estCloturee) {
    btnMain.textContent = '🔒 Journée Clôturée';
    btnMain.classList.add('state-closed');
    btnMain.disabled = true;
  } else {
    btnMain.disabled = false;
    btnMain.textContent = etat.prochaineAction;
    if (etat.prochaineAction.includes('Pause')) {
      btnMain.classList.add('state-pause');
      if (hourNow >= 16) btnSortieSec.classList.remove('hidden');
    } else if (etat.prochaineAction.includes('Sortie')) {
      btnMain.classList.add('state-sortie');
    }
  }

  // Anomalies proactives
  const anomalies = detecterAnomalies(currentEvents, currentSettings.joursReposHebdo);
  const anoBox = $('anomaliesBox');
  if (anomalies.length === 0) {
    anoBox.classList.add('hidden');
  } else {
    anoBox.classList.remove('hidden');
    anoBox.innerHTML = `
      <div class="card-header">
        <h3>⚠️ ${anomalies.length} anomalie(s) détectée(s)</h3>
        <span class="badge badge-warn">Correction 1 clic</span>
      </div>
      <div class="stack-sm mt-8">
        ${anomalies.map((a) => `
          <div class="timeline-item">
            <div class="timeline-top">
              <span class="badge badge-warn">${a.date}</span>
              <span class="small">${a.description}</span>
            </div>
            <div class="row-2 mt-8">
              <button type="button" class="btn btn-sm btn-emerald" data-fix-id="${a.eventId}" data-fix-action="${a.actionProposee}">
                ⚡ Reclasser en ${a.actionProposee}
              </button>
              ${a.peutSupprimer ? `<button type="button" class="btn btn-sm btn-outline-danger" data-del-id="${a.eventId}">🗑️ Supprimer doublon</button>` : '<span></span>'}
            </div>
          </div>
        `).join('')}
      </div>
    `;

    anoBox.querySelectorAll('[data-fix-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ev = currentEvents.find((e) => e.id === btn.dataset.fixId);
        if (!ev) return;
        await putEvent({ ...ev, action: btn.dataset.fixAction, synced: false });
        await refreshAll();
        showToast('✅ Anomalie régularisée et rescellée SHA-256.', 'success');
      });
    });
    anoBox.querySelectorAll('[data-del-id]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await deleteEventById(btn.dataset.delId);
        await refreshAll();
        showToast('🗑️ Doublon supprimé et registre rescellé.', 'success');
      });
    });
  }

  // Liste du jour
  const todayEvs = currentEvents.filter((e) => e.date === today);
  const listEl = $('todayEventsList');
  if (todayEvs.length === 0) {
    listEl.innerHTML = '<div class="small muted text-center">Aucun pointage enregistré aujourd’hui.</div>';
  } else {
    listEl.innerHTML = [...todayEvs].reverse().map((ev) => `
      <div class="timeline-item">
        <div class="timeline-top">
          <span class="timeline-hour">${ev.dateHeure.slice(11)}</span>
          <span class="timeline-action">${ev.action}</span>
          <span class="badge ${ev.synced ? 'badge-ok' : 'badge-warn'}">${ev.synced ? '☁️' : '📱 Local'}</span>
        </div>
        <div class="timeline-detail">${ev.detail}</div>
        <div class="timeline-hash">🔐 ${ev.hash ? ev.hash.slice(0, 28) + '...' : 'N/A'}</div>
      </div>
    `).join('');
  }
}

function renderAgendaTab() {
  const audit = evaluerRobustesseEtAgenda(currentEvents, currentPhotoNames, currentSettings.joursReposHebdo);
  $('kpiTotalHeures').textContent = `${audit.resume.totalHeures.toFixed(2)} h`;
  $('kpiTotalJours').textContent = String(audit.resume.totalJours);
  $('kpiScoreMoyen').textContent = `${audit.resume.scoreGlobalMoyen}/100`;
  $('kpiTop3').textContent = String(audit.resume.totalTop3);

  $('btnFilterTop3').textContent = filterTop3Only ? '🎯 Top 3 : ACTIF' : '🎯 Top 3 : OFF';

  // Chips jours de repos hebdo
  const chipsEl = $('reposChips');
  chipsEl.innerHTML = JOURS_COURTS.map((lbl, idx) => {
    const active = currentSettings.joursReposHebdo.includes(idx);
    return `<button type="button" class="chip ${active ? 'active' : ''}" data-wd="${idx}">🛌 ${lbl}</button>`;
  }).join('');

  chipsEl.querySelectorAll('[data-wd]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.wd);
      const set = new Set(currentSettings.joursReposHebdo);
      if (set.has(idx)) set.delete(idx); else set.add(idx);
      await saveSettings({ joursReposHebdo: [...set].sort((a, b) => a - b) });
      await refreshAll();
    });
  });

  // Rubans hebdomadaires
  const weeksEl = $('weeksContainer');
  const weeks = Object.values(audit.semainesIso);
  if (weeks.length === 0) {
    weeksEl.innerHTML = '<div class="card small muted text-center">Importez votre pointage.csv ou effectuez votre premier pointage pour afficher l’agenda.</div>';
    return;
  }

  weeksEl.innerHTML = weeks.map((sem) => `
    <div class="week-card">
      <div class="week-head">
        <strong>${sem.label}</strong>
        <span class="badge ${sem.totalHeures > 48 ? 'badge-err' : 'badge-info'}">
          ${sem.totalHeures.toFixed(2)} h ${sem.totalHeuresSup > 0 ? `(+${sem.totalHeuresSup.toFixed(1)}h sup)` : ''}
        </span>
      </div>
      <div class="week-grid">
        ${sem.jours7j.map((j) => {
          const dimmed = filterTop3Only && !j.estTop3 ? 'dimmed' : '';
          const topCls = j.estTop3 ? 'top3' : '';
          return `
            <div class="day-tile ${j.statutCouleur} ${topCls} ${dimmed}" data-open-date="${j.date}">
              <div class="tile-dow">${j.jourCourt}</div>
              <div class="tile-num">${j.jourNum}</div>
              <div class="tile-hrs">${j.dureeDecimale > 0 ? j.dureeDecimale.toFixed(1) + 'h' : j.dureeStr}</div>
              <div class="tile-star">${j.estTop3 ? `★#${j.rangTop3}` : (j.scoreRobustesse ? j.grade : '')}</div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `).join('');

  weeksEl.querySelectorAll('[data-open-date]').forEach((tile) => {
    tile.addEventListener('click', () => openDayModal(tile.dataset.openDate));
  });
}

async function openDayModal(dateStr) {
  const audit = evaluerRobustesseEtAgenda(currentEvents, currentPhotoNames, currentSettings.joursReposHebdo);
  const j = audit.joursEvalues[dateStr];
  if (!j) {
    showToast(`Aucun pointage enregistré le ${dateStr}.`, 'info', 2500);
    return;
  }
  modalSelectedDate = dateStr;
  $('modalDayTitle').textContent = j.dateFr;
  $('modalDaySub').textContent = `${j.statutLabel} • Score ${j.scoreRobustesse}/100 (${j.grade})`;

  $('modalDaySummary').innerHTML = `
    <div class="kpi-card"><div class="kpi-label">Entrée</div><div class="kpi-value small">${j.heureEntree}</div></div>
    <div class="kpi-card"><div class="kpi-label">Sortie</div><div class="kpi-value small">${j.heureSortie}</div></div>
    <div class="kpi-card"><div class="kpi-label">Pause</div><div class="kpi-value small">${j.pauseStr}</div></div>
    <div class="kpi-card"><div class="kpi-label">Net</div><div class="kpi-value small text-sky">${j.dureeDecimale.toFixed(2)} h</div></div>
  `;

  $('modalDayEvents').innerHTML = j.evenements.map((ev) => `
    <div class="timeline-item">
      <div class="timeline-top">
        <span class="timeline-hour">${ev.dateHeure.slice(11)}</span>
        <span class="timeline-action">${ev.action}</span>
      </div>
      <div class="timeline-detail">${ev.detail}</div>
      <div class="timeline-hash">🔐 ${ev.hash || 'N/A'}</div>
    </div>
  `).join('');

  const photosBox = $('modalDayPhotos');
  photosBox.innerHTML = '';
  if (j.photos.length === 0) {
    photosBox.innerHTML = '<div class="small muted">Aucune photo associée.</div>';
  } else {
    for (const ph of j.photos) {
      const rec = await getPhoto(ph.nom);
      const card = document.createElement('div');
      card.className = 'photo-card';
      if (rec?.blob) {
        const url = URL.createObjectURL(rec.blob);
        card.innerHTML = `<img src="${url}" alt="${ph.nom}" /><div class="photo-card-cap">${ph.nom}<br>🔐 ${(ph.hash || '').slice(0, 14)}...</div>`;
      } else {
        card.innerHTML = `<div class="photo-card-cap">📷 ${ph.nom}<br><em>(Non présente localement — importez le dossier photos ou restaurez depuis Drive)</em></div>`;
      }
      photosBox.appendChild(card);
    }
  }

  $('dayModal').classList.remove('hidden');
}

function renderChiffrageTab() {
  $('chifAnnees').value = String(currentSettings.anneesArrieres);
  $('chifSalaire').value = Number(currentSettings.salaireMensuelBrut).toFixed(2);
  $('chifTaux').value = Number(currentSettings.tauxHoraireBrut).toFixed(2);

  const bilan = auditerEtChiffrerCreances(currentEvents, {
    tauxHoraireBrut: currentSettings.tauxHoraireBrut,
    salaireMensuelBrut: currentSettings.salaireMensuelBrut,
    anneesArrieres: currentSettings.anneesArrieres
  });

  $('chifTotalGlobal').textContent = `${bilan.totaux.totalGlobal.toLocaleString('fr-FR', { minimumFractionDigits: 2 })} €`;
  $('chifPeriodeLabel').textContent = bilan.arrieres.libellePeriode;

  $('chifPostesList').innerHTML = bilan.postes.map((p) => `
    <div class="poste-row">
      <div>
        <div class="timeline-action">${p.num}. ${p.titre}</div>
        <div class="small muted">${p.assiette} • ${p.fondement}</div>
      </div>
      <div class="poste-amount">${p.montant.toLocaleString('fr-FR', { minimumFractionDigits: 2 })} €</div>
    </div>
  `).join('');
}

async function renderSyncTab() {
  $('driveUrlInput').value = currentSettings.driveScriptUrl || '';
  $('driveTokenInput').value = currentSettings.driveSecretToken || '';
  $('btnDisablePin').classList.toggle('hidden', !currentSettings.pinHash);

  const { hashGlobal } = await genererCertificatScellement(currentEvents);
  $('globalShaDisplay').textContent = hashGlobal;
}

// --- ÉCOUTEURS D'ÉVÉNEMENTS ---
function bindEvents() {
  // Navigation 4 onglets
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // Caméra / Galerie
  $('btnTakePhoto').addEventListener('click', async () => {
    if (isNativePlatform()) {
      try {
        const res = await capturerPhotoNative('CAMERA');
        if (res?.blob) await preparePhotoFromBlob(res.blob);
      } catch (e) {
        if (!String(e).includes('cancel')) showToast(`Caméra : ${e.message || e}`, 'error');
      }
    } else {
      $('hiddenPhotoInput').click();
    }
  });

  $('btnPickGallery').addEventListener('click', async () => {
    if (isNativePlatform()) {
      try {
        const res = await capturerPhotoNative('PHOTOS');
        if (res?.blob) await preparePhotoFromBlob(res.blob);
      } catch (e) {
        if (!String(e).includes('cancel')) showToast(`Galerie : ${e.message || e}`, 'error');
      }
    } else {
      $('hiddenGalleryInput').click();
    }
  });

  const handleFileInput = async (e) => {
    const file = e.target.files?.[0];
    if (file) await preparePhotoFromBlob(file);
    e.target.value = '';
  };
  $('hiddenPhotoInput').addEventListener('change', handleFileInput);
  $('hiddenGalleryInput').addEventListener('change', handleFileInput);
  $('btnClearPhoto').addEventListener('click', () => setPendingPhoto(null));

  // Bouton principal séquentiel
  $('btnPrimaryAction').addEventListener('click', () => {
    const etat = obtenirEtatJournee(currentEvents, todayParisDate());
    if (etat.estCloturee) return;
    if (etat.prochaineAction === ACTIONS.SORTIE) {
      $('confirmSortieModal').classList.remove('hidden');
    } else {
      enregistrerPointage(etat.prochaineAction);
    }
  });

  $('btnSecondarySortie').addEventListener('click', () => {
    $('confirmSortieModal').classList.remove('hidden');
  });
  $('btnConfirmSortieNo').addEventListener('click', () => $('confirmSortieModal').classList.add('hidden'));
  $('btnConfirmSortieYes').addEventListener('click', () => {
    $('confirmSortieModal').classList.add('hidden');
    enregistrerPointage(ACTIONS.SORTIE);
  });

  // Actions rapides
  $('btnQuickGps').addEventListener('click', () => enregistrerPointage(ACTIONS.GPS, { forceGps: true }));
  $('btnQuickPhoto').addEventListener('click', () => enregistrerPointage(ACTIONS.PHOTO, { requirePhoto: true }));

  $('btnToggleIncident').addEventListener('click', () => {
    activeMotifMode = ACTIONS.INCIDENT;
    $('motifDrawerTitle').textContent = '⚠️ Signaler un Incident (joignez une photo si possible)';
    $('motifDrawer').classList.remove('hidden');
  });
  $('btnToggleNote').addEventListener('click', () => {
    activeMotifMode = ACTIONS.OBSERVATION;
    $('motifDrawerTitle').textContent = '📝 Consigner une Observation factuelle';
    $('motifDrawer').classList.remove('hidden');
  });
  $('btnCancelMotif').addEventListener('click', () => {
    activeMotifMode = null;
    $('motifDrawer').classList.add('hidden');
  });
  $('btnSubmitMotif').addEventListener('click', () => {
    const txt = $('motifInput').value.trim();
    if (!txt) {
      showToast('Veuillez saisir une description factuelle.', 'error');
      return;
    }
    enregistrerPointage(activeMotifMode || ACTIONS.OBSERVATION, { motif: txt });
  });

  // Annuler dernier pointage du jour
  $('btnUndoLast').addEventListener('click', async () => {
    const today = todayParisDate();
    const todayEvs = currentEvents.filter((e) => e.date === today);
    if (todayEvs.length === 0) {
      showToast('Aucun pointage à annuler aujourd’hui.', 'info');
      return;
    }
    const last = todayEvs[todayEvs.length - 1];
    if (!confirm(`Annuler le dernier pointage [${last.action}] de ${last.dateHeure.slice(11)} ?`)) return;
    await deleteEventById(last.id);
    await refreshAll();
    showToast(`↩️ Pointage [${last.action}] annulé.`, 'success');
  });

  // Agenda Top 3 toggle & Modale jour
  $('btnFilterTop3').addEventListener('click', () => {
    filterTop3Only = !filterTop3Only;
    renderAgendaTab();
  });
  $('btnCloseDayModal').addEventListener('click', () => $('dayModal').classList.add('hidden'));
  $('btnModalDayPdf').addEventListener('click', async () => {
    if (!modalSelectedDate) return;
    showToast('Génération du PDF du jour...', 'info');
    const blob = await buildRapportPointagePdfBlob(currentEvents, { dateCible: modalSelectedDate, includePhotos: true });
    await exporterPdfDirect(blob, `Rapport_Pointage_${modalSelectedDate}.pdf`);
  });
  $('btnModalDayDelete').addEventListener('click', async () => {
    if (!modalSelectedDate) return;
    if (!confirm(`Supprimer intégralement tous les pointages du ${modalSelectedDate} ?`)) return;
    const n = await deleteEventsByDate(modalSelectedDate);
    $('dayModal').classList.add('hidden');
    await refreshAll();
    showToast(`🗑️ Journée ${modalSelectedDate} supprimée (${n} enregistrements).`, 'success');
  });

  // Chiffrage live
  $('chifAnnees').addEventListener('change', async (e) => {
    await saveSettings({ anneesArrieres: Number(e.target.value) });
    await refreshAll();
  });
  $('chifSalaire').addEventListener('change', async (e) => {
    const sal = Math.max(0, Number(e.target.value) || 0);
    const taux = Math.round((sal / 151.67) * 100) / 100;
    await saveSettings({ salaireMensuelBrut: sal, tauxHoraireBrut: taux });
    await refreshAll();
  });
  $('chifTaux').addEventListener('change', async (e) => {
    const taux = Math.max(0, Number(e.target.value) || 0);
    const sal = Math.round(taux * 151.67 * 100) / 100;
    await saveSettings({ tauxHoraireBrut: taux, salaireMensuelBrut: sal });
    await refreshAll();
  });
  $('btnExportChiffragePdf').addEventListener('click', async () => {
    showToast('Génération du Bordereau Chiffré PDF...', 'info');
    const blob = await buildChiffragePdfBlob(currentEvents, {
      tauxHoraireBrut: currentSettings.tauxHoraireBrut,
      salaireMensuelBrut: currentSettings.salaireMensuelBrut,
      anneesArrieres: currentSettings.anneesArrieres
    });
    await exporterPdfDirect(blob, `Piece_4_Chiffrage_Prudhommes_${currentSettings.anneesArrieres}ans.pdf`);
  });

  // Google Drive Sync
  $('btnGenToken').addEventListener('click', () => {
    const tok = genererTokenSecret256();
    $('driveTokenInput').value = tok;
    navigator.clipboard?.writeText(tok).catch(() => {});
    showToast('🔑 Clé secrète 256 bits générée (copiez-la dans sync_drive.gs).', 'info', 5000);
  });

  $('btnSaveDriveCfg').addEventListener('click', async () => {
    const url = $('driveUrlInput').value.trim();
    const token = $('driveTokenInput').value.trim();
    await saveSettings({ driveScriptUrl: url, driveSecretToken: token });
    currentSettings = await getSettings();
    try {
      $('syncStatusBox').textContent = 'Test de connexion vers Google Drive...';
      const res = await testerConnexionDrive(url, token);
      $('syncStatusBox').textContent = `✅ Connecté : dossier ${res.folderName} (heure serveur Google : ${res.serverTimestamp})`;
      showToast('✅ Connexion Google Drive validée !', 'success');
      await renderSyncHeader();
    } catch (err) {
      $('syncStatusBox').textContent = `❌ ${err.message}`;
      showToast(`Erreur Drive : ${err.message}`, 'error', 5000);
    }
  });

  const runSync = async () => {
    try {
      const res = await synchroniserVersGoogleDrive((msg) => {
        $('syncStatusBox').textContent = `⏳ ${msg}`;
      });
      if (!res.ok) {
        showToast(res.message, res.offline ? 'info' : 'error');
        $('syncStatusBox').textContent = res.message;
        return;
      }
      await refreshAll();
      const bilan = `✅ Synchronisé sur Google Drive (${res.photosEnvoyees} photo(s), ${res.totalEvents} lignes) — Horodatage Google : ${res.serverTimestamp}`;
      $('syncStatusBox').textContent = bilan;
      showToast('☁️ Synchronisation Google Drive réussie !', 'success');
    } catch (err) {
      $('syncStatusBox').textContent = `❌ ${err.message}`;
      showToast(`Échec synchro : ${err.message}`, 'error', 5000);
    }
  };

  $('btnSyncNow').addEventListener('click', runSync);
  $('btnQuickSync').addEventListener('click', runSync);

  $('btnRestoreDrive').addEventListener('click', async () => {
    if (!confirm('Restaurer le registre pointage.csv et les photos manquantes depuis votre Google Drive ?')) return;
    try {
      const res = await restaurerDepuisGoogleDrive((msg) => {
        $('syncStatusBox').textContent = `⬇️ ${msg}`;
      }, true);
      await refreshAll();
      const msg = `✅ Restauration terminée : ${res.eventsRestaures} pointage(s) et ${res.photosRestaurees} photo(s) récupérés.`;
      $('syncStatusBox').textContent = msg;
      showToast(msg, 'success', 5000);
    } catch (err) {
      $('syncStatusBox').textContent = `❌ ${err.message}`;
      showToast(`Erreur restauration : ${err.message}`, 'error', 5000);
    }
  });

  // Exports PDF / ZIP / CSV
  $('btnExportKitZip').addEventListener('click', async () => {
    try {
      const fname = await exporterKitAvocatZip(currentEvents, currentSettings, (m) => showToast(m, 'info', 4000));
      showToast(`📦 ${fname} généré !`, 'success');
    } catch (err) {
      showToast(`Erreur ZIP : ${err.message}`, 'error');
    }
  });

  $('btnExportRapportPdf').addEventListener('click', async () => {
    showToast('Génération du rapport PDF global...', 'info');
    const blob = await buildRapportPointagePdfBlob(currentEvents, { includePhotos: false });
    await exporterPdfDirect(blob, `Rapport_Prudhommes_${todayParisDate()}.pdf`);
  });

  $('btnExportTop3Pdf').addEventListener('click', async () => {
    showToast('Génération de la synthèse Top 3 PDF...', 'info');
    const blob = await buildTop3PdfBlob(currentEvents, currentSettings.joursReposHebdo);
    await exporterPdfDirect(blob, `Synthese_Top3_Preuves_${todayParisDate()}.pdf`);
  });

  $('btnExportCsvRaw').addEventListener('click', async () => {
    const csv = serializePointageCsv(currentEvents);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    await partagerOuTelechargerBlob(blob, 'pointage.csv', 'text/csv');
  });

  // Import historique existant (CSV + Lot Photos EXIF)
  $('importCsvInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parsePointageCsv(text);
    if (parsed.length === 0) {
      showToast('Aucun enregistrement valide trouvé dans ce CSV.', 'error');
      return;
    }
    await putManyEvents(parsed.map((ev) => ({ ...ev, synced: false })));
    await refreshAll();
    showToast(`🎉 ${parsed.length} enregistrements importés depuis pointage.csv !`, 'success', 5000);
    e.target.value = '';
  });

  $('importPhotosInput').addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])];
    if (files.length === 0) return;
    showToast(`⏳ Analyse EXIF & SHA-256 de ${files.length} photo(s)...`, 'info', 8000);

    let photosStockees = 0;
    let nouveauxPointages = 0;
    const existingPhotoNames = new Set(currentEvents.map((ev) => ev.photoName).filter(Boolean));

    for (const file of files) {
      const hash = await sha256Blob(file);
      const exifDt = await extraireDateExifBlob(file) || extraireDateNomFichier(file.name);
      const cleanName = file.name.startsWith('ticket_preuve_') || file.name.startsWith('timeline_google_')
        ? file.name
        : (exifDt
          ? `ticket_preuve_${exifDt.slice(0, 10)}_${exifDt.slice(11, 13)}h${exifDt.slice(14, 16)}m${exifDt.slice(17, 19)}s.jpg`
          : `ticket_preuve_${Date.now()}_${file.name}`);

      await putPhoto({
        name: cleanName,
        blob: file,
        hash,
        date: exifDt ? exifDt.slice(0, 10) : todayParisDate(),
        exifDate: exifDt || '',
        size: file.size,
        synced: false
      });
      photosStockees++;

      // Si cette photo n'est pas déjà référencée dans pointage.csv et possède une date EXIF, créer le pointage
      const dupHash = await hasHashInEvents(hash);
      if (!dupHash && !existingPhotoNames.has(cleanName) && exifDt) {
        const hInt = Number(exifDt.slice(11, 13));
        const act = hInt < 14 ? ACTIONS.ENTREE : ACTIONS.SORTIE;
        await putEvent({
          id: `${exifDt}__${act}__${hash.slice(0, 12)}`,
          dateHeure: exifDt,
          date: exifDt.slice(0, 10),
          action: act,
          detail: `${cleanName} - Utilisateur: ${currentSettings.salarieNom || SALARIE_NOM} (ID: ${SALARIE_ID} - Import EXIF)`,
          hash,
          photoName: cleanName,
          synced: false,
          source: 'exif_import'
        });
        nouveauxPointages++;
      }
    }

    await refreshAll();
    showToast(`✅ ${photosStockees} photo(s) archivée(s) (${nouveauxPointages} nouveau(x) pointage(s) EXIF).`, 'success', 5000);
    e.target.value = '';
  });

  // Code PIN local (PBKDF2-SHA256)
  $('btnSavePin').addEventListener('click', async () => {
    const pin = $('newPinInput').value.trim();
    if (pin.length < 4) {
      showToast('Le code PIN doit contenir au moins 4 caractères.', 'error');
      return;
    }
    const { hash, salt } = await hasherPinLocal(pin);
    await saveSettings({ pinHash: hash, pinSalt: salt });
    $('newPinInput').value = '';
    await refreshAll();
    showToast('🔐 Code PIN local activé (haché PBKDF2-SHA256).', 'success');
  });

  $('btnDisablePin').addEventListener('click', async () => {
    await saveSettings({ pinHash: '', pinSalt: '' });
    await refreshAll();
    showToast('Code PIN local désactivé.', 'info');
  });

  // Auto-sync à la reconnexion réseau
  onNetworkReconnect(async () => {
    await renderSyncHeader();
    if (currentSettings?.autoSyncDrive && currentSettings?.driveScriptUrl && currentSettings?.driveSecretToken) {
      const counts = await getPendingSyncCounts();
      if (counts.pendingEvents + counts.pendingPhotos > 0) {
        synchroniserVersGoogleDrive().then(() => refreshAll()).catch(() => {});
      }
    }
  });
}

// --- DÉMARRAGE DE L'APPLICATION ---
async function init() {
  bindEvents();
  currentSettings = await getSettings();

  // Horloge temps réel Europe/Paris
  const tickClock = () => {
    $('liveClock').textContent = `${nowParisISO().slice(11)} • Europe/Paris`;
  };
  tickClock();
  setInterval(tickClock, 1000);

  // Vérification PIN local si activé
  if (currentSettings.pinHash && currentSettings.pinSalt) {
    $('pinOverlay').classList.remove('hidden');
    const tryUnlock = async () => {
      const ok = await verifierPinLocal($('pinUnlockInput').value, currentSettings.pinHash, currentSettings.pinSalt);
      if (ok) {
        $('pinOverlay').classList.add('hidden');
        $('pinUnlockError').classList.add('hidden');
        await refreshAll();
      } else {
        $('pinUnlockError').textContent = 'Code PIN incorrect.';
        $('pinUnlockError').classList.remove('hidden');
      }
    };
    $('btnPinUnlock').addEventListener('click', tryUnlock);
    $('pinUnlockInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
  } else {
    await refreshAll();
  }
}

init();
