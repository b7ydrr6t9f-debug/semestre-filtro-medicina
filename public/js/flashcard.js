// Flashcard di studio: due modalità di generazione condividono lo stesso
// visualizzatore. 1) "Base": mazzo generato dall'AI su 2-3 unità didattiche
// insieme, per un primo ripasso prima delle esercitazioni a punteggio.
// 2) "Dagli errori": mazzo costruito all'istante dai dati già presenti nel
// deposito errori (nessuna chiamata AI: domanda, risposta corretta e
// spiegazione sono già salvate, non c'è nulla da generare di nuovo).

// --- Generazione mazzo base (AI, multi-unità) ---

// Popola le checkbox delle unità didattiche per la materia scelta
function updateFlashUnitaOptions() {
  const matKey = document.getElementById('flash-materia').value;
  const lista = document.getElementById('flash-unita-lista');
  lista.innerHTML = '';

  SYLLABUS_DATA[matKey].unita.forEach(u => {
    const label = document.createElement('label');
    label.className = 'flex items-center gap-2 p-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 cursor-pointer text-sm transition';
    label.innerHTML = `
      <input type="checkbox" value="${u.id}" class="flash-unita-checkbox w-4 h-4 text-indigo-600 focus:ring-indigo-500 rounded">
      <span>${escapeHtml(u.title)}</span>
    `;
    lista.appendChild(label);
  });

  lista.querySelectorAll('.flash-unita-checkbox').forEach(cb => cb.addEventListener('change', aggiornaContatoreUnita));
  aggiornaContatoreUnita();
}

// Al massimo 3 unità insieme: oltre quel numero il contenuto per singola
// unità diventerebbe troppo diluito nel mazzo generato
function aggiornaContatoreUnita() {
  const checkbox = document.querySelectorAll('.flash-unita-checkbox');
  const selezionate = document.querySelectorAll('.flash-unita-checkbox:checked');
  document.getElementById('flash-unita-contatore').textContent = `${selezionate.length}/3 selezionate (minimo 2)`;
  checkbox.forEach(cb => { if (!cb.checked) cb.disabled = selezionate.length >= 3; });
}

// Costruisce il prompt per un mazzo di flashcard su piu' unita' insieme
function buildFlashcardPrompt(materiaObj, unitaSelezionate) {
  const programmi = unitaSelezionate.map(u => `--- ${u.title} ---\n${u.content}`).join('\n\n');
  const nCarte = unitaSelezionate.length * 9;

  return `Sei un professore universitario per il Corso di Laurea in Medicina e Chirurgia (Semestre Filtro).
Crea un mazzo di ESATTAMENTE ${nCarte} flashcard di studio (non domande a risposta multipla, servono per un primo ripasso) basate ESCLUSIVAMENTE sul seguente programma di ${materiaObj.title}, che copre insieme le unità didattiche indicate:

${programmi}

Ogni flashcard deve avere:
- "front": il fronte della carta — un termine, una domanda concettuale breve, o l'enunciato di una legge/definizione da ricordare (massimo 20 parole).
- "back": il retro — la risposta o spiegazione concisa (massimo 40 parole), chiara e autosufficiente senza dover rileggere il programma.
- "unita": il titolo dell'unità didattica di provenienza, ESATTAMENTE uguale a una di queste: ${unitaSelezionate.map(u => `"${u.title}"`).join(', ')}.

Distribuisci le flashcard in modo equilibrato tra le unità indicate, dando priorità ai concetti più importanti e più probabili in un esame, non a dettagli marginali.

Rispondi TASSATIVAMENTE ed ESCLUSIVAMENTE con un oggetto JSON valido privo di markdown o formattazione extra con questa struttura esatta:
{ "flashcard": [ { "front": "...", "back": "...", "unita": "..." } ] }`;
}

async function generaFlashcardBase() {
  const matKey = document.getElementById('flash-materia').value;
  const idsSelezionati = Array.from(document.querySelectorAll('.flash-unita-checkbox:checked')).map(cb => cb.value);

  if (idsSelezionati.length < 2) {
    alert('Seleziona almeno 2 unità didattiche da studiare insieme (massimo 3).');
    return;
  }

  const materiaObj = SYLLABUS_DATA[matKey];
  const unitaSelezionate = materiaObj.unita.filter(u => idsSelezionati.includes(String(u.id)));

  const btn = document.getElementById('btn-genera-flashcard');
  const ripristina = impostaCaricamento([btn], btn, 'Generazione flashcard in corso...');

  try {
    const parsed = await chiediJsonAlServer(buildFlashcardPrompt(materiaObj, unitaSelezionate));
    if (!Array.isArray(parsed.flashcard) || parsed.flashcard.length === 0) {
      throw new Error('Formato di risposta inatteso dal modello.');
    }
    const mazzo = parsed.flashcard.map(f => ({ front: f.front, back: f.back, unita: f.unita || '' }));
    apriFlashcard(mazzo, `${materiaObj.title} — ${unitaSelezionate.map(u => u.title).join(', ')}`);
  } catch (err) {
    alert('Si è verificato un errore: ' + err.message);
  } finally {
    ripristina();
  }
}

// --- Generazione mazzo dagli errori depositati (nessuna AI: dati già in mano) ---

