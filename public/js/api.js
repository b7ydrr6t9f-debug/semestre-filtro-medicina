// Livello di trasporto verso il backend: allega il token di sessione a ogni
// richiesta e gestisce la scadenza (avviso e rinnovo).

function logout() {
  clearTimeout(timerAvvisoScadenza);
  localStorage.removeItem('med_user');
  location.reload();
}

// Wrapper attorno a fetch che allega il token di sessione. Se il server
// risponde 401 (sessione mancante o scaduta) riporta l'utente al login
// invece di far fallire silenziosamente le chiamate successive.
async function authFetch(url, options = {}) {
  const headers = { ...(options.headers || {}), 'Authorization': `Bearer ${currentUser.token}` };
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    logout();
    throw new Error('Sessione scaduta, effettua di nuovo l\'accesso.');
  }
  return res;
}

// Mostra il banner "sessione in scadenza" 10 minuti prima della scadenza
// effettiva del token, così c'è tempo per rinnovarla senza perdere lavoro.
const AVVISO_PRIMA_SCADENZA_MS = 10 * 60 * 1000;
let timerAvvisoScadenza = null;

function pianificaAvvisoScadenza() {
  clearTimeout(timerAvvisoScadenza);
  if (!currentUser.expiresAt) return;
  const msAllaScadenza = new Date(currentUser.expiresAt).getTime() - Date.now();
  const msAllAvviso = Math.max(0, msAllaScadenza - AVVISO_PRIMA_SCADENZA_MS);
  timerAvvisoScadenza = setTimeout(() => {
    document.getElementById('banner-sessione').classList.remove('hidden');
    lucide.createIcons();
  }, msAllAvviso);
}

// Rinnova il token corrente chiamato dal banner di avviso: non tocca
// account o dati, allunga solo la validità della sessione.
async function rinnovaSessione() {
  try {
    const res = await authFetch('/api/auth/rinnova', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.errore || 'Rinnovo non riuscito.');
    currentUser = { ...currentUser, token: data.token, expiresAt: data.expiresAt };
    localStorage.setItem('med_user', JSON.stringify(currentUser));
    document.getElementById('banner-sessione').classList.add('hidden');
    pianificaAvvisoScadenza();
  } catch (e) {
    alert('Non è stato possibile rinnovare la sessione: ' + e.message);
  }
}
