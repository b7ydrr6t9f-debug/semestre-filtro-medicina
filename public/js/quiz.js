// Generatore di esercitazioni: costruzione dei prompt per Gemini, rendering
// del quiz e salvataggio del punteggio. Le MCQ si correggono da sole
// (indice esatto); i completamenti si correggono con corrispondenza esatta
// locale e, per le risposte non identiche, con una verifica AI dedicata che
// riconosce sinonimi/sigle ma non i refusi di battitura (vedi submitQuiz).

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

// Chiama il backend con un prompt generico che deve rispondere in JSON,
// restituisce l'oggetto parsato o lancia un errore chiaro. Usata sia per
// generare i quiz sia per far verificare all'AI le risposte a completamento.
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

// Costruisce il prompt per far valutare all'AI le risposte a completamento
// che non corrispondono esattamente a quella attesa: distingue le
// riformulazioni concettualmente corrette (sinonimi, sigle, termini
// equivalenti) dai veri errori — refusi di battitura compresi, che devono
// SEMPRE risultare sbagliati anche se molto simili alla risposta attesa.
function buildCorrezioneCompletamentoPrompt(elementi) {
  const elenco = elementi.map((el, i) =>
    `${i + 1}. Domanda: "${el.domanda}"\n   Risposta attesa: "${el.rispostaAttesa}"\n   Risposta data dallo studente: "${el.rispostaUtente}"`
  ).join('\n\n');

  return `Sei un professore universitario che corregge domande a completamento per un esame di Medicina e Chirurgia (Semestre Filtro).

Per ciascuna delle seguenti risposte, stabilisci se lo studente ha risposto in modo concettualmente corretto, anche usando parole diverse da quelle attese: sinonimi, termine tecnico equivalente, sigla al posto del nome esteso (o viceversa), riformulazione con lo stesso identico significato.

Regola fondamentale, da rispettare sempre: un errore di ortografia o di battitura, o una risposta incompleta/troncata rispetto a quella attesa, NON deve MAI essere considerato corretto, anche se graficamente molto simile alla risposta attesa. Sono corrette solo le risposte scritte in modo corretto e concettualmente equivalenti; qualunque refuso rende la risposta errata.

${elenco}

Rispondi TASSATIVAMENTE ed ESCLUSIVAMENTE con un oggetto JSON valido privo di markdown o formattazione extra, con questa struttura esatta e un elemento per ciascuna delle ${elementi.length} risposte sopra, nello stesso ordine:
{ "risultati": [ { "n": 1, "corretto": true }, { "n": 2, "corretto": false } ] }`;
}

// Chiede all'AI di valutare un elenco di risposte a completamento; in caso di
// errore di rete o di risposta malformata NON concede il beneficio del
// dubbio, le lascia segnate come errate invece di rischiare falsi positivi.
async function correggiCompletamentiConAI(elementi) {
  if (elementi.length === 0) return [];
  try {
    const parsed = await chiediJsonAlServer(buildCorrezioneCompletamentoPrompt(elementi));
    if (!Array.isArray(parsed.risultati) || parsed.risultati.length !== elementi.length) {
      throw new Error('Formato di risposta inatteso dal modello.');
    }
    return parsed.risultati.map(r => r.corretto === true);
  } catch (e) {
    return elementi.map(() => false);
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
    const parsedQuiz = await chiediJsonAlServer(buildEsercitazionePrompt(materiaObj, unitaObj));
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

// Confronta la risposta data con quella attesa dopo la normalizzazione
// (case, accenti, punteggiatura): devono corrispondere esattamente.
// Un refuso di battitura deve risultare sbagliato, per questo qui non c'è
// nessuna tolleranza (né su sottostringhe né su distanza tra caratteri);
// le riformulazioni concettualmente valide vengono verificate dall'AI in
// submitQuiz, non qui.
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

// Corregge tutto in automatico: le MCQ e i completamenti esatti localmente,
// poi manda all'AI solo i completamenti non identici alla risposta attesa
// (per riconoscere sinonimi/sigle senza tollerare refusi di battitura).
async function submitQuiz() {
  clearInterval(timerInterval);

  const daVerificareConAI = []; // { idx, domanda, rispostaUtente, rispostaAttesa }

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
        q._esito = 'errata'; // provvisorio: potrebbe essere un sinonimo, verificato sotto
        daVerificareConAI.push({ idx, domanda: q.question, rispostaUtente: userVal, rispostaAttesa: q.correctAnswer });
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

  if (daVerificareConAI.length > 0) {
    const btnSubmit = document.getElementById('btn-submit-quiz');
    const ripristina = impostaCaricamento([btnSubmit], btnSubmit, `Verifica AI di ${daVerificareConAI.length} rispost${daVerificareConAI.length === 1 ? 'a' : 'e'} non identiche...`);
    try {
      const esiti = await correggiCompletamentiConAI(daVerificareConAI);
      esiti.forEach((corretta, i) => {
        if (corretta) currentQuizData.questions[daVerificareConAI[i].idx]._esito = 'esatta';
      });
    } finally {
      ripristina();
    }
  }

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
