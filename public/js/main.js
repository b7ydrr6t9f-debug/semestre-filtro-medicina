// Punto di ingresso: riprende la sessione salvata o mostra il login.

// Registra il service worker (necessario su Android per il prompt di
// installazione); volutamente non mette nulla in cache, vedi service-worker.js
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}

// Se c'è già un utente salvato riprende la sessione, altrimenti mostra il login.
// Gestisce anche i link ricevuti via email (conferma email / reset PIN).
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();

  const params = new URLSearchParams(window.location.search);
  const tokenReset = params.get('reset-pin');
  const tokenVerifica = params.get('verifica');

  if (tokenReset) {
    mostraFormResetPinEmail(tokenReset);
    window.history.replaceState({}, '', window.location.pathname);
    return;
  }

  if (tokenVerifica) {
    confermaVerificaEmailDaLink(tokenVerifica);
    window.history.replaceState({}, '', window.location.pathname);
    // prosegue comunque con il normale avvio della sessione qui sotto
  }

  const savedUser = JSON.parse(localStorage.getItem('med_user') || 'null');
  if (savedUser && savedUser.id && savedUser.email && savedUser.token) {
    avviaApp(savedUser);
  } else {
    localStorage.removeItem('med_user');
    switchAuthTab('accedi');
  }
});
