/**
 * ==============================================================================
 * ☁️ PONT DE SYNCHRONISATION GOOGLE DRIVE GRATUIT (0 €/mois — SANS GOOGLE CLOUD)
 * ==============================================================================
 * À copier-coller sur https://script.google.com avec votre compte Gmail personnel.
 *
 * Étapes rapides :
 * 1. Ouvrez https://script.google.com ➔ "Nouveau projet".
 * 2. Remplacez tout le contenu par ce fichier.
 * 3. Modifiez SECRET_TOKEN ci-dessous avec la clé secrète générée dans votre APK.
 * 4. Cliquez sur "Déployer" ➔ "Nouveau déploiement" ➔ Type : "Application Web".
 *    - Exécuter en tant que : "Moi"
 *    - Qui a accès : "Tout le monde" (la sécurité repose sur votre SECRET_TOKEN 256 bits)
 * 5. Copiez l'URL "https://script.google.com/macros/s/.../exec" dans l'APK.
 *
 * Arborescence créée automatiquement dans votre Google Drive :
 *   /POINTAGE_PRUDHOMMES/
 *     ├── pointage.csv
 *     ├── scellement_global.sha256
 *     ├── certificat_scellement.json
 *     ├── backups_csv/          (historique horodaté automatique avant chaque mise à jour)
 *     └── preuves_photos/       (toutes vos photos originales + horodatage serveur Google)
 * ==============================================================================
 */

var SECRET_TOKEN = 'REMPLACER_PAR_VOTRE_CLE_SECRETE_GENEREE_DANS_L_APP';
var ROOT_FOLDER_NAME = 'POINTAGE_PRUDHOMMES';

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateFolder(parent, name) {
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

function getRootStructure() {
  var root = getOrCreateFolder(DriveApp.getRootFolder(), ROOT_FOLDER_NAME);
  var photos = getOrCreateFolder(root, 'preuves_photos');
  var backups = getOrCreateFolder(root, 'backups_csv');
  return { root: root, photos: photos, backups: backups };
}

function writeOrUpdateTextFile(folder, filename, content, mimeType) {
  var it = folder.getFilesByName(filename);
  if (it.hasNext()) {
    var existing = it.next();
    existing.setContent(content);
    return existing;
  }
  return folder.createFile(filename, content, mimeType || MimeType.PLAIN_TEXT);
}

function doGet() {
  return jsonResponse({
    ok: true,
    service: 'Pointage Prudhommes Drive Sync',
    serverTimestamp: new Date().toISOString()
  });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    if (!body.token || body.token !== SECRET_TOKEN || SECRET_TOKEN.indexOf('REMPLACER') === 0) {
      return jsonResponse({ ok: false, error: 'Accès refusé : clé secrète invalide ou non configurée.' });
    }

    var action = body.action || '';
    var dirs = getRootStructure();
    var serverNow = new Date().toISOString();

    if (action === 'ping') {
      return jsonResponse({
        ok: true,
        message: 'Connexion Google Drive opérationnelle.',
        folderName: ROOT_FOLDER_NAME,
        folderUrl: dirs.root.getUrl(),
        serverTimestamp: serverNow
      });
    }

    if (action === 'upload_photo') {
      var fname = String(body.filename || '').replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!fname || !body.base64Data) {
        return jsonResponse({ ok: false, error: 'Nom de fichier ou données base64 manquants.' });
      }
      // Anti-doublon : si le fichier existe déjà dans preuves_photos, ne pas dupliquer
      var existingIt = dirs.photos.getFilesByName(fname);
      if (existingIt.hasNext()) {
        var fEx = existingIt.next();
        return jsonResponse({
          ok: true,
          alreadyExists: true,
          fileId: fEx.getId(),
          serverTimestamp: serverNow
        });
      }
      var decoded = Utilities.base64Decode(body.base64Data);
      var blob = Utilities.newBlob(decoded, body.mimeType || 'image/jpeg', fname);
      var created = dirs.photos.createFile(blob);
      if (body.sha256) {
        created.setDescription('SHA-256: ' + body.sha256 + ' | Scelle serveur Google: ' + serverNow);
      }
      return jsonResponse({
        ok: true,
        fileId: created.getId(),
        serverTimestamp: serverNow
      });
    }

    if (action === 'sync_registry') {
      var csvContent = String(body.csvContent || '');
      if (!csvContent) {
        return jsonResponse({ ok: false, error: 'Contenu pointage.csv vide.' });
      }
      // Archive de sécurité horodatée si pointage.csv existait déjà
      var oldCsvIt = dirs.root.getFilesByName('pointage.csv');
      if (oldCsvIt.hasNext()) {
        var oldContent = oldCsvIt.next().getBlob().getDataAsString();
        if (oldContent !== csvContent) {
          var stamp = Utilities.formatDate(new Date(), 'Europe/Paris', 'yyyyMMdd_HHmmss');
          dirs.backups.createFile('pointage_' + stamp + '.csv', oldContent, MimeType.PLAIN_TEXT);
        }
      }

      writeOrUpdateTextFile(dirs.root, 'pointage.csv', csvContent, MimeType.PLAIN_TEXT);
      if (body.sha256Content) {
        writeOrUpdateTextFile(dirs.root, 'scellement_global.sha256', String(body.sha256Content), MimeType.PLAIN_TEXT);
      }
      if (body.certificatJson) {
        writeOrUpdateTextFile(dirs.root, 'certificat_scellement.json', String(body.certificatJson), 'application/json');
      }

      return jsonResponse({
        ok: true,
        hashGlobal: body.hashGlobal || '',
        folderUrl: dirs.root.getUrl(),
        serverTimestamp: serverNow
      });
    }

    if (action === 'restore_registry') {
      var csvIt = dirs.root.getFilesByName('pointage.csv');
      var csvText = csvIt.hasNext() ? csvIt.next().getBlob().getDataAsString() : '';
      var photoFiles = [];
      var phIt = dirs.photos.getFiles();
      while (phIt.hasNext()) {
        var pf = phIt.next();
        photoFiles.push({
          id: pf.getId(),
          name: pf.getName(),
          size: pf.getSize(),
          updated: pf.getLastUpdated().toISOString()
        });
      }
      return jsonResponse({
        ok: true,
        csvContent: csvText,
        photoFiles: photoFiles,
        serverTimestamp: serverNow
      });
    }

    if (action === 'download_photo') {
      var fileId = String(body.fileId || '');
      if (!fileId) return jsonResponse({ ok: false, error: 'fileId manquant.' });
      var file = DriveApp.getFileById(fileId);
      var bytes = file.getBlob().getBytes();
      var b64 = Utilities.base64Encode(bytes);
      var desc = file.getDescription() || '';
      var mHash = desc.match(/SHA-256:\s*([a-f0-9]{64})/i);
      return jsonResponse({
        ok: true,
        name: file.getName(),
        mimeType: file.getMimeType(),
        sha256: mHash ? mHash[1] : '',
        base64Data: b64
      });
    }

    return jsonResponse({ ok: false, error: 'Action inconnue : ' + action });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}
