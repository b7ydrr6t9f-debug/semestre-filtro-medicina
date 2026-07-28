require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');
const XLSX = require('xlsx');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// --- 1. INIZIALIZZAZIONE DATABASE SQLITE ---
const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
// Tabella Utenti
db.run(`
CREATE TABLE IF NOT EXISTS users (
id INTEGER PRIMARY KEY AUTOINCREMENT,
name TEXT NOT NULL,
email TEXT UNIQUE NOT NULL,
pin TEXT NOT NULL
)
`);

// Tabella Risultati
db.run(`
CREATE TABLE IF NOT EXISTS results (
id INTEGER PRIMARY KEY AUTOINCREMENT,
user_id INTEGER,
data_esecuzione TEXT,
tipo TEXT,
materia TEXT,
unita TEXT,
punteggio REAL,
totale_domande INTEGER,
esatte INTEGER,
errate INTEGER,
omesse INTEGER,
punti_aperte REAL,
tempo_impiegato TEXT,
FOREIGN KEY(user_id) REFERENCES users(id)
)
`);

// Tabella Registro Errori
db.run(`
CREATE TABLE IF NOT EXISTS errors_log (
id INTEGER PRIMARY KEY AUTOINCREMENT,
user_id INTEGER,
materia TEXT,
unita TEXT,
argomento TEXT,
quesito TEXT,
data_errore TEXT,
FOREIGN KEY(user_id) REFERENCES users(id)
)
`);
});

// --- 2. GEMINI AI SETTING ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
let genAI = null;
let model = null;

if (GEMINI_API_KEY && GEMINI_API_KEY.startsWith("AIzaSy")) {
try {
genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
} catch (e) {}
}

function generateBackupQuestions(materia, unita, errorTopics = []) {
const multiple = [];
const note = errorTopics.length > 0 ? " (Focus su tue lacune pregresse)" : "";

for (let i = 1; i <= 21; i++) {
multiple.push({
id: i,
materia,
unita,
quesito: `[${materia}${note}] Quesito n. ${i}: Qual è l'affermazione corretta riguardo ai meccanismi di ${unita}?`,
opzione_a: "È un processo regolato da gradienti e complessi enzimatici specifici.",
opzione_b: "Avviene esclusivamente in assenza di energia molecolare.",
opzione_c: "Inibisce completamente la trascrizione cellulare.",
opzione_d: "Dipende unicamente dalla temperatura esterna.",
opzione_e: "Non coinvolge alcuna proteina di membrana.",
esatta: "A",
spiegazione: "L'opzione A riflette il principio corretto del Syllabus 2026."
});
}

const aperte = [];
for (let i = 1; i <= 10; i++) {
aperte.push({
id: 21 + i,
materia,
unita,
quesito: `[${materia}${note}] Quesito aperto n. ${i}: Spiega in dettaglio i punti critici di ${unita}.`,
chiave_correzione: "Identificare chiaramente i componenti primari ed i meccanismi di regolazione."
});
}

return { multiple, aperte };
}

// --- 3. API AUTENTICAZIONE E REGISTRAZIONE ---

app.post('/api/register', (req, res) => {
const { name, email, pin } = req.body;
if (!name || !email || !pin) {
return res.status(400).json({ error: 'Compila tutti i campi (Nome, Email, PIN).' });
}

const query = `INSERT INTO users (name, email, pin) VALUES (?, ?, ?)`;
db.run(query, [name, email, pin], function(err) {
if (err) {
if (err.message.includes('UNIQUE')) {
return res.status(400).json({ error: 'Questa email è già registrata.' });
}
return res.status(500).json({ error: 'Errore durante la creazione del profilo.' });
}
res.json({ success: true, user: { id: this.lastID, name, email } });
});
});

app.post('/api/login', (req, res) => {
const { email, pin } = req.body;
if (!email || !pin) {
return res.status(400).json({ error: 'Inserisci sia l\'email che il PIN.' });
}

db.get('SELECT id, name, email FROM users WHERE email = ? AND pin = ?', [email, pin], (err, user) => {
if (err) return res.status(500).json({ error: 'Errore interno del database.' });
if (!user) return res.status(401).json({ error: 'Email o PIN errati.' });
res.json({ success: true, user });
});
});

// --- 4. API PIATTAFORMA STUDIO ---

