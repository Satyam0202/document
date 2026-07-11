const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const DEFAULT_GOOGLE_DRIVE_FOLDER_ID = '1l8hQdOfzbpJkjQ6g8UPwd7i_0wokJDPE';

/**
 * Upload a file to Google Drive.
 * Returns { ok, service, fileId, webViewLink } on success.
 */
async function uploadToGoogleDrive(file) {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || DEFAULT_GOOGLE_DRIVE_FOLDER_ID;

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.warn('[Drive] GOOGLE_APPLICATION_CREDENTIALS not set — skipping Drive upload.');
    return { ok: false, service: 'Google Drive' };
  }

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/drive.file']
    });

    const drive = google.drive({ version: 'v3', auth });

    const fileMetadata = {
      name: path.basename(file.originalname),
      parents: folderId ? [folderId] : []
    };

    const media = {
      mimeType: file.mimetype,
      body: fs.createReadStream(file.path)
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: 'id, webViewLink, webContentLink'
    });

    // Make file readable by anyone with link (optional — remove if you want private)
    await drive.permissions.create({
      fileId: response.data.id,
      requestBody: { role: 'reader', type: 'anyone' }
    });

    return {
      ok: true,
      service: 'Google Drive',
      fileId: response.data.id,
      webViewLink: response.data.webViewLink,
      webContentLink: response.data.webContentLink
    };
  } catch (error) {
    console.error('[Drive] Upload error:', error && error.message);
    return { ok: false, service: 'Google Drive' };
  }
}

module.exports = { uploadToGoogleDrive };
