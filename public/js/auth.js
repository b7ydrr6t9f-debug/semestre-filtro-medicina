// Schermata di accesso: login, registrazione, recupero PIN e avvio dell'app.

// Carica i dati dell'utente dal server e mostra l'interfaccia principale
async function avviaApp(user) {
  currentUser = user;
  localStorage.setItem('med_user', JSON.stringify(user));
  document.getElementById('header-user-email').textContent = user.email;
  document.getElementById('link-area-gestione').classList.toggle('hidden', user.ruolo !== 'admin');

  try {
    await ricaricaDatiServer();
  } catch (e) {
    errori = [];
    valutazioni = [];
  }

  document.getElementById('auth-overlay').classList.add('hidden');
  document.getElementById('app-content').classList.remove('hidden');

  loadMateria('biologia');
  updateSimUnitaOptions();
  updateFlashUnitaOptions();
  renderValutazioniTable();
  renderDepositoRiepilogo();
  renderLezioniSuggerite();
  renderCountdownEsami();
  pianificaAvvisoScadenza();
  lucide.createIcons();
}

// --- sotto-tab di autenticazione (accedi / crea account / recupera PIN) ---
function switchAuthTab(tab) {
  ['accedi', 'registrati', 'recupera'].forEach(t => {
    document.getElementById(`auth-form-${t}`).classList.add('hidden');
    document.getElementById(`authtab-${t}`).classList.remove('authtab-active');
  });
  document.getElementById(`auth-form-${tab}`).classList.remove('hidden');
  document.getElementById(`authtab-${tab}`).classList.add('authtab-active');
  document.getElementById('recupera-step1').classList.remove('hidden');
  document.getElementById('recupera-step2').classList.add('hidden');
  nascondiMessaggiAuth();
}

function mostraErroreAuth(msg) {
  const el = document.getElementById('auth-errore');
  el.textContent = msg;
  el.classList.remove('hidden');
  document.getElementById('auth-successo').classList.add('hidden');
}
function mostraSuccessoAuth(msg) {
  const el = document.getElementById('auth-successo');
  el.textContent = msg;
  el.classList.remove('hidden');
  document.getElementById('auth-errore').classList.add('hidden');
}
function nascondiMessaggiAuth() {
  document.getElementById('auth-errore').classList.add('hidden');
  document.getElementById('auth-successo').classList.add('hidden');
}

// Accedi con email + PIN
async function accedi() {
  const email = document.getElementById('accedi-email').value.trim();
  const pin = document.getElementById('accedi-pin').value.trim();
  if (!email || !pin) return mostraErroreAuth('Inserisci email e PIN.');

  const btn = document.getElementById('btn-accedi');
  btn.disabled = true; btn.textContent = 'Accesso in corso...';
  try {
    const res = await fetch('/api/auth/accedi', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, pin })
    });
    const data = await res.json();
    if (!res.ok) { mostraErroreAuth(data.errore); return; }
    await avviaApp({ ...data.user, token: data.token, expiresAt: data.expiresAt });
  } catch (e) {
    mostraErroreAuth('Impossibile contattare il server.');
  } finally {
    btn.disabled = false; btn.textContent = 'Accedi';
  }
}

// Crea un nuovo account (email + PIN + domanda di sicurezza)
async function registrati() {
  const email = document.getElementById('registrati-email').value.trim();
  const pin = document.getElementById('registrati-pin').value.trim();
  const domandaSicurezza = document.getElementById('registrati-domanda').value.trim();
  const rispostaSicurezza = document.getElementById('registrati-risposta').value.trim();
  if (!email || !pin || !domandaSicurezza || !rispostaSicurezza) return mostraErroreAuth('Compila tutti i campi.');

  const btn = document.getElementById('btn-registrati');
  btn.disabled = true; btn.textContent = 'Creazione account...';
  try {
    const res = await fetch('/api/auth/registrati', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, pin, domandaSicurezza, rispostaSicurezza })
    });
    const data = await res.json();
    if (!res.ok) { mostraErroreAuth(data.errore); return; }
    await avviaApp({ ...data.user, token: data.token, expiresAt: data.expiresAt });
  } catch (e) {
    mostraErroreAuth('Impossibile contattare il server.');
  } finally {
    btn.disabled = false; btn.textContent = 'Crea Account';
  }
}

// Recupero PIN, step 1: cerca la domanda di sicurezza associata all'email
async function cercaDomandaSicurezza() {
  const email = document.getElementById('recupera-email').value.trim();
  if (!email) return mostraErroreAuth('Inserisci la tua email.');

  const btn = document.getElementById('btn-recupera-step1');
  btn.disabled = true; btn.textContent = 'Ricerca in corso...';
  try {
    const res = await fetch('/api/auth/domanda-sicurezza', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) { mostraErroreAuth(data.errore); return; }
    document.getElementById('recupera-domanda-label').textContent = data.domandaSicurezza;
    document.getElementById('recupera-step1').classList.add('hidden');
    document.getElementById('recupera-step2').classList.remove('hidden');
    nascondiMessaggiAuth();
  } catch (e) {
    mostraErroreAuth('Impossibile contattare il server.');
  } finally {
    btn.disabled = false; btn.textContent = 'Continua';
  }
}

// Recupero PIN, step 2: verifica la risposta e imposta il nuovo PIN
async function recuperaPin() {
  const email = document.getElementById('recupera-email').value.trim();
  const rispostaSicurezza = document.getElementById('recupera-risposta').value.trim();
  const nuovoPin = document.getElementById('recupera-nuovo-pin').value.trim();
  if (!rispostaSicurezza || !nuovoPin) return mostraErroreAuth('Compila risposta e nuovo PIN.');

  const btn = document.getElementById('btn-recupera-step2');
  btn.disabled = true; btn.textContent = 'Aggiornamento...';
  try {
    const res = await fetch('/api/auth/recupera-pin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, rispostaSicurezza, nuovoPin })
    });
    const data = await res.json();
    if (!res.ok) { mostraErroreAuth(data.errore); return; }
    switchAuthTab('accedi');
    document.getElementById('accedi-email').value = email;
    mostraSuccessoAuth('PIN aggiornato! Ora puoi accedere con il nuovo PIN.');
  } catch (e) {
    mostraErroreAuth('Impossibile contattare il server.');
  } finally {
    btn.disabled = false; btn.textContent = 'Imposta Nuovo PIN';
  }
}
