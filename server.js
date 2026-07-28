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
subject TEXT,
unit TEXT,
questions_json TEXT,
answers_json TEXT,
score INTEGER,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
});

// Funzione chiamata Gemini API
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
'Content-Length': data.length
}
};

const req = https.request(options, (res) => {
let body = '';
res.on('data', (chunk) => body += chunk);
res.on('end', () => {
try {
const response = JSON.parse(body);
if (response.candidates && response.candidates[0].content.parts[0].text) {
resolve(response.candidates[0].content.parts[0].text);
} else {
reject(new Error("Risposta API Gemini non valida"));
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

// Rotte API
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

app.post('/api/generate-exercise', async (req, res) => {
const { subject, unit } = req.body;

const prompt = `Sei un professore universitario esperto nel test d'ingresso di Medicina per il Syllabus 2026.
Genera un'esercitazione da 5 domande a risposta multipla per la materia "${subject}" e la specifica unità "${unit}".
Rispondi ESCLUSIVAMENTE con un oggetto JSON con questo formato esatto, senza markdown o testo aggiuntivo:
{
"questions": [
{
"id": 1,
"question": "Testo del quesito...",
"options": ["Opzione A", "Opzione B", "Opzione C", "Opzione D"],
"correct": 0,
"explanation": "Spiegazione dettagliata della risposta corretta..."
}
]
}`;

try {
const aiText = await callGeminiAPI(prompt);
const cleanJson = aiText.replace(/```json/g, '').replace(/```/g, '').trim();
const exerciseData = JSON.parse(cleanJson);
res.json(exerciseData);
} catch (err) {
console.error("Errore Gemini:", err.message);
res.status(500).json({ error: "Impossibile generare l'esercitazione: " + err.message });
}
});

app.post('/api/save-exercise', (req, res) => {
const { userId, subject, unit, questions, answers, score } = req.body;

db.run(
`INSERT INTO exercises (user_id, subject, unit, questions_json, answers_json, score) VALUES (?, ?, ?, ?, ?, ?)`,
[userId, subject, unit, JSON.stringify(questions), JSON.stringify(answers), score],
function (err) {
if (err) return res.status(500).json({ error: "Errore durante il salvataggio." });
res.json({ success: true, exerciseId: this.lastID });
}
);
});

app.get('/api/user-history/:userId', (req, res) => {
const { userId } = req.params;
db.all(`SELECT * FROM exercises WHERE user_id = ? ORDER BY created_at DESC`, [userId], (err, rows) => {
if (err) return res.status(500).json({ error: "Errore nel recupero storico." });
res.json(rows);
});
});

// Serve la pagina principale
app.get('*', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
console.log(`Server avviato sulla porta ${PORT}`);
});