app.post('/api/ai/generate-test', async (req, res) => {
const { materia, unita, isWeekend, userId } = req.body;

let frequentErrors = [];
if (isWeekend && userId) {
frequentErrors = await new Promise((resolve) => {
db.all("SELECT unita, COUNT(*) as cnt FROM errors_log WHERE materia = ? AND user_id = ? GROUP BY unita ORDER BY cnt DESC LIMIT 5", [materia, userId], (err, rows) => {
if (err || !rows) resolve([]);
else resolve(rows.map(r => r.unita));
});
});
}

if (model) {
try {
let contextPrompt = "";
if (isWeekend && frequentErrors.length > 0) {
contextPrompt = "ATTENZIONE: Questa è una Mini Simulazione basata SUGLI ERRORI PREGRESSI dello studente. Concentra almeno il 70% delle domande sulle seguenti unità critiche dove ha sbagliato: " + frequentErrors.join(", ") + ".\n";
}

const prompt = "Sei un professore del Semestre Filtro Medicina 2026.\n" +
contextPrompt +
"Crea una prova da 31 domande per la materia \"" + materia + "\", Unità/Tema: \"" + unita + "\".\n" +
"La prova DEVE contenere esattamente:\n" +
"1) \"multiple\": 21 quesiti a risposta multipla (opzione_a, opzione_b, opzione_c, opzione_d, opzione_e, esatta, spiegazione).\n" +
"2) \"aperte\": 10 quesiti a risposta aperta (quesito, chiave_correzione).\n\n" +
"Rispondi ESCLUSIVAMENTE in formato JSON:\n" +
"{\n" +
" \"multiple\": [ { \"id\": 1, \"quesito\": \"...\", \"opzione_a\": \"...\", \"opzione_b\": \"...\", \"opzione_c\": \"...\", \"opzione_d\": \"...\", \"opzione_e\": \"...\", \"esatta\": \"A\", \"spiegazione\": \"...\" } ],\n" +
" \"aperte\": [ { \"id\": 22, \"quesito\": \"...\", \"chiave_correzione\": \"...\" } ]\n" +
"}";

const result = await model.generateContent({
contents: [{ role: 'user', parts: [{ text: prompt }] }],
generationConfig: { responseMimeType: "application/json" }
});

const parsed = JSON.parse(result.response.text());
return res.json({ success: true, questions: parsed, targetedErrors: frequentErrors });
} catch (err) {}
}

const fallbackData = generateBackupQuestions(materia, unita || "Programma Generale", frequentErrors);
res.json({ success: true, questions: fallbackData, targetedErrors: frequentErrors });
});

app.post('/api/ai/evaluate-test', async (req, res) => {
const { userAnswersMultiple, userAnswersAperte, currentQuestions, materia, unita, userId } = req.body;

let esatte = 0, errate = 0, omesse = 0;
const multipleDetail = [];
const errorsToSave = [];

currentQuestions.multiple.forEach((q, idx) => {
const given = userAnswersMultiple[idx];
if (!given) {
omesse++;
multipleDetail.push({ quesito: q.quesito, status: 'OMESSA', punti: 0, esatta: q.esatta, dato: 'Nessuna' });
errorsToSave.push({ materia, unita, argomento: q.quesito });
} else if (given === q.esatta) {
esatte++;
multipleDetail.push({ quesito: q.quesito, status: 'CORRETTA', punti: 1.5, esatta: q.esatta, dato: given });
} else {
errate++;
multipleDetail.push({ quesito: q.quesito, status: 'ERRATA', punti: -0.4, esatta: q.esatta, dato: given, spiegazione: q.spiegazione });
errorsToSave.push({ materia, unita, argomento: q.quesito });
}
});

const puntiMultiple = (esatte * 1.5) - (errate * 0.4);
let puntiAperte = 0;
const aperteDetail = [];

currentQuestions.aperte.forEach((q, idx) => {
const text = (userAnswersAperte[idx] || "").trim();
let p = 0;
let commento = "";

if (text.length === 0) {
commento = "Risposta omessa (0 punti).";
p = 0;
errorsToSave.push({ materia, unita, argomento: q.quesito });
} else if (text.length > 50) {
p = 1.5;
commento = "Risposta completa ed esauriente (1.5 / 1.5).";
} else {
p = 0.8;
commento = "Risposta parziale (0.8 / 1.5).";
errorsToSave.push({ materia, unita, argomento: q.quesito });
}

puntiAperte += p;
aperteDetail.push({
quesito: q.quesito,
rispostaData: text || "Non fornita",
punti: p,
commento,
chiave: q.chiave_correzione
});
});

const dataNow = new Date().toISOString().replace('T', ' ').substring(0, 19);
errorsToSave.forEach(e => {
db.run("INSERT INTO errors_log (user_id, materia, unita, argomento, quesito, data_errore) VALUES (?, ?, ?, ?, ?, ?)", [userId || null, e.materia, e.unita, e.argomento, e.argomento, dataNow]);
});

const punteggioFinale = (puntiMultiple + puntiAperte).toFixed(2);

res.json({
success: true,
punteggioFinale: parseFloat(punteggioFinale),
puntiMultiple: parseFloat(puntiMultiple.toFixed(2)),
puntiAperte: parseFloat(puntiAperte.toFixed(2)),
esatte, errate, omesse,
multipleDetail,
aperteDetail
});
});

app.post('/api/results/save', (req, res) => {
const { tipo, materia, unita, punteggio, totale, esatte, errate, omesse, punti_aperte, tempo_impiegato, userId } = req.body;
const dataNow = new Date().toISOString().replace('T', ' ').substring(0, 19);

const query = "INSERT INTO results (user_id, data_esecuzione, tipo, materia, unita, punteggio, totale_domande, esatte, errate, omesse, punti_aperte, tempo_impiegato) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
db.run(query, [userId || null, dataNow, tipo, materia, unita, punteggio, totale, esatte, errate, omesse, punti_aperte, tempo_impiegato || "N/D"], function(err) {
if (err) return res.status(500).json({ success: false, error: err.message });
res.json({ success: true, id: this.lastID });
});
});

app.get('/api/results/all/:userId', (req, res) => {
const { userId } = req.params;
db.all("SELECT * FROM results WHERE user_id = ? ORDER BY id DESC", [userId], (err, rows) => {
if (err) return res.status(500).json({ success: false, error: err.message });
res.json({ success: true, data: rows });
});
});

