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

function chiamaGemini(prompt, callback) {
const postData = JSON.stringify({
contents: [{ parts: [{ text: prompt }] }]
});

const options = {
hostname: 'generativelanguage.googleapis.com',
path: `/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Content-Length': Buffer.byteLength(postData)
}
};

const req = https.request(options, (res) => {
let data = '';
res.on('data', (chunk) => data += chunk);
res.on('end', () => {
try {
const parsed = JSON.parse(data);
if (parsed.candidates && parsed.candidates[0].content.parts[0].text) {
callback(null, parsed.candidates[0].content.parts[0].text);
} else {
callback("Risposta API non valida o vuota", null);
}
} catch (e) {
callback("Errore nel parsing della risposta Gemini", null);
}
});
});

req.on('error', (e) => callback(e.message, null));
req.write(postData);
req.end();
}

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

