// Registro valutazioni ed esportazione in Excel.

// Renderizza tabella registro valutazioni Excel
function renderValutazioniTable() {
  renderStatsPersonali();
  const tbody = document.getElementById('valutazioni-tbody');
  tbody.innerHTML = '';

  if (valutazioni.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-6 text-center text-slate-400 italic">Nessuna simulazione ancora registrata. Effettua un test nel Generatore Quiz.</td></tr>`;
    return;
  }

  valutazioni.forEach(v => {
    const corrette = parseInt(v.rateo, 10) || 0; // v.rateo è nel formato "esatte/totale"
    const badgeClass = v.esito === "Superato" ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800";
    tbody.innerHTML += `
      <tr class="hover:bg-slate-50 transition">
        <td class="p-3 font-mono text-xs text-slate-600">${v.data}</td>
        <td class="p-3 font-medium text-slate-900">${v.tipoProva}</td>
        <td class="p-3 text-slate-700">${v.materiaUnita}</td>
        <td class="p-3 text-center font-bold text-indigo-900">${v.punteggio}</td>
        <td class="p-3 text-center font-mono text-xs">${v.tempo}</td>
        <td class="p-3 text-center font-semibold text-slate-800">${corrette}/${v.errate ?? 0}/${v.omesse ?? 0}</td>
        <td class="p-3 text-center">
          <span class="text-xs px-2.5 py-1 rounded-full font-bold ${badgeClass}">${v.esito}</span>
        </td>
      </tr>
    `;
  });
}

// Pannello statistiche personali: riepilogo + andamento punteggio nel tempo.
// Nessuna libreria di grafici: un semplice SVG generato a mano è sufficiente
// per una sparkline e non aggiunge dipendenze esterne.
function renderStatsPersonali() {
  const panel = document.getElementById('stats-personali');
  if (!panel) return;

  if (valutazioni.length === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  const punteggi = valutazioni.map(v => parseFloat(v.punteggio)).filter(n => !isNaN(n));
  const media = punteggi.reduce((a, b) => a + b, 0) / punteggi.length;
  const superate = valutazioni.filter(v => v.esito === 'Superato').length;
  const tassoSuperamento = Math.round((superate / valutazioni.length) * 100);

  document.getElementById('stats-tot-simulazioni').textContent = valutazioni.length;
  document.getElementById('stats-media-punteggio').textContent = media.toFixed(1);
  document.getElementById('stats-tasso-superamento').textContent = `${tassoSuperamento}%`;

  // Argomento più debole: quello con più errori accumulati nel deposito
  const conteggi = {};
  errori.forEach(e => {
    const chiave = `${e.materia} — ${e.topic}`;
    conteggi[chiave] = (conteggi[chiave] || 0) + 1;
  });
  const piuDebole = Object.entries(conteggi).sort((a, b) => b[1] - a[1])[0];
  document.getElementById('stats-argomento-debole').textContent = piuDebole ? piuDebole[0] : 'Nessun errore registrato';

  // Grafico andamento: ultime 15 simulazioni in ordine cronologico
  // (l'array valutazioni arriva dal server ordinato dal più recente al più vecchio)
  const ultime = [...valutazioni].slice(0, 15).reverse();
  document.getElementById('stats-grafico').innerHTML = costruisciSparkline(ultime.map(v => parseFloat(v.punteggio) || 0));
}

function costruisciSparkline(valori) {
  if (valori.length < 2) {
    return '<p class="text-xs text-slate-400 italic">Servono almeno 2 simulazioni per mostrare l\'andamento.</p>';
  }

  const larghezza = 600, altezza = 120, padding = 12;
  const min = Math.min(...valori), max = Math.max(...valori);
  const range = (max - min) || 1;

  const coordinate = valori.map((v, i) => {
    const x = padding + (i / (valori.length - 1)) * (larghezza - padding * 2);
    const y = altezza - padding - ((v - min) / range) * (altezza - padding * 2);
    return { x, y, v };
  });

  const punti = coordinate.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const cerchi = coordinate.map(c => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3.5" fill="#4f46e5"><title>${c.v.toFixed(1)} punti</title></circle>`).join('');

  return `
    <svg viewBox="0 0 ${larghezza} ${altezza}" class="w-full h-28" preserveAspectRatio="none">
      <polyline points="${punti}" fill="none" stroke="#4f46e5" stroke-width="2.5" />
      ${cerchi}
    </svg>
  `;
}

// Esportazione in foglio Excel (.XLSX)
function exportToExcel() {
  if (valutazioni.length === 0) {
    alert("Non ci sono dati registrati da esportare.");
    return;
  }

  const excelData = valutazioni.map(v => ({
    "Data e Ora": v.data,
    "Tipo Prova": v.tipoProva,
    "Materia / Unità Didattica": v.materiaUnita,
    "Punteggio Totale": v.punteggio,
    "Tempo Impiegato": v.tempo,
    "Corrette/Errate/Omesse": `${parseInt(v.rateo, 10) || 0}/${v.errate ?? 0}/${v.omesse ?? 0}`,
    "Esito Finale": v.esito
  }));

  const worksheet = XLSX.utils.json_to_sheet(excelData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Valutazioni Simulazioni");

  // Auto-fit colonne
  worksheet['!cols'] = [
    { wch: 20 },
    { wch: 18 },
    { wch: 45 },
    { wch: 16 },
    { wch: 16 },
    { wch: 20 },
    { wch: 15 }
  ];

  XLSX.writeFile(workbook, "Registro_Valutazioni_Medicina_2026.xlsx");
}
