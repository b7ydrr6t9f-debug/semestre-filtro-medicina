// Registro valutazioni ed esportazione in Excel.

// Renderizza tabella registro valutazioni Excel
function renderValutazioniTable() {
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
