const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const ensureAuthenticated = require('../middleware/auth');
const { uploadToGoogleDrive } = require('../services/storage');
const router = express.Router();

const defaultCategories = ['Education', 'Identity', 'Career', 'Finance', 'Personal'];
const dataFile = path.join(__dirname, '..', 'utils', 'documents.json');

// Temp local storage only — files are deleted after Drive upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'uploads')),
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, '-');
    cb(null, `${Date.now()}-${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: (Number(process.env.UPLOAD_LIMIT_MB) || 10) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = (process.env.ALLOWED_EXTENSIONS || 'pdf,jpg,jpeg,png,doc,docx').split(',');
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    cb(null, allowed.includes(ext));
  }
});

function loadDocuments() {
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify([], null, 2));
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(dataFile, 'utf8')) || [];
  } catch {
    return [];
  }
}

function saveDocuments(documents) {
  fs.writeFileSync(dataFile, JSON.stringify(documents, null, 2));
}

function getCategories(documents) {
  return [...new Set([...defaultCategories, ...documents.map((doc) => doc.category).filter(Boolean)])];
}

function formatBytes(size) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Number(size);
  let index = 0;
  while (value > 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function getFileType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.pdf') return 'PDF';
  if (['.jpg', '.jpeg', '.png'].includes(ext)) return 'Image';
  if (['.doc', '.docx'].includes(ext)) return 'Word';
  return 'File';
}

// ── Dashboard ────────────────────────────────────────────────────────────────

router.get('/dashboard', ensureAuthenticated, (req, res) => {
  const documents = loadDocuments();
  const search = (req.query.search || '').trim().toLowerCase();
  const categoryFilter = req.query.category || '';
  const storageFilter = req.query.storage || '';
  const dateFilter = req.query.date || '';
  const typeFilter = req.query.type || '';

  const filteredDocuments = documents.filter((doc) => {
    const matchesSearch =
      !search ||
      [doc.name, doc.originalName, doc.category, doc.type].some((v) =>
        String(v).toLowerCase().includes(search)
      );
    const matchesCategory = !categoryFilter || doc.category === categoryFilter;
    const matchesStorage = !storageFilter || doc.storage === storageFilter;
    const matchesDate =
      !dateFilter || new Date(doc.uploadedAt).toISOString().slice(0, 10) === dateFilter;
    const matchesType = !typeFilter || doc.type === typeFilter;
    return matchesSearch && matchesCategory && matchesStorage && matchesDate && matchesType;
  });

  const totalDocuments = documents.length;
  const totalCategories = [
    ...new Set(documents.map((doc) => doc.category).filter(Boolean))
  ].length;
  const recentDocuments = [...documents]
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    .slice(0, 3);
  const storageSummary = {
    'Google Drive': documents.filter((doc) => doc.storage === 'Google Drive').length,
    Local: documents.filter((doc) => doc.storage === 'Local').length
  };

  res.render('dashboard', {
    user: req.session.user,
    documents: filteredDocuments,
    categories: getCategories(documents),
    totalDocuments,
    totalCategories,
    recentDocuments,
    storageSummary,
    filters: { search, categoryFilter, storageFilter, dateFilter, typeFilter }
  });
});

// ── Upload ───────────────────────────────────────────────────────────────────

router.post('/documents/upload', ensureAuthenticated, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.redirect('/dashboard?error=No+file+uploaded');
  }

  const documents = loadDocuments();
  const category = (req.body.customCategory || req.body.category || 'Personal').trim() || 'Personal';
  const storageChoice = req.body.storage || 'Google Drive';

  let storageStatus = 'Stored locally';
  let driveFileId = null;
  let driveViewLink = null;
  let driveDownloadLink = null;

  // Always try Google Drive upload
  if (storageChoice === 'Google Drive') {
    const result = await uploadToGoogleDrive(req.file);
    if (result.ok) {
      storageStatus = 'Stored in Google Drive';
      driveFileId = result.fileId;
      driveViewLink = result.webViewLink;
      driveDownloadLink = result.webContentLink;

      // Remove temp local file after successful Drive upload
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        // non-fatal
      }
    } else {
      storageStatus = 'Drive upload failed — stored locally as fallback';
    }
  }

  const newDocument = {
    id: Date.now(),
    name: path.parse(req.file.originalname).name,
    originalName: req.file.originalname,
    category,
    storage: driveFileId ? 'Google Drive' : 'Local',
    uploadedAt: new Date().toISOString(),
    size: formatBytes(req.file.size),
    type: getFileType(req.file.originalname),
    // Local fallback path (null when Drive upload succeeded)
    filePath: driveFileId ? null : req.file.path,
    fileName: driveFileId ? null : req.file.filename,
    // Drive metadata
    driveFileId,
    driveViewLink,
    driveDownloadLink,
    status: storageStatus
  };

  documents.push(newDocument);
  saveDocuments(documents);
  return res.redirect('/dashboard');
});

// ── Preview ──────────────────────────────────────────────────────────────────

router.get('/documents/:id/preview', ensureAuthenticated, (req, res) => {
  const documents = loadDocuments();
  const document = documents.find((doc) => doc.id === Number(req.params.id));

  if (!document) return res.status(404).send('Document not found');

  // Drive-hosted file — redirect to Drive viewer
  if (document.driveViewLink) {
    return res.redirect(document.driveViewLink);
  }

  // Local fallback
  if (document.filePath && fs.existsSync(document.filePath)) {
    const ext = path.extname(document.filePath).toLowerCase();
    if (['.doc', '.docx'].includes(ext)) {
      return res.download(document.filePath, document.originalName || document.name);
    }
    return res.sendFile(document.filePath);
  }

  return res.status(404).send('File not found — it may have been removed from the server.');
});

// ── Download ─────────────────────────────────────────────────────────────────

router.get('/documents/:id/download', ensureAuthenticated, (req, res) => {
  const documents = loadDocuments();
  const document = documents.find((doc) => doc.id === Number(req.params.id));

  if (!document) return res.status(404).send('Document not found');

  // Drive-hosted file — redirect to Drive download link
  if (document.driveDownloadLink) {
    return res.redirect(document.driveDownloadLink);
  }

  // Local fallback
  if (document.filePath && fs.existsSync(document.filePath)) {
    return res.download(document.filePath, document.originalName || document.name);
  }

  return res.status(404).send('File not found — it may have been removed from the server.');
});

// ── Delete ───────────────────────────────────────────────────────────────────

router.post('/documents/:id/delete', ensureAuthenticated, (req, res) => {
  const documents = loadDocuments();
  const document = documents.find((doc) => doc.id === Number(req.params.id));

  // Remove local file if it exists
  if (document && document.filePath && fs.existsSync(document.filePath)) {
    fs.unlinkSync(document.filePath);
  }

  const filtered = documents.filter((doc) => doc.id !== Number(req.params.id));
  saveDocuments(filtered);
  res.redirect('/dashboard');
});

// ── Rename ───────────────────────────────────────────────────────────────────

router.post('/documents/:id/rename', ensureAuthenticated, (req, res) => {
  const documents = loadDocuments();
  const document = documents.find((doc) => doc.id === Number(req.params.id));
  if (document) {
    document.name = req.body.name;
    saveDocuments(documents);
  }
  res.redirect('/dashboard');
});

// ── Update metadata ───────────────────────────────────────────────────────────

router.post('/documents/:id/update', ensureAuthenticated, (req, res) => {
  const documents = loadDocuments();
  const document = documents.find((doc) => doc.id === Number(req.params.id));
  if (document) {
    document.category = req.body.category;
    saveDocuments(documents);
  }
  res.redirect('/dashboard');
});

module.exports = router;