function generaFlashcardDaErrori() {
  if (errori.length === 0) {
    alert('Il deposito è vuoto: non ci sono errori da ripassare con le flashcard.');
    return;
  }
  const mazzo = errori.map(e => ({
    front: `${e.materia} — ${e.topic}\n\n${e.question}`,
    back: e.explanation ? `${e.correctAnswer}\n\n${e.explanation}` : e.correctAnswer,
    unita: e.topic
  }));
  apriFlashcard(mazzo, `Ripasso Deposito Errori (${errori.length})`);
}

// --- Visualizzatore condiviso ---

let flashDeck = [];
let flashIndex = 0;
let flashGirata = false;
let flashConosciute = [];
let flashDaRipassare = [];

function mescola(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function apriFlashcard(mazzo, titolo) {
  if (!mazzo || mazzo.length === 0) { alert('Nessuna flashcard da mostrare.'); return; }
  flashDeck = mescola([...mazzo]);
  flashIndex = 0;
  flashConosciute = [];
  flashDaRipassare = [];

  document.getElementById('flashcard-titolo').textContent = titolo;
  document.getElementById('flashcard-riepilogo').classList.add('hidden');
  document.getElementById('flashcard-corpo').classList.remove('hidden');
  document.getElementById('modale-flashcard').classList.remove('hidden');
  renderFlashcardCorrente();
}

function chiudiFlashcard() {
  document.getElementById('modale-flashcard').classList.add('hidden');
}

function renderFlashcardCorrente() {
  const carta = flashDeck[flashIndex];
  flashGirata = false;

  document.getElementById('flashcard-contatore').textContent = `${flashIndex + 1} / ${flashDeck.length}`;
  document.getElementById('flashcard-unita-badge').textContent = carta.unita || '';
  document.getElementById('flashcard-fronte').innerHTML = escapeHtml(carta.front).replace(/\n/g, '<br>');
  document.getElementById('flashcard-retro').innerHTML = escapeHtml(carta.back).replace(/\n/g, '<br>');

  document.getElementById('flashcard-fronte-box').classList.remove('hidden');
  document.getElementById('flashcard-retro-box').classList.add('hidden');
  document.getElementById('flashcard-azioni-valutazione').classList.add('hidden');
  document.getElementById('flashcard-suggerimento-gira').classList.remove('hidden');

  document.getElementById('flashcard-btn-prev').disabled = flashIndex === 0;
  document.getElementById('flashcard-btn-next').disabled = flashIndex === flashDeck.length - 1;
  lucide.createIcons();
}

function giraFlashcard() {
  flashGirata = !flashGirata;
  document.getElementById('flashcard-fronte-box').classList.toggle('hidden', flashGirata);
  document.getElementById('flashcard-retro-box').classList.toggle('hidden', !flashGirata);
  document.getElementById('flashcard-suggerimento-gira').classList.toggle('hidden', flashGirata);
  document.getElementById('flashcard-azioni-valutazione').classList.toggle('hidden', !flashGirata);
}

// Navigazione libera (non valuta la carta, utile solo per scorrere il mazzo)
function flashcardVai(delta) {
  const nuovoIndice = flashIndex + delta;
  if (nuovoIndice < 0 || nuovoIndice >= flashDeck.length) return;
  flashIndex = nuovoIndice;
  renderFlashcardCorrente();
}

// Valuta la carta corrente ("la so" / "da ripassare") e avanza alla prossima,
// oppure mostra il riepilogo se era l'ultima del mazzo
function flashcardValuta(esito) {
  const carta = flashDeck[flashIndex];
  if (esito === 'conosciuta') flashConosciute.push(carta);
  else flashDaRipassare.push(carta);

  if (flashIndex === flashDeck.length - 1) {
    mostraRiepilogoFlashcard();
  } else {
    flashIndex++;
    renderFlashcardCorrente();
  }
}

function mostraRiepilogoFlashcard() {
  document.getElementById('flashcard-corpo').classList.add('hidden');
  const riepilogo = document.getElementById('flashcard-riepilogo');
  riepilogo.classList.remove('hidden');
  riepilogo.innerHTML = `
    <i data-lucide="party-popper" class="w-8 h-8 text-indigo-600 mx-auto mb-2"></i>
    <p class="text-lg font-bold text-slate-900 mb-1">Ripasso completato</p>
    <p class="text-sm text-slate-600 mb-5">${flashConosciute.length} conosciute su ${flashDeck.length} · ${flashDaRipassare.length} da ripassare</p>
    <div class="flex flex-col sm:flex-row gap-3 justify-center">
      ${flashDaRipassare.length > 0 ? `<button onclick="riavviaFlashcardConDaRipassare()" class="px-5 py-2.5 bg-amber-600 hover:bg-amber-700 text-white rounded-lg font-medium transition">Ripassa le ${flashDaRipassare.length} da rivedere</button>` : ''}
      <button onclick="chiudiFlashcard()" class="px-5 py-2.5 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-lg font-medium transition">Chiudi</button>
    </div>
  `;
  lucide.createIcons();
}

function riavviaFlashcardConDaRipassare() {
  const titolo = document.getElementById('flashcard-titolo').textContent;
  apriFlashcard([...flashDaRipassare], titolo);
}
