// Generatore di esercitazioni: costruzione dei prompt per Gemini, rendering
// del quiz, correzione automatica (MCQ + completamento) e salvataggio del punteggio.

// Costruisce il prompt per un'esercitazione su un'unita' didattica (31 domande: 21 MCQ + 10 completamento)
function buildEsercitazionePrompt(materiaObj, unitaObj) {
  return `Sei un professore universitario d'esame per il Corso di Laurea in Medicina e Chirurgia (Semestre Filtro).
Crea un'esercitazione di ESATTAMENTE 31 quesiti basati ESCLUSIVAMENTE sul seguente programma dell'Unità Didattica:

Materia: ${materiaObj.title}
Unità Didattica: ${unitaObj.title}
Programma Dettagliato:
${unitaObj.content}

Di questi 31 quesiti:
- 21 devono avere "type":"mcq", con "options" (5 opzioni A-E) e "correctIndex" (0-4) dell'opzione corretta.
- 10 devono avere "type":"completamento": una frase con una lacuna concettuale, senza "options" né "correctIndex", ma con "correctAnswer" (la risposta attesa, breve, 1-5 parole).

Ogni quesito deve includere anche:
- "materia": "${materiaObj.title}"
- "topic": etichetta sintetica (3-6 parole) del sotto-argomento specifico trattato, utile per tracciare gli errori dello studente.
- "explanation": spiegazione sintetica della risposta corretta.

Rispondi TASSATIVAMENTE ed ESCLUSIVAMENTE con un oggetto JSON valido privo di markdown o formattazione extra con questa struttura esatta:
{
  "questions": [
{ "id": 1, "type": "mcq", "materia": "...", "topic": "...", "question": "...", "options": ["...","...","...","...","..."], "correctIndex": 0, "explanation": "..." },
{ "id": 2, "type": "completamento", "materia": "...", "topic": "...", "question": "...", "correctAnswer": "...", "explanation": "..." }
  ]
}`;
}

// Costruisce il prompt per il test di recupero basato sugli errori del deposito
function buildRecuperoPrompt(argomentiErrori, nMcq, nCompletamento) {
  return `Sei un professore universitario d'esame per il Corso di Laurea in Medicina e Chirurgia (Semestre Filtro).
Crea un test di recupero mirato sui seguenti argomenti in cui lo studente ha sbagliato in passato (tra parentesi il numero di errori registrati su ciascuno):
${argomentiErrori}

Crea ESATTAMENTE ${nMcq + nCompletamento} quesiti: ${nMcq} con "type":"mcq" (5 opzioni A-E in "options", più "correctIndex") e ${nCompletamento} con "type":"completamento" (senza options, con "correctAnswer" breve, 1-5 parole).
Distribuisci i quesiti sugli argomenti sopra elencati, dando priorità a quelli con più errori. Ogni quesito deve includere anche "materia" (Biologia, Fisica, o Chimica e Prop. Biochimica, a seconda dell'argomento), "topic" (etichetta sintetica dell'argomento) e "explanation" (spiegazione sintetica della risposta corretta).

Rispondi TASSATIVAMENTE ed ESCLUSIVAMENTE con un oggetto JSON valido privo di markdown o formattazione extra con questa struttura esatta:
{
  "questions": [
{ "id": 1, "type": "mcq", "materia": "...", "topic": "...", "question": "...", "options": ["...","...","...","...","..."], "correctIndex": 0, "explanation": "..." },
{ "id": 2, "type": "completamento", "materia": "...", "topic": "...", "question": "...", "correctAnswer": "...", "explanation": "..." }
  ]
}`;
}

