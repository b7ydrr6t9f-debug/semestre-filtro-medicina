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
    timestamp TEXT
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS valutazioni (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    data TEXT, tipo_prova TEXT, materia_unita TEXT,
    punteggio TEXT, tempo TEXT, rateo TEXT, esito TEXT
  )`);
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

const SESSION_DURATA_MS = 30 * 24 * 60 * 60 * 1000; // 30 giorni

async function creaSessione(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const scadenza = new Date(Date.now() + SESSION_DURATA_MS).toISOString();
  await db.execute({
    sql: 'INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)',
    args: [token, userId, scadenza]
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
    const result = await db.execute({ sql: 'SELECT user_id, expires_at FROM sessions WHERE token = ?', args: [token] });
    const sessione = result.rows[0];
    if (!sessione || new Date(sessione.expires_at) < new Date()) {
      return res.status(401).json({ errore: 'Sessione scaduta, effettua di nuovo l\'accesso.' });
    }
    req.userId = Number(sessione.user_id);
    next();
  } catch (e) {
    console.error('[Auth] Errore verifica sessione:', e.message);
    res.status(500).json({ errore: 'Errore database.' });
  }
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

    const result = await db.execute({
      sql: 'INSERT INTO users (email, pin_hash, domanda_sicurezza, risposta_hash) VALUES (?,?,?,?)',
      args: [email, pinHash, domandaSicurezza, rispostaHash]
    });

    const userId = Number(result.lastInsertRowid);
    const token = await creaSessione(userId);
    res.json({ success: true, token, user: { id: userId, email } });
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

    const token = await creaSessione(user.id);
    res.json({ success: true, token, user: { id: Number(user.id), email: user.email } });
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
      valutazioni: valutazioniResult.rows.map(v => ({ data: v.data, tipoProva: v.tipo_prova, materiaUnita: v.materia_unita, punteggio: v.punteggio, tempo: v.tempo, rateo: v.rateo, esito: v.esito }))
    });
  } catch (e) {
    console.error('[Dati] Errore caricamento:', e.message);
    res.status(500).json({ errore: 'Errore database.' });
  }
});

app.post('/api/dati/errori', richiedeAutenticazione, async (req, res) => {
  const { userId, nuoviErrori } = req.body;
  if (userId !== req.userId) return res.status(403).json({ errore: 'Non autorizzato.' });
  if (!Array.isArray(nuoviErrori) || nuoviErrori.length === 0) return res.json({ success: true });

  try {
    for (const e of nuoviErrori) {
      await db.execute({
        sql: 'INSERT INTO errori (user_id, materia, topic, question, user_answer, correct_answer, explanation, timestamp) VALUES (?,?,?,?,?,?,?,?)',
        args: [userId, e.materia, e.topic, e.question, e.userAnswer, e.correctAnswer, e.explanation, e.timestamp]
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
    await db.execute({
      sql: 'INSERT INTO valutazioni (user_id, data, tipo_prova, materia_unita, punteggio, tempo, rateo, esito) VALUES (?,?,?,?,?,?,?,?)',
      args: [userId, valutazione.data, valutazione.tipoProva, valutazione.materiaUnita, valutazione.punteggio, valutazione.tempo, valutazione.rateo, valutazione.esito]
    });
    res.json({ success: true });
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
