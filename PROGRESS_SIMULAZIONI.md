# Pregenerazione simulazioni — stato di avanzamento

Per riprendere in una nuova chat, scrivi: **CONTINUA SIMULAZIONI**
(Claude leggerà questo file dal repo e riparte dalla prossima unità non fatta.)

## Come funziona
Ogni unità didattica ha un file JSON in `data/simulazioni-pregenerate/<materia>-<unitaId>.json`
con 31 domande (21 mcq + 10 completamento) scritte a mano restando SOLO sul contenuto
di quell'unità (niente Gemini live in questa fase, per evitare l'accozzaglia di argomenti).
Il server li carica in automatico all'avvio (funzione `seedSimulazioniPregenerate` in
`server.js`) e li inserisce nella tabella `simulazioni_pregenerate`. Basta il deploy su
Render, nessun comando da lanciare a mano.

Endpoint di distribuzione: `GET /api/simulazione-pregenerata/:materia/:unitaId`
(pesca dal pool ruotando su quelle già viste dallo studente; se un'unità non ha ancora
un file, il client fa fallback sulla vecchia generazione live via Gemini — quindi il sito
resta funzionante anche a metà lavoro).

Per ora c'è **una** simulazione per unità (un solo file = un pool di 1). Si può ampliare
il pool aggiungendo file `biologia-1b.json`, `biologia-1c.json`, ecc. per la stessa unità,
in un secondo momento.

## Stato per materia

### Biologia (7 unità)
- [x] Unità 1 — Le basi dell'organizzazione biologica e molecolare della vita
- [x] Unità 2 — Trasmissione e controllo dell'informazione genetica ed epigenetica
- [x] Unità 3 — Il flusso dell'informazione
- [x] Unità 4 — Trasmissione e controllo dei caratteri selvatici e mutati
- [x] Unità 5 — Le strutture cellulari: biogenesi, morfologia e funzioni
- [ ] Unità 6 — La cellula e l'ambiente, segnalazione e trasduzione del segnale
- [ ] Unità 7 — Controllo della proliferazione e sopravvivenza cellulare

### Fisica (7 unità)
- [x] Unità 1 — Introduzione ai metodi della fisica
- [x] Unità 2 — Meccanica
- [x] Unità 3 — Meccanica dei fluidi
- [x] Unità 4 — Onde meccaniche
- [x] Unità 5 — Termodinamica
- [ ] Unità 6 — Elettricità e magnetismo
- [ ] Unità 7 — Fisica delle radiazioni

### Chimica (7 unità)
- [x] Unità 1 — Struttura dell'atomo, legami chimici, stati di aggregazione, termodinamica
- [x] Unità 2 — Miscele, soluzioni, proprietà colligative
- [x] Unità 3 — Reazioni chimiche: cinetica ed equilibrio
- [x] Unità 4 — Acidi, basi, sali, pH, tamponi, redox
- [x] Unità 5 — Carbonio, idrocarburi, aromatici
- [ ] Unità 6 — Gruppi funzionali e isomerie
- [ ] Unità 7 — Amminoacidi, proteine, carboidrati, lipidi, acidi nucleici

**Totale: 15/21 unità completate.** (Unità 1-5 coperte su tutte e tre le materie; restano Unità 6 e 7 per ciascuna materia.)

---
Per riprendere: scrivi **CONTINUA SIMULAZIONI** in una nuova chat. Non è un pulsante vero
(le chat non condividono stato tra loro), ma questa frase dice a Claude di leggere questo
file dal repo e ripartire dalla prossima unità non spuntata, senza bisogno di rispiegare
il contesto da capo.
