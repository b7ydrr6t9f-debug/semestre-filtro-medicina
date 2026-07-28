const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database SQLite
const db = new sqlite3.Database('./database.sqlite', (err) => {
if (err) console.error("Errore DB:", err.message);
else console.log("Database SQLite connesso.");
});

// Tabelle
db.serialize(() => {
db.run(`CREATE TABLE IF NOT EXISTS users (
id INTEGER PRIMARY KEY AUTOINCREMENT,
name TEXT UNIQUE,
email TEXT UNIQUE,
pin TEXT,
recovery_answer TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS exercises (
id INTEGER PRIMARY KEY AUTOINCREMENT,
user_id INTEGER,
type TEXT,
subject TEXT,
unit TEXT,
questions_json TEXT,
answers_json TEXT,
score REAL,
correct_count INTEGER,
wrong_count INTEGER,
omitted_count INTEGER,
time_spent TEXT,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
});

// Chiamata API Gemini con Risposta JSON Forzata
function callGeminiAPI(prompt, isJsonMode = true) {
return new Promise((resolve, reject) => {
if (!GEMINI_API_KEY) {
return reject(new Error("GEMINI_API_KEY non configurata su Render."));
}

const payload = {
contents: [{ parts: [{ text: prompt }] }],
generationConfig: {
maxOutputTokens: 8192,
temperature: 0.1
}
};

if (isJsonMode) {
payload.generationConfig.response_mime_type = "application/json";
}

const data = JSON.stringify(payload);

const options = {
hostname: 'generativelanguage.googleapis.com',
port: 443,
path: `/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Content-Length': Buffer.byteLength(data)
}
};

const req = https.request(options, (res) => {
let body = '';
res.on('data', (chunk) => body += chunk);
res.on('end', () => {
try {
const response = JSON.parse(body);
if (response.candidates && response.candidates[0] && response.candidates[0].content && response.candidates[0].content.parts[0].text) {
resolve(response.candidates[0].content.parts[0].text);
} else if (response.error) {
reject(new Error("API Error: " + response.error.message));
} else {
reject(new Error("Risposta vuota o incompleta da parte dell'API."));
}
} catch (e) {
reject(new Error("Errore nel parsing della risposta API: " + e.message));
}
});
});

req.on('error', (error) => reject(error));
req.write(data);
req.end();
});
}

// Rotte Autenticazione
app.post('/api/register', (req, res) => {
const { name, email, pin, recoveryAnswer } = req.body;
if (!name || !email || !pin) return res.status(400).json({ error: "Dati incompleti." });

db.run(
`INSERT INTO users (name, email, pin, recovery_answer) VALUES (?, ?, ?, ?)`,
[name, email, pin, recoveryAnswer || 'medicina2026'],
function (err) {
if (err) return res.status(400).json({ error: "Utente o Email già registrati." });
res.json({ id: this.lastID, name, email });
}
);
});

app.post('/api/login', (req, res) => {
const { email, pin } = req.body;
db.get(`SELECT * FROM users WHERE email = ? AND pin = ?`, [email, pin], (err, row) => {
if (err || !row) return res.status(401).json({ error: "Credenziali errate." });
res.json({ id: row.id, name: row.name, email: row.email });
});
});

app.post('/api/recover-pin', (req, res) => {
const { email, recoveryAnswer } = req.body;
db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, row) => {
if (err || !row) return res.status(404).json({ error: "Email non trovata." });
if (row.recovery_answer && recoveryAnswer && row.recovery_answer.toLowerCase() !== recoveryAnswer.toLowerCase()) {
return res.status(400).json({ error: "Risposta di sicurezza errata." });
}
res.json({ pin: row.pin });
});
});

// Generazione Test (31 Domande, 5 Opzioni Ciascuna)
app.post('/api/generate-exercise', async (req, res) => {
const { subject, unit, mode, errorTopics } = req.body;

let targetScope = `materia "${subject}" e unità "${unit}"`;
if (mode === 'weekend' && errorTopics) {
targetScope = `argomenti in cui lo studente ha sbagliato: ${errorTopics}`;
}

const prompt = `Sei un docente universitario per il test di Medicina Syllabus 2026.
Genera un test da ESATTAMENTE 31 domande per ${targetScope}:
- Domande 1-21: Risposta multipla (type: "multiple").
- Domande 22-31: Completamento (type: "fill", con '___' nel testo della domanda).

STRUTTURA OBBLIGATORIA DEL JSON:
Restituisci un oggetto JSON con la chiave "questions" contenente un array di 31 oggetti.
Ogni oggetto deve avere:
- "id": numero da 1 a 31
- "type": "multiple" o "fill"
- "question": testo breve e chiaro
- "options": array di ESATTAMENTE 5 stringhe (A, B, C, D, E)
- "correct": numero intero da 0 a 4
- "explanation": breve spiegazione concisa (massimo 15 parole)

Esempio:
{
"questions": [
{
"id": 1,
"type": "multiple",
"question": "Qual è la formula della velocità?",
"options": ["v=s/t", "v=s*t", "v=m*a", "v=F/a", "v=p*v"],
"correct": 0,
"explanation": "La velocità è il rapporto tra spazio e tempo."
}
]
}`;

try {
const aiText = await callGeminiAPI(prompt, true);
const exerciseData = JSON.parse(aiText);
res.json(exerciseData);
} catch (err) {
console.error("Errore Generazione Test:", err.message);
res.status(500).json({ error: "Errore generazione: " + err.message });
}
});

// Generazione Lezione di Recupero
app.post('/api/generate-lesson', async (req, res) => {
const { topic, depth } = req.body;

const depthPrompt = depth === 'fast'
? "Spiegazione sintetica e rapida in bullet points con concetti chiave e formule essenziali."
: "Lezione completa, approfondita con teoria, esempi e trucchi per il test di Medicina.";

const prompt = `Sei un tutor per il test di Medicina 2026.
Prepara una lezione su: "${topic}".
Livello: ${depthPrompt}.
Usa formattazione HTML con tag <h3>, <ul>, <li>, <strong>, <blockquote>. Non includere <html> o <body>.`;

try {
const lessonHtml = await callGeminiAPI(prompt, false);
res.json({ lesson: lessonHtml });
} catch (err) {
res.status(500).json({ error: "Impossibile generare la lezione: " + err.message });
}
});

// Salvataggio Risultati
app.post('/api/save-exercise', (req, res) => {
const { userId, type, subject, unit, questions, answers, score, correctCount, wrongCount, omittedCount, timeSpent } = req.body;

db.run(
`INSERT INTO exercises (user_id, type, subject, unit, questions_json, answers_json, score, correct_count, wrong_count, omitted_count, time_spent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
[userId, type || 'Giornaliera', subject, unit, JSON.stringify(questions), JSON.stringify(answers), score, correctCount, wrongCount, omittedCount, timeSpent],
function (err) {
if (err) return res.status(500).json({ error: "Errore salvataggio." });
res.json({ success: true, exerciseId: this.lastID });
}
);
});

// Storico
app.get('/api/user-history/:userId', (req, res) => {
const { userId } = req.params;
db.all(`SELECT * FROM exercises WHERE user_id = ? ORDER BY created_at DESC`, [userId], (err, rows) => {
if (err) return res.status(500).json({ error: "Errore recupero storico." });
res.json(rows);
});
});

app.get('*', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server attivo su porta ${PORT}`));

