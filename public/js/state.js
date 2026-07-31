// Stato applicativo condiviso: utente corrente, cache di errori/valutazioni,
// quiz in corso e cronometro. Popolato da auth.js e letto/scritto dagli altri moduli.

// Stato utente, registro valutazioni e registro errori (sincronizzati con il server)
let currentUser = null;
let valutazioni = [];
let errori = [];
let currentQuizData = null;
let timerInterval = null;
let secondsElapsed = 0;
