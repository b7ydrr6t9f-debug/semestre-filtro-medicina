// Generatore di esercitazioni: costruzione dei prompt per Gemini, rendering
// del quiz e salvataggio del punteggio. Le MCQ si correggono da sole
// (indice esatto); i completamenti si correggono con corrispondenza esatta
// locale (nessuna verifica AI: vedi rispostaEsatta/submitQuiz).

// Costruisce il prompt per un'esercitazione su un'unita' didattica (31 domande: 21 MCQ + 10 completamento)
function buildEsercitazionePrompt(materiaObj, unitaObj, domandeGiaUsate = []) {
  const sezioneCronologia = domandeGiaUsate.length === 0 ? '' : `
Nelle esercitazioni precedenti su questa stessa unità didattica sono già state usate queste domande: NON riproporle, nemmeno con variazioni minime nella formulazione. Copri altri dettagli, altri sotto-argomenti o altre angolature del programma, così ogni esercitazione risulta diversa dalle precedenti:
${domandeGiaUsate.map((d, i) => `${i + 1}. ${d}`).join('\n')}
`;

  return `Sei un professore universitario d'esame per il Corso di Laurea in Medicina e Chirurgia (Semestre Filtro).
Crea un'esercitazione di ESATTAMENTE 31 quesiti basati ESCLUSIVAMENTE sul seguente programma dell'Unità Didattica:

Materia: ${materiaObj.title}
Unità Didattica: ${unitaObj.title}
Programma Dettagliato:
${unitaObj.content}
${sezioneCronologia}
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

// Chiama il backend con un prompt generico che deve rispondere in JSON,
// restituisce l'oggetto parsato o lancia un errore chiaro. Usata per generare
// i quiz dal vivo (fallback quando un'unità non ha un pool pregenerato).
async function chiediJsonAlServer(promptText) {
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

// Prova a pescare una simulazione dal pool pregenerato per l'unità
// richiesta. Restituisce l'array di domande, o null se il pool per quella
// unità è ancora vuoto (nessuna simulazione pregenerata caricata).
async function chiediSimulazionePregenerata(matKey, unitaId) {
  const res = await authFetch(`/api/simulazione-pregenerata/${matKey}/${unitaId}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.pool ? data.questions : null;
}

// Avvia un'esercitazione (31 domande) sull'unita' didattica selezionata.
// Attinge sempre prima al pool pregenerato (domande verificate, aderenti
// solo al programma dell'unità, già pronte e disponibili istantaneamente);
// ricorre alla generazione live via Gemini solo come fallback, se quell'unità
// non ha ancora simulazioni pregenerate caricate.
async function avviaEsercitazione() {
  const matKey = document.getElementById('sim-materia').value;
  const unitaId = parseInt(document.getElementById('sim-unita').value);
  const materiaObj = SYLLABUS_DATA[matKey];
  const unitaObj = materiaObj.unita.find(u => u.id === unitaId);
  const chiaveCronologia = `esercitazione_${matKey}_${unitaId}`;

  const btnGen = document.getElementById('btn-avvia-esercitazione');
  const ripristina = impostaCaricamento([btnGen], btnGen, 'Avvio dell\'esercitazione in corso...');

  try {
    const domandePregenerate = await chiediSimulazionePregenerata(matKey, unitaId);

    if (domandePregenerate) {
      currentQuizData = {
        materia: materiaObj.title,
        unitaTitle: unitaObj.title,
        questions: domandePregenerate
      };
      renderQuizUI();
      return;
    }

    // Fallback: nessuna simulazione pregenerata per questa unità, si genera
    // live come prima.
    const domandeGiaUsate = await leggiCronologiaGenerazione(chiaveCronologia);
    const parsedQuiz = await chiediJsonAlServer(buildEsercitazionePrompt(materiaObj, unitaObj, domandeGiaUsate));
    currentQuizData = {
      materia: materiaObj.title,
      unitaTitle: unitaObj.title,
      questions: parsedQuiz.questions
    };
    await salvaCronologiaGenerazione(chiaveCronologia, parsedQuiz.questions.map(q => q.question));
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

  const btn = document.getElementById('btn-avvia-test-recupero');
  const ripristina = impostaCaricamento([btn], btn, 'Generazione test di recupero in corso...');

  try {
    const parsedQuiz = await chiediJsonAlServer(buildRecuperoPrompt(argomentiTesto, nMcq, nCompletamento));
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
        <div class="flex justify-end">
          <button type="button" onclick="annullaRispostaDomanda(${idx}, '${q.type}')" class="text-xs text-slate-500 hover:text-rose-600 font-medium flex items-center gap-1 transition">
            <i data-lucide="rotate-ccw" class="w-3.5 h-3.5"></i> Annulla risposta
          </button>
        </div>
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

// Annulla la risposta data a una singola domanda (deseleziona il radio
// per le risposte multiple, svuota il campo per il completamento)
function annullaRispostaDomanda(idx, tipo) {
  if (tipo === 'completamento') {
    const input = document.getElementById(`completion_${idx}`);
    if (input) input.value = '';
  } else {
    document.querySelectorAll(`input[name="question_${idx}"]`).forEach(r => { r.checked = false; });
  }
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

// Confronta la risposta data con quella attesa dopo la normalizzazione
// (case, accenti, punteggiatura): devono corrispondere esattamente.
// Un refuso di battitura deve risultare sbagliato, per questo qui non c'è
// nessuna tolleranza (né su sottostringhe né su distanza tra caratteri).
// Questa è l'unica correzione applicata ai completamenti: niente più
// verifica AI di sinonimi/riformulazioni.
function rispostaEsatta(rispostaUtente, rispostaAttesa) {
  return normalizzaTesto(rispostaUtente) === normalizzaTesto(rispostaAttesa);
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

// Corregge tutto in automatico, in locale: MCQ e completamenti confrontati
// esattamente con la risposta attesa. Nessuna verifica AI di sinonimi o
// riformulazioni: la corrispondenza deve essere testuale (dopo normalizzazione).
async function submitQuiz() {
  clearInterval(timerInterval);

  currentQuizData.questions.forEach((q, idx) => {
    if (q.type === 'completamento') {
      const inputEl = document.getElementById(`completion_${idx}`);
      const userVal = inputEl ? inputEl.value.trim() : '';
      q._userAnswerText = userVal;
      if (!userVal) {
        q._esito = 'omessa';
      } else if (rispostaEsatta(userVal, q.correctAnswer)) {
        q._esito = 'esatta';
      } else {
        q._esito = 'errata';
      }
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
    errate: errate,
    omesse: omesse,
    esito: punteggioTot >= (totale * 0.6) ? "Superato" : "Non Superato"
  };

  try {
    const resValutazione = await authFetch('/api/dati/valutazione', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, valutazione: nuovaValutazione })
    });
    const datiValutazione = await resValutazione.json();

    await authFetch('/api/dati/errori', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentUser.id, nuoviErrori, valutazioneId: datiValutazione.valutazioneId })
    });
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

  switchTab('valutazione');
}
