/**
 * Test automatisé de compatibilité stricte entre le nouveau moteur JS (Android)
 * et votre registre existant /home/sid/POINTAGE/pointage.csv (471 lignes, 53 journées).
 */

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { parsePointageCsv, serializePointageCsv } from '../src/modules/csv_io.js';
import {
  detecterAnomalies,
  evaluerRobustesseEtAgenda,
  genererCertificatScellement
} from '../src/modules/audit.js';
import { auditerEtChiffrerCreances } from '../src/modules/chiffrage.js';

const csvPath = path.resolve(process.cwd(), '..', 'pointage.csv');
const certPath = path.resolve(process.cwd(), '..', 'certificat_scellement.json');

const rawCsv = fs.readFileSync(csvPath, 'utf-8');
const refCert = JSON.parse(fs.readFileSync(certPath, 'utf-8'));

const events = parsePointageCsv(rawCsv);
assert.equal(events.length, refCert.nombre_enregistrements, `Attendu ${refCert.nombre_enregistrements} lignes, obtenu ${events.length}`);

const { hashGlobal, certificat } = await genererCertificatScellement(events);
assert.equal(certificat.nombre_enregistrements, refCert.nombre_enregistrements);
assert.equal(certificat.nombre_journees_traitees, refCert.nombre_journees_traitees);
assert.equal(certificat.controle_chronologique.statut, '100% VALIDE');
assert.equal(certificat.controle_sequentiel_workflow.statut, '100% VALIDE');
assert.equal(hashGlobal, refCert.empreinte_sha256, `Hash SHA-256 différent : ${hashGlobal} vs ${refCert.empreinte_sha256}`);

const anomalies = detecterAnomalies(events, [0]);
const agenda = evaluerRobustesseEtAgenda(events, new Set(), [0]);
const bilan3ans = auditerEtChiffrerCreances(events, { tauxHoraireBrut: 12.0, anneesArrieres: 3.0 });

// Vérifier l'aller-retour de sérialisation CSV
const reSerialized = serializePointageCsv(events);
const reParsed = parsePointageCsv(reSerialized);
assert.equal(reParsed.length, events.length);

console.log('✅ Compatibilité 100 % validée avec /home/sid/POINTAGE/pointage.csv !');
console.log(`   • Enregistrements lus     : ${events.length} (réf. Python : ${refCert.nombre_enregistrements})`);
console.log(`   • Journées auditées       : ${certificat.nombre_journees_traitees} (réf. Python : ${refCert.nombre_journees_traitees})`);
console.log(`   • Anomalies détectées     : ${anomalies.length}`);
console.log(`   • Heures cumulées         : ${agenda.resume.totalHeures} h (${agenda.resume.totalSemaines} semaines, ${agenda.resume.totalTop3} Top 3)`);
console.log(`   • Score robustesse moyen  : ${agenda.resume.scoreGlobalMoyen}/100`);
console.log(`   • Chiffrage CPH (3 ans)   : ${bilan3ans.totaux.totalGlobal.toLocaleString('fr-FR', { minimumFractionDigits: 2 })} €`);
console.log(`   • Hash SHA-256 re-scellé  : ${hashGlobal}`);