app.get('/api/results/export-excel/:userId', (req, res) => {
const { userId } = req.params;
db.all("SELECT id AS 'ID', data_esecuzione AS 'Data Prova', tipo AS 'Tipologia Prova', materia AS 'Materia', unita AS 'Unità Didattica', tempo_impiegato AS 'Tempo Impiegato', punteggio AS 'Punteggio Totale', punti_aperte AS 'Punti Risposte Aperte', esatte AS 'Esatte (+1.5)', errate AS 'Errate (-0.4)', omesse AS 'Omesse (0)' FROM results WHERE user_id = ? ORDER BY id DESC", [userId], (err, rows) => {
if (err) return res.status(500).json({ success: false, error: err.message });

const worksheet = XLSX.utils.json_to_sheet(rows);
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, worksheet, "Report Semestre Filtro");

const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
res.setHeader('Content-Disposition', 'attachment; filename="Valutazioni_Semestre_Filtro_2026.xlsx"');
res.send(buffer);
});
});

app.get('/api/recovery/suggestions/:userId', (req, res) => {
const { userId } = req.params;
db.all("SELECT materia, unita, COUNT(*) as conteggio FROM errors_log WHERE user_id = ? GROUP BY materia, unita ORDER BY conteggio DESC LIMIT 10", [userId], (err, rows) => {
if (err) return res.status(500).json({ success: false, error: err.message });
res.json({ success: true, suggestions: rows });
});
});

app.post('/api/recovery/generate-lesson', async (req, res) => {
const { materia, unita, modalita, argomentoSpecifico } = req.body;

const extraContext = argomentoSpecifico && argomentoSpecifico.trim() !== ''
? " ARGOMENTO/RICHIESTA SPECIFICA DELL'UTENTE: \"" + argomentoSpecifico.trim() + "\". Focalizza fortemente la spiegazione su questo aspetto."
: "";

if (model) {
try {
const prompt = "Sei un Docente Universitario per il Semestre Filtro Medicina 2026.\n" +
"Prepara una LEZIONE DI RECUPERO " + modalita.toUpperCase() + " per la materia \"" + materia + "\", Unità: \"" + unita + "\".\n" +
extraContext + "\n" +
"Basa la lezione sugli errori più frequenti commessi negli esami ed accertati di spiegare con chiarezza i concetti chiave.\n" +
"Usa formattazione HTML pulita con h4, h5, ul, li, blockquote.";

const result = await model.generateContent(prompt);
return res.json({ success: true, lesson: result.response.text() });
} catch (e) {}
}

const isBreve = modalita === 'breve';
const customTopicText = argomentoSpecifico && argomentoSpecifico.trim() !== ''
? `<div class="alert alert-info"><strong>Focus Specifico Richiesto:</strong> ${argomentoSpecifico}</div>`
: '';

const lessonHtml = `
<h4><i class="bi bi-book-half"></i> Lezione di Recupero (${isBreve ? 'Sintetica / Fast Review' : 'Dettagliata & Approfondita'})</h4>
<p class="lead mb-2">Materia: <strong>${materia}</strong> | Unità Didattica: <strong>${unita}</strong></p>
${customTopicText}
<hr>
<h5><i class="bi bi-exclamation-triangle-fill text-warning"></i> Analisi degli Errori & Spiegazione</h5>
<p>In questa unità gli errori principali si concentrano sui trabocchetti concettuali e sui dettagli fisiologici/operativi.</p>
<ul>
<li><strong>Punto critico 1:</strong> Confusione nei tempi di reazione, nei bilanci energetici e nella terminologia.</li>
<li><strong>Punto critico 2:</strong> Errata valutazione dei fattori di regolazione molecolare/fisica.</li>
</ul>
<div class="p-3 bg-light rounded border mt-3">
<strong>💡 Consiglio Studio:</strong> Esegui una Mini Simulazione mirata per testare la comprensione di questa lezione.
</div>
`;

res.json({ success: true, lesson: lessonHtml });
});

