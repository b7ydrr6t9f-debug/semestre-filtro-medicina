// Deposito degli errori accumulati e generazione delle lezioni di recupero.

// Mostra o nasconde l'elenco dettagliato del deposito
function toggleDepositoDettaglio() {
  const box = document.getElementById('deposito-dettaglio');
  if (box.classList.contains('hidden')) {
    renderDepositoDettaglioLista();
    box.classList.remove('hidden');
  } else {
    box.classList.add('hidden');
  }
}

// Renderizza l'elenco dettagliato di ogni singolo errore nel deposito
function renderDepositoDettaglioLista() {
  const container = document.getElementById('deposito-dettaglio-lista');
  if (errori.length === 0) {
    container.innerHTML = `<p class="text-slate-500 text-sm italic">Il deposito è vuoto.</p>`;
    return;
  }
  container.innerHTML = errori.map(e => `
    <div class="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-1.5">
      <div class="flex justify-between items-start gap-2">
        <span class="text-xs font-semibold text-indigo-700">${escapeHtml(e.materia)} — ${escapeHtml(e.topic)}</span>
        <button onclick="eliminaErrore(${e.id})" class="text-rose-500 hover:text-rose-700 shrink-0" title="Rimuovi dal deposito">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </div>
      <p class="text-sm font-medium text-slate-800">${escapeHtml(e.question)}</p>
      <p class="text-xs text-slate-600"><strong>La tua risposta:</strong> ${escapeHtml(e.userAnswer) || '(nessuna risposta)'}</p>
      <p class="text-xs text-emerald-700"><strong>Risposta corretta:</strong> ${escapeHtml(e.correctAnswer)}</p>
      ${e.explanation ? `<p class="text-xs text-slate-500 italic">${escapeHtml(e.explanation)}</p>` : ''}
    </div>
  `).join('');
  lucide.createIcons();
}

// Rimuove un singolo errore dal deposito (dopo averlo ripassato)
async function eliminaErrore(id) {
  if (!confirm('Rimuovere questo errore dal deposito?')) return;
  try {
    await authFetch(`/api/dati/errori/${id}`, { method: 'DELETE' });
    errori = errori.filter(e => e.id !== id);
    renderDepositoRiepilogo();
    renderDepositoDettaglioLista();
    renderLezioniSuggerite();
  } catch (e) {
    alert('Errore durante la rimozione dal deposito.');
  }
}

// Riepilogo del deposito errori (tab "deposito fine settimana")
function renderDepositoRiepilogo() {
  const container = document.getElementById('deposito-riepilogo');
  if (!container) return;

  if (errori.length === 0) {
    container.innerHTML = `<p class="text-slate-500 text-sm italic p-4 bg-slate-50 rounded-lg border border-slate-200">Nessun errore ancora registrato. Completa un'esercitazione nel tab "Esercitazioni" per iniziare a costruire il tuo deposito.</p>`;
    return;
  }

  const conteggio = {};
  errori.forEach(e => {
    const key = `${e.materia} — ${normalizzaTopic(e.topic)}`;
    conteggio[key] = (conteggio[key] || 0) + 1;
  });
  const ordinati = Object.entries(conteggio).sort((a, b) => b[1] - a[1]);

  let html = `<div class="flex items-center justify-between mb-2">
    <span class="text-sm font-semibold text-slate-700">${errori.length} error${errori.length === 1 ? 'e' : 'i'} nel deposito, su ${ordinati.length} argoment${ordinati.length === 1 ? 'o' : 'i'}</span>
  </div>`;

  ordinati.forEach(([key, count]) => {
    html += `
      <div class="flex items-center justify-between p-3 bg-slate-50 border border-slate-200 rounded-lg">
        <span class="text-sm text-slate-800">${escapeHtml(key)}</span>
        <span class="text-xs bg-rose-100 text-rose-800 font-bold px-2.5 py-1 rounded-full">${count}×</span>
      </div>
    `;
  });

  container.innerHTML = html;
}

// Suggerisce argomenti per le lezioni di recupero in base agli errori
function renderLezioniSuggerite() {
  const container = document.getElementById('lezioni-suggerite');
  if (!container) return;

  if (errori.length === 0) {
    container.innerHTML = `<p class="text-slate-500 text-sm italic">Nessun argomento suggerito ancora: completa qualche esercitazione, oppure cerca liberamente un argomento qui sopra.</p>`;
    return;
  }

  const conteggio = {};
  errori.forEach(e => {
    const key = normalizzaTopic(e.topic);
    conteggio[key] = (conteggio[key] || 0) + 1;
  });
  const top = Object.entries(conteggio).sort((a, b) => b[1] - a[1]).slice(0, 8);

  container.innerHTML = top.map(([topic, count]) => `
    <button type="button" class="chip-argomento-suggerito px-3 py-1.5 bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-800 text-xs font-semibold rounded-full transition">
      ${escapeHtml(topic)} <span class="opacity-70">(${count}×)</span>
    </button>
  `).join('');

  // Usa addEventListener invece di onclick inline per evitare problemi di escaping
  // delle virgolette quando l'argomento contiene apostrofi o caratteri speciali.
  container.querySelectorAll('.chip-argomento-suggerito').forEach((btn, i) => {
    const topicValue = top[i][0];
    btn.addEventListener('click', () => {
      const searchInput = document.getElementById('lezione-search');
      searchInput.value = topicValue;
      searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  });
}

// Genera una lezione di recupero (breve o dettagliata) sull'argomento cercato
async function generaLezione(profondita) {
  const argomento = document.getElementById('lezione-search').value.trim();
  if (!argomento) {
    alert("Scrivi o seleziona prima un argomento da approfondire.");
    return;
  }

  const btnBreve = document.getElementById('btn-lezione-breve');
  const btnDettagliata = document.getElementById('btn-lezione-dettagliata');
  const btnAttivo = profondita === 'breve' ? btnBreve : btnDettagliata;
  const ripristina = impostaCaricamento([btnBreve, btnDettagliata], btnAttivo, 'Generazione lezione in corso...');

  const risultatoBox = document.getElementById('lezione-risultato');

  try {
    const res = await authFetch('/api/genera-lezione', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ argomento, profondita })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.errore || 'Errore nella comunicazione con il server AI.');

    risultatoBox.classList.remove('hidden');
    risultatoBox.innerHTML = `
      <div class="flex items-center justify-between mb-4 pb-3 border-b border-slate-100">
        <h3 class="font-bold text-slate-900 text-lg">${escapeHtml(argomento)}</h3>
        <span class="text-xs px-2.5 py-1 rounded-full font-semibold ${profondita === 'breve' ? 'bg-slate-200 text-slate-800' : 'bg-indigo-100 text-indigo-800'}">${profondita === 'breve' ? 'Lezione breve' : 'Lezione dettagliata'}</span>
      </div>
      <div class="text-slate-700 text-sm whitespace-pre-line leading-relaxed">${escapeHtml(data.lezione)}</div>
    `;
    risultatoBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    alert("Si è verificato un errore: " + err.message);
  } finally {
    ripristina();
  }
}
