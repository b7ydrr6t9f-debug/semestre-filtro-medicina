// Sezione Profilo: info account, cambio PIN, esportazione dati personali,
// eliminazione account (self-service, sempre disponibile all'utente).

async function renderProfilo() {
  document.getElementById('profilo-email').textContent = currentUser.email || '-';
  try {
    const res = await authFetch('/api/account/info');
    const data = await res.json();
    if (!res.ok) return;
    document.getElementById('profilo-email').textContent = data.email || '-';
    document.getElementById('profilo-creato').textContent = data.createdAt
      ? new Date(data.createdAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })
      : '-';
    document.getElementById('profilo-ultimo-accesso').textContent = data.lastLogin
      ? new Date(data.lastLogin).toLocaleString('it-IT')
      : 'Questo è il tuo primo accesso registrato';
  } catch (e) {
    // Se la chiamata fallisce restano i valori già mostrati (email da currentUser)
  }
}

function mostraEsitoCambioPin(msg, ok) {
  const el = document.getElementById('profilo-pin-esito');
  el.textContent = msg;
  el.className = `text-sm mt-3 p-2.5 rounded-lg ${ok ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-rose-50 text-rose-800 border border-rose-200'}`;
  el.classList.remove('hidden');
}

async function cambiaPinProprio() {
  const pinAttuale = document.getElementById('profilo-pin-attuale').value;
  const nuovoPin = document.getElementById('profilo-pin-nuovo').value;
  if (!pinAttuale || !nuovoPin) return mostraEsitoCambioPin('Compila entrambi i campi.', false);

  const btn = document.getElementById('btn-cambia-pin');
  btn.disabled = true; btn.textContent = 'Aggiornamento...';
  try {
    const res = await authFetch('/api/account/cambia-pin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinAttuale, nuovoPin })
    });
    const data = await res.json();
    if (!res.ok) { mostraEsitoCambioPin(data.errore, false); return; }
    document.getElementById('profilo-pin-attuale').value = '';
    document.getElementById('profilo-pin-nuovo').value = '';
    mostraEsitoCambioPin('PIN aggiornato con successo.', true);
  } catch (e) {
    mostraEsitoCambioPin('Impossibile contattare il server.', false);
  } finally {
    btn.disabled = false; btn.textContent = 'Aggiorna PIN';
  }
}

async function esportaDatiProprio() {
  try {
    const res = await authFetch('/api/account/esporta');
    if (!res.ok) { alert('Impossibile esportare i dati in questo momento.'); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'i-miei-dati.json';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Impossibile contattare il server per l\'esportazione.');
  }
}

// Elimina definitivamente l'account dell'utente loggato e tutti i suoi dati
// (errori depositati, valutazioni, sessioni). Nessuna disattivazione: i dati
// vengono persi per sempre. Doppia conferma perché l'azione non è reversibile.
async function eliminaAccountProprio() {
  const email = currentUser.email || 'il tuo account';
  if (!confirm(`Eliminare definitivamente "${email}" e tutti i tuoi dati? Verranno persi per sempre, senza possibilità di recupero.`)) return;
  if (!confirm('Confermi? Questa è l\'ultima possibilità per annullare.')) return;

  try {
    const res = await authFetch('/api/account', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.errore || 'Eliminazione non riuscita.');
    localStorage.removeItem('med_user');
    alert('Il tuo account è stato eliminato. Grazie per aver usato la piattaforma.');
    location.reload();
  } catch (e) {
    alert('Errore durante l\'eliminazione dell\'account: ' + e.message);
  }
}
