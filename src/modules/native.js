/**
 * Pont natif unifié Capacitor (Android) + repli transparent Navigateur Web.
 * Gère : Caméra, Lecture EXIF, Géolocalisation GPS, Partage/Export fichier, Réseau.
 */

import { Capacitor } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Geolocation } from '@capacitor/geolocation';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { Network } from '@capacitor/network';
import exifr from 'exifr';
import { nowParisISO } from './constants.js';

export function isNativePlatform() {
  return Capacitor.isNativePlatform();
}

/**
 * Convertit un Blob en base64 pur (sans préfixe data:...)
 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const res = String(reader.result || '');
      const idx = res.indexOf(',');
      resolve(idx >= 0 ? res.slice(idx + 1) : res);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function base64ToBlob(base64, mimeType = 'image/jpeg') {
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    bytes[i] = byteChars.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/**
 * Extrait la date EXIF originale d'une image (Blob / File) en 'YYYY-MM-DD HH:MM:SS' ou null.
 */
export async function extraireDateExifBlob(blob) {
  try {
    const data = await exifr.parse(blob, ['DateTimeOriginal', 'CreateDate', 'ModifyDate']);
    const dt = data?.DateTimeOriginal || data?.CreateDate || data?.ModifyDate;
    if (dt instanceof Date && !Number.isNaN(dt.getTime())) {
      return nowParisISO(dt);
    }
  } catch {
    // Pas d'EXIF exploitable
  }
  return null;
}

/**
 * Extrait la date depuis un nom de fichier photo (ex: ticket_preuve_2026-11-08_19h57m30s.jpg ou IMG_20261108_195730.jpg).
 */
export function extraireDateNomFichier(filename) {
  if (!filename) return null;
  const base = String(filename).split('/').pop();
  const m1 = base.match(/(\d{4})[-_](\d{2})[-_](\d{2})[-_T\s]+(\d{2})[hH:._-](\d{2})(?:[mM:._-](\d{2}))?/);
  if (m1) {
    return `${m1[1]}-${m1[2]}-${m1[3]} ${m1[4]}:${m1[5]}:${m1[6] || '00'}`;
  }
  const m2 = base.match(/(\d{4})(\d{2})(\d{2})[-_T\s]+(\d{2})(\d{2})(\d{2})/);
  if (m2) {
    return `${m2[1]}-${m2[2]}-${m2[3]} ${m2[4]}:${m2[5]}:${m2[6]}`;
  }
  return null;
}

/**
 * Capture une photo via la caméra native Android (ou sélecteur galerie) en préservant les données.
 */
export async function capturerPhotoNative(source = 'CAMERA') {
  if (isNativePlatform()) {
    const photo = await Camera.getPhoto({
      quality: 90,
      allowEditing: false,
      resultType: CameraResultType.Uri,
      source: source === 'PHOTOS' ? CameraSource.Photos : CameraSource.Camera,
      correctOrientation: true
    });
    if (!photo.webPath) throw new Error('Aucune image capturée.');
    const resp = await fetch(photo.webPath);
    const blob = await resp.blob();
    return {
      blob,
      originalName: `capture_${Date.now()}.jpg`
    };
  }
  return null; // Sur navigateur, l'input file HTML prend le relais
}

/**
 * Lit la position GPS haute précision (Capacitor Geolocation ou navigator.geolocation).
 */
export async function obtenirPositionGPS(timeoutMs = 10000) {
  try {
    if (isNativePlatform()) {
      const perm = await Geolocation.checkPermissions();
      if (perm.location !== 'granted') {
        await Geolocation.requestPermissions();
      }
      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: timeoutMs,
        maximumAge: 15000
      });
      return {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: Math.round(pos.coords.accuracy || 0)
      };
    }
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      return await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: Math.round(pos.coords.accuracy || 0)
          }),
          () => resolve(null),
          { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 15000 }
        );
      });
    }
  } catch {
    // GPS refusé ou indisponible
  }
  return null;
}

/**
 * Sauvegarde et propose le partage natif Android d'un Blob (PDF, ZIP, CSV) ou le télécharge dans le navigateur.
 */
export async function partagerOuTelechargerBlob(blob, filename, mimeType = 'application/octet-stream') {
  if (isNativePlatform()) {
    const base64 = await blobToBase64(blob);
    const saved = await Filesystem.writeFile({
      path: filename,
      data: base64,
      directory: Directory.Cache
    });
    await Share.share({
      title: filename,
      text: `Document probatoire scellé : ${filename}`,
      url: saved.uri,
      dialogTitle: `Partager / Enregistrer ${filename}`
    });
    return { mode: 'native_share', uri: saved.uri };
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { mode: 'browser_download' };
}

/**
 * État réseau actuel + abonnement aux reconnexions.
 */
export async function isOnlineNow() {
  try {
    if (isNativePlatform()) {
      const st = await Network.getStatus();
      return Boolean(st.connected);
    }
  } catch {
    // fallback navigateur
  }
  return typeof navigator !== 'undefined' ? navigator.onLine : true;
}

export function onNetworkReconnect(callback) {
  if (isNativePlatform()) {
    Network.addListener('networkStatusChange', (status) => {
      if (status.connected) callback();
    });
  } else if (typeof window !== 'undefined') {
    window.addEventListener('online', callback);
  }
}
