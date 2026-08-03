// Schermata di accesso: login, registrazione, recupero PIN e avvio dell'app.

// Carica i dati dell'utente dal server e mostra l'interfaccia principale
async function avviaApp(user) {
  currentUser = user;
  localStorage.setItem('med_user', JSON.stringify(user));
  document.getElementById('header-user-email').textContent = user.email;
  document.getElementById('link-area-gestione').classList.toggle('hidden', user.ruolo !== 'admin');
  document.getElementById('banner-verifica-email').classList.toggle('hidden', !!user.emailVerificata);

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

// Rimanda l'email di conferma (bottone nel banner "email non verificata")
async function reinviaVerificaEmail() {
  const btn = document.getElementById('btn-reinvia-verifica');
  btn.disabled = true; btn.textContent = 'Invio...';
  try {
    const res = await authFetch('/api/auth/reinvia-verifica', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.errore || 'Invio non riuscito.');
    btn.textContent = 'Inviata ✓';
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Invia di nuovo'; }, 5000);
  } catch (e) {
    alert('Errore durante l\'invio: ' + e.message);
    btn.disabled = false; btn.textContent = 'Invia di nuovo';
  }
}

// Alternativa alla domanda di sicurezza: chiede un link di reset via email
async function richiediResetPinEmail() {
  const email = document.getElementById('recupera-email').value.trim();
  if (!email) return mostraErroreAuth('Inserisci la tua email qui sopra, poi premi di nuovo questo pulsante.');

  const btn = document.getElementById('btn-recupera-email');
  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/richiedi-reset-pin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    await res.json();
    // Risposta identica indipendentemente dall'esistenza dell'account: niente enumerazione utenti
    mostraSuccessoAuth('Se l\'indirizzo è registrato, riceverai a breve un\'email con il link per reimpostare il PIN.');
  } catch (e) {
    mostraErroreAuth('Impossibile contattare il server.');
  } finally {
    btn.disabled = false;
  }
}

// Token letto dall'URL quando si arriva tramite il link di reset ricevuto via email
let tokenResetPinDaLink = null;

function mostraFormResetPinEmail(token) {
  tokenResetPinDaLink = token;
  ['accedi', 'registrati', 'recupera'].forEach(t => document.getElementById(`auth-form-${t}`).classList.add('hidden'));
  document.getElementById('auth-form-reset-pin-email').classList.remove('hidden');
  document.querySelectorAll('[id^="authtab-"]').forEach(el => el.classList.add('hidden'));
}

async function confermaResetPinEmail() {
  const nuovoPin = document.getElementById('reset-pin-email-nuovo').value.trim();
  if (!/^\d{4,6}$/.test(nuovoPin)) return mostraErroreAuth('Il PIN deve avere tra 4 e 6 cifre numeriche.');

  const btn = document.getElementById('btn-reset-pin-email');
  btn.disabled = true; btn.textContent = 'Aggiornamento...';
  try {
    const res = await fetch('/api/auth/reset-pin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: tokenResetPinDaLink, nuovoPin })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.errore);

    document.getElementById('auth-form-reset-pin-email').classList.add('hidden');
    document.querySelectorAll('[id^="authtab-"]').forEach(el => el.classList.remove('hidden'));
    switchAuthTab('accedi');
    mostraSuccessoAuth('PIN aggiornato! Ora puoi accedere con il nuovo PIN.');
  } catch (e) {
    mostraErroreAuth(e.message || 'Impossibile contattare il server.');
  } finally {
    btn.disabled = false; btn.textContent = 'Imposta Nuovo PIN';
  }
}

// Gestisce l'arrivo tramite il link di conferma email ("?verifica=TOKEN"),
// che deve funzionare anche senza sessione attiva su questo dispositivo
async function confermaVerificaEmailDaLink(token) {
  try {
    const res = await fetch(`/api/auth/verifica-email?token=${encodeURIComponent(token)}`);
    const data = await res.json();
    if (res.ok) {
      // Se l'account risulta già salvato su questo dispositivo, aggiorna subito lo stato locale
      const savedUser = JSON.parse(localStorage.getItem('med_user') || 'null');
      if (savedUser) {
        savedUser.emailVerificata = true;
        localStorage.setItem('med_user', JSON.stringify(savedUser));
      }
      alert('Email confermata con successo!');
    } else {
      alert('Link di verifica non valido o scaduto: ' + (data.errore || ''));
    }
  } catch (e) {
    alert('Impossibile contattare il server per confermare l\'email.');
  }
}

// Recupero PIN (via domanda di sicurezza), step 2: verifica la risposta e imposta il nuovo PIN
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
