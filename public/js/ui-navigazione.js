// Navigazione tra tab e caricamento dei contenuti statici del syllabus.

// Switch tab
function switchTab(tabName) {
  ['syllabus', 'simulator', 'deposito', 'lezioni', 'valutazione'].forEach(t => {
    document.getElementById(`sec-${t}`).classList.add('hidden');
    document.getElementById(`tab-${t}`).classList.remove('tab-active');
  });
  document.getElementById(`sec-${tabName}`).classList.remove('hidden');
  document.getElementById(`tab-${tabName}`).classList.add('tab-active');
  if (tabName === 'deposito') renderDepositoRiepilogo();
  if (tabName === 'lezioni') renderLezioniSuggerite();
}

// Carica materia nel tab syllabus
function loadMateria(materiaKey) {
  ['bio', 'fis', 'chi'].forEach(b => {
    const btn = document.getElementById(`btn-${b}`);
    btn.classList.remove('border-2', 'border-indigo-600', 'bg-indigo-50/50');
    btn.classList.add('border', 'border-slate-200', 'bg-white');
  });
  
  const activeBtnId = materiaKey === 'biologia' ? 'btn-bio' : materiaKey === 'fisica' ? 'btn-fis' : 'btn-chi';
  const activeBtn = document.getElementById(activeBtnId);
  activeBtn.classList.remove('border-slate-200', 'bg-white');
  activeBtn.classList.add('border-2', 'border-indigo-600', 'bg-indigo-50/50');

  const data = SYLLABUS_DATA[materiaKey];
  const container = document.getElementById('syllabus-content');
  
  let html = `<div class="bg-indigo-900 text-white p-4 rounded-xl flex justify-between items-center">
    <h3 class="font-bold text-lg">${data.title}</h3>
    <span class="bg-yellow-400 text-indigo-950 font-bold px-3 py-1 rounded-full text-xs">${data.cfu} Totali</span>
  </div>`;

  data.unita.forEach(u => {
    html += `
      <div class="bg-white border border-slate-200 rounded-xl p-5 shadow-sm space-y-3">
        <div class="flex justify-between items-start border-b border-slate-100 pb-2">
          <h4 class="font-bold text-indigo-950 text-base">${u.title}</h4>
          <span class="text-xs bg-indigo-100 text-indigo-800 font-semibold px-2.5 py-1 rounded-full">${u.cfu}</span>
        </div>
        <div class="text-slate-700 text-sm whitespace-pre-line leading-relaxed">${u.content}</div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// Aggiorna option unita' didattiche nel simulatore
function updateSimUnitaOptions() {
  const matKey = document.getElementById('sim-materia').value;
  const selectUnita = document.getElementById('sim-unita');
  selectUnita.innerHTML = '';

  SYLLABUS_DATA[matKey].unita.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = `${u.title} (${u.cfu})`;
    selectUnita.appendChild(opt);
  });
}
