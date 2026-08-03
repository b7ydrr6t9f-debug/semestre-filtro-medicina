require('dotenv').config();

const express = require('express');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ------------------------------------------------------------------
// Database (libSQL). Punta a Turso se TURSO_DATABASE_URL è impostata
// (Render → Environment), altrimenti usa un file sqlite locale che
// su Render senza Persistent Disk non sopravvive ai redeploy.
// ------------------------------------------------------------------
const usaTurso = !!process.env.TURSO_DATABASE_URL;
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:database.sqlite',
  authToken: process.env.TURSO_AUTH_TOKEN
});
console.log(`[Database] Modalità: ${usaTurso ? 'Turso (cloud, persistente)' : 'file locale (non persistente su Render senza Persistent Disk)'}`);

async function initDb() {
  await db.execute(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    pin_hash TEXT NOT NULL,
    domanda_sicurezza TEXT NOT NULL,
    risposta_hash TEXT NOT NULL,
    ruolo TEXT NOT NULL DEFAULT 'studente',
    last_login DATETIME,
    email_verificata INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Compatibilità con database creati prima dell'introduzione dei ruoli:
  // aggiunge la colonna solo se manca ancora.
  const infoUsers = await db.execute("PRAGMA table_info(users)");
  const colonneUsers = infoUsers.rows.map(r => r.name);
  if (!colonneUsers.includes('ruolo')) {
    await db.execute("ALTER TABLE users ADD COLUMN ruolo TEXT NOT NULL DEFAULT 'studente'");
    console.log('[Database] Aggiunta colonna ruolo alla tabella users (database preesistente).');
  }
  if (!colonneUsers.includes('last_login')) {
    await db.execute("ALTER TABLE users ADD COLUMN last_login DATETIME");
    console.log('[Database] Aggiunta colonna last_login alla tabella users (database preesistente).');
  }
  if (!colonneUsers.includes('email_verificata')) {
    await db.execute("ALTER TABLE users ADD COLUMN email_verificata INTEGER NOT NULL DEFAULT 0");
    console.log('[Database] Aggiunta colonna email_verificata alla tabella users (database preesistente).');
  }

  // Token per verifica email e reset PIN via link: un unico posto per
  // entrambi, distinti dal campo "tipo", monouso e con scadenza.
  await db.execute(`CREATE TABLE IF NOT EXISTS token_azioni (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    tipo TEXT NOT NULL,
    expires_at DATETIME NOT NULL,
    usato INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS errori (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    materia TEXT, topic TEXT, question TEXT,
    user_answer TEXT, correct_answer TEXT, explanation TEXT,
    timestamp TEXT,
    valutazione_id INTEGER
  )`);

  // Compatibilità con database creati prima che ogni errore fosse collegato
  // alla simulazione che lo ha generato (serve per poterli eliminare insieme).
  const infoErrori = await db.execute("PRAGMA table_info(errori)");
  if (!infoErrori.rows.map(r => r.name).includes('valutazione_id')) {
    await db.execute("ALTER TABLE errori ADD COLUMN valutazione_id INTEGER");
    console.log('[Database] Aggiunta colonna valutazione_id alla tabella errori (database preesistente).');
  }

  await db.execute(`CREATE TABLE IF NOT EXISTS valutazioni (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    data TEXT, tipo_prova TEXT, materia_unita TEXT,
    punteggio TEXT, tempo TEXT, rateo TEXT, esito TEXT,
    errate INTEGER NOT NULL DEFAULT 0,
    omesse INTEGER NOT NULL DEFAULT 0
  )`);

  // Compatibilità con database creati prima che il conteggio di errate e
  // omesse venisse salvato insieme alla valutazione (prima veniva calcolato
  // e mostrato solo nel popup finale, poi scartato).
  const infoValutazioni = await db.execute("PRAGMA table_info(valutazioni)");
  const colonneValutazioni = infoValutazioni.rows.map(r => r.name);
  if (!colonneValutazioni.includes('errate')) {
    await db.execute("ALTER TABLE valutazioni ADD COLUMN errate INTEGER NOT NULL DEFAULT 0");
    console.log('[Database] Aggiunta colonna errate alla tabella valutazioni (database preesistente).');
  }
  if (!colonneValutazioni.includes('omesse')) {
    await db.execute("ALTER TABLE valutazioni ADD COLUMN omesse INTEGER NOT NULL DEFAULT 0");
    console.log('[Database] Aggiunta colonna omesse alla tabella valutazioni (database preesistente).');
  }

  await db.execute(`CREATE TABLE IF NOT EXISTS segnalazioni (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    email TEXT,
    categoria TEXT NOT NULL,
    messaggio TEXT NOT NULL,
    stato TEXT NOT NULL DEFAULT 'aperta',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Cronologia di domande/flashcard già generate per un utente + unità
  // didattica, usata per chiedere a Gemini di non riproporle. Legata
  // all'account (non al browser), così vale su tutti i dispositivi.
  await db.execute(`CREATE TABLE IF NOT EXISTS cronologia_domande (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    chiave TEXT NOT NULL,
    testo TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_cronologia_utente_chiave ON cronologia_domande (user_id, chiave)`);
}
initDb().catch(e => console.error('[Database] Errore inizializzazione:', e.message));

// ------------------------------------------------------------------
// Hashing (scrypt + salt, nessuna dipendenza esterna) e sessioni
// ------------------------------------------------------------------
function hashConSalt(valore) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(valore), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verificaHash(valore, saltHash) {
  const [salt, hash] = (saltHash || '').split(':');
  if (!salt || !hash) return false;
  const verifica = crypto.scryptSync(String(valore), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(verifica, 'hex'));
}

function normEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Il ruolo è deciso dalla lista ADMIN_EMAILS in Environment su Render (email
// separate da virgola), non da un flag scrivibile via API: così promuovere o
// revocare un amministratore si fa cambiando l'env var, senza endpoint dedicati
// da proteggere ulteriormente.
function ruoloPerEmail(email) {
  const ammessi = (process.env.ADMIN_EMAILS || '').split(',').map(normEmail).filter(Boolean);
  return ammessi.includes(normEmail(email)) ? 'admin' : 'studente';
}

const SESSION_DURATA_MS = 2 * 60 * 60 * 1000; // 2 ore

// ------------------------------------------------------------------
// Invio email (opzionale, via Resend). Finché RESEND_API_KEY non è
// impostata su Render, questa funzione non fa nulla e nessuna parte
// dell'app dipende da essa: registrazione e segnalazioni continuano a
// funzionare normalmente, semplicemente senza inviare email.
// ------------------------------------------------------------------
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_MITTENTE = process.env.EMAIL_MITTENTE || 'onboarding@resend.dev';
// RENDER_EXTERNAL_URL è impostata automaticamente da Render su ogni Web
// Service (es. https://tuo-progetto.onrender.com): i link nelle email
// funzionano già "di fabbrica" su Render, senza configurazione aggiuntiva.
// APP_URL resta disponibile per sovrascriverla (es. sviluppo locale, dominio custom).
const APP_URL = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

function inviaEmail(destinatario, oggetto, corpoHtml) {
  if (!RESEND_API_KEY || !destinatario) return;

  const postData = JSON.stringify({ from: EMAIL_MITTENTE, to: [destinatario], subject: oggetto, html: corpoHtml });
  const options = {
    hostname: 'api.resend.com',
    path: '/emails',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const richiesta = https.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      if (res.statusCode >= 400) console.error('[Email] Invio fallito, status', res.statusCode, ':', data.slice(0, 300));
    });
  });
  richiesta.on('error', (e) => console.error('[Email] Errore di rete verso Resend:', e.message));
  richiesta.write(postData);
  richiesta.end();
}

function bottoneEmail(link, testo) {
  return `<p><a href="${link}" style="background:#4f46e5;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block;">${testo}</a></p><p style="font-size:12px;color:#64748b;word-break:break-all;">Oppure copia questo link: ${link}</p>`;
}

function inviaEmailBenvenuto(email, tokenVerifica) {
  const link = APP_URL && tokenVerifica ? `${APP_URL}/?verifica=${tokenVerifica}` : null;
  inviaEmail(email, 'Benvenuto su Semestre Filtro Medicina 2026', `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#312e81;">Benvenuto! 🎓</h2>
      <p>Il tuo account per la piattaforma di preparazione al Semestre Filtro è attivo.</p>
      <p>Puoi iniziare subito da <strong>Syllabus & Unità Didattiche</strong>, oppure ripassare con le <strong>Flashcard</strong> prima di passare alle esercitazioni a punteggio.</p>
      ${link ? `<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;"><p><strong>Conferma la tua email</strong> per essere sicuro di ricevere le notifiche importanti:</p>${bottoneEmail(link, 'Conferma email')}` : ''}
      <p style="color:#64748b; font-size:13px; margin-top:24px;">Se non ti sei registrato tu, ignora pure questa email.</p>
    </div>
  `);
}

function inviaEmailVerifica(email, token) {
  if (!APP_URL) return; // senza URL pubblico non c'è un link utile da mandare
  const link = `${APP_URL}/?verifica=${token}`;
  inviaEmail(email, 'Conferma la tua email - Semestre Filtro Medicina', `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#312e81;">Conferma la tua email</h2>
      <p>Clicca il pulsante qui sotto per confermare che questo indirizzo è tuo:</p>
      ${bottoneEmail(link, 'Conferma email')}
      <p style="color:#64748b; font-size:13px; margin-top:24px;">Il link scade tra 24 ore. Se non hai richiesto tu questa email, ignorala pure.</p>
    </div>
  `);
}

function inviaEmailResetPin(email, token) {
  if (!APP_URL) return;
  const link = `${APP_URL}/?reset-pin=${token}`;
  inviaEmail(email, 'Reimposta il tuo PIN - Semestre Filtro Medicina', `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="color:#312e81;">Reimposta il tuo PIN</h2>
      <p>Hai richiesto di reimpostare il PIN di accesso alla piattaforma. Clicca qui sotto per sceglierne uno nuovo:</p>
      ${bottoneEmail(link, 'Reimposta PIN')}
      <p style="color:#64748b; font-size:13px; margin-top:24px;">Il link è valido 30 minuti ed è utilizzabile una sola volta. Se non hai richiesto tu questa operazione, ignora l'email: il tuo PIN attuale resterà invariato.</p>
    </div>
  `);
}

// Notifica chi ha ruolo admin quando arriva una nuova segnalazione
function inviaEmailNuovaSegnalazione(segnalazione) {
  const destinatari = (process.env.ADMIN_EMAILS || '').split(',').map(normEmail).filter(Boolean);
  destinatari.forEach(dest => {
    inviaEmail(dest, `Nuova segnalazione: ${segnalazione.categoria}`, `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h3 style="color:#312e81;">Nuova segnalazione ricevuta</h3>
        <p><strong>Da:</strong> ${segnalazione.email}</p>
        <p><strong>Categoria:</strong> ${segnalazione.categoria}</p>
        <p style="white-space:pre-line; background:#f8fafc; padding:12px; border-radius:8px;">${segnalazione.messaggio}</p>
      </div>
    `);
  });
}

async function creaSessione(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_DURATA_MS).toISOString();
  await db.execute({
    sql: 'INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)',
    args: [token, userId, expiresAt]
  });
  await db.execute({ sql: 'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', args: [userId] });
  return { token, expiresAt };
}

// Token monouso per verifica email o reset PIN via link (tabella token_azioni,
// distinta da "sessions": qui i token servono per una singola azione, non per autenticare richieste)
async function creaTokenAzione(userId, tipo, durataMs) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + durataMs).toISOString();
  await db.execute({
    sql: 'INSERT INTO token_azioni (user_id, token, tipo, expires_at) VALUES (?,?,?,?)',
    args: [userId, token, tipo, expiresAt]
  });
  return token;
}

// Verifica il Bearer token e attacca req.userId. Tutte le rotte che
// leggono o modificano i dati di un account passano da qui: prima non
// c'era nessun controllo e bastava conoscere l'id numerico di un altro
// utente (facilmente indovinabile, sono autoincrement) per leggerne o
// cancellarne i dati.
async function richiedeAutenticazione(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ errore: 'Sessione mancante, effettua di nuovo l\'accesso.' });

  try {
    const result = await db.execute({
      sql: `SELECT sessions.user_id AS user_id, sessions.expires_at AS expires_at, users.ruolo AS ruolo
            FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE sessions.token = ?`,
      args: [token]
    });
    const sessione = result.rows[0];
    if (!sessione || new Date(sessione.expires_at) < new Date()) {
      return res.status(401).json({ errore: 'Sessione scaduta, effettua di nuovo l\'accesso.' });
    }
    req.userId = Number(sessione.user_id);
    req.userRuolo = sessione.ruolo || 'studente';
    req.token = token;
    next();
  } catch (e) {
    console.error('[Auth] Errore verifica sessione:', e.message);
    res.status(500).json({ errore: 'Errore database.' });
  }
}

// Da usare dopo richiedeAutenticazione sulle rotte riservate a chi gestisce la piattaforma.
function richiedeAdmin(req, res, next) {
  if (req.userRuolo !== 'admin') return res.status(403).json({ errore: 'Accesso riservato agli amministratori.' });
  next();
}

// ------------------------------------------------------------------
// Rate limiting minimale, in memoria: sufficiente per un'app a singola
// istanza come questa senza introdurre Redis o altre dipendenze.
// ------------------------------------------------------------------
function creaLimiter({ maxTentativi, finestraMs }) {
  const tentativi = new Map();
  return function limita(chiave) {
    const ora = Date.now();
    const storico = (tentativi.get(chiave) || []).filter(t => ora - t < finestraMs);
    if (storico.length >= maxTentativi) return false;
    storico.push(ora);
    tentativi.set(chiave, storico);
    return true;
  };
}

const limitLogin = creaLimiter({ maxTentativi: 8, finestraMs: 15 * 60 * 1000 });
const limitAi = creaLimiter({ maxTentativi: 20, finestraMs: 10 * 60 * 1000 });

// --- AUTENTICAZIONE ---

app.post('/api/auth/registrati', async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const pin = String(req.body.pin || '');
    const domandaSicurezza = String(req.body.domandaSicurezza || '').trim();
    const rispostaSicurezza = String(req.body.rispostaSicurezza || '').trim();

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ errore: 'Email non valida.' });
    if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ errore: 'Il PIN deve avere tra 4 e 6 cifre numeriche.' });
    if (!domandaSicurezza || !rispostaSicurezza) return res.status(400).json({ errore: 'Domanda e risposta di sicurezza obbligatorie (servono per recuperare il PIN).' });

    const esistente = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
    if (esistente.rows.length > 0) return res.status(409).json({ errore: 'Esiste già un account con questa email. Usa "Accedi".' });

    const pinHash = hashConSalt(pin);
    const rispostaHash = hashConSalt(rispostaSicurezza.toLowerCase());
    const ruolo = ruoloPerEmail(email);

    const result = await db.execute({
      sql: 'INSERT INTO users (email, pin_hash, domanda_sicurezza, risposta_hash, ruolo) VALUES (?,?,?,?,?)',
      args: [email, pinHash, domandaSicurezza, rispostaHash, ruolo]
    });

    const userId = Number(result.lastInsertRowid);
    const { token, expiresAt } = await creaSessione(userId);
    const tokenVerifica = await creaTokenAzione(userId, 'verifica', 24 * 60 * 60 * 1000);
    inviaEmailBenvenuto(email, tokenVerifica);
    res.json({ success: true, token, expiresAt, user: { id: userId, email, ruolo, emailVerificata: false } });
  } catch (e) {
    console.error('[Auth] Errore registrazione:', e.message);
    res.status(500).json({ errore: 'Errore durante la creazione dell\'account.' });
  }
});

app.post('/api/auth/accedi', async (req, res) => {
  const email = normEmail(req.body.email);

  if (!limitLogin(email || req.ip)) {
    return res.status(429).json({ errore: 'Troppi tentativi. Riprova tra qualche minuto.' });
  }

  try {
    const pin = String(req.body.pin || '');
    const result = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
    const user = result.rows[0];
    if (!user || !verificaHash(pin, user.pin_hash)) return res.status(401).json({ errore: 'Email o PIN errati.' });

    // Se ADMIN_EMAILS è cambiata da Render, allinea il ruolo salvato senza
    // richiedere una nuova registrazione.
    const ruolo = ruoloPerEmail(user.email);
    if (ruolo !== user.ruolo) {
      await db.execute({ sql: 'UPDATE users SET ruolo = ? WHERE id = ?', args: [ruolo, user.id] });
    }

    const { token, expiresAt } = await creaSessione(user.id);
    res.json({ success: true, token, expiresAt, user: { id: Number(user.id), email: user.email, ruolo, emailVerificata: !!user.email_verificata } });
  } catch (e) {
    console.error('[Auth] Errore login:', e.message);
    res.status(500).json({ errore: 'Errore database.' });
  }
});

// Step 1 recupero PIN: restituisce la domanda di sicurezza per l'email indicata
app.post('/api/auth/domanda-sicurezza', async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const result = await db.execute({ sql: 'SELECT domanda_sicurezza FROM users WHERE email = ?', args: [email] });
    const user = result.rows[0];
    if (!user) return res.status(404).json({ errore: 'Nessun account trovato con questa email.' });
    res.json({ domandaSicurezza: user.domanda_sicurezza });
  } catch (e) {
    res.status(500).json({ errore: 'Errore database.' });
  }
});

// Step 2 recupero PIN: verifica la risposta e imposta il nuovo PIN
app.post('/api/auth/recupera-pin', async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const rispostaSicurezza = String(req.body.rispostaSicurezza || '').trim().toLowerCase();
    const nuovoPin = String(req.body.nuovoPin || '');

    if (!/^\d{4,6}$/.test(nuovoPin)) return res.status(400).json({ errore: 'Il nuovo PIN deve avere tra 4 e 6 cifre numeriche.' });

    const result = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
    const user = result.rows[0];
    if (!user || !verificaHash(rispostaSicurezza, user.risposta_hash)) return res.status(401).json({ errore: 'Risposta di sicurezza errata.' });

    const nuovoPinHash = hashConSalt(nuovoPin);
    await db.execute({ sql: 'UPDATE users SET pin_hash = ? WHERE id = ?', args: [nuovoPinHash, user.id] });
    res.json({ success: true });
  } catch (e) {
    console.error('[Auth] Errore recupero PIN:', e.message);
    res.status(500).json({ errore: 'Errore durante l\'aggiornamento del PIN.' });
  }
});

// Conferma l'email tramite il link ricevuto (nessuna autenticazione richiesta:
// deve funzionare anche aprendo il link su un browser/dispositivo diverso da
// quello con cui ci si è registrati).
app.get('/api/auth/verifica-email', async (req, res) => {
  const token = String(req.query.token || '');
  try {
    const result = await db.execute({ sql: "SELECT * FROM token_azioni WHERE token = ? AND tipo = 'verifica'", args: [token] });
    const riga = result.rows[0];
    if (!riga || riga.usato || new Date(riga.expires_at) < new Date()) {
      return res.status(400).json({ errore: 'Link di verifica non valido o scaduto.' });
    }
    await db.execute({ sql: 'UPDATE users SET email_verificata = 1 WHERE id = ?', args: [riga.user_id] });
    await db.execute({ sql: 'UPDATE token_azioni SET usato = 1 WHERE id = ?', args: [riga.id] });
    res.json({ success: true });
  } catch (e) {
    console.error('[Auth] Errore verifica email:', e.message);
    res.status(500).json({ errore: 'Errore database.' });
  }
});

// Rimanda l'email di verifica (usato dal banner "verifica la tua email" nell'app)
app.post('/api/auth/reinvia-verifica', richiedeAutenticazione, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT email, email_verificata FROM users WHERE id = ?', args: [req.userId] });
    const user = result.rows[0];
    if (!user) return res.status(404).json({ errore: 'Utente non trovato.' });
    if (user.email_verificata) return res.json({ success: true, giaVerificata: true });

    const tokenVerifica = await creaTokenAzione(req.userId, 'verifica', 24 * 60 * 60 * 1000);
    inviaEmailVerifica(user.email, tokenVerifica);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ errore: 'Errore durante l\'invio dell\'email.' });
  }
});

// Step 1 recupero PIN via email: genera e invia il link di reset. Risponde
// sempre allo stesso modo, che l'email esista o meno, per non rivelare quali
// indirizzi sono registrati sulla piattaforma.
app.post('/api/auth/richiedi-reset-pin', async (req, res) => {
  const email = normEmail(req.body.email);
  if (!limitLogin(email || req.ip)) return res.status(429).json({ errore: 'Troppi tentativi. Riprova tra qualche minuto.' });

  try {
    const result = await db.execute({ sql: 'SELECT id, email FROM users WHERE email = ?', args: [email] });
    const user = result.rows[0];
    if (user) {
      const token = await creaTokenAzione(user.id, 'reset_pin', 30 * 60 * 1000);
      inviaEmailResetPin(user.email, token);
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[Auth] Errore richiesta reset PIN:', e.message);
    res.status(500).json({ errore: 'Errore database.' });
  }
});

// Step 2 recupero PIN via email: verifica il token dal link e imposta il nuovo PIN
app.post('/api/auth/reset-pin', async (req, res) => {
  const token = String(req.body.token || '');
  const nuovoPin = String(req.body.nuovoPin || '');
  if (!/^\d{4,6}$/.test(nuovoPin)) return res.status(400).json({ errore: 'Il nuovo PIN deve avere tra 4 e 6 cifre numeriche.' });

  try {
    const result = await db.execute({ sql: "SELECT * FROM token_azioni WHERE token = ? AND tipo = 'reset_pin'", args: [token] });
    const riga = result.rows[0];
    if (!riga || riga.usato || new Date(riga.expires_at) < new Date()) {
      return res.status(400).json({ errore: 'Link di recupero non valido o scaduto. Richiedine uno nuovo.' });
    }

    const nuovoPinHash = hashConSalt(nuovoPin);
    await db.execute({ sql: 'UPDATE users SET pin_hash = ? WHERE id = ?', args: [nuovoPinHash, riga.user_id] });
    await db.execute({ sql: 'UPDATE token_azioni SET usato = 1 WHERE id = ?', args: [riga.id] });
    // Dopo un reset del PIN, invalida tutte le sessioni esistenti dell'account per sicurezza
    await db.execute({ sql: 'DELETE FROM sessions WHERE user_id = ?', args: [riga.user_id] });
    res.json({ success: true });
  } catch (e) {
    console.error('[Auth] Errore reset PIN:', e.message);
    res.status(500).json({ errore: 'Errore durante il reset del PIN.' });
  }
});

// Rinnova la sessione corrente (chiamato dal banner "sessione in scadenza").
// Ruota il token invece di allungare la scadenza di quello vecchio: se il
// vecchio token fosse stato intercettato, smette comunque di funzionare.
app.post('/api/auth/rinnova', richiedeAutenticazione, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [req.token] });
    const { token, expiresAt } = await creaSessione(req.userId);
    res.json({ success: true, token, expiresAt });
  } catch (e) {
    console.error('[Auth] Errore rinnovo sessione:', e.message);
    res.status(500).json({ errore: 'Errore durante il rinnovo della sessione.' });
  }
});

// --- SINCRONIZZAZIONE DATI (deposito errori + registro valutazioni) ---
// Ogni rotta qui sotto richiede un token valido e verifica che l'id
// nell'URL o nel body coincida con l'utente autenticato dal token.

app.get('/api/dati/:userId', richiedeAutenticazione, async (req, res) => {
  const userId = parseInt(req.params.userId);
  if (userId !== req.userId) return res.status(403).json({ errore: 'Non autorizzato.' });

  try {
    const erroriResult = await db.execute({ sql: 'SELECT * FROM errori WHERE user_id = ? ORDER BY id DESC', args: [userId] });
    const valutazioniResult = await db.execute({ sql: 'SELECT * FROM valutazioni WHERE user_id = ? ORDER BY id DESC', args: [userId] });

    res.json({
      errori: erroriResult.rows.map(e => ({ id: Number(e.id), materia: e.materia, topic: e.topic, question: e.question, userAnswer: e.user_answer, correctAnswer: e.correct_answer, explanation: e.explanation, timestamp: e.timestamp })),
      valutazioni: valutazioniResult.rows.map(v => ({ id: Number(v.id), data: v.data, tipoProva: v.tipo_prova, materiaUnita: v.materia_unita, punteggio: v.punteggio, tempo: v.tempo, rateo: v.rateo, errate: Number(v.errate || 0), omesse: Number(v.omesse || 0), esito: v.esito }))
    });
  } catch (e) {
    console.error('[Dati] Errore caricamento:', e.message);
    res.status(500).json({ errore: 'Errore database.' });
  }
});

app.post('/api/dati/errori', richiedeAutenticazione, async (req, res) => {
  const { userId, nuoviErrori, valutazioneId } = req.body;
  if (userId !== req.userId) return res.status(403).json({ errore: 'Non autorizzato.' });
  if (!Array.isArray(nuoviErrori) || nuoviErrori.length === 0) return res.json({ success: true });

  try {
    for (const e of nuoviErrori) {
      await db.execute({
        sql: 'INSERT INTO errori (user_id, materia, topic, question, user_answer, correct_answer, explanation, timestamp, valutazione_id) VALUES (?,?,?,?,?,?,?,?,?)',
        args: [userId, e.materia, e.topic, e.question, e.userAnswer, e.correctAnswer, e.explanation, e.timestamp, valutazioneId || null]
      });
    }
    res.json({ success: true });
  } catch (e) {
    console.error('[Dati] Errore salvataggio errori:', e.message);
    res.status(500).json({ errore: 'Errore salvataggio errori.' });
  }
});

// Elimina un errore dal deposito, solo se appartiene a chi fa la richiesta.
app.delete('/api/dati/errori/:id', richiedeAutenticazione, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT user_id FROM errori WHERE id = ?', args: [req.params.id] });
    const riga = result.rows[0];
    if (!riga) return res.json({ success: true });
    if (Number(riga.user_id) !== req.userId) return res.status(403).json({ errore: 'Non autorizzato.' });

    await db.execute({ sql: 'DELETE FROM errori WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ errore: 'Errore eliminazione.' });
  }
});

app.post('/api/dati/valutazione', richiedeAutenticazione, async (req, res) => {
  const { userId, valutazione } = req.body;
  if (userId !== req.userId) return res.status(403).json({ errore: 'Non autorizzato.' });
  if (!valutazione) return res.status(400).json({ errore: 'Dati mancanti.' });

  try {
    const result = await db.execute({
      sql: 'INSERT INTO valutazioni (user_id, data, tipo_prova, materia_unita, punteggio, tempo, rateo, errate, omesse, esito) VALUES (?,?,?,?,?,?,?,?,?,?)',
      args: [userId, valutazione.data, valutazione.tipoProva, valutazione.materiaUnita, valutazione.punteggio, valutazione.tempo, valutazione.rateo, valutazione.errate || 0, valutazione.omesse || 0, valutazione.esito]
    });
    res.json({ success: true, valutazioneId: Number(result.lastInsertRowid) });
  } catch (e) {
    console.error('[Dati] Errore salvataggio valutazione:', e.message);
    res.status(500).json({ errore: 'Errore salvataggio valutazione.' });
  }
});

// Diagnostica: verifica se il database è configurato su Turso o su file locale
app.get('/api/db-health', async (req, res) => {
  try {
    await db.execute('SELECT 1');
    res.json({ modalita: usaTurso ? 'Turso (persistente)' : 'file locale (non persistente su Render senza Persistent Disk)', connesso: true });
  } catch (e) {
    res.json({ modalita: usaTurso ? 'Turso (persistente)' : 'file locale', connesso: false, errore: e.message });
  }
});

// ------------------------------------------------------------------
// Area gestione (riservata a chi ha ruolo 'admin'): elenco studenti,
// statistiche aggregate, gestione account.
// ------------------------------------------------------------------

app.get('/api/admin/utenti', richiedeAutenticazione, richiedeAdmin, async (req, res) => {
  try {
    const result = await db.execute(`
      SELECT users.id AS id, users.email AS email, users.ruolo AS ruolo, users.created_at AS created_at, users.last_login AS last_login,
        (SELECT COUNT(*) FROM errori WHERE errori.user_id = users.id) AS numero_errori,
        (SELECT COUNT(*) FROM valutazioni WHERE valutazioni.user_id = users.id) AS numero_valutazioni,
        (SELECT MAX(data) FROM valutazioni WHERE valutazioni.user_id = users.id) AS ultima_valutazione
      FROM users
      ORDER BY users.created_at DESC
    `);
    res.json({
      utenti: result.rows.map(u => ({
        id: Number(u.id),
        email: u.email,
        ruolo: u.ruolo,
        creatoIl: u.created_at,
        ultimoAccesso: u.last_login || null,
        numeroErrori: Number(u.numero_errori),
        numeroValutazioni: Number(u.numero_valutazioni),
        ultimaValutazione: u.ultima_valutazione || null
      }))
    });
  } catch (e) {
    console.error('[Admin] Errore lista utenti:', e.message);
    res.status(500).json({ errore: 'Errore database.' });
  }
});

app.get('/api/admin/statistiche', richiedeAutenticazione, richiedeAdmin, async (req, res) => {
  try {
    const [utentiTot, valTot, mediaPunt, argomentiTop] = await Promise.all([
      db.execute('SELECT COUNT(*) AS n FROM users'),
      db.execute('SELECT COUNT(*) AS n FROM valutazioni'),
      db.execute('SELECT AVG(CAST(punteggio AS REAL)) AS media FROM valutazioni'),
      db.execute('SELECT materia AS materia, topic AS topic, COUNT(*) AS n FROM errori GROUP BY materia, topic ORDER BY n DESC LIMIT 10')
    ]);
    res.json({
      utentiTotali: Number(utentiTot.rows[0].n),
      valutazioniTotali: Number(valTot.rows[0].n),
      mediaPunteggio: mediaPunt.rows[0].media != null ? Number(mediaPunt.rows[0].media).toFixed(2) : null,
      argomentiPiuSbagliati: argomentiTop.rows.map(r => ({ materia: r.materia, topic: r.topic, conteggio: Number(r.n) }))
    });
  } catch (e) {
    console.error('[Admin] Errore statistiche:', e.message);
    res.status(500).json({ errore: 'Errore database.' });
  }
});

// Elimina un account studente e tutti i suoi dati. Un admin non può
// eliminare se stesso da qui, per evitare di restare fuori per errore.
app.delete('/api/admin/utenti/:id', richiedeAutenticazione, richiedeAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.userId) return res.status(400).json({ errore: 'Non puoi eliminare il tuo stesso account da qui.' });

  try {
    await db.execute({ sql: 'DELETE FROM errori WHERE user_id = ?', args: [targetId] });
    await db.execute({ sql: 'DELETE FROM valutazioni WHERE user_id = ?', args: [targetId] });
    await db.execute({ sql: 'DELETE FROM sessions WHERE user_id = ?', args: [targetId] });
    const result = await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [targetId] });
    res.json({ success: true, eliminato: result.rowsAffected > 0 });
  } catch (e) {
    console.error('[Admin] Errore eliminazione utente:', e.message);
    res.status(500).json({ errore: 'Errore durante l\'eliminazione dell\'utente.' });
  }
});

// Elenco delle simulazioni di un singolo studente, per poterne cancellare
// una fatta partire per sbaglio senza dover eliminare l'intero account.
app.get('/api/admin/utenti/:id/valutazioni', richiedeAutenticazione, richiedeAdmin, async (req, res) => {
  const targetId = parseInt(req.params.id);
  try {
    const result = await db.execute({ sql: 'SELECT * FROM valutazioni WHERE user_id = ? ORDER BY id DESC', args: [targetId] });
    res.json({
      valutazioni: result.rows.map(v => ({ id: Number(v.id), data: v.data, tipoProva: v.tipo_prova, materiaUnita: v.materia_unita, punteggio: v.punteggio, tempo: v.tempo, rateo: v.rateo, errate: Number(v.errate || 0), omesse: Number(v.omesse || 0), esito: v.esito }))
    });
  } catch (e) {
    console.error('[Admin] Errore lista simulazioni:', e.message);
    res.status(500).json({ errore: 'Errore database.' });
  }
});

// Elimina una singola simulazione (di un qualsiasi studente). A differenza
// della cancellazione di un errore da parte dello studente, qui non serve
// verificare il proprietario: chi ha ruolo admin può intervenire su
// qualunque riga, è il caso d'uso di questa rotta.
// Elimina anche gli errori depositati generati da quella specifica
// esercitazione (collegati tramite valutazione_id), non l'intero deposito.
app.delete('/api/admin/valutazioni/:id', richiedeAutenticazione, richiedeAdmin, async (req, res) => {
  try {
    const erroriEliminati = await db.execute({ sql: 'DELETE FROM errori WHERE valutazione_id = ?', args: [req.params.id] });
    const result = await db.execute({ sql: 'DELETE FROM valutazioni WHERE id = ?', args: [req.params.id] });
    res.json({ success: true, eliminato: result.rowsAffected > 0, erroriEliminati: erroriEliminati.rowsAffected });
  } catch (e) {
    console.error('[Admin] Errore eliminazione valutazione:', e.message);
    res.status(500).json({ errore: 'Errore durante l\'eliminazione della simulazione.' });
  }
});

// ------------------------------------------------------------------
// Cronologia domande/flashcard già generate (per evitare ripetizioni da
// parte di Gemini): legata all'account, non al browser.
// ------------------------------------------------------------------

const CRONOLOGIA_MAX_ELEMENTI = 60;
const CHIAVE_CRONOLOGIA_VALIDA = /^[a-z0-9_-]{1,100}$/i;

app.get('/api/cronologia/:chiave', richiedeAutenticazione, async (req, res) => {
  if (!CHIAVE_CRONOLOGIA_VALIDA.test(req.params.chiave)) return res.status(400).json({ errore: 'Chiave non valida.' });

  try {
    const result = await db.execute({
      sql: 'SELECT testo FROM cronologia_domande WHERE user_id = ? AND chiave = ? ORDER BY id ASC',
      args: [req.userId, req.params.chiave]
    });
    res.json({ elementi: result.rows.map(r => r.testo) });
  } catch (e) {
    console.error('[Cronologia] Errore lettura:', e.message);
    res.status(500).json({ errore: 'Errore database.' });
  }
});

app.post('/api/cronologia/:chiave', richiedeAutenticazione, async (req, res) => {
  if (!CHIAVE_CRONOLOGIA_VALIDA.test(req.params.chiave)) return res.status(400).json({ errore: 'Chiave non valida.' });

  const elementi = Array.isArray(req.body.elementi) ? req.body.elementi : [];
  if (elementi.length === 0) return res.json({ success: true });

  try {
    for (const testo of elementi) {
      await db.execute({
        sql: 'INSERT INTO cronologia_domande (user_id, chiave, testo) VALUES (?,?,?)',
        args: [req.userId, req.params.chiave, String(testo).slice(0, 500)]
      });
    }
    // Mantiene solo gli ultimi CRONOLOGIA_MAX_ELEMENTI per questo utente+chiave,
    // altrimenti la cronologia (e quindi il prompt) crescerebbe senza limite
    await db.execute({
      sql: `DELETE FROM cronologia_domande WHERE user_id = ? AND chiave = ? AND id NOT IN (
        SELECT id FROM cronologia_domande WHERE user_id = ? AND chiave = ? ORDER BY id DESC LIMIT ?
      )`,
      args: [req.userId, req.params.chiave, req.userId, req.params.chiave, CRONOLOGIA_MAX_ELEMENTI]
    });
    res.json({ success: true });
  } catch (e) {
    console.error('[Cronologia] Errore salvataggio:', e.message);
    res.status(500).json({ errore: 'Errore salvataggio cronologia.' });
  }
});

// ------------------------------------------------------------------
// Segnalazioni ("Contattaci"): bug o suggerimenti mandati dagli studenti.
// ------------------------------------------------------------------

const CATEGORIE_SEGNALAZIONE = ['Bug / errore tecnico', 'Errore nei contenuti', 'Suggerimento', 'Altro'];

app.post('/api/segnalazioni', richiedeAutenticazione, async (req, res) => {
  const categoria = String(req.body.categoria || '').trim();
  const messaggio = String(req.body.messaggio || '').trim();
  if (!CATEGORIE_SEGNALAZIONE.includes(categoria)) return res.status(400).json({ errore: 'Categoria non valida.' });
  if (!messaggio || messaggio.length > 2000) return res.status(400).json({ errore: 'Messaggio mancante o troppo lungo (max 2000 caratteri).' });

  try {
    const utente = await db.execute({ sql: 'SELECT email FROM users WHERE id = ?', args: [req.userId] });
    const email = utente.rows[0] ? utente.rows[0].email : null;

    await db.execute({
      sql: 'INSERT INTO segnalazioni (user_id, email, categoria, messaggio) VALUES (?,?,?,?)',
      args: [req.userId, email, categoria, messaggio]
    });
    inviaEmailNuovaSegnalazione({ email, categoria, messaggio });
    res.json({ success: true });
  } catch (e) {
    console.error('[Segnalazioni] Errore salvataggio:', e.message);
    res.status(500).json({ errore: 'Errore durante l\'invio della segnalazione.' });
  }
});

// Storico delle proprie segnalazioni (per mostrare allo studente lo stato)
app.get('/api/segnalazioni', richiedeAutenticazione, async (req, res) => {
  try {
    const result = await db.execute({ sql: 'SELECT * FROM segnalazioni WHERE user_id = ? ORDER BY id DESC', args: [req.userId] });
    res.json({
      segnalazioni: result.rows.map(s => ({ id: Number(s.id), categoria: s.categoria, messaggio: s.messaggio, stato: s.stato, createdAt: s.created_at }))
    });
  } catch (e) {
    res.status(500).json({ errore: 'Errore database.' });
  }
});

app.get('/api/admin/segnalazioni', richiedeAutenticazione, richiedeAdmin, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM segnalazioni ORDER BY id DESC');
    res.json({
      segnalazioni: result.rows.map(s => ({ id: Number(s.id), email: s.email, categoria: s.categoria, messaggio: s.messaggio, stato: s.stato, createdAt: s.created_at }))
    });
  } catch (e) {
    res.status(500).json({ errore: 'Errore database.' });
  }
});

app.patch('/api/admin/segnalazioni/:id', richiedeAutenticazione, richiedeAdmin, async (req, res) => {
  const stato = String(req.body.stato || '');
  if (!['aperta', 'risolta'].includes(stato)) return res.status(400).json({ errore: 'Stato non valido.' });

  try {
    await db.execute({ sql: 'UPDATE segnalazioni SET stato = ? WHERE id = ?', args: [stato, req.params.id] });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ errore: 'Errore durante l\'aggiornamento.' });
  }
});

// Backup completo in JSON (tutto tranne le credenziali: hash del PIN e
// della risposta di sicurezza non vengono mai esportati).
app.get('/api/admin/backup', richiedeAutenticazione, richiedeAdmin, async (req, res) => {
  try {
    const [utenti, errori, valutazioni, segnalazioni] = await Promise.all([
      db.execute('SELECT id, email, ruolo, created_at, last_login FROM users ORDER BY id'),
      db.execute('SELECT * FROM errori ORDER BY id'),
      db.execute('SELECT * FROM valutazioni ORDER BY id'),
      db.execute('SELECT * FROM segnalazioni ORDER BY id')
    ]);
    res.setHeader('Content-Disposition', `attachment; filename="backup-semestre-filtro-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({
      generatoIl: new Date().toISOString(),
      utenti: utenti.rows,
      errori: errori.rows,
      valutazioni: valutazioni.rows,
      segnalazioni: segnalazioni.rows
    });
  } catch (e) {
    console.error('[Admin] Errore generazione backup:', e.message);
    res.status(500).json({ errore: 'Errore durante la generazione del backup.' });
  }
});

