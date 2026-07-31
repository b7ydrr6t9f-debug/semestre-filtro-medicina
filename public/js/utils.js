// Funzioni di utilità senza dipendenze da altri moduli: escaping HTML, parsing
// delle risposte JSON di Gemini, gestione dello stato di caricamento dei bottoni.

// Disabilita i bottoni passati e mostra uno spinner su quello attivo;
// restituisce una funzione che ripristina tutto allo stato originale.
// Evita di ripetere lo stesso blocco disabled/innerHTML in ogni azione async.
function impostaCaricamento(bottoni, bottoneAttivo, testo) {
  const originale = bottoneAttivo.innerHTML;
  bottoni.forEach(b => b.disabled = true);
  bottoneAttivo.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> ${testo}`;
  lucide.createIcons();
  return () => {
    bottoni.forEach(b => b.disabled = false);
    bottoneAttivo.innerHTML = originale;
    lucide.createIcons();
  };
}

// Neutralizza i caratteri HTML prima di iniettare in innerHTML testo che
// arriva dal modello AI (domande, spiegazioni, lezioni): senza, una
// risposta che contenesse markup verrebbe eseguita come HTML nella pagina.
function escapeHtml(testo) {
  const div = document.createElement('div');
  div.textContent = testo ?? '';
  return div.innerHTML;
}

// Estrae il JSON pulito da una risposta testuale di Gemini (rimuove eventuali fence ```json)
function pulisciJson(testo) {
  let clean = testo.trim();
  if (clean.startsWith("```json")) clean = clean.substring(7);
  if (clean.startsWith("```")) clean = clean.substring(3);
  if (clean.endsWith("```")) clean = clean.substring(0, clean.length - 3);
  return JSON.parse(clean.trim());
}

// Normalizza un'etichetta di argomento per raggruppare gli errori
function normalizzaTopic(t) {
  return (t || 'Argomento generico').trim();
}
