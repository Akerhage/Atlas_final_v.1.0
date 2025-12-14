// /forceAddEngine.js
// UPPDATERAD VERSION (v1.1.9.1 -  RAG Cleanup efter Nollutrymme Fallback)

class forceAddEngine {
constructor(allChunks) {
this.allChunks = allChunks;
this.mustAddChunks = [];
this.forceHighConfidence = false;
this.version = "1.9.1"; 
}

// === HJÄLPFUNKTIONER (oförändrade) ===
qHas(queryLower, ...terms) {
return terms.some(t => queryLower.includes(t));
}
qReg(queryLower, re) {
return re.test(queryLower);
}
isBasfakta(c) {
const t = (c && c.type) ? c.type.toString().toLowerCase() : '';
return t === 'basfakta' || t === 'basfak' || t === 'basfacts' || t === 'basfacta' || t === 'bas-fakta';
}
addChunks(chunks, score, prepend = false) {
const uniqueChunks = chunks.filter(c => !this.mustAddChunks.some(existing => existing.id === c.id));
uniqueChunks.forEach(c => c.score = score);
if (prepend) {
this.mustAddChunks.unshift(...uniqueChunks);
} else {
this.mustAddChunks.push(...uniqueChunks);
}
return uniqueChunks.length;
}
findBasfaktaBySource(sourceFilename) {
return this.allChunks.filter(c =>
this.isBasfakta(c) &&
(c.source || '').toLowerCase().includes(sourceFilename)
);
}

// --- GRUPP A: HÖGSTA PRIO (KORT/TESTLEKTION/INGÅR) ---
rule_A1_AM(queryLower, intent, slots) {
if (slots.vehicle !== 'AM' && !this.qReg(queryLower, /\bam\b/) && !this.qHas(queryLower, 'moped', 'moppe')) {
return 0;
}
const chunks = this.findBasfaktaBySource('basfakta_am_kort_och_kurser');
const count = this.addChunks(chunks, 5000, false);
console.log(`[A1-AM] Lade till ${count} chunks (score: 5000)`);
return count;
}

rule_A4_LockedCityGenericPrice(queryLower, intent, slots, lockedCity) {
    // Triggers om vi söker pris OCH har en låst stad OCH frågan inkluderar en lektionsterm
    if (lockedCity && intent === 'price_lookup' && this.qHas(queryLower, 'körlektion', 'lektion', 'köra', 'lektioner')) {
        const targetServiceName = "Körlektion Bil";
        
        const matchingChunks = this.allChunks.filter(c => 
            c.type === 'price' && 
            (c.city || '').toString().toLowerCase() === lockedCity.toLowerCase() &&
            c.service_name === targetServiceName // EXAKT matchning på tjänstens namn
        );
        
        // Lägg till med absolut högsta prioritet (10000) och preppend: true
        const count = this.addChunks(matchingChunks, 10000, true);
        if (count > 0) {
            console.log(`[A4-LOCKED-PRICE] Lade till ${count} Körlektionspris för ${lockedCity} (score: 10000, FÖRST)`);
        }
        return count;
    }
    return 0;
}

/**
* REGEL A3: AM-INNEHÅLL (INAKTIVERAD - Hanteras av Nollutrymme Fallback)
*/
rule_A3_AM_Content(queryLower, intent, slots) {
// REGEL A3 ÄR INAKTIVERAD. AM-Ingår hanteras av EMERGENCY FALLBACK.
return 0;
}

// --- GRUPP B: KRITISK POLICY/INTRO/TILLSTÅND ---

rule_B1_Policy(queryLower, intent, slots) {
// REGEL B1 ÄR INAKTIVERAD. Generella Policy/Ångerrätt hanteras av EMERGENCY FALLBACK.
return 0;
}

/**
* REGEL B2: FÖRETAGSINFO/FINANS (Rensad: Hanterar ej Fakturaadress längre)
*/
rule_B2_Finance(queryLower, intent, slots) {
const has_keywords = this.qHas(queryLower,
'betalning', 'klarna', 'swish', 'faktura', 'orgnr', 'organisationsnummer', 'org nr', 'kort', 'delbetala', 'rabatt', 'företagsuppgifter', 'mårtenssons', 'adress'
);

if (!has_keywords) {
return 0;
}

// FAKTURAADRESS HANTERAS NU AV EMERGENCY FALLBACK. Vi hanterar bara den generella företagsinfon.
const generalChunks = this.findBasfaktaBySource('basfakta_om_foretaget');
const count = this.addChunks(generalChunks, 8000, false);
console.log(`[B2-FINANS] Lade till ${count} generella chunks (score: 8000)`);
return count;
}

rule_B4_KortTillstand(queryLower, intent, slots) {
const has_keywords = (intent !== 'tillstand_info' && !this.qHas(queryLower, 'körkortstillstånd', 'tillstånd', 'handläggningstid', 'läkarintyg', 'syntest', 'grupp 1', 'grupp 2', 'grupp 3', 'prövotid'));
if (has_keywords) {
return 0;
}

// Tvinga fram Prövotid-faktan FÖRST (score 10000)
if (this.qHas(queryLower, 'prövotid')) {
const provtidChunk = this.allChunks.filter(c =>
this.isBasfakta(c) && (c.keywords || []).includes('prövotid')
);
this.addChunks(provtidChunk, 10000, true);
console.log(`[B4-TILLSTÅND] Lade till Prövotid-chunk FÖRST (score: 10000)`);
}

const chunks = this.findBasfaktaBySource('basfakta_korkortstillstand');
const count = this.addChunks(chunks, 7000, false);
console.log(`[B4-TILLSTÅND] Lade till ${count} chunks (score: 7000)`);
return count;
}

/**
* REGEL B5: SPECIFIK GILTIGHET / INGÅR (Rensad: Hanterar ej Ångerrätt/ID 158 längre)
*/
rule_B5_SpecificFact(queryLower, intent, slots) {
let added = 0;

// Fix 1: Presentkort / Paket Giltighet (ID 156, 157) - Hallucination
if (this.qHas(queryLower, 'paket', 'giltighet', 'presentkort', 'hur länge gäller')) {
const giltighetChunks = this.allChunks.filter(c =>
this.isBasfakta(c) && (
(c.title || '').toLowerCase().includes('paket giltighet') ||
(c.title || '').toLowerCase().includes('presentkort')
)
);

// NYTT: Tagga för att lösa hallucinationer i LLM
giltighetChunks.forEach(c => {
// Ersätt text i chunken med taggar
c.text = c.text.replace(/1 år/gi, '<EXACT_FACT>1 år</EXACT_FACT>')
.replace(/24 månader/gi, '<EXACT_FACT>24 månader</EXACT_FACT>');
});

added += this.addChunks(giltighetChunks, 10000, true);
if (added > 0) console.log(`[B5-GILTIGHET] Lade till ${added} Giltighet chunks FÖRST (score: 10000, med TAGS)`);
}

// Fix 2: ÅNGRERÄTT / ÅTERBETALNING (BORTTAGEN - Hanteras av Nollutrymme Fallback)

return added;
}

// --- GRUPP C: ÖVRIG KRITISK BASFAKTA ---

rule_C1a_Risk1(queryLower, intent, slots) {
if (!this.qHas(queryLower, 'risk 1', 'riskettan')) {
return 0;
}

const allRiskChunks = this.findBasfaktaBySource('basfakta_riskutbildning_bil_mc');
const risk1Chunks = allRiskChunks.filter(c =>
(c.title || '').toLowerCase().includes('risk 1') ||
(c.title || '').toLowerCase().includes('riskettan')
);

const count = this.addChunks(risk1Chunks, 9000, true);
if (count > 0) {
this.forceHighConfidence = true;
console.log(`[C1a-RISK1] Lade till ${count} specifika Risk 1-chunks FÖRST (score: 9000, HIGH CONF)`);
}
return count;
}

rule_C1b_Risk2(queryLower, intent, slots) {
if (!this.qHas(queryLower, 'risk 2', 'risktvåan', 'halkbana')) {
return 0;
}

const allRiskChunks = this.findBasfaktaBySource('basfakta_riskutbildning_bil_mc');

const risk2Chunks = allRiskChunks.filter(c =>
(c.title || '').toLowerCase().includes('risk 2') ||
(c.title || '').toLowerCase().includes('risktvåan') ||
(c.title || '').toLowerCase().includes('halkbanan')
);

const count = this.addChunks(risk2Chunks, 9000, true);
if (count > 0) {
this.forceHighConfidence = true;
console.log(`[C1b-RISK2] Lade till ${count} specifika Risk 2-chunks FÖRST (score: 9000, HIGH CONF)`);
}
return count;
}

rule_C1c_RiskGeneric(queryLower, intent, slots) {
const hasGenericKeyword = this.qHas(queryLower, 'riskutbildning');
const hasSpecificKeyword = this.qHas(queryLower, 'risk 1', 'riskettan', 'risk 2', 'risktvåan', 'halkbana');

if ((intent === 'risk_course' || hasGenericKeyword) && !hasSpecificKeyword) {
const chunks = this.findBasfaktaBySource('basfakta_riskutbildning_bil_mc');
const count = this.addChunks(chunks, 6500, false);
console.log(`[C1c-RISK-GENERIC] Lade till ${count} generiska risk-chunks (score: 6500)`);
return count;
}
return 0;
}

rule_C2_MC_Behorighet(queryLower, intent, slots) {
const has_mc_keywords = this.qHas(queryLower, 'motorcykel', 'a1', 'a2', '125cc', 'lätt motorcykel', 'tung motorcykel');

if (slots.vehicle === 'MC' || has_mc_keywords) {
const chunks = this.findBasfaktaBySource('basfakta_mc_a_a1_a2');
const count = this.addChunks(chunks, 6000, false);
console.log(`[C2-MC-BEHÖRIGHET] Lade till ${count} MC behörighets-chunks (score: 6000)`);
return count;
}
return 0;
}

rule_C4_Paket_Bil(queryLower, intent, slots) {
const has_paket_keywords = this.qHas(queryLower, 'paket', 'totalpaket', 'minipaket', 'mellanpaket', 'baspaket', 'lektionspaket');

if (slots.vehicle === 'BIL' || (has_paket_keywords && slots.vehicle === null)) {
const chunks = this.findBasfaktaBySource('basfakta_lektioner_paket_bil');
const count = this.addChunks(chunks, 5500, false);
console.log(`[C4-PAKET-BIL] Lade till ${count} Bil-paket-chunks (score: 5500)`);
return count;
}
return 0;
}

rule_C5_Paket_MC(queryLower, intent, slots) {
const has_paket_keywords = this.qHas(queryLower, 'mc-paket', 'mc paket');

if (slots.vehicle === 'MC' || has_paket_keywords) {
const chunks = this.findBasfaktaBySource('basfakta_lektioner_paket_mc');
const count = this.addChunks(chunks, 5500, false);
console.log(`[C5-PAKET-MC] Lade till ${count} MC-paket-chunks (score: 5500)`);
return count;
}
return 0;
}

rule_C6_TungaFordon(queryLower, intent, slots) {
if (slots.vehicle === 'LASTBIL' || slots.vehicle === 'SLÄP') {
let chunkSource = (slots.vehicle === 'LASTBIL') 
	? 'basfakta_lastbil_c_ce_c1_c1e.json' 
	: 'basfakta_be_b96.json';

let score = 6500;
let addedCount = 0;

// Om frågan är specifik (innehåller sökord), ge den högre vikt
if (this.qHas(queryLower, 'lastbil', 'c-körkort', 'ce', 'släp', 'be-kort', 'b96')) { 
	score = 7000;
	// Använder prepend: true för att säkerställa att fakta ligger tidigt i kontexten
	addedCount = this.addChunks(this.findBasfaktaBySource(chunkSource), score, true);
	console.log(`[C6-TUNGA FORDON] Lade till ${addedCount} chunks (Kärnfråga, score: ${score})`);
} else {
	// Laddar filen bara baserat på slot
	addedCount = this.addChunks(this.findBasfaktaBySource(chunkSource), score, false);
	console.log(`[C6-TUNGA FORDON] Lade till ${addedCount} chunks (Slot-baserad, score: ${score})`);
}
return addedCount;
}
return 0;
}

rule_C7_TeoriAppen(queryLower, intent, slots) {
const has_teori_keywords = this.qHas(queryLower,
'mittkorkort', 'mittkrkort',
'korkort', 'krkort', 'teori',
'appen', 'teori-portalen', 'plugga-portalen',
'bemästra', 'bluestacks', 'teoripaket', 'teorilektion'
);

if (has_teori_keywords) {
const chunks = this.findBasfaktaBySource('basfakta_korkortsteori_mitt_korkort');
const added = this.addChunks(chunks, 5300, false);
if (added > 0) console.log(`[C7-TEORIAPP] Lade till ${added} Teori/App-chunks (score: 5300)`);
return added;
}
return 0;
}

rule_C8_Kontakt(queryLower, intent, slots) {
const has_kontakt_keywords = this.qHas(queryLower, 'kontakta', 'kontakt', 'telefonnummer', 'mail', 'support', 'finns ni', 'kontor', 'plats', 'telefon', 'hur många kontor', 'fakturaadress', 'kvällslektioner', 'morgonlektioner', 'öppettider stora holm', 'öppet stora holm', 'faktura', 'fakturor');

if (has_kontakt_keywords) {
const chunks = this.findBasfaktaBySource('basfakta_om_foretaget');
const added = this.addChunks(chunks, 5200, false);
if (added > 0) console.log(`[C8-KONTAKT] Lade till ${added} Kontakt/Företags-chunks (score: 5200)`);
return added;
}
return 0;
}

rule_C9_BilFakta(queryLower, intent, slots) {

// FIX för ID 145/142 (Automat/Manuell) 
if (this.qHas(queryLower, 'automat', 'manuell', 'villkor 78', 'kod 78', 'körkort för automat', 'körkort för manuell')) {
const chunks = this.findBasfaktaBySource('basfakta_personbil_b');
const added = this.addChunks(chunks, 7500, true); 
if (added > 0) console.log(`[C9-BIL-FAKTA] Lade till ${added} Automat/Manuell-chunks (score: 7500)`);
return added;
}
return 0;
}

execute(queryLower, intentResult, lockedCity) {
console.log(`\n${'='.repeat(60)}`);
console.log(`[FORCE-ADD ENGINE v${this.version}] Kör regler...`); 
console.log(`Query: "${queryLower.slice(0, 80)}..."`);
console.log(`Intent: ${intentResult.intent}, Fordon: ${intentResult.slots.vehicle || 'N/A'}`);
console.log(`${'='.repeat(60)}`);

let totalAdded = 0;
const { intent, slots } = intentResult;

// === SLUTGILTIG FIX – 2025-12-09 ===
if (intent === 'weather') {
return { mustAddChunks: [], forceHighConfidence: false };
}
if (intent === 'testlesson_info' || /testlektion|provlektion/i.test(queryLower)) {
// NY FIX: Ladda in de två chunks som tillsammans bildar det kompletta svaret.
const chunks = this.allChunks.filter(c => 
(this.isBasfakta(c) && /testlektion.*elev/i.test(c.text)) || // Endast en testlektion per elev
(this.isBasfakta(c) && /testlektion för bil/i.test(c.title))   // Vad är en testlektion för bil?
);
if (chunks.length) this.addChunks(chunks, 999999, true); // Högsta score för att tvinga LLM att läsa båda
}
if (intent === 'handledare_course' || /\b\d+\s*(år|års)\b/i.test(queryLower)) {
const chunks = this.allChunks.filter(c => this.isBasfakta(c) && c.source?.includes('introduktionskurs'));
if (chunks.length) this.addChunks(chunks, 999999, true);
}
if (slots.vehicle === 'MC' || /mc|motorcykel/i.test(queryLower)) {
const chunks = this.allChunks.filter(c => this.isBasfakta(c) && /15.?20 lektioner/i.test(c.text));
if (chunks.length) this.addChunks(chunks, 999999, true);
}

// KÖR NY PRIS-REGEL HÄR (FIXAR SCENARIO 2)
totalAdded += this.rule_A4_LockedCityGenericPrice(queryLower, intent, slots, lockedCity);

// NYA SPECIFIKA REGLER (KÖR FÖRST)
totalAdded += this.rule_C1a_Risk1(queryLower, intent, slots);

// NYA SPECIFIKA REGLER (KÖR FÖRST)
totalAdded += this.rule_C1a_Risk1(queryLower, intent, slots);
totalAdded += this.rule_C1b_Risk2(queryLower, intent, slots);

// NY BIL-FAKTA REGEL
totalAdded += this.rule_C9_BilFakta(queryLower, intent, slots);

// Policy och Ekonomi (Dessa kan också preppend-a in höga chunks)
totalAdded += this.rule_B2_Finance(queryLower, intent, slots); // RENAS
totalAdded += this.rule_B4_KortTillstand(queryLower, intent, slots);

// NYA SPECIFIKA POLICYREGLER (FIXAR HALLUCINATIONER)
totalAdded += this.rule_B5_SpecificFact(queryLower, intent, slots); // RENAS

// Medium Prio (Append / Generiska regler)
totalAdded += this.rule_A1_AM(queryLower, intent, slots);
totalAdded += this.rule_C1c_RiskGeneric(queryLower, intent, slots);

// NYA MC-REGLER (PRIO 1)
totalAdded += this.rule_C2_MC_Behorighet(queryLower, intent, slots);

// NYA PAKET-REGLER (PRIO 2)
totalAdded += this.rule_C4_Paket_Bil(queryLower, intent, slots);
totalAdded += this.rule_C5_Paket_MC(queryLower, intent, slots);

// NY TUNG FORDON-REGEL (PRIO 3)
totalAdded += this.rule_C6_TungaFordon(queryLower, intent, slots);

// NY TEORI-REGEL (PRIO 4)
totalAdded += this.rule_C7_TeoriAppen(queryLower, intent, slots);

// NY KONTAKT-REGEL (PRIO 5)
totalAdded += this.rule_C8_Kontakt(queryLower, intent, slots);

console.log(`\n[FORCE-ADD] Totalt: ${totalAdded} unika chunks tillagda`);
console.log(`[FORCE-ADD] forceHighConfidence: ${this.forceHighConfidence}`);
console.log(`${'='.repeat(60)}\n`);

return {
mustAddChunks: this.mustAddChunks,
forceHighConfidence: this.forceHighConfidence
};
}
}

module.exports = forceAddEngine;