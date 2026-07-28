require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// --- 1. INIZIALIZZAZIONE DATABASE SQLITE ---
const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
// Tabella Utenti con PIN personalizzato
db.run(`
CREATE TABLE IF NOT EXISTS users (
id INTEGER PRIMARY KEY AUTOINCREMENT,
name TEXT NOT NULL,
email TEXT UNIQUE NOT NULL,
pin TEXT NOT NULL
)
`);

// Tabella Risultati Simulazioni
db.run(`
CREATE TABLE IF NOT EXISTS results (
id INTEGER PRIMARY KEY AUTOINCREMENT,
user_id INTEGER NOT NULL,
score REAL NOT NULL,
correct_count INTEGER NOT NULL,
wrong_count INTEGER NOT NULL,
blank_count INTEGER NOT NULL,
timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
FOREIGN KEY(user_id) REFERENCES users(id)
)
`);

// Tabella Registro Errori
db.run(`
CREATE TABLE IF NOT EXISTS errors (
id INTEGER PRIMARY KEY AUTOINCREMENT,
user_id INTEGER NOT NULL,
question TEXT NOT NULL,
user_answer TEXT,
correct_answer TEXT,
topic TEXT,
explanation TEXT,
timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
FOREIGN KEY(user_id) REFERENCES users(id)
)
`);

// Profili predefiniti di base (Marco e Paola)
const stmt = db.prepare(`INSERT OR IGNORE INTO users (id, name, email, pin) VALUES (?, ?, ?, ?)`);
stmt.run(1, 'Marco', 'marco@medicina.it', '1234');
stmt.run(2, 'Paola', 'paola@medicina.it', '5678');
stmt.finalize();
});

// --- 2. API ENDPOINTS ---

// API Registrazione Nuovo Profilo
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

// API Login
app.post('/api/login', (req, res) => {
const { email, pin } = req.body;
if (!email || !pin) {
return res.status(400).json({ error: 'Inserisci sia la mail che il PIN.' });
}

db.get('SELECT id, name, email FROM users WHERE email = ? AND pin = ?', [email, pin], (err, user) => {
if (err) return res.status(500).json({ error: 'Errore interno del database.' });
if (!user) return res.status(401).json({ error: 'Email o PIN errati.' });
res.json({ success: true, user });
});
});

// API Lista Utenti per la Selezione Rapida
app.get('/api/users', (req, res) => {
db.all('SELECT id, name, email FROM users', [], (err, rows) => {
if (err) return res.status(500).json({ error: err.message });
res.json(rows);
});
});

// API Salva Risultati Simulazione
app.post('/api/results', (req, res) => {
const { userId, score, correctCount, wrongCount, blankCount } = req.body;
if (!userId) return res.status(400).json({ error: 'Utente non identificato.' });

const query = `INSERT INTO results (user_id, score, correct_count, wrong_count, blank_count) VALUES (?, ?, ?, ?, ?)`;
db.run(query, [userId, score, correctCount, wrongCount, blankCount], function(err) {
if (err) return res.status(500).json({ error: err.message });
res.json({ success: true, resultId: this.lastID });
});
});

// API Recupero Statistiche Profilo
app.get('/api/stats/:userId', (req, res) => {
const { userId } = req.params;
db.all('SELECT * FROM results WHERE user_id = ? ORDER BY timestamp DESC', [userId], (err, rows) => {
if (err) return res.status(500).json({ error: err.message });
res.json(rows);
});
});

