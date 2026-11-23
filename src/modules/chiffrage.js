/**
 * Moteur de chiffrage financier des créances prud'homales.
 * Portage exact de chiffrage_prudhommes.py (Art. L. 3245-1, L. 3121-28, L. 3141-24, L. 8223-1, Art. 700 CPC).
 */

import { calculerSyntheseJournee } from './audit.js';
import { getISOWeekInfo } from './constants.js';

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function auditerEtChiffrerCreances(events, { tauxHoraireBrut = 12.0, salaireMensuelBrut = null, anneesArrieres = 3.0 } = {}) {
  let taux = Number(tauxHoraireBrut) || 12.0;
  let salaire = salaireMensuelBrut ? Number(salaireMensuelBrut) : round2(taux * 151.67);
  if (salaireMensuelBrut && !tauxHoraireBrut) {
    taux = round2(salaire / 151.67);
  }
  const taux25 = round2(taux * 1.25);
  const taux50 = round2(taux * 1.50);

  const parDate = new Map();
  for (const ev of events) {
    if (!parDate.has(ev.date)) parDate.set(ev.date, []);
    parDate.get(ev.date).push(ev);
  }

  const semaines = new Map();
  let totalHeuresGlobal = 0;

  for (const [dStr, evs] of [...parDate.entries()].sort()) {
    const synth = calculerSyntheseJournee(evs);
    const hTrav = synth.dureeDecimale || 0;
    const { key, week } = getISOWeekInfo(dStr);
    if (!semaines.has(key)) {
      semaines.set(key, {
        key,
        numSemaine: week,
        totalHeures: 0,
        heuresSup25: 0,
        heuresSup50: 0,
        depassement48h: 0,
        nbJoursTravailles: 0,
        violationReposHebdo: false
      });
    }
    const s = semaines.get(key);
    if (hTrav > 0) s.nbJoursTravailles++;
    s.totalHeures = round2(s.totalHeures + hTrav);
    totalHeuresGlobal = round2(totalHeuresGlobal + hTrav);
  }

  let echantillonSup25 = 0;
  let echantillonSup50 = 0;
  const semCompletes25 = [];
  const semCompletes50 = [];
  const semainesDep48 = [];
  const semainesViolRepos = [];

  for (const s of semaines.values()) {
    const hTot = s.totalHeures;
    if (hTot > 35) {
      const exc = hTot - 35;
      s.heuresSup25 = round2(Math.min(exc, 8));
      s.heuresSup50 = round2(Math.max(0, exc - 8));
    }
    echantillonSup25 += s.heuresSup25;
    echantillonSup50 += s.heuresSup50;

    if (s.nbJoursTravailles >= 5) {
      semCompletes25.push(s.heuresSup25);
      semCompletes50.push(s.heuresSup50);
    }
    if (hTot > 48) {
      s.depassement48h = round2(hTot - 48);
      semainesDep48.push([s.key, hTot]);
    }
    if (s.nbJoursTravailles > 6) {
      s.violationReposHebdo = true;
      semainesViolRepos.push(s.key);
    }
  }

  const moySup25 = semCompletes25.length
    ? semCompletes25.reduce((a, b) => a + b, 0) / semCompletes25.length
    : 8.0;
  const moySup50 = semCompletes50.length
    ? semCompletes50.reduce((a, b) => a + b, 0) / semCompletes50.length
    : 17.315;

  const estProjection = anneesArrieres > 0;
  const nbSemaines = estProjection ? Math.round(anneesArrieres * 47) : semaines.size;
  const totalSup25 = round2(estProjection ? nbSemaines * moySup25 : echantillonSup25);
  const totalSup50 = round2(estProjection ? nbSemaines * moySup50 : echantillonSup50);
  const totalSup = round2(totalSup25 + totalSup50);

  const montantSup25 = round2(totalSup25 * taux25);
  const montantSup50 = round2(totalSup50 * taux50);
  const totalRappelHS = round2(montantSup25 + montantSup50);
  const cpAfferents = round2(totalRappelHS * 0.10);
  const travailDissimule = round2(salaire * 6);

  let di48h = 0;
  let diRepos = 0;
  let art700 = 2500;
  if (estProjection) {
    const coef = Math.max(1, anneesArrieres);
    di48h = round2(2000 + (coef - 1) * 2000);
    diRepos = round2(1500 + (coef - 1) * 1000);
    art700 = round2(2500 + (coef - 1) * 500);
  } else {
    di48h = semainesDep48.length ? 2000 : 0;
    diRepos = semainesViolRepos.length ? 1500 : 0;
    art700 = 2500;
  }

  const totalRappelsEtCp = round2(totalRappelHS + cpAfferents);
  const totalDommagesInterets = round2(di48h + diRepos);
  const totalGlobal = round2(totalRappelsEtCp + travailDissimule + totalDommagesInterets + art700);

  return {
    parametres: {
      tauxHoraireBase: taux,
      salaireMensuelBrut: salaire,
      tauxSup25: taux25,
      tauxSup50: taux50
    },
    arrieres: {
      annees: anneesArrieres,
      estProjection,
      nbSemaines,
      libellePeriode: estProjection
        ? `${anneesArrieres} an(s) (${nbSemaines} semaines travaillées — Art. L. 3245-1)`
        : `Période constatée (${parDate.size} journées auditées)`,
      moySup25Semaine: round2(moySup25),
      moySup50Semaine: round2(moySup50)
    },
    echantillon: {
      totalHeuresNettes: totalHeuresGlobal,
      nombreJournees: parDate.size,
      heuresSup25: round2(echantillonSup25),
      heuresSup50: round2(echantillonSup50),
      semainesDep48: semainesDep48.length,
      semainesViolRepos: semainesViolRepos.length
    },
    postes: [
      {
        num: 1,
        titre: 'Rappel Heures Sup. +25 % (36e à 43e heure)',
        fondement: 'Art. L. 3121-28 & L. 3121-36 C. Trav.',
        assiette: `${totalSup25.toFixed(2)} h @ ${taux25.toFixed(2)} €`,
        montant: montantSup25
      },
      {
        num: 2,
        titre: 'Rappel Heures Sup. +50 % (au-delà de 43h)',
        fondement: 'Art. L. 3121-28 & L. 3121-36 C. Trav.',
        assiette: `${totalSup50.toFixed(2)} h @ ${taux50.toFixed(2)} €`,
        montant: montantSup50
      },
      {
        num: 3,
        titre: 'Congés payés afférents (+10 %)',
        fondement: 'Art. L. 3141-24 C. Trav.',
        assiette: '10 % des rappels HS',
        montant: cpAfferents
      },
      {
        num: 4,
        titre: 'Indemnité forfaitaire Travail Dissimulé (6 mois)',
        fondement: 'Art. L. 8223-1 & L. 8221-5 C. Trav.',
        assiette: `6 × ${salaire.toFixed(2)} € brut`,
        montant: travailDissimule
      },
      {
        num: 5,
        titre: 'D&I — Dépassement plafond absolu 48h/semaine',
        fondement: 'Art. L. 3121-20 & Cass. Soc. 26/01/2022',
        assiette: `${nbSemaines} sem. concernées`,
        montant: di48h
      },
      {
        num: 6,
        titre: 'D&I — Privation du repos hebdomadaire',
        fondement: 'Art. L. 3132-1 & Cass. Soc. 14/12/2022',
        assiette: 'Infraction repos légal',
        montant: diRepos
      },
      {
        num: 7,
        titre: 'Frais irrépétibles d’avocat (Article 700 CPC)',
        fondement: 'Art. 700 du Code de procédure civile',
        assiette: 'Forfait frais de défense',
        montant: art700
      }
    ],
    totaux: {
      totalSup25,
      totalSup50,
      totalSup,
      totalRappelsEtCp,
      travailDissimule,
      totalDommagesInterets,
      art700,
      totalGlobal
    },
    semaines: [...semaines.values()].sort((a, b) => a.key.localeCompare(b.key))
  };
}
