// Logica dell'area gestione: login (con verifica del ruolo), statistiche
// aggregate, elenco studenti ed eliminazione account. Riusa lo stesso
// meccanismo di sessione dell'app studenti (state.js + api.js) perché è
// lo stesso account, solo con un ruolo diverso.

let ultimoElencoUtenti = [];

document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  const savedUser = JSON.parse(localStorage.getItem('med_user') || 'null');
  // Riprende la sessione solo se è già un account admin: se è uno studente
  // che ha aperto questa pagina per sbaglio, resta sulla schermata di
  // accesso senza toccare la sua sessione salvata per l'app principale.
  if (savedUser && savedUser.id && savedUser.email && savedUser.token && savedUser.ruolo === 'admin') {
    avviaAdmin(savedUser);
  }
});

async function accediAdmin() {
  const email = document.getElementById('admin-email').value.trim();
  const pin = document.getElementById('admin-pin').value.trim();
  const erroreEl = document.getElementById('admin-auth-errore');
  erroreEl.classList.add('hidden');
  if (!email || !pin) return mostraErroreAdmin('Inserisci email e PIN.');

  const btn = document.getElementById('btn-admin-accedi');
  btn.disabled = true; btn.textContent = 'Accesso in corso...';
  try {
    const res = await fetch('/api/auth/accedi', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, pin })
    });
    const data = await res.json();
    if (!res.ok) return mostraErroreAdmin(data.errore);
    if (data.user.ruolo !== 'admin') return mostraErroreAdmin('Questo account non ha accesso all\'area gestione.');
    await avviaAdmin({ ...data.user, token: data.token, expiresAt: data.expiresAt });
  } catch (e) {
    mostraErroreAdmin('Impossibile contattare il server.');
  } finally {
    btn.disabled = false; btn.textContent = 'Accedi';
  }
}

