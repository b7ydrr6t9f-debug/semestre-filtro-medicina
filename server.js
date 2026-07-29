const express = require('express');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const app = express();

app.use(express.json());

// 1. Serve i file statici dalla cartella 'public'
app.use(express.static(path.join(__dirname, 'public')));

// 2. Quando si visita la home page (/), carica public/index.html
app.get('/', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// DATABASE SQLITE (account, deposito errori, registro valutazioni)
// NOTA: su Render senza un Persistent Disk collegato, il filesystem
// è EFFIMERO: ad ogni redeploy/riavvio il database viene azzerato.
// Per una persistenza reale servirebbe un Persistent Disk (a pagamento
// su Render) montato su questa cartella.
// ============================================================
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));

db.serialize(() => {
db.run(`CREATE TABLE IF NOT EXISTS users (
id INTEGER PRIMARY KEY AUTOINCREMENT,
email TEXT UNIQUE NOT NULL,
pin_hash TEXT NOT NULL,
domanda_sicurezza TEXT NOT NULL,
risposta_hash TEXT NOT NULL,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.run(`CREATE TABLE IF NOT EXISTS errori (
id INTEGER PRIMARY KEY AUTOINCREMENT,
user_id INTEGER NOT NULL,
materia TEXT, topic TEXT, question TEXT,
user_answer TEXT, correct_answer TEXT, explanation TEXT,
timestamp TEXT,
FOREIGN KEY(user_id) REFERENCES users(id)
)`);

db.run(`CREATE TABLE IF NOT EXISTS valutazioni (
id INTEGER PRIMARY KEY AUTOINCREMENT,
user_id INTEGER NOT NULL,
data TEXT, tipo_prova TEXT, materia_unita TEXT,
punteggio TEXT, tempo TEXT, rateo TEXT, esito TEXT,
FOREIGN KEY(user_id) REFERENCES users(id)
)`);
});

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

app.post('/api/auth/registrati', (req, res) => {
const email = normEmail(req.body.email);
const pin = String(req.body.pin || '');
const domandaSicurezza = String(req.body.domandaSicurezza || '').trim();
const rispostaSicurezza = String(req.body.rispostaSicurezza || '').trim();

if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ errore: 'Email non valida.' });
if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ errore: 'Il PIN deve avere tra 4 e 6 cifre numeriche.' });
if (!domandaSicurezza || !rispostaSicurezza) return res.status(400).json({ errore: 'Domanda e risposta di sicurezza obbligatorie (servono per recuperare il PIN).' });

db.get('SELECT id FROM users WHERE email = ?', [email], (err, row) => {
if (err) return res.status(500).json({ errore: 'Errore database.' });
if (row) return res.status(409).json({ errore: 'Esiste già un account con questa email. Usa "Accedi".' });

const pinHash = hashConSalt(pin);
const rispostaHash = hashConSalt(rispostaSicurezza.toLowerCase());

db.run('INSERT INTO users (email, pin_hash, domanda_sicurezza, risposta_hash) VALUES (?,?,?,?)',
[email, pinHash, domandaSicurezza, rispostaHash], function (err2) {
if (err2) return res.status(500).json({ errore: 'Errore durante la creazione dell\'account.' });
res.json({ success: true, user: { id: this.lastID, email } });
});
});
});

app.post('/api/auth/accedi', (req, res) => {
const email = normEmail(req.body.email);
const pin = String(req.body.pin || '');

db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
if (err) return res.status(500).json({ errore: 'Errore database.' });
if (!user || !verificaHash(pin, user.pin_hash)) return res.status(401).json({ errore: 'Email o PIN errati.' });
res.json({ success: true, user: { id: user.id, email: user.email } });
});
});

// Step 1 recupero PIN: restituisce la domanda di sicurezza per l'email indicata
app.post('/api/auth/domanda-sicurezza', (req, res) => {
const email = normEmail(req.body.email);
db.get('SELECT domanda_sicurezza FROM users WHERE email = ?', [email], (err, user) => {
if (err) return res.status(500).json({ errore: 'Errore database.' });
if (!user) return res.status(404).json({ errore: 'Nessun account trovato con questa email.' });
res.json({ domandaSicurezza: user.domanda_sicurezza });
});
});

// Step 2 recupero PIN: verifica la risposta e imposta il nuovo PIN
app.post('/api/auth/recupera-pin', (req, res) => {
const email = normEmail(req.body.email);
const rispostaSicurezza = String(req.body.rispostaSicurezza || '').trim().toLowerCase();
const nuovoPin = String(req.body.nuovoPin || '');

if (!/^\d{4,6}$/.test(nuovoPin)) return res.status(400).json({ errore: 'Il nuovo PIN deve avere tra 4 e 6 cifre numeriche.' });

db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
if (err) return res.status(500).json({ errore: 'Errore database.' });
if (!user || !verificaHash(rispostaSicurezza, user.risposta_hash)) return res.status(401).json({ errore: 'Risposta di sicurezza errata.' });

const nuovoPinHash = hashConSalt(nuovoPin);
db.run('UPDATE users SET pin_hash = ? WHERE id = ?', [nuovoPinHash, user.id], (err2) => {
if (err2) return res.status(500).json({ errore: 'Errore durante l\'aggiornamento del PIN.' });
res.json({ success: true });
});
});
});

// --- SINCRONIZZAZIONE DATI (deposito errori + registro valutazioni) ---

// Carica tutti i dati dell'utente al login
app.get('/api/dati/:userId', (req, res) => {
const userId = parseInt(req.params.userId);
db.all('SELECT * FROM errori WHERE user_id = ? ORDER BY id DESC', [userId], (err, errori) => {
if (err) return res.status(500).json({ errore: 'Errore database.' });
db.all('SELECT * FROM valutazioni WHERE user_id = ? ORDER BY id DESC', [userId], (err2, valutazioni) => {
if (err2) return res.status(500).json({ errore: 'Errore database.' });
res.json({
errori: errori.map(e => ({ id: e.id, materia: e.materia, topic: e.topic, question: e.question, userAnswer: e.user_answer, correctAnswer: e.correct_answer, explanation: e.explanation, timestamp: e.timestamp })),
valutazioni: valutazioni.map(v => ({ data: v.data, tipoProva: v.tipo_prova, materiaUnita: v.materia_unita, punteggio: v.punteggio, tempo: v.tempo, rateo: v.rateo, esito: v.esito }))
});
});
});
});

// Aggiunge nuovi errori dopo un'esercitazione
app.post('/api/dati/errori', (req, res) => {
const { userId, nuoviErrori } = req.body;
if (!userId || !Array.isArray(nuoviErrori) || nuoviErrori.length === 0) return res.json({ success: true });

const stmt = db.prepare('INSERT INTO errori (user_id, materia, topic, question, user_answer, correct_answer, explanation, timestamp) VALUES (?,?,?,?,?,?,?,?)');
nuoviErrori.forEach(e => {
stmt.run(userId, e.materia, e.topic, e.question, e.userAnswer, e.correctAnswer, e.explanation, e.timestamp);
});
stmt.finalize(err => {
if (err) return res.status(500).json({ errore: 'Errore salvataggio errori.' });
res.json({ success: true });
});
});

// Elimina un errore dal deposito (dopo averlo "spulciato" e ripassato)
app.delete('/api/dati/errori/:id', (req, res) => {
db.run('DELETE FROM errori WHERE id = ?', [req.params.id], err => {
if (err) return res.status(500).json({ errore: 'Errore eliminazione.' });
res.json({ success: true });
});
});

// Registra una nuova valutazione completata
app.post('/api/dati/valutazione', (req, res) => {
const { userId, valutazione } = req.body;
if (!userId || !valutazione) return res.status(400).json({ errore: 'Dati mancanti.' });

db.run('INSERT INTO valutazioni (user_id, data, tipo_prova, materia_unita, punteggio, tempo, rateo, esito) VALUES (?,?,?,?,?,?,?,?)',
[userId, valutazione.data, valutazione.tipoProva, valutazione.materiaUnita, valutazione.punteggio, valutazione.tempo, valutazione.rateo, valutazione.esito],
err => {
if (err) return res.status(500).json({ errore: 'Errore salvataggio valutazione.' });
res.json({ success: true });
});
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

// Google ha risposto con un errore esplicito (chiave non valida, modello inesistente, quota, ecc.)
if (parsed.error) {
console.error('[Gemini] Errore API, status', res.statusCode, ':', JSON.stringify(parsed.error));
return callback(`Gemini API (status ${res.statusCode}): ${parsed.error.message || 'errore sconosciuto'}`, null);
}

if (parsed.candidates && parsed.candidates[0] && parsed.candidates[0].content && parsed.candidates[0].content.parts[0].text) {
return callback(null, parsed.candidates[0].content.parts[0].text);
}

// Caso tipico: risposta bloccata dai filtri di sicurezza (finishReason SAFETY, ecc.)
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