// Chiama il backend, restituisce il quiz parsato o lancia un errore chiaro
async function chiedaQuizAlServer(promptText) {
  const res = await authFetch('/api/generate-quiz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: promptText })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.errore || 'Errore nella comunicazione con il server AI.');
  try {
    return pulisciJson(data.result);
  } catch (e) {
    throw new Error("Errore durante la formattazione dei dati ricevuti dal modello.");
  }
}

// Genera un'esercitazione (31 domande) sull'unita' didattica selezionata
async function generateQuiz() {
  const matKey = document.getElementById('sim-materia').value;
  const unitaId = parseInt(document.getElementById('sim-unita').value);
  const materiaObj = SYLLABUS_DATA[matKey];
  const unitaObj = materiaObj.unita.find(u => u.id === unitaId);

  const btnGen = document.getElementById('btn-generate');
  const ripristina = impostaCaricamento([btnGen], btnGen, 'Generazione delle 31 domande in corso (può richiedere qualche secondo)...');

  try {
    const parsedQuiz = await chiedaQuizAlServer(buildEsercitazionePrompt(materiaObj, unitaObj));
    currentQuizData = {
      materia: materiaObj.title,
      unitaTitle: unitaObj.title,
      questions: parsedQuiz.questions
    };
    renderQuizUI();
  } catch (err) {
    alert("Si è verificato un errore: " + err.message);
  } finally {
    ripristina();
  }
}

// Genera un test di recupero dal deposito errori
async function generaTestDeposito() {
  if (errori.length === 0) {
    alert("Il deposito è vuoto: completa qualche esercitazione per iniziare a registrare i tuoi errori.");
    return;
  }

  const conteggio = {};
  errori.forEach(e => {
    const key = `${e.materia} — ${e.topic}`;
    conteggio[key] = (conteggio[key] || 0) + 1;
  });
  const argomentiOrdinati = Object.entries(conteggio).sort((a, b) => b[1] - a[1]);
  const argomentiTesto = argomentiOrdinati.map(([k, v]) => `- ${k} (${v} error${v === 1 ? 'e' : 'i'})`).join('\n');

  const nTotal = Math.min(20, Math.max(6, argomentiOrdinati.length * 2));
  const nMcq = Math.ceil(nTotal * 0.6);
  const nCompletamento = nTotal - nMcq;

  const btn = document.getElementById('btn-generate-deposito');
  const ripristina = impostaCaricamento([btn], btn, 'Generazione test di recupero in corso...');

  try {
    const parsedQuiz = await chiedaQuizAlServer(buildRecuperoPrompt(argomentiTesto, nMcq, nCompletamento));
    currentQuizData = {
      materia: "Recupero Fine Settimana",
      unitaTitle: `Basato su ${errori.length} error${errori.length === 1 ? 'e' : 'i'} registrat${errori.length === 1 ? 'o' : 'i'}`,
      questions: parsedQuiz.questions,
      source: 'deposito'
    };
    switchTab('simulator');
    renderQuizUI();
  } catch (err) {
    alert("Si è verificato un errore: " + err.message);
  } finally {
    ripristina();
  }
}

// Renderizza interfaccia quiz (gestisce MCQ e completamento)
function renderQuizUI() {
  document.getElementById('quiz-area').classList.remove('hidden');
  document.getElementById('quiz-title-display').textContent = `${currentQuizData.materia} - ${currentQuizData.unitaTitle}`;

  const qContainer = document.getElementById('questions-container');
  qContainer.classList.remove('hidden');
  qContainer.innerHTML = '';

  const reviewContainer = document.getElementById('review-container');
  reviewContainer.classList.add('hidden');
  reviewContainer.innerHTML = '';

  const btnSubmit = document.getElementById('btn-submit-quiz');
  btnSubmit.classList.remove('hidden');
  btnSubmit.disabled = false;
  btnSubmit.innerHTML = `<i data-lucide="check-circle" class="w-5 h-5"></i> Concludi e Calcola Punteggio`;

  currentQuizData.questions.forEach((q, idx) => {
    const badge = q.type === 'completamento'
      ? `<span class="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold">Completamento</span>`
      : `<span class="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-800 font-semibold">Risposta multipla</span>`;

    let bodyHtml;
    if (q.type === 'completamento') {
      bodyHtml = `<input type="text" id="completion_${idx}" placeholder="Scrivi qui la tua risposta..." class="w-full p-3 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none">`;
    } else {
      let optionsHtml = '';
      q.options.forEach((opt, oIdx) => {
        optionsHtml += `
          <label class="flex items-start gap-3 p-3 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer transition">
            <input type="radio" name="question_${idx}" value="${oIdx}" class="mt-1 text-indigo-600 focus:ring-indigo-500">
            <span class="text-sm text-slate-800">${String.fromCharCode(65 + oIdx)}) ${escapeHtml(opt)}</span>
          </label>
        `;
      });
      bodyHtml = `<div class="space-y-2">${optionsHtml}</div>`;
    }

    qContainer.innerHTML += `
      <div class="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-3">
        <div class="flex justify-between items-start gap-3">
          <h4 class="font-bold text-slate-900 text-base flex gap-2">
            <span class="text-indigo-600 font-mono">Q${idx + 1}.</span> ${escapeHtml(q.question)}
          </h4>
          ${badge}
        </div>
        ${bodyHtml}
      </div>
    `;
  });

  // Reset & Avvio Timer
  clearInterval(timerInterval);
  secondsElapsed = 0;
  document.getElementById('timer-display').textContent = '00:00';
  timerInterval = setInterval(() => {
    secondsElapsed++;
    const mins = String(Math.floor(secondsElapsed / 60)).padStart(2, '0');
    const secs = String(secondsElapsed % 60).padStart(2, '0');
    document.getElementById('timer-display').textContent = `${mins}:${secs}`;
  }, 1000);

  lucide.createIcons();
  window.scrollTo({ top: document.getElementById('quiz-area').offsetTop - 80, behavior: 'smooth' });
}

// Normalizza un testo per il confronto: minuscolo, senza accenti né punteggiatura
function normalizzaTesto(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // rimuove accenti
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Distanza di Levenshtein, per tollerare piccoli errori di battitura
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// Corregge una domanda a completamento tollerando piccole variazioni di battitura
function correttoCompletamento(rispostaUtente, rispostaAttesa) {
  const a = normalizzaTesto(rispostaUtente);
  const b = normalizzaTesto(rispostaAttesa);
  if (!a) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.includes(a)) return true;
  if (b.length >= 4 && a.includes(b)) return true;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return false;
  return levenshtein(a, b) <= Math.max(1, Math.floor(maxLen * 0.25));
}

// Azzera tutte le risposte date finora, senza rigenerare le domande
function annullaRisposte() {
  if (!currentQuizData) return;
  currentQuizData.questions.forEach((q, idx) => {
    if (q.type === 'completamento') {
      const el = document.getElementById(`completion_${idx}`);
      if (el) el.value = '';
    } else {
      document.querySelectorAll(`input[name="question_${idx}"]`).forEach(r => r.checked = false);
    }
  });
}

// Corregge tutto in automatico (MCQ + completamento) e calcola il punteggio
async function submitQuiz() {
  clearInterval(timerInterval);

  currentQuizData.questions.forEach((q, idx) => {
    if (q.type === 'completamento') {
      const inputEl = document.getElementById(`completion_${idx}`);
      const userVal = inputEl ? inputEl.value.trim() : '';
      q._userAnswerText = userVal;
      q._esito = !userVal ? 'omessa' : (correttoCompletamento(userVal, q.correctAnswer) ? 'esatta' : 'errata');
    } else {
      const selected = document.querySelector(`input[name="question_${idx}"]:checked`);
      if (!selected) {
        q._esito = 'omessa';
      } else {
        const val = parseInt(selected.value);
        q._userAnswerText = q.options[val];
        q._esito = val === q.correctIndex ? 'esatta' : 'errata';
      }
    }
  });

  await finalizeScore();
}

// Ricarica errori e valutazioni dell'utente loggato dal server
async function ricaricaDatiServer() {
  const res = await authFetch(`/api/dati/${currentUser.id}`);
  if (!res.ok) throw new Error('Impossibile caricare i dati salvati.');
  const data = await res.json();
  errori = data.errori;
  valutazioni = data.valutazioni;
}

// Calcola il punteggio finale, salva gli errori e la valutazione sul server (legati all'account)
async function finalizeScore() {
  let esatte = 0, errate = 0, omesse = 0;
  const nuoviErrori = [];

  currentQuizData.questions.forEach(q => {
    if (q._esito === 'esatta') esatte++;
    else if (q._esito === 'errata') errate++;
    else omesse++;

    if (q._esito === 'errata' || q._esito === 'omessa') {
      nuoviErrori.push({
        materia: q.materia || currentQuizData.materia,
        topic: normalizzaTopic(q.topic),
        question: q.question,
        userAnswer: q._userAnswerText || '(nessuna risposta)',
        correctAnswer: q.type === 'completamento' ? q.correctAnswer : (q.options ? q.options[q.correctIndex] : ''),
        explanation: q.explanation || '',
        timestamp: new Date().toISOString()
      });
    }
  });

  const punteggioTot = (esatte * 1) - (errate * 0.1);
  const mins = String(Math.floor(secondsElapsed / 60)).padStart(2, '0');
  const secs = String(secondsElapsed % 60).padStart(2, '0');
  const tempoFormattato = `${mins}:${secs}`;
  const oraAttuale = new Date().toLocaleString('it-IT');
  const totale = currentQuizData.questions.length;
  const rateo = `${esatte}/${totale}`;

  const nuovaValutazione = {
    data: oraAttuale,
    tipoProva: currentQuizData.source === 'deposito' ? "Recupero Weekend" : "Esercitazione UD",
    materiaUnita: `${currentQuizData.materia} - ${currentQuizData.unitaTitle.split('.')[0]}`,
    punteggio: punteggioTot.toFixed(1),
    tempo: tempoFormattato,
    rateo: rateo,
    esito: punteggioTot >= (totale * 0.6) ? "Superato" : "Non Superato"
  };

  try {
    await Promise.all([
      authFetch('/api/dati/errori', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id, nuoviErrori })
      }),
      authFetch('/api/dati/valutazione', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id, valutazione: nuovaValutazione })
      })
    ]);
    await ricaricaDatiServer();
  } catch (e) {
    alert("Punteggio calcolato, ma non è stato possibile salvarlo sul server: " + e.message);
  }

  renderValutazioniTable();
  renderDepositoRiepilogo();
  renderLezioniSuggerite();

  alert(`Esercitazione Completata!\n\nPunteggio: ${punteggioTot.toFixed(1)} Punti\nRisposte Esatte: ${esatte}\nRisposte Errate: ${errate}\nOmesse: ${omesse}\nTempo: ${tempoFormattato}\n\nGli errori sono stati aggiunti al Deposito Fine Settimana.`);

  document.getElementById('quiz-area').classList.add('hidden');
  document.getElementById('questions-container').innerHTML = '';
  document.getElementById('review-container').innerHTML = '';
  document.getElementById('review-container').classList.add('hidden');

  switchTab('valutazione');
}
