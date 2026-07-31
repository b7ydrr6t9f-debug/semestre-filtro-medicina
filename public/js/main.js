// Punto di ingresso: riprende la sessione salvata o mostra il login.

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