function mostraErroreAdmin(msg) {
  const el = document.getElementById('admin-auth-errore');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function avviaAdmin(user) {
  currentUser = user;
  localStorage.setItem('med_user', JSON.stringify(user));
  document.getElementById('admin-email-display').textContent = user.email;
  document.getElementById('admin-auth').classList.add('hidden');
  document.getElementById('admin-content').classList.remove('hidden');
  pianificaAvvisoScadenza();

  try {
    await caricaDashboard();
  } catch (e) {
    alert('Errore nel caricamento della dashboard: ' + e.message);
  }
  lucide.createIcons();
}

function logoutAdmin() {
  logout();
}

async function caricaDashboard() {
  const [resStat, resUtenti] = await Promise.all([
    authFetch('/api/admin/statistiche'),
    authFetch('/api/admin/utenti')
  ]);
  const statistiche = await resStat.json();
  const { utenti } = await resUtenti.json();
  renderStatistiche(statistiche);
  renderTabellaUtenti(utenti);
}

function renderStatistiche(stat) {
  document.getElementById('stat-utenti').textContent = stat.utentiTotali;
  document.getElementById('stat-valutazioni').textContent = stat.valutazioniTotali;
  document.getElementById('stat-media').textContent = stat.mediaPunteggio ?? '—';

  const top = stat.argomentiPiuSbagliati[0];
  document.getElementById('stat-argomento-top').textContent = top ? top.topic : '—';

  const lista = document.getElementById('lista-argomenti-critici');
  if (stat.argomentiPiuSbagliati.length === 0) {
    lista.innerHTML = '<p class="text-slate-500 italic">Nessun errore registrato ancora.</p>';
    return;
  }
  lista.innerHTML = stat.argomentiPiuSbagliati.map(a => `
    <div class="flex items-center justify-between p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
      <span class="text-slate-800">${escapeHtml(a.materia)} — ${escapeHtml(a.topic)}</span>
      <span class="text-xs bg-rose-100 text-rose-800 font-bold px-2.5 py-1 rounded-full">${a.conteggio}×</span>
    </div>
  `).join('');
}

function renderTabellaUtenti(utenti) {
  ultimoElencoUtenti = utenti;
  const tbody = document.getElementById('tbody-utenti');

  if (utenti.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="p-6 text-center text-slate-400 italic">Nessuno studente registrato.</td></tr>';
    return;
  }

  tbody.innerHTML = utenti.map(u => `
    <tr class="border-b border-slate-100 hover:bg-slate-50">
      <td class="py-2 pr-3 font-mono text-xs">${escapeHtml(u.email)}</td>
      <td class="py-2 pr-3">
        <span class="text-xs px-2 py-0.5 rounded-full font-semibold ${u.ruolo === 'admin' ? 'bg-yellow-100 text-yellow-800' : 'bg-slate-100 text-slate-700'}">${escapeHtml(u.ruolo)}</span>
      </td>
      <td class="py-2 pr-3 text-center">${u.numeroErrori}</td>
      <td class="py-2 pr-3 text-center">${u.numeroValutazioni}</td>
      <td class="py-2 pr-3 text-xs text-slate-600">${escapeHtml(u.ultimaValutazione) || '—'}</td>
      <td class="py-2 pr-3 text-xs text-slate-600 font-mono">${escapeHtml(u.creatoIl)}</td>
      <td class="py-2 text-right">
        <button type="button" class="btn-vedi-simulazioni text-indigo-500 hover:text-indigo-700" data-user-id="${u.id}" title="Vedi ed elimina simulazioni">
          <i data-lucide="list-checks" class="w-4 h-4"></i>
        </button>
      </td>
      <td class="py-2 text-right">
        <button onclick="eliminaUtente(${u.id})" class="text-rose-500 hover:text-rose-700" title="Elimina account">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </td>
    </tr>
  `).join('');

  // addEventListener invece di onclick inline: l'email finisce in un
  // attributo HTML già delimitato da doppi apici, e JSON.stringify(email)
  // produrrebbe a sua volta doppi apici che spezzerebbero l'attributo.
  tbody.querySelectorAll('.btn-vedi-simulazioni').forEach(btn => {
    const utente = utenti.find(u => u.id === Number(btn.dataset.userId));
    btn.addEventListener('click', () => apriModaleSimulazioni(utente.id, utente.email));
  });

  lucide.createIcons();
}

// Mostra le simulazioni di un singolo studente, per poterne cancellare una
// fatta partire per sbaglio senza toccare tutto l'account.
let utenteCorrenteModale = null;

async function apriModaleSimulazioni(userId, email) {
  utenteCorrenteModale = userId;
  document.getElementById('modale-simulazioni-email').textContent = email;
  document.getElementById('modale-simulazioni').classList.remove('hidden');
  await ricaricaSimulazioniModale();
}

function chiudiModaleSimulazioni() {
  document.getElementById('modale-simulazioni').classList.add('hidden');
  utenteCorrenteModale = null;
}

async function ricaricaSimulazioniModale() {
  const lista = document.getElementById('modale-simulazioni-lista');
  lista.innerHTML = '<p class="text-slate-400 text-sm italic">Caricamento...</p>';
  try {
    const res = await authFetch(`/api/admin/utenti/${utenteCorrenteModale}/valutazioni`);
    const { valutazioni } = await res.json();
    if (valutazioni.length === 0) {
      lista.innerHTML = '<p class="text-slate-400 text-sm italic">Nessuna simulazione registrata per questo studente.</p>';
      return;
    }
    lista.innerHTML = valutazioni.map(v => `
      <div class="flex items-center justify-between gap-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
        <div class="text-xs space-y-0.5">
          <p class="font-mono text-slate-500">${escapeHtml(v.data)}</p>
          <p class="font-semibold text-slate-800">${escapeHtml(v.tipoProva)} — ${escapeHtml(v.materiaUnita)}</p>
          <p class="text-slate-600">Punteggio ${escapeHtml(v.punteggio)} · ${parseInt(v.rateo, 10) || 0}/${v.errate ?? 0}/${v.omesse ?? 0} (corrette/errate/omesse) · ${escapeHtml(v.esito)}</p>
        </div>
        <button onclick="eliminaValutazioneAdmin(${v.id})" class="text-rose-500 hover:text-rose-700 shrink-0" title="Elimina questa simulazione">
          <i data-lucide="trash-2" class="w-4 h-4"></i>
        </button>
      </div>
    `).join('');
    lucide.createIcons();
  } catch (e) {
    lista.innerHTML = '<p class="text-rose-600 text-sm">Errore nel caricamento delle simulazioni.</p>';
  }
}

// Elimina una singola simulazione fatta partire per sbaglio, senza toccare
// account, errori depositati o le altre simulazioni dello studente.
async function eliminaValutazioneAdmin(id) {
  if (!confirm('Eliminare questa simulazione? Non influisce sull\'account né sugli altri dati dello studente.')) return;
  try {
    const res = await authFetch(`/api/admin/valutazioni/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.errore || 'Eliminazione non riuscita.');
    await ricaricaSimulazioniModale();
    await caricaDashboard(); // aggiorna i conteggi nella tabella e le statistiche aggregate
  } catch (e) {
    alert('Errore durante l\'eliminazione: ' + e.message);
  }
}

// Elimina un account studente e tutti i suoi dati (errori, valutazioni,
// sessioni). L'id basta a identificare l'utente: l'email viene recuperata
// dall'ultimo elenco caricato solo per il messaggio di conferma.
async function eliminaUtente(id) {
  const utente = ultimoElencoUtenti.find(u => u.id === id);
  const email = utente ? utente.email : `#${id}`;
  if (!confirm(`Eliminare definitivamente l'account ${email} e tutti i suoi dati? L'operazione non è reversibile.`)) return;

  try {
    const res = await authFetch(`/api/admin/utenti/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.errore || 'Eliminazione non riuscita.');
    await caricaDashboard();
  } catch (e) {
    alert('Errore durante l\'eliminazione: ' + e.message);
  }
}
