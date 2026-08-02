// Sezione "Contattaci": invio di segnalazioni (bug, errori nei contenuti,
// suggerimenti) e storico delle proprie, con lo stato aggiornato dall'admin.

async function inviaSegnalazione() {
  const categoria = document.getElementById('contatti-categoria').value;
  const messaggio = document.getElementById('contatti-messaggio').value.trim();

  if (!messaggio) {
    alert('Scrivi un messaggio prima di inviare.');
    return;
  }

  const btn = document.getElementById('btn-invia-segnalazione');
  const ripristina = impostaCaricamento([btn], btn, 'Invio in corso...');

  try {
    const res = await authFetch('/api/segnalazioni', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoria, messaggio })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.errore || 'Invio non riuscito.');

    document.getElementById('contatti-messaggio').value = '';
    await renderStoricoSegnalazioni();
    alert('Segnalazione inviata, grazie! La trovi qui sotto nel tuo storico.');
  } catch (err) {
    alert('Si è verificato un errore: ' + err.message);
  } finally {
    ripristina();
  }
}

async function renderStoricoSegnalazioni() {
  const container = document.getElementById('contatti-storico');
  if (!container) return;

  try {
    const res = await authFetch('/api/segnalazioni');
    const { segnalazioni } = await res.json();

    if (segnalazioni.length === 0) {
      container.innerHTML = '<p class="text-slate-400 text-sm italic">Non hai ancora inviato nessuna segnalazione.</p>';
      return;
    }

    container.innerHTML = segnalazioni.map(s => `
      <div class="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-semibold text-indigo-700">${escapeHtml(s.categoria)}</span>
          <span class="text-xs px-2 py-0.5 rounded-full font-bold ${s.stato === 'risolta' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}">${s.stato === 'risolta' ? 'Risolta' : 'In attesa'}</span>
        </div>
        <p class="text-sm text-slate-800">${escapeHtml(s.messaggio)}</p>
        <p class="text-xs text-slate-400 font-mono">${escapeHtml(s.createdAt)}</p>
      </div>
    `).join('');
  } catch (e) {
    container.innerHTML = '<p class="text-rose-600 text-sm">Errore nel caricamento dello storico.</p>';
  }
}
