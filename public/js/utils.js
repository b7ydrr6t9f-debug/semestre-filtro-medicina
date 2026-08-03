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

// Cronologia (sul server, legata all'account) di domande/flashcard già
// generate per una data unità didattica: usata per dire esplicitamente a
// Gemini cosa evitare di riproporre. Salvata lato server, non nel browser,
// così vale su tutti i dispositivi con cui accedi allo stesso account.
async function leggiCronologiaGenerazione(chiave) {
  try {
    const res = await authFetch(`/api/cronologia/${chiave}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.elementi || [];
  } catch (e) {
    return []; // se il caricamento fallisce, si genera comunque senza cronologia
  }
}

async function salvaCronologiaGenerazione(chiave, nuoviElementi) {
  try {
    await authFetch(`/api/cronologia/${chiave}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ elementi: nuoviElementi })
    });
  } catch (e) {
    // Il salvataggio della cronologia non deve mai bloccare l'esercitazione appena generata
  }
}
