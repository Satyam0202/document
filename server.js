const express = require('express');
const session = require('express-session');
const path = require('path');
const dotenv = require('dotenv');
const fs = require('fs');

dotenv.config();

// Support writing Google service account JSON from an environment variable.
// This allows Railway (and similar platforms) to provide the service account
// via env var instead of uploading a file.
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  try {
    const keyPath = path.join(__dirname, 'gdrive-service-account.json');
    fs.writeFileSync(keyPath, process.env.GOOGLE_SERVICE_ACCOUNT_JSON, { encoding: 'utf8' });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    console.log('Google service account written to', keyPath);
  } catch (err) {
    console.error('Failed to write Google service account JSON:', err && err.message);
  }
}

const app = express();
const port = process.env.PORT || 3000;

// Railway runs behind a proxy — needed for secure cookies + correct IP
app.set('trust proxy', 1);
const uploadsDir = path.join(__dirname, 'uploads');

fs.mkdirSync(uploadsDir, { recursive: true });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
const isProduction = process.env.NODE_ENV === 'production';
app.use(session({
  secret: process.env.SESSION_SECRET || 'vault-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,   // true in prod (HTTPS), false locally
    sameSite: 'lax'
  }
}));

const authRoutes = require('./routes/auth');
const documentRoutes = require('./routes/documents');

app.use('/', authRoutes);
app.use('/', documentRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  return res.redirect('/login');
});

app.listen(port, () => {
  console.log(`Personal Document Vault running at http://localhost:${port}`);
});
