const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 10000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

app.use(express.json());

// Database SQLite
const db = new sqlite3.Database('./database.sqlite', (err) => {
if (err) console.error("Errore DB:", err.message);
else console.log("Database SQLite connesso.");
});

// Tabelle DB
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
subject TEXT,
unit TEXT,
type TEXT DEFAULT 'ordinaria',
questions_json TEXT,
answers_json TEXT,
score INTEGER,
time_taken_sec INTEGER DEFAULT 0,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
});

// Funzione Helper per chiamata a Gemini API
function callGeminiAPI(prompt) {
return new Promise((resolve, reject) => {
if (!GEMINI_API_KEY) {
return reject(new Error("GEMINI_API_KEY non configurata su Render."));
}

const data = JSON.stringify({
contents: [{ parts: [{ text: prompt }] }]
});

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
if (response.candidates && response.candidates[0].content && response.candidates[0].content.parts[0].text) {
resolve(response.candidates[0].content.parts[0].text);
} else {
reject(new Error("Risposta API Gemini non valida o vuota."));
}
} catch (e) {
reject(e);
}
});
});

req.on('error', (error) => reject(error));
req.write(data);
req.end();
});
}

// ROTTE UTENTI
app.post('/api/register', (req, res) => {
const { name, email, pin, recoveryAnswer } = req.body;
if (!name || !email || !pin) {
return res.status(400).json({ error: "Nome, Email e PIN sono obbligatori." });
}

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

// GENERAZIONE ESERCITAZIONE ORDINARIA
app.post('/api/generate-exercise', async (req, res) => {
const { subject, unit } = req.body;

const prompt = `Sei un docente universitario esperto per la preparazione al Test d'Ingresso di Medicina (Syllabus 2026).
Genera 5 quesiti a risposta multipla specifici per la materia "${subject}" e l'unità del Syllabus "${unit}".
Rispondi ESCLUSIVAMENTE con un oggetto JSON valido privo di formattazione markdown extra, con questa struttura esatta:
{
"questions": [
{
"id": 1,
"question": "Testo della domanda...",
"options": ["Opzione A", "Opzione B", "Opzione C", "Opzione D"],
"correct": 0,
"explanation": "Spiegazione approfondita del motivo per cui la risposta è corretta."
}
]
}`;

try {
const aiText = await callGeminiAPI(prompt);
const cleanJson = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
const exerciseData = JSON.parse(cleanJson);
res.json(exerciseData);
} catch (err) {
res.status(500).json({ error: "Impossibile generare test: " + err.message });
}
});

// GENERAZIONE MINI-ESERCITAZIONE FINE SETTIMANA SUI MIEI ERRORI
app.post('/api/generate-weekend-recap', (req, res) => {
const { userId } = req.body;

db.all(`SELECT questions_json, answers_json, subject, unit FROM exercises WHERE user_id = ?`, [userId], async (err, rows) => {
if (err || !rows || rows.length === 0) {
return res.status(400).json({ error: "Nessuno storico errori disponibile per generare la mini-esercitazione." });
}

let mistakesList = [];
rows.forEach(r => {
try {
const questions = JSON.parse(r.questions_json);
const answers = JSON.parse(r.answers_json);
questions.forEach((q, idx) => {
if (answers[idx] !== undefined && answers[idx] !== q.correct) {
mistakesList.push(`[${r.subject} - ${r.unit}] Domanda: "${q.question}" | Errore dell'utente: Risposta data "${q.options[answers[idx]]}" invece di quella corretta "${q.options[q.correct]}"`);
}
});
} catch(e){}
});

if (mistakesList.length === 0) {
return res.status(400).json({ error: "Complimenti! Non hai commesso errori nelle tue esercitazioni passate." });
}

const sampledMistakes = mistakesList.slice(-10).join("\n");
const prompt = `Sei un docente specializzato nella preparazione al test di Medicina 2026.
L'algoritmo ha raccolto i seguenti errori commessi dallo studente nelle esercitazioni passate:
${sampledMistakes}

Crea una MINI-ESERCITAZIONE DI FINE SETTIMANA da 5 quesiti a risposta multipla mirata a colmare e verificare ESATTAMENTE i concetti errati dallo studente.
Rispondi ESCLUSIVAMENTE con un JSON con la seguente struttura:
{
"questions": [
{
"id": 1,
"question": "Testo del quesito di ripasso...",
"options": ["Opzione A", "Opzione B", "Opzione C", "Opzione D"],
"correct": 0,
"explanation": "Spiegazione per il recupero del concetto..."
}
]
}`;

try {
const aiText = await callGeminiAPI(prompt);
const cleanJson = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
const exerciseData = JSON.parse(cleanJson);
res.json(exerciseData);
} catch (e) {
res.status(500).

