# Guide d'Installation — Application Android Pointage Prud'hommes (0 €/mois + Google Drive)

Ce dossier (`mobile-app/`) contient votre nouvelle **application Android autonome (`.apk` via Capacitor)** qui fonctionne **100 % hors-ligne** sur votre smartphone et se **synchronise automatiquement sur votre compte Google Drive (15 Go gratuits)** — **sans aucun serveur payant et sans Google Cloud Console**.

---

## Étape 1 — Créer votre pont Google Drive gratuit (2 minutes, 0 €)

1. Ouvrez **[https://script.google.com](https://script.google.com)** connecté avec votre compte **Gmail**.
2. Cliquez sur **Nouveau projet** (nommez-le par exemple `Pointage Drive Sync`).
3. Effacez tout le texte dans l'éditeur et collez le contenu complet du fichier :
   - `google-apps-script/sync_drive.gs`
4. Dans l'application (onglet **☁️ Drive & PDF**), cliquez sur **🔑 Générer** pour créer votre **clé secrète 256 bits**.
5. Dans `sync_drive.gs`, remplacez `'REMPLACER_PAR_VOTRE_CLE_SECRETE_GENEREE_DANS_L_APP'` par cette clé secrète, puis cliquez sur **Enregistrer** (icône disquette).
6. Cliquez en haut à droite sur **Déployer ➔ Nouveau déploiement** :
   - Type : **Application Web**
   - Exécuter en tant que : **Moi**
   - Qui a accès : **Tout le monde** *(seule votre clé secrète 256 bits autorise l'écriture)*
   - Acceptez l'autorisation d'accès à votre propre Google Drive.
7. Copiez l'URL générée (`https://script.google.com/macros/s/.../exec`) et collez-la dans l'onglet **☁️ Drive & PDF** de l'application, puis cliquez sur **💾 Enregistrer & Tester**.

> Un dossier `/POINTAGE_PRUDHOMMES/` (avec `pointage.csv`, `scellement_global.sha256`, `certificat_scellement.json`, `backups_csv/` et `preuves_photos/`) est créé automatiquement sur votre Google Drive !

---

## Étape 2 — Générer et installer le fichier `.apk` sur votre téléphone Android

### Méthode A (La plus simple — 0 € via GitHub Actions, aucune installation sur le PC)

1. Créez un dépôt **privé** gratuit sur [github.com](https://github.com) (ex: `pointage-android`).
2. Poussez le contenu du dossier `mobile-app/` sur ce dépôt :
   ```bash
   cd /home/sid/POINTAGE/mobile-app
   git init
   git add .
   git commit -m "Application Android Pointage Prud'hommes v1"
   git branch -M main
   git remote add origin https://github.com/<VOTRE_COMPTE>/pointage-android.git
   git push -u origin main
   ```
3. Sur GitHub, ouvrez l'onglet **Actions** : le workflow **`Build Android APK`** démarre automatiquement (~3 minutes).
4. Une fois terminé, cliquez sur l'artefact **`Pointage-Prudhommes-Android-APK`** pour télécharger **`app-debug.apk`** sur votre téléphone Android et installez-le !

### Méthode B (Compilation locale sur ce PC Linux — si vous installez Java 17 + Android SDK)

```bash
cd /home/sid/POINTAGE/mobile-app
npm install
npm run build
npx cap add android
npx cap sync android
cd android && ./gradlew assembleDebug
# APK généré dans : android/app/build/outputs/apk/debug/app-debug.apk
```

---

## Étape 3 — Reprendre vos 471 pointages et 187 photos existants (en 1 clic)

1. Copiez votre fichier `/home/sid/POINTAGE/pointage.csv` (et vos photos `/home/sid/POINTAGE/preuves_photos/`) sur votre téléphone (câble USB ou via Google Drive).
2. Dans l'application Android, ouvrez l'onglet **☁️ Drive & PDF** ➔ section **📂 Importer Votre Historique Existant** :
   - Cliquez sur **📄 Importer pointage.csv existant** ➔ vos 471 pointages (53 journées) apparaissent instantanément dans **Agenda & Top 3** et **Chiffrage CPH**.
   - Cliquez sur **📸 Importer lot de photos** pour rattacher vos clichés locaux.
3. Cliquez sur **☁️ Synchroniser** : tout votre historique est sauvegardé et horodaté sur votre **Google Drive**.