// --- 3. FRONTEND WEB COMPLETO (RESPONSIVE) ---
app.get('/', (req, res) => {
res.send(`
<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Semestre Filtro Medicina 2026</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
body { background-color: #f4f6f9; color: #333; padding: 15px; }
.container { max-width: 800px; margin: 10px auto; background: #ffffff; padding: 25px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.08); }
h1 { font-size: 1.6rem; color: #1a365d; text-align: center; margin-bottom: 20px; }

.tabs { display: flex; gap: 10px; margin-bottom: 20px; border-bottom: 2px solid #e2e8f0; }
.tab-btn { padding: 10px 15px; border: none; background: none; font-weight: bold; color: #718096; cursor: pointer; }
.tab-btn.active { color: #3182ce; border-bottom: 3px solid #3182ce; }

.profile-selector { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 20px; }
.card { border: 2px solid #e2e8f0; padding: 12px; border-radius: 10px; text-align: center; cursor: pointer; transition: all 0.2s; background: #fafafa; }
.card:hover, .card.selected { border-color: #3182ce; background: #ebf8ff; }
.card h3 { color: #2b6cb0; font-size: 1rem; }
.card p { font-size: 0.75rem; color: #718096; }

.input-group { margin-bottom: 12px; }
label { display: block; font-size: 0.85rem; margin-bottom: 4px; font-weight: 600; color: #4a5568; }
input { width: 100%; padding: 10px; border: 1px solid #cbd5e0; border-radius: 8px; font-size: 0.95rem; }

.btn { width: 100%; padding: 12px; background-color: #3182ce; color: white; border: none; border-radius: 8px; font-size: 1rem; font-weight: bold; cursor: pointer; margin-top: 5px; }
.btn:hover { background-color: #2b6cb0; }
.btn-secondary { background-color: #718096; margin-top: 10px; }

.dashboard { display: none; }
.user-header { display: flex; justify-content: space-between; align-items: center; background: #edf2f7; padding: 12px 15px; border-radius: 8px; margin-bottom: 20px; }

.quiz-box { border: 1px solid #e2e8f0; padding: 15px; border-radius: 8px; margin-bottom: 15px; background: #fff; }
.option-btn { display: block; width: 100%; text-align: left; padding: 10px; margin: 6px 0; border: 1px solid #cbd5e0; border-radius: 6px; background: #f7fafc; cursor: pointer; }
.option-btn.selected { background: #ebf8ff; border-color: #3182ce; font-weight: bold; }

.timer { font-size: 1.2rem; font-weight: bold; color: #e53e3e; text-align: right; margin-bottom: 10px; }
.stat-box { background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 10px; }

@media (max-width: 480px) {
body { padding: 5px; }
.container { padding: 15px; }
}
</style>
</head>
<body>
<div class="container">
<h1>Semestre Filtro Medicina 2026</h1>

<!-- AUTENTICAZIONE E REGISTRAZIONE -->
<div id="auth-section">
<div class="tabs">
<button class="tab-btn active" onclick="switchAuthTab('login')">Accedi</button>
<button class="tab-btn" onclick="switchAuthTab('register')">Crea Nuovo Profilo</button>
</div>

<!-- FORM ACCESSO -->
<div id="login-form">
<p style="text-align: center; color: #718096; margin-bottom: 15px; font-size: 0.85rem;">Seleziona o inserisci le credenziali</p>
<div class="profile-selector" id="users-list"></div>

<div class="input-group">
<label>Email</label>
<input type="email" id="login-email" placeholder="email@medicina.it">
</div>
<div class="input-group">
<label>PIN Personale</label>
<input type="password" id="login-pin" placeholder="Inserisci il tuo PIN">
</div>
<button class="btn" onclick="login()">Entra nella Piattaforma</button>
</div>

<!-- FORM REGISTRAZIONE PROFILO -->
<div id="register-form" style="display: none;">
<div class="input-group">
<label>Nome Completo</label>
<input type="text" id="reg-name" placeholder="Es. Mario Rossi">
</div>
<div class="input-group">
<label>Email</label>
<input type="email" id="reg-email" placeholder="mario@medicina.it">
</div>
<div class="input-group">
<label>Scegli il tuo PIN (es. 4 cifre)</label>
<input type="password" id="reg-pin" placeholder="Crea PIN personalizzato">
</div>
<button class="btn" onclick="register()">Crea Profilo e Accedi</button>
</div>

<p id="auth-error" style="color: #e53e3e; text-align: center; margin-top: 10px; font-size: 0.85rem;"></p>
</div>

<!-- DASHBOARD DI STUDIO COMPLETA -->
<div id="dashboard-section" class="dashboard">
<div class="user-header">
<span>Utente: <strong id="user-name"></strong></span>
<button onclick="logout()" style="padding: 5px 10px; font-size: 0.8rem; background: #e53e3e; color: white; border: none; border-radius: 5px; cursor: pointer;">Esci</button>
</div>

<div class="tabs">
<button class="tab-btn active" onclick="switchDashTab('sim')">Esercitazione / Simulazione</button>
<button class="tab-btn" onclick="switchDashTab('stats')">Statistiche e Registro</button>
</div>

<!-- SEZIONE SIMULAZIONE -->
<div id="sim-tab">
<div class="timer" id="timer-display">Tempo: 50:00</div>
<div id="questions-container"></div>
<button class="btn" onclick="submitSimulation()">Concludi e Invia Simulazione</button>
</div>

<!-- SEZIONE STATISTICHE -->
<div id="stats-tab" style="display: none;">
<h3>Storico Risultati DM 941/2026</h3>
<div id="stats-container" style="margin-top: 15px;"></div>
</div>
</div>
</div>

<script>
let activeUser = null;
let questions = [];
let userAnswers = {};
let timerInterval = null;
let timeLeft = 3000; // 50 minuti in secondi

// Quiz di esempio ufficiali MUR per il Semestre Filtro
const sampleQuestions = [
{ id: 1, topic: "Fisica", q: "Qual è l'unità di misura della forza nel Sistema Internazionale?", options: ["Joule", "Newton", "Pascal", "Watt"], correct: 1 },
{ id: 2, topic: "Biologia", q: "Quale organello cellulare è responsabile della respirazione cellulare?", options: ["Ribosoma", "Apparato di Golgi", "Mitocondrio", "Lisosoma"], correct: 2 },
{ id: 3, topic: "Chimica", q: "Qual è il pH di una soluzione neutra a 25°C?", options: ["0", "7", "14", "1"], correct: 1 },
{ id: 4, topic: "Fisica", q: "La prima legge della dinamica è nota anche come principio di:", options: ["Inerzia", "Azione e reazione", "Conservazione della massa", "Gravitazione"], correct: 0 },
{ id: 5, topic: "Biologia", q: "Il processo di duplicazione del DNA avviane in quale fase del ciclo cellulare?", options: ["Fase M", "Fase S", "Fase G1", "Fase G2"], correct: 1 }
];

window.onload = loadUsersList;

async function loadUsersList() {
try {
const res = await fetch('/api/users');
const users = await res.json();
const container = document.getElementById('users-list');
container.innerHTML = users.map(u => \`
<div class="card" onclick="selectUser('\${u.email}', '\${u.name}')">
<h3>\${u.name}</h3>
<p>\${u.email}</p>
</div>
\`).join('');
} catch (e) {}
}

function selectUser(email, name) {
document.getElementById('login-email').value = email;
}

function switchAuthTab(tab) {
document.getElementById('auth-error').innerText = '';
if (tab === 'login') {
document.getElementById('login-form').style.display = 'block';
document.getElementById('register-form').style.display = 'none';
} else {
document.getElementById('login-form').style.display = 'none';
document.getElementById('register-form').style.display = 'block';
}
document.querySelectorAll('#auth-section .tab-btn').forEach((b, i) => {
b.classList.toggle('active', (tab === 'login' && i === 0) || (tab === 'register' && i === 1));
});
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
startSession();
} catch (e) {
err.innerText = 'Errore di connessione.';
}
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
startSession();
} catch (e) {
err.innerText = 'Errore durante l accessso.';
}
}

function startSession() {
document.getElementById('auth-section').style.display = 'none';
document.getElementById('dashboard-section').style.display = 'block';
document.getElementById('user-name').innerText = activeUser.name;
loadSimulation();
startTimer();
}

function loadSimulation() {
questions = sampleQuestions;
userAnswers = {};
const container = document.getElementById('questions-container');
container.innerHTML = questions.map((q, idx) => \`
<div class="quiz-box">
<small style="color: #3182ce; font-weight: bold;">\${q.topic} - Quesito \${idx + 1}</small>
<p style="font-size: 1rem; margin: 8px 0; font-weight: 600;">\${q.q}</p>
\${q.options.map((opt, oIdx) => \`
<button class="option-btn" id="q_\${q.id}_\${oIdx}" onclick="selectAnswer(\${q.id}, \${oIdx})">
\${String.fromCharCode(65 + oIdx)}) \${opt}
</button>
\`).join('')}
</div>
\`).join('');
}

function selectAnswer(qId, oIdx) {
userAnswers[qId] = oIdx;
const q = questions.find(x => x.id === qId);
q.options.forEach((_, i) => {
const btn = document.getElementById(\`q_\${qId}_\${i}\`);
if (btn) btn.classList.toggle('selected', i === oIdx);
});
}

function startTimer() {
clearInterval(timerInterval);
timerInterval = setInterval(() => {
timeLeft--;
const m = Math.floor(timeLeft / 60);
const s = timeLeft % 60;
document.getElementById('timer-display').innerText = \`Tempo: \${m}:\${s < 10 ? '0' : ''}\${s}\`;
if (timeLeft <= 0) {
clearInterval(timerInterval);
submitSimulation();
}
}, 1000);
}

async function submitSimulation() {
clearInterval(timerInterval);
let correct = 0, wrong = 0, blank = 0, score = 0;

questions.forEach(q => {
const ans = userAnswers[q.id];
if (ans === undefined) {
blank++;
} else if (ans === q.correct) {
correct++;
score += 1.5; // Valutazione Decreto MUR
} else {
wrong++;
score -= 0.4;
}
});

await fetch('/api/results', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
userId: activeUser.id,
score,
correctCount: correct,
wrongCount: wrong,
blankCount: blank
})
});

alert(\`Simulazione Completata!\\n\\nPunteggio: \${score.toFixed(2)} pt\\nEsatte: \${correct}\\nErrate: \${wrong}\\nOmesse: \${blank}\`);
switchDashTab('stats');
}

function switchDashTab(tab) {
if (tab === 'sim') {
document.getElementById('sim-tab').style.display = 'block';
document.getElementById('stats-tab').style.display = 'none';
} else {
document.getElementById('sim-tab').style.display = 'none';
document.getElementById('stats-tab').style.display = 'block';
loadStats();
}
document.querySelectorAll('#dashboard-section .tab-btn').forEach((b, i) => {
b.classList.toggle('active', (tab === 'sim' && i === 0) || (tab === 'stats' && i === 1));
});
}

async function loadStats() {
const container = document.getElementById('stats-container');
try {
const res = await fetch(\`/api/stats/\${activeUser.id}\`);
const data = await res.json();

if (data.length === 0) {
container.innerHTML = '<p style="color: #718096;">Nessuna esercitazione completata finora.</p>';
return;
}

container.innerHTML = data.map(s => \`
<div class="stat-box">
<strong>Punteggio Totale: \${s.score.toFixed(2)} pt</strong><br>
<small>Esatte: \${s.correct_count} | Errate: \${s.wrong_count} | Omesse: \${s.blank_count}</small><br>
<small style="color: #a0aec0;">Data: \${new Date(s.timestamp).toLocaleString('it-IT')}</small>
</div>
\`).join('');
} catch (e) {
container.innerHTML = '<p style="color: #e53e3e;">Errore durante il caricamento.</p>';
}
}

function logout() {
activeUser = null;
clearInterval(timerInterval);
document.getElementById('auth-section').style.display = 'block';
document.getElementById('dashboard-section').style.display = 'none';
loadUsersList();
}
</script>
</body>
</html>
`);
});

// --- 4. AVVIO SERVER ---
app.listen(PORT, () => {
console.log(`Server attivo su http://localhost:${PORT}`);
});