// ------------------------------------------------------------------
// Generazione contenuti via Gemini (esercitazioni e lezioni di recupero)
// ------------------------------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Alias gestito da Google che punta sempre al modello Flash stabile più
// recente, così l'app non si rompe a ogni dismissione di modello.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

function chiamaGemini(prompt, callback) {
  if (!GEMINI_API_KEY) {
    console.error('[Gemini] GEMINI_API_KEY non è impostata nelle Environment Variables di Render.');
    return callback('Chiave GEMINI_API_KEY non configurata sul server (Render → Environment).', null);
  }

  const postData = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${GEMINI_MODEL}:generateContent`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const richiesta = https.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (e) {
        console.error('[Gemini] Risposta non-JSON, status', res.statusCode, ':', data.slice(0, 500));
        return callback(`Risposta non valida da Gemini (status ${res.statusCode}).`, null);
      }

      if (parsed.error) {
        console.error('[Gemini] Errore API, status', res.statusCode, ':', JSON.stringify(parsed.error));
        return callback(`Gemini API (status ${res.statusCode}): ${parsed.error.message || 'errore sconosciuto'}`, null);
      }

      const testo = parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content && parsed.candidates[0].content.parts[0] && parsed.candidates[0].content.parts[0].text;
      if (testo) return callback(null, testo);

      const finishReason = parsed.candidates && parsed.candidates[0] ? parsed.candidates[0].finishReason : null;
      console.error('[Gemini] Risposta senza testo utilizzabile:', JSON.stringify(parsed).slice(0, 500));
      callback(`Risposta Gemini vuota${finishReason ? ' (motivo: ' + finishReason + ')' : ''}.`, null);
    });
  });

  richiesta.on('error', (e) => {
    console.error('[Gemini] Errore di rete verso Google:', e.message);
    callback(`Errore di connessione a Gemini: ${e.message}`, null);
  });
  richiesta.write(postData);
  richiesta.end();
}

// Endpoint diagnostico: verifica se la chiave è configurata e se Gemini risponde davvero
app.get('/api/health', (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.json({ chiaveConfigurata: false, modello: GEMINI_MODEL, gemini: 'GEMINI_API_KEY assente su Render' });
  }
  chiamaGemini('Rispondi solo con la parola: OK', (err, risposta) => {
    if (err) return res.json({ chiaveConfigurata: true, modello: GEMINI_MODEL, gemini: `ERRORE: ${err}` });
    res.json({ chiaveConfigurata: true, modello: GEMINI_MODEL, gemini: `OK, risposta: ${risposta.trim()}` });
  });
});

app.post('/api/generate-quiz', richiedeAutenticazione, (req, res) => {
  if (!limitAi(req.userId)) return res.status(429).json({ errore: 'Troppe richieste ravvicinate, attendi qualche minuto.' });

  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ errore: 'Prompt mancante.' });

  chiamaGemini(prompt, (err, risposta) => {
    if (err) return res.status(500).json({ errore: err });
    res.json({ result: risposta });
  });
});

app.post('/api/genera-lezione', richiedeAutenticazione, (req, res) => {
  if (!limitAi(req.userId)) return res.status(429).json({ errore: 'Troppe richieste ravvicinate, attendi qualche minuto.' });

  const { argomento, profondita } = req.body;
  if (!argomento) return res.status(400).json({ errore: 'Argomento mancante.' });

  const prompt = `Fornisci una lezione di recupero di livello ${profondita} sull'argomento: "${argomento}". Strutturala con introduzione, punti chiave, spiegazione approfondita ed esempi pratici.`;

  chiamaGemini(prompt, (err, risposta) => {
    if (err) return res.status(500).json({ errore: err });
    res.json({ lezione: risposta });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server attivo sulla porta ${PORT}`));
