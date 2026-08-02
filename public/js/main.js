// Punto di ingresso: riprende la sessione salvata o mostra il login.

// Registra il service worker (necessario su Android per il prompt di
// installazione); volutamente non mette nulla in cache, vedi service-worker.js
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  });
}

// Se c'è già un utente salvato riprende la sessione, altrimenti mostra il login
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  const savedUser = JSON.parse(localStorage.getItem('med_user') || 'null');
  if (savedUser && savedUser.id && savedUser.email && savedUser.token) {
    avviaApp(savedUser);
  } else {
    localStorage.removeItem('med_user');
    switchAuthTab('accedi');
  }
});
