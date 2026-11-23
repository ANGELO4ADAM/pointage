/**
 * Moteur de synchronisation bidirectionnelle vers Google Drive (15 Go gratuits)
 * via Google Apps Script (script.google.com — 0 EUR, sans Google Cloud Console).
 */

import {
  getAllEvents,
  getAllPhotosMeta,
  getSettings,
  putEvent,
  putManyEvents,
  putPhoto,
  getPhotoNamesSet
} from './db.js';
import { genererCertificatScellement } from './audit.js';
import { parsePointageCsv } from './csv_io.js';
import { base64ToBlob, blobToBase64, isOnlineNow } from './native.js';

async function postToDriveScript(scriptUrl, payload) {
  // text/plain évite le preflight CORS sur Apps Script tout en transportant du JSON pur
  const resp = await fetch(scriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Réponse Google Drive inattendue (HTTP ${resp.status}). Vérifiez le déploiement du script.`);
  }
  if (!json.ok) {
    throw new Error(json.error || 'Échec de synchronisation Google Drive.');
  }
  return json;
}

/**
 * Teste la connexion avec le script Google Apps Script.
 */
export async function testerConnexionDrive(scriptUrl, secretToken) {
  if (!scriptUrl || !secretToken) {
    throw new Error('Renseignez l’URL du script Google Drive et votre clé secrète.');
  }
  return postToDriveScript(scriptUrl.trim(), {
    action: 'ping',
    token: secretToken.trim()
  });
}

/**
 * Synchronise (Push) vers Google Drive :
 * 1. Toutes les photos locales non encore envoyées (chacune vérifiée SHA-256)
 * 2. Le registre complet pointage.csv + scellement_global.sha256 + certificat_scellement.json
 * 3. Marque les événements et photos comme synchronisés avec l'horodatage serveur Google.
 */
export async function synchroniserVersGoogleDrive(onProgress = () => {}) {
  const online = await isOnlineNow();
  if (!online) {
    return { ok: false, offline: true, message: 'Mode hors-ligne : la synchro reprendra automatiquement dès le retour du réseau.' };
  }

  const settings = await getSettings();
  const scriptUrl = (settings.driveScriptUrl || '').trim();
  const token = (settings.driveSecretToken || '').trim();
  if (!scriptUrl || !token) {
    return { ok: false, unconfigured: true, message: 'Google Drive non configuré (allez dans Exports & Sync).' };
  }

  const [events, photos] = await Promise.all([getAllEvents(), getAllPhotosMeta()]);
  const pendingPhotos = photos.filter((p) => !p.synced && p.blob);

  let photosEnvoyees = 0;
  for (let i = 0; i < pendingPhotos.length; i++) {
    const ph = pendingPhotos[i];
    onProgress(`Envoi photo ${i + 1}/${pendingPhotos.length} (${ph.name})...`);
    const base64 = await blobToBase64(ph.blob);
    const res = await postToDriveScript(scriptUrl, {
      action: 'upload_photo',
      token,
      filename: ph.name,
      sha256: ph.hash || '',
      mimeType: ph.blob.type || 'image/jpeg',
      base64Data: base64
    });
    await putPhoto({
      ...ph,
      synced: true,
      driveFileId: res.fileId || ph.driveFileId || '',
      driveServerTime: res.serverTimestamp || new Date().toISOString()
    });
    photosEnvoyees++;
  }

  onProgress('Scellement SHA-256 et envoi du registre pointage.csv...');
  const { csvContent, hashGlobal, sha256FileContent, certificat } = await genererCertificatScellement(events);

  const resCsv = await postToDriveScript(scriptUrl, {
    action: 'sync_registry',
    token,
    csvContent,
    sha256Content: sha256FileContent,
    certificatJson: JSON.stringify(certificat, null, 2),
    hashGlobal
  });

  // Marquer tous les événements locaux comme synchronisés avec horodatage serveur Google
  const unsyncedEvents = events.filter((e) => !e.synced);
  for (const ev of unsyncedEvents) {
    await putEvent({
      ...ev,
      synced: true,
      driveServerTime: resCsv.serverTimestamp || new Date().toISOString()
    });
  }

  return {
    ok: true,
    photosEnvoyees,
    eventsSynchronises: unsyncedEvents.length,
    totalEvents: events.length,
    hashGlobal,
    serverTimestamp: resCsv.serverTimestamp,
    folderUrl: resCsv.folderUrl || ''
  };
}

/**
 * Restaure (Pull) l'intégralité du registre pointage.csv et les photos manquantes depuis Google Drive
 * (idéal lors d'un changement de téléphone).
 */
export async function restaurerDepuisGoogleDrive(onProgress = () => {}, inclurePhotos = true) {
  const online = await isOnlineNow();
  if (!online) throw new Error('Connexion Internet requise pour restaurer depuis Google Drive.');

  const settings = await getSettings();
  const scriptUrl = (settings.driveScriptUrl || '').trim();
  const token = (settings.driveSecretToken || '').trim();
  if (!scriptUrl || !token) throw new Error('Configurez d’abord votre lien Google Drive.');

  onProgress('Téléchargement du registre pointage.csv depuis Google Drive...');
  const res = await postToDriveScript(scriptUrl, {
    action: 'restore_registry',
    token
  });

  const importedEvents = parsePointageCsv(res.csvContent || '');
  if (importedEvents.length > 0) {
    await putManyEvents(importedEvents.map((e) => ({ ...e, synced: true })));
  }

  let photosRestaurees = 0;
  if (inclurePhotos && Array.isArray(res.photoFiles) && res.photoFiles.length > 0) {
    const existantes = await getPhotoNamesSet();
    const manquantes = res.photoFiles.filter((f) => !existantes.has(f.name));

    for (let i = 0; i < manquantes.length; i++) {
      const f = manquantes[i];
      onProgress(`Restauration photo ${i + 1}/${manquantes.length} (${f.name})...`);
      try {
        const dl = await postToDriveScript(scriptUrl, {
          action: 'download_photo',
          token,
          fileId: f.id
        });
        if (dl.base64Data) {
          const blob = base64ToBlob(dl.base64Data, dl.mimeType || 'image/jpeg');
          await putPhoto({
            name: f.name,
            blob,
            hash: dl.sha256 || '',
            size: blob.size,
            synced: true,
            driveFileId: f.id
          });
          photosRestaurees++;
        }
      } catch {
        // Poursuivre même si une photo individuelle échoue
      }
    }
  }

  return {
    ok: true,
    eventsRestaures: importedEvents.length,
    photosRestaurees
  };
}
