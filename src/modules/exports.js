/**
 * Génération 100 % locale (sur le téléphone, sans serveur) des PDFs juridiques
 * et archives ZIP Avocat + Top 3 VIP avec manifestes SHA-256.
 */

import { jsPDF } from 'jspdf';
import JSZip from 'jszip';
import {
  ENTREPRISE_ADRESSE,
  ENTREPRISE_NOM,
  SALARIE_NOM,
  nowParisISO
} from './constants.js';
import {
  calculerSyntheseJournee,
  evaluerRobustesseEtAgenda,
  genererCertificatScellement
} from './audit.js';
import { auditerEtChiffrerCreances } from './chiffrage.js';
import { sha256Bytes } from './crypto.js';
import { getPhoto, getPhotoNamesSet } from './db.js';
import { blobToBase64, partagerOuTelechargerBlob } from './native.js';

function cleanPdfText(str) {
  return String(str ?? '')
    .replace(/€/g, 'EUR')
    .replace(/[’‘]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[—–]/g, '-')
    .replace(/[^\x20-\xFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function drawHeader(doc, title, subtitle, accentRgb = [59, 130, 246]) {
  doc.setFillColor(20, 30, 45);
  doc.rect(0, 0, 210, 26, 'F');
  doc.setFillColor(...accentRgb);
  doc.rect(0, 26, 210, 2, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(cleanPdfText(title), 105, 11, { align: 'center' });

  doc.setTextColor(203, 213, 225);
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.text(cleanPdfText(subtitle), 105, 19, { align: 'center' });
}

function drawFooters(doc, hashGlobal) {
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7.5);
    doc.setTextColor(120, 130, 145);
    doc.text(
      cleanPdfText(`${SALARIE_NOM} c/ ${ENTREPRISE_NOM} | Sceau SHA-256 : ${hashGlobal.slice(0, 16)}... | Page ${i}/${total}`),
      105,
      290,
      { align: 'center' }
    );
  }
}

/**
 * 1. Génère le Rapport Officiel de Pointage Certifié (global ou d'une journée).
 */
export async function buildRapportPointagePdfBlob(events, { dateCible = null, includePhotos = true } = {}) {
  const { hashGlobal } = await genererCertificatScellement(events);
  const filtered = dateCible ? events.filter((e) => e.date === dateCible) : events;
  const synth = dateCible ? calculerSyntheseJournee(filtered) : null;

  const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
  drawHeader(
    doc,
    'DOSSIER DE PREUVE - RELEVE DE POINTAGE CERTIFIE',
    'Tracabilite geolocalisee (200m) et scellee par empreinte cryptographique SHA-256'
  );

  let y = 34;
  doc.setTextColor(30, 41, 59);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.text(cleanPdfText(`Salarie : ${SALARIE_NOM}`), 12, y); y += 5;
  doc.text(cleanPdfText(`Etablissement : ${ENTREPRISE_NOM} - ${ENTREPRISE_ADRESSE}`), 12, y); y += 5;
  if (dateCible) {
    doc.text(cleanPdfText(`Journee auditee : ${dateCible}`), 12, y); y += 5;
  }
  doc.setFont('helvetica', 'normal');
  doc.text(cleanPdfText(`Edition : ${nowParisISO()} (Europe/Paris) | Enregistrements : ${filtered.length}`), 12, y); y += 6;

  // Boîte Sceau SHA-256
  doc.setFillColor(240, 253, 244);
  doc.setDrawColor(134, 239, 172);
  doc.rect(12, y, 186, 12, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(22, 101, 52);
  doc.text('SCELLE GLOBAL D\'INTEGRITE DU REGISTRE SOURCE (pointage.csv) :', 15, y + 4.5);
  doc.setFont('courier', 'bold');
  doc.setTextColor(15, 23, 42);
  doc.text(`SHA-256: ${hashGlobal}`, 15, y + 9.5);
  y += 16;

  if (synth && !synth.estEnCours) {
    doc.setFillColor(241, 245, 249);
    doc.setDrawColor(203, 213, 225);
    doc.rect(12, y, 186, 14, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(15, 23, 42);
    doc.text(cleanPdfText(`Temps de travail effectif net : ${synth.dureeNetteSeule} (${synth.dureeDecimale.toFixed(2)} h)`), 15, y + 5.5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(cleanPdfText(`Entree : ${synth.heureEntree}  |  Pause : ${synth.pauseStr}  |  Sortie : ${synth.heureSortie}`), 15, y + 11);
    y += 18;
  }

  // En-tête tableau
  const drawTableHeader = () => {
    doc.setFillColor(30, 41, 59);
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.rect(12, y, 186, 7, 'F');
    doc.text('Date / Heure', 14, y + 4.8);
    doc.text('Action', 48, y + 4.8);
    doc.text('Detail factuel', 88, y + 4.8);
    doc.text('Sceau SHA-256', 166, y + 4.8);
    y += 7;
  };
  drawTableHeader();

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.2);
  const photoNames = [];

  for (let i = 0; i < filtered.length; i++) {
    const ev = filtered[i];
    if (y > 274) {
      doc.addPage();
      drawHeader(doc, 'DOSSIER DE PREUVE - RELEVE DE POINTAGE CERTIFIE', 'Suite chronologique scellee SHA-256');
      y = 33;
      drawTableHeader();
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.2);
    }
    if (i % 2 === 1) {
      doc.setFillColor(248, 250, 252);
      doc.rect(12, y, 186, 5.5, 'F');
    }
    doc.setDrawColor(226, 232, 240);
    doc.rect(12, y, 186, 5.5, 'S');
    doc.setTextColor(15, 23, 42);
    doc.text(cleanPdfText(ev.dateHeure).slice(0, 19), 13.5, y + 3.8);
    doc.text(cleanPdfText(ev.action).slice(0, 24), 48, y + 3.8);
    doc.text(cleanPdfText(ev.detail).slice(0, 48), 88, y + 3.8);
    doc.setFont('courier', 'normal');
    doc.text(ev.hash ? `${ev.hash.slice(0, 14)}...` : 'N/A', 166, y + 3.8);
    doc.setFont('helvetica', 'normal');
    y += 5.5;

    if (ev.photoName && !photoNames.includes(ev.photoName)) {
      photoNames.push({ name: ev.photoName, dateHeure: ev.dateHeure, action: ev.action, hash: ev.hash });
    }
  }

  // Annexe photos (pour rapport journalier ou jusqu'à 20 clichés en mode global mobile)
  if (includePhotos && photoNames.length > 0) {
    const limitPhotos = dateCible ? photoNames : photoNames.slice(0, 20);
    let addedPage = false;
    for (const p of limitPhotos) {
      const rec = await getPhoto(p.name);
      if (!rec?.blob) continue;
      if (!addedPage || y > 180) {
        doc.addPage();
        drawHeader(doc, 'ANNEXE DES PREUVES PHOTOGRAPHIQUES SCELLEES', 'Cliches originaux conserves localement avec sceau SHA-256');
        y = 34;
        addedPage = true;
      }
      try {
        const b64 = await blobToBase64(rec.blob);
        const dataUrl = `data:${rec.blob.type || 'image/jpeg'};base64,${b64}`;
        doc.setFillColor(248, 250, 252);
        doc.setDrawColor(203, 213, 225);
        doc.rect(15, y, 180, 92, 'FD');
        doc.addImage(dataUrl, 'JPEG', 45, y + 3, 120, 72, undefined, 'MEDIUM');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8);
        doc.setTextColor(15, 23, 42);
        doc.text(cleanPdfText(`${p.dateHeure} | ${p.action} | ${p.name}`), 18, y + 81);
        doc.setFont('courier', 'normal');
        doc.setFontSize(7);
        doc.text(`SHA-256 : ${p.hash || rec.hash || 'N/A'}`, 18, y + 87);
        y += 96;
      } catch {
        // Ignorer image non décodable
      }
    }
  }

  drawFooters(doc, hashGlobal);
  return doc.output('blob');
}

/**
 * 2. Génère le Bordereau Chiffré PDF (Pièce n° 4).
 */
export async function buildChiffragePdfBlob(events, params) {
  const { hashGlobal } = await genererCertificatScellement(events);
  const bilan = auditerEtChiffrerCreances(events, params);
  const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });

  drawHeader(
    doc,
    'CONSEIL DE PRUD\'HOMMES DE BOBIGNY - PIECE N 4',
    'Bordereau detaille des creances salariales & indemnitaires (Art. L. 3245-1)',
    [217, 119, 6]
  );

  let y = 34;
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(203, 213, 225);
  doc.rect(12, y, 186, 22, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(15, 23, 42);
  doc.text(`DEMANDEUR : M. ${SALARIE_NOM}`, 15, y + 6);
  doc.text(`DEFENDEUR : ${ENTREPRISE_NOM}`, 108, y + 6);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(cleanPdfText(`Periode : ${bilan.arrieres.libellePeriode}`), 15, y + 12);
  doc.text(cleanPdfText(`Base : ${bilan.parametres.salaireMensuelBrut.toFixed(2)} EUR/mois (${bilan.parametres.tauxHoraireBase.toFixed(2)} EUR/h)`), 15, y + 18);
  y += 27;

  // Encadré Total
  doc.setFillColor(254, 252, 232);
  doc.setDrawColor(217, 119, 6);
  doc.rect(12, y, 186, 18, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(180, 83, 9);
  doc.text('TOTAL GENERAL DES PRETENTIONS PECUNIAIRES (CPH)', 105, y + 5.5, { align: 'center' });
  doc.setFontSize(15);
  doc.setTextColor(15, 23, 42);
  doc.text(`${bilan.totaux.totalGlobal.toLocaleString('fr-FR', { minimumFractionDigits: 2 })} EUR`, 105, y + 14, { align: 'center' });
  y += 23;

  // Tableau des 7 postes
  doc.setFillColor(30, 41, 59);
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.rect(12, y, 186, 7, 'F');
  doc.text('N', 15, y + 4.8);
  doc.text('Chef de Demande & Fondement', 24, y + 4.8);
  doc.text('Assiette', 122, y + 4.8);
  doc.text('Montant', 194, y + 4.8, { align: 'right' });
  y += 7;

  for (const p of bilan.postes) {
    doc.setDrawColor(226, 232, 240);
    doc.rect(12, y, 186, 10, 'S');
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.text(String(p.num), 15, y + 6);
    doc.text(cleanPdfText(p.titre), 24, y + 4.5);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(6.8);
    doc.setTextColor(100, 116, 139);
    doc.text(cleanPdfText(p.fondement), 24, y + 8.5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(51, 65, 85);
    doc.text(cleanPdfText(p.assiette), 122, y + 6);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.2);
    doc.setTextColor(15, 23, 42);
    doc.text(`${p.montant.toLocaleString('fr-FR', { minimumFractionDigits: 2 })} EUR`, 194, y + 6, { align: 'right' });
    y += 10;
  }

  y += 6;
  doc.setFillColor(240, 253, 244);
  doc.setDrawColor(134, 239, 172);
  doc.rect(12, y, 186, 13, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(22, 101, 52);
  doc.text('GARANTIE D\'INALTERABILITE SHA-256 (pointage.csv) :', 15, y + 5);
  doc.setFont('courier', 'normal');
  doc.setTextColor(15, 23, 42);
  doc.text(hashGlobal, 15, y + 10);

  drawFooters(doc, hashGlobal);
  return doc.output('blob');
}

/**
 * 3. Génère le PDF Synthèse Top 3 Preuves Hebdomadaires.
 */
export async function buildTop3PdfBlob(events, joursReposHebdo = [0]) {
  const photoNames = await getPhotoNamesSet();
  const audit = evaluerRobustesseEtAgenda(events, photoNames, joursReposHebdo);
  const { hashGlobal } = await genererCertificatScellement(events);
  const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });

  drawHeader(
    doc,
    'SELECTION AUTOMATISEE - TOP 3 PREUVES PAR SEMAINE (CPH)',
    'Scoring forensique /100 pts (Photos SHA-256, GPS <200m, Sequence, Amplitude)',
    [16, 185, 129]
  );

  let y = 34;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.setTextColor(15, 23, 42);
  doc.text(
    cleanPdfText(`${audit.resume.totalTop3} journees d'elite sur ${audit.resume.totalSemaines} semaines | Score moyen : ${audit.resume.scoreGlobalMoyen}/100`),
    12,
    y
  );
  y += 7;

  const semaines = Object.values(audit.semainesIso).sort((a, b) => a.key.localeCompare(b.key));
  for (const sem of semaines) {
    if (y > 250) {
      doc.addPage();
      drawHeader(doc, 'SELECTION AUTOMATISEE - TOP 3 PREUVES PAR SEMAINE', 'Suite', [16, 185, 129]);
      y = 34;
    }
    doc.setFillColor(30, 41, 59);
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.rect(12, y, 186, 6, 'F');
    doc.text(
      cleanPdfText(`${sem.label} | Total : ${sem.totalHeures.toFixed(2)}h (HS +25%: ${sem.heuresSup25.toFixed(2)}h | HS +50%: ${sem.heuresSup50.toFixed(2)}h)`),
      15,
      y + 4.2
    );
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    for (const j of sem.top3Jours) {
      doc.setDrawColor(226, 232, 240);
      doc.rect(12, y, 186, 5.8, 'S');
      doc.setTextColor(15, 23, 42);
      doc.text(`#${j.rangTop3} (${j.grade})`, 14, y + 4);
      doc.text(cleanPdfText(`${j.date} (${j.jourCourt})`), 34, y + 4);
      doc.text(`${j.heureEntree.slice(0, 5)} -> ${j.heureSortie.slice(0, 5)}`, 68, y + 4);
      doc.text(`${j.dureeDecimale.toFixed(2)} h`, 102, y + 4);
      doc.text(`${j.nbPhotos} Ph / ${j.nbGps} GPS`, 122, y + 4);
      doc.setTextColor(22, 101, 52);
      doc.text(`${j.scoreRobustesse}/100`, 152, y + 4);
      doc.setFont('courier', 'normal');
      doc.setTextColor(71, 85, 105);
      doc.text(j.hashPrincipal ? `${j.hashPrincipal.slice(0, 14)}...` : 'Scelle', 168, y + 4);
      doc.setFont('helvetica', 'normal');
      y += 5.8;
    }
    y += 3;
  }

  drawFooters(doc, hashGlobal);
  return doc.output('blob');
}

/**
 * 4. Construit et partage le Kit Avocat complet (.ZIP) avec MANIFESTE_SHA256_COMPLET.sha256.
 */
export async function exporterKitAvocatZip(events, settings, onProgress = () => {}) {
  const zip = new JSZip();
  onProgress('Scellement SHA-256 du registre...');
  const { csvContent, sha256FileContent, certificat } = await genererCertificatScellement(events);
  const photoNames = await getPhotoNamesSet();
  const audit = evaluerRobustesseEtAgenda(events, photoNames, settings.joursReposHebdo);

  zip.file('pointage.csv', csvContent);
  zip.file('Piece_3_scellement_global.sha256', sha256FileContent);
  zip.file('Piece_3_certificat_scellement.json', JSON.stringify(certificat, null, 2));

  // Récapitulatif Excel UTF-8 BOM
  const recapLines = ['Date;Heure Entree;Heure Sortie;Temps de Pause;Duree Totale (heures)'];
  let totalH = 0;
  for (const j of Object.values(audit.joursEvalues).sort((a, b) => a.date.localeCompare(b.date))) {
    if (j.isClosed) totalH += j.dureeDecimale;
    recapLines.push(`${j.date};${j.heureEntree};${j.heureSortie};${j.pauseStr};${j.dureeDecimale.toFixed(2)}`);
  }
  recapLines.push(`TOTAL;;;;${totalH.toFixed(2)}`);
  zip.file('Recapitulatif_Heures.csv', '\uFEFF' + recapLines.join('\n') + '\n');

  onProgress('Génération des pièces PDF (Pointages, Chiffrage, Top 3)...');
  const pdfGlobal = await buildRapportPointagePdfBlob(events, { includePhotos: false });
  zip.file('Piece_1_Rapport_Prudhommes_Global.pdf', pdfGlobal);

  const pdfChiffrage = await buildChiffragePdfBlob(events, {
    tauxHoraireBrut: settings.tauxHoraireBrut,
    salaireMensuelBrut: settings.salaireMensuelBrut,
    anneesArrieres: settings.anneesArrieres
  });
  zip.file('Piece_4_Bordereau_Chiffrage_Creances.pdf', pdfChiffrage);

  const pdfTop3 = await buildTop3PdfBlob(events, settings.joursReposHebdo);
  zip.file('Piece_5_Synthese_Top3_Preuves_Hebdo.pdf', pdfTop3);

  // Manifeste SHA-256 intégral de l'archive
  onProgress('Calcul du manifeste SHA-256 de l’archive...');
  const manifestLines = [];
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const bytes = await entry.async('uint8array');
    const h = await sha256Bytes(bytes);
    manifestLines.push(`${h}  ${name}`);
  }
  zip.file('MANIFESTE_SHA256_COMPLET.sha256', manifestLines.join('\n') + '\n');

  onProgress('Compression de l’archive ZIP...');
  const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const filename = `Dossier_Prudhommes_${nowParisISO().slice(0, 10)}.zip`;
  await partagerOuTelechargerBlob(zipBlob, filename, 'application/zip');
  return filename;
}

export async function exporterPdfDirect(blob, filename) {
  return partagerOuTelechargerBlob(blob, filename, 'application/pdf');
}
