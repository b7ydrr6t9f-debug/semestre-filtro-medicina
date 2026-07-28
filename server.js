const express = require('express');
const https = require('https');
const path = require('path');
const app = express();

app.use(express.json());

// 1. Serve i file statici dalla cartella 'public'
app.use(express.static(path.join(__dirname, 'public')));

// 2. Quando si visita la home page (/), carica public/index.html
app.get('/', (req, res) => {
res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

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

// Rotte API per la generazione dei test e lezioni
app.post('/api/genera-test', (req, res) => {
const { materia, unita } = req.body;
const prompt = `Crea un test di 31 domande sul programma di ${materia}, nello specifico sull'unità didattica: "${unita}". Fornisci 21 domande a risposta multipla e 10 a risposta aperta, complete di opzioni e soluzioni. Rispondi in formato JSON.`;

chiamaGemini(prompt, (err, risposta) => {
if (err) return res.status(500).json({ errore: err });
res.json({ domande: risposta });
});
});

app.post('/api/genera-test-fine-settimana', (req, res) => {
const { errori } = req.body;
const argomenti = errori.map(e => `${e.materia}: ${e.argomento}`).join(', ');
const prompt = `Crea un test di recupero del fine settimana incentrato su questi argomenti in cui lo studente ha sbagliato: ${argomenti || "Fisica, Chimica e Biologia generale"}. Rispondi in formato JSON.`;

chiamaGemini(prompt, (err, risposta) => {
if (err) return res.status(500).json({ errore: err });
res.json({ domande: risposta });
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