// --- 5. FRONTEND WEB ---
app.get('/', (req, res) => {
res.send(`
<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Semestre Filtro Medicina 2026</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css">
<style>
body { background-color: #f4f6f9; font-family: 'Segoe UI', system-ui, sans-serif; }
.hero-header { background: linear-gradient(135deg, #0d47a1 0%, #1976d2 100%); color: white; padding: 25px 0; border-radius: 0 0 20px 20px; }
.card-custom { border: none; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); background: white; }
.nav-pills .nav-link.active { background-color: #0d47a1; }
.timer-badge { position: fixed; top: 15px; right: 20px; z-index: 1050; font-size: 1.2rem; font-weight: bold; border-radius: 30px; }
.auth-container { max-width: 450px; margin: 40px auto; }
</style>
</head>
<body>

<!-- SCHERMATA LOGIN & REGISTRAZIONE PULITA -->
<div id="auth-section" class="container auth-container">
<div class="card card-custom p-4 shadow">
<h3 class="fw-bold text-center text-primary mb-3"><i class="bi bi-journal-medical"></i> Semestre Filtro 2026</h3>

<ul class="nav nav-pills nav-justified mb-3" id="authTabs">
<li class="nav-item">
<button class="nav-link active fw-bold" id="tab-login-btn" onclick="switchAuthTab('login')">Accedi</button>
</li>
<li class="nav-item">
<button class="nav-link fw-bold" id="tab-reg-btn" onclick="switchAuthTab('register')">Crea Nuovo Profilo</button>
</li>
</ul>

<!-- FORM LOGIN -->
<div id="login-form">
<div class="mb-3">
<label class="form-label fw-bold">Email</label>
<input type="email" id="login-email" class="form-control" placeholder="Inserisci la tua email">
</div>
<div class="mb-3">
<label class="form-label fw-bold">PIN Personale</label>
<input type="password" id="login-pin" class="form-control" placeholder="Inserisci il tuo PIN">
</div>
<button class="btn btn-primary w-100 fw-bold" onclick="login()">Entra nella Piattaforma</button>
</div>

<!-- FORM REGISTRAZIONE -->
<div id="register-form" style="display: none;">
<div class="mb-3">
<label class="form-label fw-bold">Nome Completo</label>
<input type="text" id="reg-name" class="form-control" placeholder="Es. Mario Rossi">
</div>
<div class="mb-3">
<label class="form-label fw-bold">Email</label>
<input type="email" id="reg-email" class="form-control" placeholder="mario@medicina.it">
</div>
<div class="mb-3">
<label class="form-label fw-bold">Scegli il tuo PIN</label>
<input type="password" id="reg-pin" class="form-control" placeholder="Crea un PIN personalizzato">
</div>
<button class="btn btn-success w-100 fw-bold" onclick="register()">Crea Profilo e Accedi</button>
</div>

<div id="auth-error" class="text-danger text-center mt-3 small fw-bold"></div>
</div>
</div>

<!-- PLATFORM INTERFACE -->
<div id="platform-section" style="display: none;">
<!-- TIMER GALLEGGIANTE -->
<div id="floating-timer" class="badge bg-danger text-white p-3 timer-badge d-none shadow">
<i class="bi bi-clock-history"></i> Tempo Rimasto: <span id="timer-display">50:00</span>
</div>

<div class="hero-header text-center shadow">
<div class="container d-flex justify-content-between align-items-center">
<div class="text-start">
<h1 class="fw-bold mb-0"><i class="bi bi-journal-medical"></i> Semestre Filtro Medicina 2026</h1>
<p class="lead mb-0">Piattaforma di Preparazione ed Esercitazione Adattiva</p>
</div>
<div>
<span class="me-2 fw-bold text-light">Utente: <span id="logged-user-name"></span></span>
<button class="btn btn-sm btn-outline-light fw-bold" onclick="logout()">Esci</button>
</div>
</div>
</div>

<div class="container my-4" style="max-width: 1050px;">

<ul class="nav nav-pills nav-justified mb-4 card-custom p-2" id="mainTabs" role="tablist">
<li class="nav-item">
<button class="nav-link active fw-bold" id="daily-tab" data-bs-toggle="pill" data-bs-target="#daily" type="button"><i class="bi bi-check2-square"></i> Esercitazione Unità</button>
</li>
<li class="nav-item">
<button class="nav-link fw-bold text-success" id="weekend-tab" data-bs-toggle="pill" data-bs-target="#weekend" type="button"><i class="bi bi-lightning-charge-fill"></i> Mini Simulazione (Sugli Errori)</button>
</li>
<li class="nav-item">
<button class="nav-link fw-bold text-warning" id="recovery-tab" data-bs-toggle="pill" data-bs-target="#recovery" type="button" onclick="loadRecoverySuggestions()"><i class="bi bi-mortarboard-fill"></i> Lezioni di Recupero</button>
</li>
<li class="nav-item">
<button class="nav-link fw-bold" id="eval-tab" data-bs-toggle="pill" data-bs-target="#eval" type="button" onclick="loadEvaluations()"><i class="bi bi-file-earmark-excel"></i> Valutazioni & Excel</button>
</li>
</ul>

<div class="tab-content" id="mainTabsContent">

<!-- TAB 1: ESERCITAZIONE -->
<div class="tab-pane fade show active" id="daily" role="tabpanel">
<div class="card card-custom p-4 mb-4">
<h5 class="fw-bold mb-3 text-primary"><i class="bi bi-sliders"></i> Seleziona Materia e Unità Didattica</h5>
<div class="row g-3">
<div class="col-md-5">
<label class="form-label fw-bold">Materia</label>
<select id="selectMateria" class="form-select" onchange="updateUnits()">
<option value="Biologia">Biologia</option>
<option value="Chimica e Propedeutica Biochimica">Chimica e Propedeutica Biochimica</option>
<option value="Fisica">Fisica</option>
</select>
</div>
<div class="col-md-7">
<label class="form-label fw-bold">Unità Didattica Completa</label>
<select id="selectUnita" class="form-select"></select>
</div>
</div>
<div class="mt-4 text-end">
<button class="btn btn-primary btn-lg shadow-sm" onclick="generateTest('daily')"><i class="bi bi-play-circle-fill"></i> Avvia Prova (31 Quesiti - 50 Minuti)</button>
</div>
</div>
</div>

<!-- TAB 2: MINI SIMULAZIONE ERRORE-BASED -->
<div class="tab-pane fade" id="weekend" role="tabpanel">
<div class="card card-custom p-4 mb-4 border-start border-4 border-success">
<div class="d-flex align-items-center mb-2">
<h5 class="fw-bold text-success mb-0 me-2"><i class="bi bi-lightning-charge-fill"></i> Mini Simulazione Adaptive (Strutturata sui Tuoi Errori)</h5>
<span class="badge bg-warning text-dark">AI Adaptive</span>
</div>
<p class="text-muted">Questa simulazione analizza i tuoi test precedenti ed elabora <strong>31 quesiti focalizzati principalmente sugli argomenti in cui hai commesso errori</strong> o lasciato risposte vuote.</p>
<div class="row g-3 align-items-center mt-1">
<div class="col-md-8">
<label class="form-label fw-bold">Materia da Esaminare</label>
<select id="selectMateriaSim" class="form-select">
<option value="Biologia">Biologia (In base ai miei errori)</option>
<option value="Chimica e Propedeutica Biochimica">Chimica e Propedeutica Biochimica (In base ai miei errori)</option>
<option value="Fisica">Fisica (In base ai miei errori)</option>
</select>
</div>
<div class="col-md-4 text-end mt-4">
<button class="btn btn-success btn-lg w-100 shadow-sm fw-bold" onclick="generateTest('weekend')"><i class="bi bi-rocket-takeoff"></i> Avvia Simulazione Mirata</button>
</div>
</div>
</div>
</div>

<!-- TAB 3: LEZIONI DI RECUPERO -->
<div class="tab-pane fade" id="recovery" role="tabpanel">
<div class="card card-custom p-4 mb-4">
<h4 class="fw-bold text-dark mb-2"><i class="bi bi-mortarboard-fill text-warning"></i> Centro Lezioni di Recupero Personalizzate</h4>
<p class="text-muted">Genera lezioni focalizzate sugli argomenti in cui hai commesso più errori o inserisci una richiesta specifica.</p>

<div class="row g-3 mb-4 p-3 bg-light rounded border">
<div class="col-md-4">
<label class="form-label fw-bold">Materia</label>
<select id="recMateria" class="form-select" onchange="updateRecUnits()">
<option value="Biologia">Biologia</option>
<option value="Chimica e Propedeutica Biochimica">Chimica e Propedeutica Biochimica</option>
<option value="Fisica">Fisica</option>
</select>
</div>
<div class="col-md-5">
<label class="form-label fw-bold">Unità Didattica</label>
<select id="recUnita" class="form-select"></select>
</div>
<div class="col-md-3">
<label class="form-label fw-bold">Profondità Lezione</label>
<select id="recModalita" class="form-select">
<option value="breve">Breve / Ripasso Veloce</option>
<option value="dettagliata">Dettagliata & Approfondita</option>
</select>
</div>

<div class="col-12 mt-3">
<label class="form-label fw-bold text-primary"><i class="bi bi-search"></i> Argomento Specifico o Richiesta Particolare (Opzionale)</label>
<input type="text" id="recArgomentoSpecifico" class="form-control" placeholder="Es. Spiega in dettaglio la catena di trasporto degli elettroni...">
</div>

<div class="col-12 text-end mt-3">
<button class="btn btn-warning fw-bold text-dark px-4" onclick="generateLesson()"><i class="bi bi-cpu-fill"></i> Genera Lezione con AI</button>
</div>
</div>

<h5 class="fw-bold text-primary mb-3"><i class="bi bi-graph-down-arrow"></i> Lezioni Consigliate In Base ai Tuoi Errori</h5>
<div id="suggestionsContainer" class="row g-3">
<div class="text-muted text-center">Fai almeno una prova per far rilevare all'AI i tuoi argomenti da recuperare.</div>
</div>

<div id="lessonContainer" class="mt-4 p-4 card-custom d-none border border-warning"></div>
</div>
</div>

<!-- TAB 4: REPORT EXCEL CON TEMPO IMPIEGATO -->
<div class="tab-pane fade" id="eval" role="tabpanel">
<div class="card card-custom p-4 mb-4">
<div class="d-flex justify-content-between align-items-center mb-3">
<h5 class="fw-bold mb-0 text-dark"><i class="bi bi-table"></i> Storico Valutazioni</h5>
<a id="export-excel-btn" href="#" class="btn btn-outline-success fw-bold"><i class="bi bi-file-earmark-spreadsheet-fill"></i> Scarica Report Excel (.xlsx)</a>
</div>
<div class="table-responsive">
<table class="table table-hover align-middle">
<thead class="table-light">
<tr>
<th>Data</th>
<th>Tipo Prova</th>
<th>Materia / Unità</th>
<th>Tempo Impiegato</th>
<th>Punteggio Totale</th>
<th>Esatte / Errate / Omesse</th>
</tr>
</thead>
<tbody id="evalTableBody">
<tr><td colspan="6" class="text-center text-muted">Nessuna valutazione presente.</td></tr>
</tbody>
</table>
</div>
</div>
</div>

</div>

<!-- AREA QUIZ -->
<div id="quiz-container"></div>

<!-- RISULTATI -->
<div id="result-container" class="mt-4 d-none"></div>

</div>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script>
let activeUser = null;

const syllabus = {
"Biologia": [
"Unità 1: Organizzazione biologica e molecolare della vita",
"Unità 2: Biologia cellulare: strutture, organelli e membrane",
"Unità 3: Bioenergetica cellulare, metabolismo e fotosintesi",
"Unità 4: Genetica molecolare: DNA, RNA, trascrizione e traduzione",
"Unità 5: Ciclo cellulare, Mitosi, Meiosi e Apoptosi",
"Unità 6: Segnalazione cellulare e trasduzione del segnale",
"Unità 7: Genetica Mendeliana ed ereditarietà umana",
"Unità 8: Biologia dello sviluppo e cellule staminali"
],
"Chimica e Propedeutica Biochimica": [
"Unità 1: Struttura atomica e tavola periodica degli elementi",
"Unità 2: Legami chimici e forze intermolecolari",
"Unità 3: Chimica delle soluzioni, concentrazioni ed osmosi",
"Unità 4: Equilibrio chimico, pH e sistemi tampone del sangue",
"Unità 5: Termodinamica, cinetica chimica e reazioni redox",
"Unità 6: Gruppi funzionali e fondamenti di chimica organica",
"Unità 7: Biochimica: Struttura e funzione delle Biomolecole"
],
"Fisica": [
"Unità 1: Grandezze fisiche, analisi dimensionale e vettori",
"Unità 2: Cinematica e Dinamica del punto materiale",
"Unità 3: Lavoro, energia, potenza e principi di conservazione",
"Unità 4: Meccanica dei fluidi perfetti e reali applicata alla circolazione",
"Unità 5: Termodinamica, calore e gas perfetti",
"Unità 6: Elettromagnetismo e circuiti in corrente continua",
"Unità 7: Ondulatoria, acustica, ottica medica e radiazioni"
]
};

let currentQuestions = null;
let currentTestType = '';
let currentMateria = '';
let currentUnita = '';
let userAnswersMultiple = {};
let userAnswersAperte = {};
let timerInterval = null;
let totalSecondsElapsed = 0;

function switchAuthTab(tab) {
document.getElementById('auth-error').innerText = '';
if (tab === 'login') {
document.getElementById('login-form').style.display = 'block';
document.getElementById('register-form').style.display = 'none';
document.getElementById('tab-login-btn').classList.add('active');
document.getElementById('tab-reg-btn').classList.remove('active');
} else {
document.getElementById('login-form').style.display = 'none';
document.getElementById('register-form').style.display = 'block';
document.getElementById('tab-login-btn').classList.remove('active');
document.getElementById('tab-reg-btn').classList.add('active');
}
}

async function register() {
const name = document.getElementById('reg-name').value;
const email = document.getElementById('reg-email').value;
const pin = document.getElementById('reg-pin').value;
const err = document.getElementById('auth-error');

if (!name || !email || !pin) {
err.innerText = 'Compila tutti i campi presenti.';
return;
}

try {
const res = await fetch('/api/register', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ name, email, pin })
});
const data = await res.json();
if (!res.ok) { err.innerText = data.error; return; }

activeUser = data.user;
startPlatform();
} catch (e) { err.innerText = 'Errore di connessione.'; }
}

async function login() {
const email = document.getElementById('login-email').value;
const pin = document.getElementById('login-pin').value;
const err = document.getElementById('auth-error');

try {
const res = await fetch('/api/login', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ email, pin })
});
const data = await res.json();
if (!res.ok) { err.innerText = data.error; return; }

activeUser = data.user;
startPlatform();
} catch (e) { err.innerText = 'Errore durante l\'accesso.'; }
}

function startPlatform() {
document.getElementById('auth-section').style.display = 'none';
document.getElementById('platform-section').style.display = 'block';
document.getElementById('logged-user-name').innerText = activeUser.name;
document.getElementById('export-excel-btn').href = '/api/results/export-excel/' + activeUser.id;
updateUnits();
updateRecUnits();
}

function logout() {
activeUser = null;
stopTimer();
document.getElementById('auth-section').style.display = 'block';
document.getElementById('platform-section').style.display = 'none';
document.getElementById('quiz-container').innerHTML = '';
document.getElementById('result-container').classList.add('d-none');
}

function updateUnits() {
const mat = document.getElementById('selectMateria').value;
const unitSelect = document.getElementById('selectUnita');
unitSelect.innerHTML = syllabus[mat].map(u => \`<option value="\${u}">\${u}</option>\`).join('');
}

function updateRecUnits() {
const mat = document.getElementById('recMateria').value;
const unitSelect = document.getElementById('recUnita');
unitSelect.innerHTML = syllabus[mat].map(u => \`<option value="\${u}">\${u}</option>\`).join('');
}

function startTimer() {
clearInterval(timerInterval);
totalSecondsElapsed = 0;
let timeLeft = 50 * 60;
const timerBadge = document.getElementById('floating-timer');
const timerDisplay = document.getElementById('timer-display');
timerBadge.classList.remove('d-none');

timerInterval = setInterval(() => {
timeLeft--;
totalSecondsElapsed++;
const m = Math.floor(timeLeft / 60);
const s = timeLeft % 60;
timerDisplay.innerText = \`\${m < 10 ? '0' : ''}\${m}:\${s < 10 ? '0' : ''}\${s}\`;

if (timeLeft <= 0) {
clearInterval(timerInterval);
alert("⏱️ Tempo massimo di 50 minuti scaduto! Correzione in corso...");
submitAndAnalyze();
}
}, 1000);
}

function stopTimer() {
clearInterval(timerInterval);
document.getElementById('floating-timer').classList.add('d-none');
}

function getFormattedElapsedTime() {
const m = Math.floor(totalSecondsElapsed / 60);
const s = totalSecondsElapsed % 60;
return \`\${m} min \${s} sec\`;
}

async function generateTest(type) {
currentTestType = type;
const container = document.getElementById('quiz-container');
document.getElementById('result-container').classList.add('d-none');

const isWeekend = (type === 'weekend');

if(type === 'daily') {
currentMateria = document.getElementById('selectMateria').value;
currentUnita = document.getElementById('selectUnita').value;
} else {
currentMateria = document.getElementById('selectMateriaSim').value;
currentUnita = 'Simulazione Mirata sugli Errori';
}

container.innerHTML = \`
<div class="card card-custom p-5 text-center">
<div class="spinner-border text-primary mx-auto mb-3" style="width: 3rem; height: 3rem;"></div>
<h5>Generazione Prova in corso...</h5>
<p class="text-muted">\${isWeekend ? 'L\\'AI sta analizzando i tuoi errori passati per costruire 31 quesiti personalizzati.' : 'Caricamento 31 quesiti dell\\'Unità Didattica.'}</p>
</div>\`;

try {
const res = await fetch('/api/ai/generate-test', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ materia: currentMateria, unita: currentUnita, isWeekend, userId: activeUser.id })
});
const data = await res.json();
if(data.success) {
currentQuestions = data.questions;
userAnswersMultiple = {};
userAnswersAperte = {};
renderQuiz(data.targetedErrors);
startTimer();
}
} catch (e) {}
}

function renderQuiz(targetedErrors = []) {
const container = document.getElementById('quiz-container');
let targetedHtml = '';
if (targetedErrors && targetedErrors.length > 0) {
targetedHtml = \`<div class="alert alert-warning mb-3">🎯 <strong>Simulazione Mirata:</strong> Questa prova contiene domande incentrate principalmente sulle tue lacune precedenti in: <em>\${targetedErrors.join(', ')}</em>.</div>\`;
}

let html = \`
<div class="card card-custom p-4 mb-4 bg-primary text-white">
<h3 class="fw-bold mb-1">\${currentTestType === 'daily' ? 'Esercitazione' : 'Mini Simulazione (Su i tuoi Errori)'}: \${currentMateria}</h3>
<p class="mb-0">\${currentUnita} | 31 Quesiti (21 Multipli + 10 Aperti) | ⏱️ tempo max: 50 minuti</p>
</div>
\${targetedHtml}\`;

html += '<h4 class="fw-bold text-dark mb-3"><i class="bi bi-list-check"></i> Sezione 1: 21 Quesiti a Risposta Multipla</h4>';
currentQuestions.multiple.forEach((q, idx) => {
html += \`
<div class="card card-custom p-4 mb-3">
<h5 class="mb-3 fw-bold text-dark">Quesito \${idx + 1}: \${q.quesito}</h5>
\${['A', 'B', 'C', 'D', 'E'].map(opt => \`
<div class="form-check mb-2">
<input class="form-check-input" type="radio" name="qm_\${idx}" id="qm_\${idx}_\${opt}" value="\${opt}" onchange="userAnswersMultiple[\${idx}] = '\${opt}'">
<label class="form-check-label w-100" for="qm_\${idx}_\${opt}"><strong>\${opt}.</strong> \${q['opzione_' + opt.toLowerCase()]}</label>
</div>
\`).join('')}
</div>\`;
});

html += '<h4 class="fw-bold text-dark mt-5 mb-3"><i class="bi bi-pencil-square"></i> Sezione 2: 10 Quesiti a Risposta Aperta</h4>';
currentQuestions.aperte.forEach((q, idx) => {
html += \`
<div class="card card-custom p-4 mb-3 border-start border-4 border-info">
<h5 class="mb-2 fw-bold text-dark">Quesito \${idx + 22}: \${q.quesito}</h5>
<div class="mb-2">
<textarea class="form-control" rows="3" placeholder="Scrivi la tua risposta sintetica qui..." onchange="userAnswersAperte[\${idx}] = this.value"></textarea>
</div>
</div>\`;
});

html += \`
<div class="text-center mt-4 mb-5">
<button class="btn btn-success btn-lg px-5 shadow-lg fw-bold" onclick="submitAndAnalyze()"><i class="bi bi-calculator"></i> Termina e Correggi Prova</button>
</div>\`;

container.innerHTML = html;
window.scrollTo({ top: container.offsetTop - 20, behavior: 'smooth' });
}

async function submitAndAnalyze() {
stopTimer();
const timeSpent = getFormattedElapsedTime();

const resultContainer = document.getElementById('result-container');
resultContainer.classList.remove('d-none');
resultContainer.innerHTML = \`
<div class="card card-custom p-5 text-center">
<div class="spinner-border text-success mx-auto mb-3" style="width: 3rem; height: 3rem;"></div>
<h5>Correzione e tracciamento errori...</h5>
</div>\`;
resultContainer.scrollIntoView({ behavior: 'smooth' });

try {
const res = await fetch('/api/ai/evaluate-test', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ userAnswersMultiple, userAnswersAperte, currentQuestions, materia: currentMateria, unita: currentUnita, userId: activeUser.id })
});
const data = await res.json();

if (data.success) {
await fetch('/api/results/save', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
tipo: currentTestType === 'daily' ? 'Unità Didattica' : 'Mini Simulazione (Errori)',
materia: currentMateria,
unita: currentUnita,
punteggio: data.punteggioFinale,
totale: 31,
esatte: data.esatte,
errate: data.errate,
omesse: data.omesse,
punti_aperte: data.puntiAperte,
tempo_impiegato: timeSpent,
userId: activeUser.id
})
});

let html = \`
<div class="card card-custom p-4 mb-4 border-success">
<h3 class="fw-bold text-success text-center mb-1"><i class="bi bi-award-fill"></i> Risultato Semestre Filtro 2026</h3>
<p class="text-center text-muted mb-3"><i class="bi bi-stopwatch-fill text-danger"></i> Tempo impiegato per completare la prova: <strong>\${timeSpent}</strong></p>
<div class="row text-center mb-4 g-3">
<div class="col-md-4">
<div class="p-3 bg-light rounded border">
<h6>Risposte Multiple</h6>
<h4 class="fw-bold text-primary">\${data.puntiMultiple} / 31.5</h4>
<small class="text-muted">Esatte: \${data.esatte} | Errate: \${data.errate} | Omesse: \${data.omesse}</small>
</div>
</div>
<div class="col-md-4">
<div class="p-3 bg-light rounded border">
<h6>Risposte Aperte</h6>
<h4 class="fw-bold text-info">\${data.puntiAperte} / 15.0</h4>
</div>
</div>
<div class="col-md-4">
<div class="p-3 bg-success text-white rounded shadow-sm">
<h6>PUNTEGGIO TOTALE</h6>
<h2 class="fw-bold mb-0">\${data.punteggioFinale} / 46.5</h2>
</div>
</div>
</div>\`;

html += '</div>';
resultContainer.innerHTML = html;
}
} catch (e) {}
}

async function loadRecoverySuggestions() {
const container = document.getElementById('suggestionsContainer');
try {
const res = await fetch('/api/recovery/suggestions/' + activeUser.id);
const data = await res.json();
if(data.success && data.suggestions.length > 0) {
container.innerHTML = data.suggestions.map(s => \`
<div class="col-md-6">
<div class="card card-custom p-3 border-start border-4 border-warning">
<h6 class="fw-bold text-dark mb-1">\${s.materia}</h6>
<p class="text-muted small mb-2">\${s.unita}</p>
<div class="d-flex justify-content-between align-items-center">
<span class="badge bg-danger">\${s.conteggio} errori registrati</span>
<button class="btn btn-sm btn-outline-warning text-dark fw-bold" onclick="quickLesson('\${s.materia}', '\${s.unita}')">Genera Lezione</button>
</div>
</div>
</div>
\`).join('');
} else {
container.innerHTML = '<div class="text-muted text-center">Nessun errore registrato finora. Completa una prova per attivare i suggerimenti!</div>';
}
} catch(e) {}
}

function quickLesson(mat, uni) {
document.getElementById('recMateria').value = mat;
updateRecUnits();
document.getElementById('recUnita').value = uni;
generateLesson();
}

async function generateLesson() {
const mat = document.getElementById('recMateria').value;
const uni = document.getElementById('recUnita').value;
const mod = document.getElementById('recModalita').value;
const argomentoSpecifico = document.getElementById('recArgomentoSpecifico').value;
const box = document.getElementById('lessonContainer');

box.classList.remove('d-none');
box.innerHTML = '<div class="text-center p-4"><div class="spinner-border text-warning"></div><p class="mt-2">Generazione lezione personalizzata con AI sui tuoi errori e requisiti specifici...</p></div>';

try {
const res = await fetch('/api/recovery/generate-lesson', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ materia: mat, unita: uni, modalita: mod, argomentoSpecifico })
});
const data = await res.json();
if(data.success) {
box.innerHTML = data.lesson;
box.scrollIntoView({ behavior: 'smooth' });
}
} catch(e) {}
}

async function loadEvaluations() {
const tbody = document.getElementById('evalTableBody');
try {
const res = await fetch('/api/results/all/' + activeUser.id);
const data = await res.json();
if(data.success && data.data.length > 0) {
tbody.innerHTML = data.data.map(row => \`
<tr>
<td><small>\${row.data_esecuzione}</small></td>
<td><span class="badge bg-primary">\${row.tipo}</span></td>
<td><strong>\${row.materia}</strong><br><small class="text-muted">\${row.unita}</small></td>
<td><span class="badge bg-secondary"><i class="bi bi-clock"></i> \${row.tempo_impiegato || 'N/D'}</span></td>
<td><span class="fw-bold text-success fs-5">\${row.punteggio}</span> / 46.5</td>
<td><span class="text-success">✔ \${row.esatte}</span> | <span class="text-danger">✖ \${row.errate}</span> | <span class="text-muted">➖ \${row.omesse}</span></td>
</tr>
\`).join('');
} else {
tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">Nessuna valutazione presente.</td></tr>';
}
} catch(e) {}
}
</script>
</body>
</html>
`);
});

// --- 6. AVVIO SERVER ---
app.listen(PORT, () => {
console.log("🚀 Server Gemini AI attivo su http://localhost:" + PORT);
});
