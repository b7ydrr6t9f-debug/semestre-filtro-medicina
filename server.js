const express = require('express');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@libsql/client');
const app = express();

app.use(express.json());

// 1. Serve i file statici dalla cartella 'public'
app.use(express.static(path.join(__dirname, 'public')));

// 2. Quando si visita la home page (/), carica public/index.html
app.get('/', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// DATABASE (libSQL) - account, deposito errori, registro valutazioni
//
// Se TURSO_DATABASE_URL è impostata (Environment Variables su Render),
// i dati vengono salvati su Turso (cloud, gratuito, persistente per sempre).
// Altrimenti si usa un file locale "database.sqlite": funziona, ma su
// Render senza Persistent Disk viene azzerato ad ogni redeploy/riavvio.
// ============================================================
const usaTurso = !!process.env.TURSO_DATABASE_URL;
const db = createClient({
url: process.env.TURSO_DATABASE_URL || 'file:database.sqlite',
authToken: process.env.TURSO_AUTH_TOKEN
});
console.log(`[Database] Modalità: ${usaTurso ? 'Turso (cloud, persistente)' : 'file locale (NON persistente su Render senza Persistent Disk)'}`);

async function initDb() {
await db.execute(`CREATE TABLE IF NOT EXISTS users (
id INTEGER PRIMARY KEY AUTOINCREMENT,
email TEXT UNIQUE NOT NULL,
pin_hash TEXT NOT NULL,
domanda_sicurezza TEXT NOT NULL,
risposta_hash TEXT NOT NULL,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

// Hash con salt per PIN e risposta di sicurezza (scrypt, nessuna dipendenza esterna)
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

res.json({ success: true, user: { id: Number(result.lastInsertRowid), email } });
} catch (e) {
console.error('[Auth] Errore registrazione:', e.message);
res.status(500).json({ errore: 'Errore durante la creazione dell\'account.' });
}
});

app.post('/api/auth/accedi', async (req, res) => {
try {
const email = normEmail(req.body.email);
const pin = String(req.body.pin || '');

const result = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email] });
const user = result.rows[0];
if (!user || !verificaHash(pin, user.pin_hash)) return res.status(401).json({ errore: 'Email o PIN errati.' });
res.json({ success: true, user: { id: Number(user.id), email: user.email } });
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

// Carica tutti i dati dell'utente al login
app.get('/api/dati/:userId', async (req, res) => {
try {
const userId = parseInt(req.params.userId);
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

// Aggiunge nuovi errori dopo un'esercitazione
app.post('/api/dati/errori', async (req, res) => {
try {
const { userId, nuoviErrori } = req.body;
if (!userId || !Array.isArray(nuoviErrori) || nuoviErrori.length === 0) return res.json({ success: true });

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

// Elimina un errore dal deposito (dopo averlo "spulciato" e ripassato)
app.delete('/api/dati/errori/:id', async (req, res) => {
try {
await db.execute({ sql: 'DELETE FROM errori WHERE id = ?', args: [req.params.id] });
res.json({ success: true });
} catch (e) {
res.status(500).json({ errore: 'Errore eliminazione.' });
}
});

// Registra una nuova valutazione completata
app.post('/api/dati/valutazione', async (req, res) => {
try {
const { userId, valutazione } = req.body;
if (!userId || !valutazione) return res.status(400).json({ errore: 'Dati mancanti.' });

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
res.json({ modalita: usaTurso ? 'Turso (persistente)' : 'file locale (NON persistente su Render senza Persistent Disk)', connesso: true });
} catch (e) {
res.json({ modalita: usaTurso ? 'Turso (persistente)' : 'file locale', connesso: false, errore: e.message });
}
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Alias auto-aggiornato da Google al modello Flash stabile più recente (oggi punta a Gemini 3.5 Flash)
// così l'app non si rompe più ad ogni dismissione di modello come successo con gemini-2.5-flash
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';

function chiamaGemini(prompt, callback) {
// Fallisce subito con un messaggio chiaro se la chiave non è configurata su Render
if (!GEMINI_API_KEY) {
console.error('[Gemini] GEMINI_API_KEY non è impostata nelle Environment Variables di Render.');
return callback('Chiave GEMINI_API_KEY non configurata sul server (Render → Environment).', null);
}

const postData = JSON.stringify({
contents: [{ parts: [{ text: prompt }] }]
});

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

const req = https.request(options, (res) => {
let data = '';
res.on('data', (chunk) => data += chunk);
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

if (parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content && parsed.candidates[0].content.parts[0].text) {
return callback(null, parsed.candidates[0].content.parts[0].text);
}

const finishReason = parsed.candidates && parsed.candidates[0] ? parsed.candidates[0].finishReason : null;
console.error('[Gemini] Risposta senza testo utilizzabile:', JSON.stringify(parsed).slice(0, 500));
callback(`Risposta Gemini vuota${finishReason ? ' (motivo: ' + finishReason + ')' : ''}.`, null);
});
});

req.on('error', (e) => {
console.error('[Gemini] Errore di rete verso Google:', e.message);
callback(`Errore di connessione a Gemini: ${e.message}`, null);
});
req.write(postData);
req.end();
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

// Rotta usata dal frontend (Generatore Quiz AI) - il frontend invia già il prompt completo
app.post('/api/generate-quiz', (req, res) => {
const { prompt } = req.body;
if (!prompt) return res.status(400).json({ errore: 'Prompt mancante.' });

chiamaGemini(prompt, (err, risposta) => {
if (err) return res.status(500).json({ errore: err });
res.json({ result: risposta });
});
});

app.post('/api/genera-lezione', (req, res) => {
const { argomento, profondita } = req.body;
const prompt = `Fornisci una lezione di recupero di livello ${profondita} sull'argomento: "${argomento}". Strutturala con introduzione, punti chiave, spiegazione approfondita ed esempi pratici.`;

chiamaGemini(prompt, (err, risposta) => {
if (err) return res.status(500).json({ errore: err });
res.json({ lezione: risposta });
});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server attivo sulla porta ${PORT}`));
