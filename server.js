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

// Funzione Gemini API
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
res.status(500).json({ error: "Impossibile generare l'esercitazione con Gemini AI: " + err.message });
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

// HTML Interface
app.get('/', (req, res) => {
res.send(`<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Semestre Filtro Medicina 2026</title>
<style>
:root {
--primary: #0284c7;
--primary-hover: #0369a1;
--bg: #f8fafc;
--card-bg: #ffffff;
--text: #0f172a;
--border: #e2e8f0;
}

* { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
body { background-color: var(--bg); color: var(--text); padding: 12px; }

.container { max-width: 900px; margin: 0 auto; }

.card {
background: var(--card-bg);
border-radius: 12px;
padding: 20px;
box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
margin-bottom: 20px;
border: 1px solid var(--border);
}

h1 { text-align: center; color: var(--primary); margin-bottom: 20px; font-size: 1.6rem; }

.tabs {
display: flex;
gap: 8px;
border-bottom: 2px solid var(--border);
margin-bottom: 20px;
overflow-x: auto;
white-space: nowrap;
padding-bottom: 4px;
}

.tab-btn {
padding: 10px 16px;
border: none;
background: none;
font-size: 0.95rem;
font-weight: 600;
color: #64748b;
cursor: pointer;
border-bottom: 3px solid transparent;
transition: all 0.2s;
}

.tab-btn.active {
color: var(--primary);
border-bottom-color: var(--primary);
}

.form-group { margin-bottom: 15px; }
label { display: block; margin-bottom: 6px; font-weight: 500; font-size: 0.9rem; }
input, select {
width: 100%;
padding: 12px;
border: 1px solid var(--border);
border-radius: 8px;
font-size: 1rem;
}

button {
width: 100%;
padding: 12px;
background-color: var(--primary);
color: white;
border: none;
border-radius: 8px;
font-weight: 600;
cursor: pointer;
font-size: 1rem;
transition: background 0.2s;
}
button:hover { background-color: var(--primary-hover); }
button.secondary { background-color: #64748b; margin-top: 8px; }

.question-card {
border: 1px solid var(--border);
padding: 16px;
border-radius: 8px;
margin-bottom: 16px;
background: #fafafa;
}

.option-btn {
display: block;
width: 100%;
text-align: left;
background: white;
color: var(--text);
border: 1px solid var(--border);
margin-top: 8px;
font-weight: normal;
}
.option-btn.selected { background: #e0f2fe; border-color: var(--primary); }
.option-btn.correct { background: #dcfce7; border-color: #22c55e; }
.option-btn.wrong { background: #fee2e2; border-color: #ef4444; }

.explanation {
margin-top: 10px;
padding: 10px;
background: #f0fdf4;
border-left: 4px solid #22c55e;
font-size: 0.9rem;
}

.hidden { display: none !important; }
.flex-between { display: flex; justify-content: space-between; align-items: center; }

@media (max-width: 600px) {
body { padding: 8px; }
.card { padding: 15px; }
h1 { font-size: 1.3rem; }
.tab-btn { padding: 8px 12px; font-size: 0.85rem; }
}
</style>
</head>
<body>

<div class="container">
<h1>Semestre Filtro Medicina 2026</h1>

<div id="auth-section" class="card">
<div class="tabs">
<button id="tab-btn-login" class="tab-btn active" onclick="switchAuthTab('login')">Accedi</button>
<button id="tab-btn-register" class="tab-btn" onclick="switchAuthTab('register')">Nuovo Profilo</button>
<button id="tab-btn-recover" class="tab-btn" onclick="switchAuthTab('recover')">Recupero PIN</button>
</div>

<!-- FORM LOGIN -->
<div id="login-form">
<div class="form-group">
<label>Email</label>
<input type="email" id="login-email" placeholder="es. marco@medicina.it">
</div>
<div class="form-group">
<label>PIN Personale</label>
<input type="password" id="login-pin" placeholder="****">
</div>
<button onclick="login()">Entra nella Piattaforma</button>
</div>

<!-- FORM REGISTRAZIONE -->
<div id="register-form" class="hidden">
<div class="form-group">
<label>Nome Completo</label>
<input type="text" id="reg-name" placeholder="es. Marco Rossi">
</div>
<div class="form-group">
<label>Email</label>
<input type="email" id="reg-email" placeholder="es. marco@medicina.it">
</div>
<div class="form-group">
<label>Crea PIN Personale</label>
<input type="password" id="reg-pin" placeholder="****">
</div>
<div class="form-group">
<label>Parola di Sicurezza (per recupero PIN)</label>
<input type="text" id="reg-recovery" placeholder="es. Nome del primo animale domestico">
</div>
<button onclick="register()">Crea Profilo</button>
</div>

<!-- FORM RECUPERO PIN -->
<div id="recover-form" class="hidden">
<div class="form-group">
<label>Inserisci la tua Email</label>
<input type="email" id="rec-email" placeholder="es. marco@medicina.it">
</div>
<div class="form-group">
<label>Parola di Sicurezza</label>
<input type="text" id="rec-answer" placeholder="Risposta di sicurezza">
</div>
<button onclick="recoverPin()">Recupera il mio PIN</button>
<div id="recovered-pin-result" style="margin-top:15px; font-weight:bold; color:var(--primary);"></div>
</div>
</div>

<!-- DASHBOARD APPLICAZIONE -->
<div id="app-section" class="hidden">
<div class="card flex-between">
<div>Utente: <strong id="user-display-name">-</strong></div>
<button class="secondary" style="width:auto; padding:6px 12px;" onclick="logout()">Esci</button>
</div>

<div class="tabs">
<button id="tab-app-ex" class="tab-btn active" onclick="switchAppTab('exercise')">Esercitazione Unità</button>
<button id="tab-app-learn" class="tab-btn" onclick="switchAppTab('learning')">Sezione Apprendimento (Errori)</button>
</div>

<div id="tab-exercise" class="card">
<h3>Genera Esercitazione Giornaliera (Syllabus 2026)</h3>
<br>
<div class="form-group">
<label>Seleziona Materia</label>
<select id="ex-subject" onchange="updateUnits()">
<option value="Fisica">Fisica</option>
<option value="Biologia">Biologia</option>
<option value="Chimica">Chimica</option>
</select>
</div>

<div class="form-group">
<label>Seleziona Unità Didattica</label>
<select id="ex-unit">
</select>
</div>

<button id="btn-generate" onclick="generateExercise()">Genera Test con Gemini AI</button>

<div id="quiz-container" class="hidden" style="margin-top: 25px;">
<hr><br>
<h4 id="quiz-title"></h4>
<br>
<div id="questions-list"></div>
<button id="btn-submit-quiz" onclick="submitQuiz()" style="margin-top:15px;">Invia Risposte</button>
</div>
</div>

<div id="tab-learning" class="card hidden">
<h3>Sezione Apprendimento e Analisi Errori</h3>
<p style="font-size:0.9rem; color:#64748b; margin-bottom:15px;">
Qui trovi lo storico dei test completati e le spiegazioni dettagliate fornite dall'AI per ciascun errore commesso.
</p>
<div id="history-container">
</div>
</div>
</div>
</div>

<script>
let currentUser = null;
let currentQuizData = null;
let userAnswers = {};

const unitsMap = {
'Fisica': ['Cinematica e Dinamica', 'Meccanica dei Fluidi', 'Termodinamica', 'Elettromagnetismo'],
'Biologia': ['Biologia Cellulare', 'Genetica ed Ereditarietà', 'Respirazione Cellulare e Metabolismo', 'Anatomia e Fisiologia'],
'Chimica': ['Struttura dell atomo', 'Legami Chimici', 'Stechiometria e Reazioni', 'Acidi, Basi e pH']
};

function updateUnits() {
const subject = document.getElementById('ex-subject').value;
const unitSelect = document.getElementById('ex-unit');
unitSelect.innerHTML = '';
unitsMap[subject].forEach(unit => {
const opt = document.createElement('option');
opt.value = unit;
opt.textContent = unit;
unitSelect.appendChild(opt);
});
}
updateUnits();

function switchAuthTab(tab) {
document.getElementById('tab-btn-login').classList.remove('active');
document.getElementById('tab-btn-register').classList.remove('active');
document.getElementById('tab-btn-recover').classList.remove('active');

document.getElementById('login-form').classList.add('hidden');
document.getElementById('register-form').classList.add('hidden');
document.getElementById('recover-form').classList.add('hidden');

if(tab === 'login') {
document.getElementById('tab-btn-login').classList.add('active');
document.getElementById('login-form').classList.remove('hidden');
} else if(tab === 'register') {
document.getElementById('tab-btn-register').classList.add('active');
document.getElementById('register-form').classList.remove('hidden');
} else if(tab === 'recover') {
document.getElementById('tab-btn-recover').classList.add('active');
document.getElementById('recover-form').classList.remove('hidden');
}
}

function switchAppTab(tab) {
document.getElementById('tab-app-ex').classList.remove('active');
document.getElementById('tab-app-learn').classList.remove('active');

document.getElementById('tab-exercise').classList.add('hidden');
document.getElementById('tab-learning').classList.add('hidden');

if(tab === 'exercise') {
document.getElementById('tab-app-ex').classList.add('active');
document.getElementById('tab-exercise').classList.remove('hidden');
} else {
document.getElementById('tab-app-learn').classList.add('active');
document.getElementById('tab-learning').classList.remove('hidden');
loadLearningHistory();
}
}

async function register() {
const name = document.getElementById('reg-name').value;
const email = document.getElementById('reg-email').value;
const pin = document.getElementById('reg-pin').value;
const recoveryAnswer = document.getElementById('reg-recovery').value;

const res = await fetch('/api/register', {
method: 'POST',
headers: {'Content-Type': 'application/json'},
body: JSON.stringify({ name, email, pin, recoveryAnswer })
});

const data = await res.json();
if(res.ok) {
alert('Profilo creato con successo! Ora puoi accedere.');
switchAuthTab('login');
} else {
alert(data.error || 'Errore durante la registrazione.');
}
}

async function login() {
const email = document.getElementById('login-email').value;
const pin = document.getElementById('login-pin').value;

const res = await fetch('/api/login', {
method: 'POST',
headers: {'Content-Type': 'application/json'},
body: JSON.stringify({ email, pin })
});

const data = await res.json();
if(res.ok) {
currentUser = data;
document.getElementById('user-display-name').textContent = currentUser.name;
document.getElementById('auth-section').classList.add('hidden');
document.getElementById('app-section').classList.remove('hidden');
} else {
alert(data.error || 'Credenziali non valide.');
}
}

async function recoverPin() {
const email = document.getElementById('rec-email').value;
const recoveryAnswer = document.getElementById('rec-answer').value;

const res = await fetch('/api/recover-pin', {
method: 'POST',
headers: {'Content-Type': 'application/json'},
body: JSON.stringify({ email, recoveryAnswer })
});

const data = await res.json();
const resultDiv = document.getElementById('recovered-pin-result');
if(res.ok) {
resultDiv.style.color = 'green';
resultDiv.textContent = 'Il tuo PIN è: ' + data.pin;
} else {
resultDiv.style.color = 'red';
resultDiv.textContent = data.error || 'Impossibile recuperare il PIN.';
}
}

function logout() {
currentUser = null;
document.getElementById('app-section').classList.add('hidden');
document.getElementById('auth-section').classList.remove('hidden');
}

async function generateExercise() {
const subject = document.getElementById('ex-subject').value;
const unit = document.getElementById('ex-unit').value;
const btn = document.getElementById('btn-generate');

btn.disabled = true;
btn.textContent = 'Generazione in corso con Gemini AI...';

try {
const res = await fetch('/api/generate-exercise', {
method: 'POST',
headers: {'Content-Type': 'application/json'},
body: JSON.stringify({ subject, unit })
});

const data = await res.json();
if(res.ok && data.questions) {
currentQuizData = { subject, unit, questions: data.questions };
renderQuiz();
} else {
alert(data.error || 'Errore nella generazione del quiz.');
}
} catch(e) {
alert('Errore di connessione con il server.');
} finally {
btn.disabled = false;
btn.textContent = 'Genera Test con Gemini AI';
}
}

function renderQuiz() {
userAnswers = {};
const container = document.getElementById('questions-list');
container.innerHTML = '';
document.getElementById('quiz-title').textContent = 'Esercitazione: ' + currentQuizData.subject + ' - ' + currentQuizData.unit;

currentQuizData.questions.forEach((q, qIndex) => {
const qDiv = document.createElement('div');
qDiv.className = 'question-card';
qDiv.innerHTML = '<p><strong>Quesito ' + (qIndex + 1) + ':</strong> ' + q.question + '</p>';

q.options.forEach((opt, oIndex) => {
const optBtn = document.createElement('button');
optBtn.className = 'option-btn';
optBtn.textContent = opt;
optBtn.onclick = () => selectOption(qIndex, oIndex, optBtn);
qDiv.appendChild(optBtn);
});

container.appendChild(qDiv);
});

document.getElementById('quiz-container').classList.remove('hidden');
}

function selectOption(qIndex, oIndex, btn) {
userAnswers[qIndex] = oIndex;
const parent = btn.parentElement;
parent.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
btn.classList.add('selected');
}

async function submitQuiz() {
let score = 0;
const qCards = document.querySelectorAll('.question-card');

currentQuizData.questions.forEach((q, qIndex) => {
const selected = userAnswers[qIndex];
const card = qCards[qIndex];
const buttons = card.querySelectorAll('.option-btn');

if(selected !== undefined) {
if(selected === q.correct) {
score++;
buttons[selected].classList.add('correct');
} else {
buttons[selected].classList.add('wrong');
buttons[q.correct].classList.add('correct');
}
} else {
buttons[q.correct].classList.add('correct');
}

const exp = document.createElement('div');
exp.className = 'explanation';
exp.innerHTML = '<strong>Spiegazione AI:</strong> ' + q.explanation;
card.appendChild(exp);
});

document.getElementById('btn-submit-quiz').disabled = true;

await fetch('/api/save-exercise', {
method: 'POST',
headers: {'Content-Type': 'application/json'},
body: JSON.stringify({
userId: currentUser.id,
subject: currentQuizData.subject,
unit: currentQuizData.unit,
questions: currentQuizData.questions,
answers: userAnswers,
score: score
})
});

alert('Test Completato! Punteggio: ' + score + ' / ' + currentQuizData.questions.length);
}

async function loadLearningHistory() {
const container = document.getElementById('history-container');
container.innerHTML = 'Caricamento storico in corso...';

const res = await fetch('/api/user-history/' + currentUser.id);
const history = await res.json();

if(!res.ok || history.length === 0) {
container.innerHTML = '<p>Nessuna esercitazione completata finora.</p>';
return;
}

container.innerHTML = '';
history.forEach(item => {
const questions = JSON.parse(item.questions_json);
const answers = JSON.parse(item.answers_json);

const card = document.createElement('div');
card.className = 'card';
card.style.background = '#f1f5f9';

let html = '<h4>' + item.subject + ' - ' + item.unit + '</h4>' +
'<p style="font-size:0.85rem; color:#64748b;">Data: ' + new Date(item.created_at).toLocaleString('it-IT') + ' | Punteggio: ' + item.score + '/' + questions.length + '</p><br>';

questions.forEach((q, idx) => {
const userAns = answers[idx];
const isCorrect = userAns === q.correct;

html += '<div style="margin-bottom:10px; background:white; padding:10px; border-radius:6px;">' +
'<p><strong>' + (idx + 1) + '. ' + q.question + '</strong></p>' +
'<p style="font-size:0.9rem; color:' + (isCorrect ? 'green' : 'red') + ';">' +
'La tua risposta: ' + (userAns !== undefined ? q.options[userAns] : 'Non data') + ' ' + (isCorrect ? '✓' : '✗') +
'</p>' +
(!isCorrect ? '<p style="font-size:0.85rem; color:#15803d; margin-top:4px;"><strong>Corretta:</strong> ' + q.options[q.correct] + '</p><div class="explanation">' + q.explanation + '</div>' : '') +
'</div>';
});

card.innerHTML = html;
container.appendChild(card);
});
}
</script>

</body>
</html>`);
});

app.listen(PORT, () => {
console.log(`Server avviato sulla porta ${PORT}`);
});

