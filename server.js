// === ATLAS v. 1.4.2 - FIX FÖR REN DATOR

// 1️⃣ DEFINIERA PORT FÖRST
const PORT = 3001;
process.env.LANG = 'sv_SE.UTF-8';

// === MODULER (resten fortsätter som vanligt)
const express   = require('express');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const MiniSearch = require('minisearch');
const OpenAI    = require('openai');
const crypto    = require('crypto');

// KRITISK FIX 1: Hämta root-sökvägen från miljövariabeln (ATLAS_ROOT_PATH = resources/)
const SERVER_ROOT = process.env.ATLAS_ROOT_PATH;

if (!SERVER_ROOT) {
    console.error("FATAL: ATLAS_ROOT_PATH saknas. Server kan inte hitta uppackade moduler.");
    process.exit(1);
}

// KRITISK FIX 2: Använd SERVER_ROOT för alla uppackade moduler.
const ForceAddEngine      = require(path.join(SERVER_ROOT, 'patch', 'forceAddEngine'));
const { IntentEngine, INTENT_PATTERNS } = require(path.join(SERVER_ROOT, 'patch', 'intentEngine'));
const contextLock = require(path.join(SERVER_ROOT, 'utils', 'contextLock'));
const priceResolver = require(path.join(SERVER_ROOT, 'utils', 'priceResolver'));

const IS_PACKAGED = process.env.IS_PACKAGED === 'true';

// ====================================================================
// SESSION MANAGEMENT
// ====================================================================
const sessions = new Map();

function generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
}

function createEmptySession(sessionId) {
    const newSession = {
        id: sessionId,
        created: Date.now(),
        messages: [],
        locked_context: {
            city: null,
            area: null,
            vehicle: null
        },
        linksSentByVehicle: {
            AM: false,
            MC: false,
            CAR: false,
            INTRO: false,
            RISK1: false,
            RISK2: false
        },
        isFirstMessage: true
    };
    sessions.set(sessionId, newSession);
    return newSession;
}

function appendToSession(sessionId, role, content) {
    const session = sessions.get(sessionId);
    if (!session) {
        console.warn(`[SESSION] Försökte appenda till icke-existerande session: ${sessionId}`);
        return;
    }
    session.messages.push({ role, content, timestamp: Date.now() });
}

// ====================================================================
// SMART SÖKVÄG – KRITISK FIX FÖR ATT ANVÄNDA ATLAS_ROOT_PATH I DEV
// ====================================================================
function getResourcePath(filename) {
  // Production FIRST (when packaged)
  if (IS_PACKAGED) {
    if (process.resourcesPath) {
      return path.join(process.resourcesPath, filename);
    }
  }
  
  // Development fallback
  if (process.env.ATLAS_ROOT_PATH) {
    return path.join(process.env.ATLAS_ROOT_PATH, filename);
  }
  
  // Final fallback
  return path.join(__dirname, filename);
}

// ====================================================================
// LOAD .ENV FÖRST – nu med korrekt sökväg
// ====================================================================
const dotenvPath = getResourcePath('.env');
const dotenvResult = require('dotenv').config({ path: dotenvPath });

if (dotenvResult.error) {
  console.error('VARNING: Kunde inte ladda .env-fil');
  console.error('Sökte efter: ' + dotenvPath);
  console.error('Fortsätter med miljövariabler från systemet…');
}

// ====================================================================
// API-NYCKLAR
// ====================================================================
const CLIENT_API_KEY      = process.env.CLIENT_API_KEY;
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY;

if (!CLIENT_API_KEY) {
  console.error('FEL: CLIENT_API_KEY saknas i .env');
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error('FEL: OPENAI_API_KEY saknas i .env');
  process.exit(1);
}

console.log('CLIENT_API_KEY laddad (verifierad)');
console.log('OpenAI-klient initialiserad.');

// ====================================================================
// KNOWLEDGE-MAPPEN – ANVÄNDER getResourcePath() FÖR ABSOLUT SÖKVÄG
// ====================================================================
const KNOWLEDGE_PATH = getResourcePath('knowledge');
const SYSTEM_PROMPT_PATH = getResourcePath('systembeskrivning.md');
const CONFIG_PATH = getResourcePath('config.json');

// Kontrollerar bara KNOWLEDGE_PATH, de andra filerna hanteras i loadKnowledgeBase/config-läsning.
if (!fs.existsSync(KNOWLEDGE_PATH)) {
  console.error(`FATAL: Knowledge-mappen saknas på: ${KNOWLEDGE_PATH}`);
  console.error('Atlas kan inte starta utan kunskapsdatabasen!');
  process.exit(1);
}
console.log(`Knowledge-mapp laddad från: ${KNOWLEDGE_PATH}`);

// === ✅ SETUP OPENAI
const openai = new OpenAI({
apiKey: OPENAI_API_KEY
});

// === ✅ SETUP EXPRESS
const app = express();
const VERSION = '1.4.2 - Atlas';

console.log('\n');
console.log('════════════════════════════════════════════════════');
console.log('                ATLAS – ONLINE                ');
console.log(`        v${VERSION} – Nu kör vi!          `);
console.log('');
console.log('            NU KÖR VI!            ');
console.log('════════════════════════════════════════════════════\n');

app.use(cors());

app.use((err, req, res, next) => {
if (err && err.message === 'Not allowed by CORS') {
return res.status(403).json({ error: 'CORS-blockerad förfrågan' });
}
next(err);
});

app.use(express.json());
app.use((req, res, next) => {
req.id = crypto.randomBytes(4).toString('hex');
req.startTime = Date.now();

console.log(`\n[${req.id}] ➡️  ${req.method} ${req.path}`);

res.on('finish', () => {
const duration = Date.now() - req.startTime;
console.log(`[${req.id}] ⬅️  ${res.statusCode} (${duration}ms)`);
});

next();
});

// Säkerställ korrekt UTF-8-hantering
app.use((req, res, next) => {
res.setHeader('Content-Type', 'application/json; charset=utf-8');
req.setEncoding('utf8');
next();
});

// VARIABLER OCH KONSTANTER
let miniSearch;
let allChunks = [];
let knownCities = [];
let knownAreas = {};
let cityOffices = {};
let officePrices = {};
let officeContactData = {};
let officeData = {};
let chunkMap = new Map();
let intentEngine;
let criticalAnswers = [];

// === BYGG CHUNKMAP EFTER ATT ALLCHUNKS ÄR FÄRDIGT
function rebuildChunkMap() {
if (!Array.isArray(allChunks)) {
chunkMap = new Map();
console.log('[CHUNKMAP] rebuild: allChunks is not an array -> tom map skapad');
return;
}
chunkMap = new Map(allChunks.map(c => [c.id, c]));
console.log(`[CHUNKMAP] rebuild: indexerade ${chunkMap.size} chunks`);
}

const LOW_CONFIDENCE_THRESHOLD = 0.25;
const LOW_CONFIDENCE_SLICE = 8;
const MAX_CHUNKS = 18;
const DEBUG_MODE = true;

const CITY_ALIASES = {
'djursholm': 'Stockholm',
'enskededalen': 'Stockholm',
'kungsholmen': 'Stockholm',
'ostermalm': 'Stockholm',
'osteraker': 'Stockholm',
'österåker': 'Stockholm',
'sodermalm': 'Stockholm',
'södermalm': 'Stockholm',
'solna': 'Stockholm',
'sthlm': 'Stockholm',
'stora holm': 'Göteborg',
'frölunda': 'Göteborg',
'frolunda': 'Göteborg',
'gbg': 'Göteborg',
'götebrog': 'Göteborg',
'gotebrog': 'Göteborg',
'gothenburg': 'Göteborg',
'Gothenburg': 'Göteborg',
'göötehoorg': 'Göteborg',
'gooteboorg': 'Göteborg',
'hogsbo': 'Göteborg',
'högsbo': 'Göteborg',
'molndal': 'Göteborg',
'mölndal': 'Göteborg',
'molnlycke': 'Göteborg',
'mölnlycke': 'Göteborg',
'ullevi': 'Göteborg',
'vastra frolunda': 'Göteborg',
'västra frölunda': 'Göteborg',
'bulltofta': 'Malmö',
'limhamn': 'Malmö',
'sodervarn': 'Malmö',
'södervärn': 'Malmö',
'triangeln': 'Malmö',
'varnhem': 'Malmö',
'värnhem': 'Malmö',
'vastra hamnen': 'Malmö',
'västra hamnen': 'Malmö',
'katedral': 'Lund',
'sodertull': 'Lund',
'södertull': 'Lund',
'halsobacken': 'Helsingborg',
'hälsobacken': 'Helsingborg',
'vaxjo': 'Växjö',
'växjö': 'Växjö'
};

const VEHICLE_MAP = {
'SLÄP': ['be', 'be-kort', 'be körkort', 'be-körkort', 'b96', 'släp', 'tungt släp', 'utökad b'],
'LASTBIL': ['lastbil', 'c', 'c1', 'c1e', 'ce', 'c-körkort', 'tung lastbil', 'medeltung lastbil'],
'AM': ['am', 'moped', 'mopedutbildning', 'moppe', 'klass 1'],
'BIL': ['bil', 'personbil', 'b-körkort', 'b körkort', 'körlektion bil', 'körlektion personbil'],
'MC': ['mc', 'motorcykel', 'a1', 'a2', 'a-körkort', '125cc', '125 cc', 'lätt motorcykel', 'tung motorcykel'],
'INTRO': ['introduktionskurs', 'handledarkurs', 'handledare']
};

const UNIFIED_SYNONYMS = {
'14 år och 9 månader': ['14 år och 9 månader', '14 år', '9 månader', '14,5 år', '14.5 år', '14 år 9 mån'],
'16 år': ['16', 'fyllt 16', 'från 16', 'sexton år', '16 år'],
'18 år': ['18', 'fyllt 18', 'arton år'],
'24 år': ['24', 'fyllt 24'],
'15 år': ['15', 'femton år'],
'5 år': ['fem år', 'giltig', 'giltighet'],
'3 månader': ['tre månader', '3 månader'],
'6 månader': ['sex månader', '6 månader'],
'2 år': ['två år', '2 år', 'tvåårsperiod', 'prövotid'],
'14 år': ['14 år', '14-åring', 'fjorton år'],
'9 månader': ['9 månader', 'nio månader', '14 år och 9 månader'],
'tre och en halv timme': ['3,5 timmar', '3.5 timmar', '3,5h', 'tre och en halv', '3 timmar', 'tre och en halv timme'],
'100 min': ['100-minuters pass', '100 minuter', '100 min'],
'80 min': ['80-minuters pass', '80 minuter', '80 min', 'standardlektion', 'vanlig lektion'],
'45 min': ['45 minuter', 'uppkörningstid', 'hela uppkörningen'],
'fyra veckor': ['4 veckor', 'handläggningstid', '4-6 veckor'],
'4-5 timmar': ['fyra till fem timmar', '4-5 timmar'],
'elev': ['du som ska ta körkort', 'du som elev', 'elev'],
'handledare': ['handledare', 'din handledare', 'handledaren', 'privat handledare'],
'två elever': ['två elever', '2 elever', 'duo-lektion'],
'behöver gå': ['måste gå', 'krävs', 'genomföra', 'obligatorisk', 'behöver genomföra', 'genomgå'],
'ansöka': ['ansöka', 'ansökan', 'ansöka om', 'söka', 'göra ansökan', 'måste handledaren ansöka'],
'göra om': ['ta om', 'göra om', 'genomföra på nytt'],
'köra': ['framföra', 'köra bil', 'trafikkörning'],
'både': ['både och', 'både manuella och automatväxlade bilar'],
'inte': ['nej', 'inte tillåtet', 'inte möjligt', 'ej', 'inte krav', 'behöver inte', 'ingen information om'],
'ja': ['ja', 'yes', 'stämmer', 'korrekt', 'det går', 'möjligt', 'får', 'kan', 'ja, vi erbjuder', 'tillåtet'],
'ingen': ['inga', 'inget'],
'del 1': ['risk 1', 'riskettan'],
'del 2': ['risk 2', 'risktvåan', 'halkbanan'],
'riskettan': ['risk 1', 'teoretisk', 'alkohol', 'droger', 'trötthet', '3,5 timmar'],
'introduktionskurs': ['handledarkurs', 'handledare', 'kurs', 'intro', 'introduktion'],
'körkortstillstånd': ['tillstånd', 'krävs', 'giltigt', 'handledarintyg'],
'nollvisionen': ['ingen dödas', 'ingen skadas'],
'riskutbildning': ['del 1', 'del 2', 'risk 1', 'risk 2'],
'obligatorisk': ['krav', 'måste', 'krävs'],
'medeltung lastbil': ['medeltung lastbil', 'c1', 'lätt lastbil'],
'giltigt körkortstillstånd': ['giltigt körkortstillstånd', 'godkänt körkortstillstånd', 'aktivt körkortstillstånd'],
'dubbellektion': ['dubbellektion', 'dubbel lektion', '2x40', '80-minuterslektion', '80 min lektion'],
'duo-lektion': ['duo-lektion', 'duolektion', 'duo', 'parlektion', 'två elever'], // duo endast för MC
'singel': ['singel-lektion', 'en 80-minuters singel-lektion'],
'första lektion': ['din första lektion', 'första körlektion'],
'manövrar': ['manöverkörning', 'manöverbana', 'manöver/grupp-körning', 'manövrer'],
'manövrering': ['manöverträning', 'trafik', 'alla moment'],
'digital teori': ['digitalt teorimaterial', 'Mitt Körkort', 'teori online'],
'färre': ['färre', 'mindre'],
'lån av moped': ['lån av moped', 'låna moped', 'moped ingår', 'moped tillhandahålls', 'vi tillhandahåller moped'],
'hjälm': ['hjälm', 'skyddsutrustning'],
'skyddsutrustning': ['utrustning', 'lånas', 'lånas kostnadsfritt', 'tillhandahålls', 'ingår', 'skyddsutrustning'],
'lån av motorcykel': ['lån av mc', 'motorcykel ingår', 'motorcykel tillhandahålls'],
'egen utrustning': ['egen utrustning', 'egen hjälm', 'egna kläder', 'eget'],
'lån av mc': ['lån av mc', 'låna motorcykel', 'mc ingår'],
'personbil': ['bil', 'personbilar'],
'automatbil': ['automat', 'automatväxlad bil'],
'manuell bil': ['manuell', 'manuellt'],
'mc': ['motorcykel', 'mc-körlektion', 'mc paket', 'motorcykel paket'],
'be': ['släp', 'BE-körkort'],
'b96': ['släp', 'B96-körkort'],
'obegränsad': ['obegränsad', 'utan begränsning', 'full behörighet', 'alla motorcyklar'],
'125cc': ['125 cc', '125cc', '125 cm3', '125 kubik', '125 kubikcentimeter', 'a1', '125 kubik cm'],
'11kw': ['11 kW', '11kw', '11 kilowatt'],
'35kw': ['35 kW', '35kw', '35 kilowatt'],
'vilken kurs': ['vilken stad', 'vilket kontor', 'var'],
'göteborg': ['gbg', 'göteborg'],
'stockholm': ['sthlm', 'stockholm'],
'41 kontor': ['största körskola', 'antal kontor', 'sammanlagt', '41'],
'halkbanan': ['risk 2', 'risktvåan', '4-5 timmar', 'halka'],
'inget teoriprov': ['inget teoriprov krävs', 'behöver inte teoriprov'],
'privat körning': ['privat övningskörning', 'övningsköra privat'],
'lärare': ['instruktör', 'körlärare'],
'intensivkurs': ['intensiv', 'snabb kurs'],
'paket': ['kurspaket', 'körkortspaket'],
'organisationsnummer': ['organisationsnummer', 'org nr', 'företagsuppgifter', 'org. nr.', 'företagets nummer'],
'regler': ['gäller', 'krav', 'villkor', 'bestämmelser'],
'påbörja': ['påbörja', 'börja', 'starta', 'inleda'],
'endast en gång': ['endast en gång', 'bara en gång', 'en enda gång', 'endast bokas en gång', 'får endast bokas en gång', 'kan endast bokas en gång'],
'alla': ['alla', 'samtliga', 'vilken som helst'],
'skillnad': ['skillnad', 'skillnaden', 'vad är skillnaden', 'jämförelse'],
'förmodligen inte': ['förmodligen inte', 'troligtvis inte', 'sannolikt inte', 'inte tillräckligt'],
'vissa orter': ['vissa orter', 'vissa städer', 'vissa kontor', 'utvalda orter'],
'övningskör': ['övningskör', 'övningsköra', 'träna körning'],
'teori': ['teori', 'teoriundervisning', 'digitalt teorimaterial'],
'kontor': ['kontor', 'vilket kontor'],
'12:00': ['12:00', 'klockan 12'],
'4499': ['4499', '4499 kr', '4499 SEK', '4499 kronor'],
'mölndal': ['mölndal', 'molndal', 'mölnlycke', 'molnlycke'],
'bokningslänk': ['bokningslänk', 'bokningssida', 'bokningslänken', 'boka via länk', 'bokningswidget', 'bokningsportal'],
'boka här': ['boka här', 'boka online', 'boka kurs', 'boka nu', 'boka AM-kurs', 'boka MC-intensiv', 'bokningslänk'],
'manöverkörning': ['manöverkörning', 'manöverträning', 'manöverbana', 'manöver'],
'körning i trafik': ['körning i trafik', 'trafikkörning', 'trafiklektion', 'avslutande körning'],
'mitt körkort': ['mitt körkort', 'appen mitt körkort', 'teoripaketet', 'teoriappen'],
'extra lektioner': ['extra lektioner', 'fler lektioner', 'tilläggslektioner', 'ytterligare lektioner'],
'heldagar': ['heldagar', 'heldag', 'hela dagar', 'från morgon till kväll'],
'intensivvecka': ['intensivvecka', '5 dagar', 'fem dagar', 'intensiv vecka'],
'anpassning': ['anpassning', 'anpassad utbildning'],
'testlektion': ['testlektion', 'provlektion', 'prova-på', 'prova på', 'provlektion bil', 'testlektion bil', 'bedömningslektion', 'inledande lektion', 'test lektion'],
'provlektion': ['provlektion', 'prova-på', 'prova på', 'testlektion'],
'startlektion': ['startlektion', 'start-lektion', 'start lektion', 'nivåtest', 'nivåbedömning', 'första lektion MC', 'bedömningslektion mc', 'startlektion mc'],
'nivåtest': ['nivåtest', 'nivåbedömning', 'bedömning mc', 'första körning mc', 'inledande lektion mc'],
'villkor 78': ['automatväxlad', 'automatlåda', 'endast automat'],
'a1': ['a1', 'a1-körkort', 'lätt mc-kort', 'lätt motorcykel'],
'a2': ['a2', 'a2-körkort', 'mellanstor mc', 'mellanstor motorcykel'],
'villkor': ['villkor', 'villkor 78', 'kod 78', 'begränsning', 'kodvillkor'],
'grupp 2': ['grupp 2', 'grupp2', 'tung behörighet'],
'syntest': ['syntest', 'synundersökning', 'synprov', 'synintyg'],
'transportstyrelsen': ['transportstyrelsen', 'transportstyrelsens', 'myndigheten', 'via transportstyrelsen'],
'e-tjänst': ['e-tjänst', 'etjänst', 'digital tjänst', 'online-tjänst', 'transportstyrelsen e-tjänst'],
'digitalt': ['digitalt', 'digital', 'online', 'via nätet'],
'B-körkort': ['bil', 'personbil', 'b-körkort', 'körkort för bil'],
'klarna': ['klarna', 'delbetala', 'delbetalning'],
'faktura': ['faktura', 'fakturaadress', 'fakturering'],
'olika priser': ['olika priser', 'prisskillnad', 'varierar', 'prisvariation'],
'avbokning': ['avbokning', 'avboka', 'omboka', 'ändra bokning'],
'återbetalning': ['återbetalning', 'pengar tillbaka', 'återbetalas', 'refund'],
'senast kl 12:00': ['senast kl 12:00', 'senast 12', 'innan klockan 12', 'före kl 12'],
'debitering': ['debitering', 'debiteras', 'avgift', 'kostnad'],
'vab': ['vab', 'vård av barn', 'sjukt barn'],
'räknas inte': ['räknas inte', 'gäller inte', 'undantag'],
'förbrukas': ['förbrukas', 'går ut', 'förfaller', 'slutar gälla'],
'användas': ['användas', 'nyttjas', 'utnyttjas', 'tas i bruk'],
'policy': ['policy', 'regler', 'villkor', 'bestämmelser'],
'swish': ['swish', 'betala med swish'],
'avbokningspolicy': ['avbokningspolicy', 'policy'],
'telefonnummer': ['telefonnummer', 'ring', 'kontakta via telefon', 'nummer', 'telefon'],
'010-333 32 31': ['010-333 32 31', '010 333 32 31', '0103333231'],
'orgnr': ['organisationsnummer', 'org.nr', 'orgnr', '559192-2198'],
'supportmail': ['supportmail', 'mejl', 'e-post', 'mail', 'support@mymoney.se', 'support@trafiko.se'],
'scancloud.se': ['scancloud.se', 'scancloud', 'fakturamottagare'],
'fe 7283': ['fe 7283', 'fe7283', 'faktura-id', 'fakturaadress'],
'östersund': ['östersund', 'faktura östersund'],
};

// ===== VERKTYGSFUNKTIONER
function expandQuery(query) {
let expanded = query.toLowerCase();
for (const [key, synonyms] of Object.entries(UNIFIED_SYNONYMS)) {
if (expanded.includes(key.toLowerCase())) {
const limited = synonyms.slice(0, 2);
limited.forEach(syn => expanded += ' ' + syn.toLowerCase());
}
}
if (expanded.length > 250) {
expanded = expanded.substring(0, 250);
}
return expanded;
}

// --- Chunk: Kontrollera om typen är Basfakta
function isBasfaktaType(c) {
const t = (c && c.type) ? c.type.toString().toLowerCase() : '';
return t === 'basfakta' || t === 'basfak' || t === 'basfacts' || t === 'basfacta' || t === 'bas-fakta';
}

// === SÖK: Normalisera & Expandera Query
function normalizeText(s) {
if (!s) return '';
return s.toString()
.toLowerCase()
.replace(/\b(\d+)\s?cc\b/g, '$1 cc')
.replace(/\b(\d+)\s?k\s?w\b/g, '$1 kW')
.replace(/\b(\d+)min(uter)?\b/g, '$1 min')
.replace(/\bmin(u?ter)?\b/g, 'min')
.replace(/[^\wåäö\- \d{}%]/g, ' ')
.replace(/\s+/g, ' ')
.trim();
}

function normalizedExpandQuery(q) {
const normalized = normalizeText(q);
return expandQuery(normalized);
}

// === RAG: Kontrollera Låg Konfidens
function isLowConfidence(results) {
if (!results || results.length === 0) return true;
const best = results[0];
return (typeof best.score === 'number') ? (best.score < LOW_CONFIDENCE_THRESHOLD) : true;
}

// === DEBUG: Logga Toppmatchningar
function logMatchDebug(question, topResults) {
try {
console.log('[MATCH_DEBUG]', JSON.stringify({
t: new Date().toISOString(),
q: question,
top: topResults.slice(0, 5).map(r => ({
id: r.id,
title: r.title,
score: r.score,
city: r.city,
type: r.type
}))
}));
} catch (e) {
console.log('[MATCH_DEBUG] could not stringify', e.message);
}
}

// === GENERATE_RAG_ANSWERS - SYSTEMPROMPT // === 
async function generate_rag_answer(
userQuestion,
retrievedContext,
detectedCity,
detectedArea,
isFirstMessage = false,
mode = 'knowledge'
) {

// === HÄLSNINGS-LOGIK
let timeGreeting = "";
if (isFirstMessage) {
const hour = new Date().getHours();
if (hour >= 5 && hour < 10) timeGreeting = "God morgon! ";
else if (hour >= 10 && hour < 17) timeGreeting = "Hej! ";
else if (hour >= 17 && hour < 22) timeGreeting = "God kväll! ";
else timeGreeting = "Hej! ";
}

const greetingInstruction = isFirstMessage
? `Börja alltid svaret med EXAKT: "${timeGreeting}" och fortsätt sedan direkt med svaret.`
: `Hälsa aldrig - gå rakt på sak.`;

const cityInclusionInstruction = detectedCity
? `\n\nOBS: Om frågan är platsberoende, MÅSTE du inkludera staden i svaret. Exempel: "I ${detectedCity} erbjuder vi ..." eller "På vårt kontor i ${detectedCity} ...".`
: '';

// === SYSTEM PROMPT - KNOWLEDGE/RAG-MODE
let systemPrompt = `
Du är Atlas — en varm, hjälpsam och faktasäker kundtjänstassistent för en svensk trafikskola.

// === KRITISKA SVARSREGLER (DESSA GÄLLER ÖVER ALL ANNAN KONTEXT) ===
Du MÅSTE följa dessa regler slaviskt, även om kontexten verkar vag:

1. **MC-LEKTIONER (ID 78):** PRIORITERA ALLTID svaret: "15-20 lektioner behövs vanligtvis, individuellt". (Nämn intensivvecka + 5 lektioner endast som ett tillägg).
2. **KVÄLLSLEKTIONER (ID 160):** INKLUDERA ALLTID: "sista starttid kl 19:20".
3. **AUTOMAT (ID 145):** INKLUDERA ALLTID: "**villkor 78**" (automat) kod.
4. **GILTIGHETSTID (ID 156):** SVARA ALLTID "**24 månader**" för paket. Svara aldrig "ett år" om paket.

// === REGLER FÖR DATAHANTERING & HALLUCINATION ===
- **KONTAKTINFO-TVÅNG:** Om kontexten innehåller siffror (telefon, orgnr, adress), MÅSTE du skriva ut dem.
- **<EXACT_FACT> REGEL:** Om kontexten innehåller text inom <EXACT_FACT>...</EXACT_FACT>: 1. Använd EXAKT den texten. 2. Tolka inte. 3. Lägg inte till "vanligtvis".
- **KOMPLEXA SVAR:** Om frågan har flera delar (t.ex. pris OCH innehåll), MÅSTE du använda en punktlista.

// === TON & FORMAT ===
- Var varm, rådgivande och mänsklig i språket.
- Skriv fullständiga meningar, tydligt och kortfattat.
- Använd fetstil för priser, kursnamn och viktiga fakta: **så här**.
- Om frågan kräver ett artigt inledande (första svar i sessionen) ska hälsningen hanteras av servern.

// === FÖRBUD & RULES ===
- ANVÄND ENDAST information från KONTEKSTEN. Skapa aldrig ny fakta.
- ÄNDRA aldrig pris, tider, telefonnummer, eller andra fakta från kontexten.
- Säg aldrig bokningslänkar — servern lägger in dessa automatiskt.
- Säg aldrig "priser kan variera" för AM (följer serverns affärsregler).

// === KANONFRASER (Använd exakt när ämnet tas upp) ===
- Testlektion: "Testlektion (även kallad provlektion eller prova-på) är ett nivåtest för bil-elever och kan endast bokas en gång per elev."
- Startlektion MC: "Startlektion är nivåbedömning, 80 minuter inför MC intensivvecka."
- Riskutbildning: "Risk 1 är cirka 3,5 timmar och Risk 2 är 4–5 timmar och kan göras i vilken ordning som helst."
- Handledare: "Handledaren måste vara minst 24 år, haft körkort i minst 5 av de senaste 10 åren och både elev och handledare behöver gå introduktionskurs."
- Automat: "Automat ger villkor 78."

// === FALLBACK ===
- Om information saknas helt i kontexten svara exakt:
"Jag hittar ingen information i vår kunskapsbas om det här."

LÄS NEDAN KONTEKST NOGA OCH SVARA UTIFRÅN DEN (MEN FÖLJ DE KRITISKA REGLERNA ÖVERST):
<<KONTEKST_BIFOGAD_AV_SERVERN>>
Svara alltid på svenska.
Använd **text** (dubbelstjärnor) för att fetmarkera priser och andra viktiga fakta.

${greetingInstruction}
${cityInclusionInstruction}
`.trim();

// === SYSTEM PROMPT - CHAT-MODE
if (mode === "chat") {
systemPrompt = `
Du är Atlas — en varm, personlig och lätt humoristisk assistent för en svensk trafikskola.

TON & FORMAT
- Vara varm, mänsklig och lätt skämtsam när det passar.
- Håll det kort, tydligt och hjälpsamt.
- Använd svenska.
- Fetstil behövs inte i fria chat-svar men är ok när det förtydligar något.

TOOLS & NÄR DE FÅR ANVÄNDAS
- Om användaren frågar om VÄDER, SKÄMT, Citat eller BILDER: **ANVÄND ALLTID motsvarande tool OMEDELBART**. Fråga ALDRIG användaren om de vill att du ska göra det - gör det direkt.
• Väderfrågor: Anropa get_weather med rätt stad
• Skämtfrågor: Anropa get_joke
• Citatfrågor: Anropa get_quote
- Servern förväntar sig tool_calls i dessa fall - returnera ALDRIG vanlig text när ett tool finns tillgängligt.

FÖRBUD
- Säg aldrig bokningslänkar — servern lägger in dem när relevant.
- Svara aldrig på faktafrågor om körkort/kurser - dessa hanteras av ett annat system.

FALLBACK
- Om du är osäker: svar kort och vänligt, t.ex. "Jag kan hjälpa med det — ska jag kolla något specifikt åt dig?"

Svara alltid på svenska.
Använd **text** (dubbelstjärnor) för att fetmarkera viktiga fakta när det passar.
${greetingInstruction}
`.trim();
}

// UTOMATISKT VISITKORT
if (detectedCity) {
const cityKey = detectedCity.toLowerCase();

// Fall 1: Vi har data för staden i officeData
if (officeData[cityKey] && officeData[cityKey].length > 0) {

const offices = officeData[cityKey];

// Scenario A: ETT kontor/stad (ex. Eslöv)
if (offices.length === 1) {
const office = offices[0];
const name = office.name || `Kontoret i ${office.city}`;
const phone = (office.contact && office.contact.phone) ? office.contact.phone : (office.phone || "");
const email = (office.contact && office.contact.email) ? office.contact.email : (office.email || "");
const address = (office.contact && office.contact.address) ? office.contact.address : (office.address || "");

let hoursText = "";
if (office.opening_hours && Array.isArray(office.opening_hours)) {
hoursText = office.opening_hours.map(h => `${h.days}: ${h.hours}`).join(", ");
}

const contactCard = `
---------------------------------------------------------------------
🚨 INSTRUKTION FÖR PLATSSPECIFIK KONTAKTINFO (${office.city}) 🚨
Användaren frågar om kontaktuppgifter i: ${office.city}.
Du MÅSTE presentera svaret EXAKT enligt följande mall:

"Här har du kontaktuppgifterna till oss i ${office.city}:

**${name}**
📍 ${address}
📞 ${phone}
📧 ${email}
${hoursText ? `🕒 Öppettider: ${hoursText}` : ''}

Ring oss gärna om du har frågor!"
---------------------------------------------------------------------
`;
systemPrompt += "\n" + contactCard;
} 

// Scenario B: FLERA kontor/stad (ex. Göteborg/Malmö/Stockholm)
else if (offices.length > 1) {

// Har användaren specifierat ett område? (ex. "Ullevi")
if (detectedArea) {
const specificOffice = offices.find(o => o.area && o.area.toLowerCase() === detectedArea.toLowerCase());

if (specificOffice) {
// Vi hittade rätt kontor
const office = specificOffice;
const name = office.name;
const phone = office.contact?.phone || "";
const email = office.contact?.email || "";
const address = office.contact?.address || "";

const contactCard = `
---------------------------------------------------------------------
🚨 INSTRUKTION FÖR PLATSSPECIFIK KONTAKTINFO (${office.city} - ${office.area}) 🚨
Du MÅSTE presentera svaret EXAKT enligt följande mall:

"Här har du kontaktuppgifterna till ${office.area}:

**${name}**
📍 ${address}
📞 ${phone}
📧 ${email}"
---------------------------------------------------------------------
`;
systemPrompt += "\n" + contactCard;
} else {
// Användaren sa ett område som inte matchade exakt, lista alla.
const list = offices.map(o => `* **${o.area}**: ${o.contact?.phone || 'Se hemsida'}`).join("\n");
systemPrompt += `\n\nVi har flera kontor i ${detectedCity}. Här är en lista:\n${list}\nBe användaren precisera vilket de vill besöka.`;
}
} else {
// Inget område valt, men flera finns. Lista dem.
const list = offices.map(o => `* **${o.area}**: ${o.contact?.phone || 'Se hemsida'}`).join("\n");
systemPrompt += `\n\nVi har ${offices.length} kontor i ${detectedCity}. Användaren måste välja ett:\n${list}\nFråga vilket kontor de undrar över.`;
}
}
}
}

// === TRIGGERS
if (mode === "chat") {
const lower = userQuestion.toLowerCase();

// — 1: Tvinga knowledge-mode om användaren frågar om priser/körkort
if (
lower.includes("pris") ||
lower.includes("kostar") ||
lower.includes("körkort") ||
lower.includes("paket") ||
lower.includes("lektion") ||
lower.includes("riskettan") ||
lower.includes("risktvåan") ||
lower.includes("am") ||
lower.includes("mc") ||
lower.includes("bil")
) {
mode = "knowledge";
}

// — 2: Om användaren ber om väder, skämt, citat, bild → håll kvar chat-mode
if (
lower.includes("väder") ||
lower.includes("skämt") ||
lower.includes("citat") ||
lower.includes("bild") ||
lower.includes("rita") ||
lower.includes("generera")
) {
mode = "chat";
}
}

// === TOOL FORCING FÖR CHAT-MODE
let toolForcingInstruction = "";
if (mode === "chat") {
const lowerQ = userQuestion.toLowerCase();

if (lowerQ.includes("väder")) {
const cityMatch = detectedCity || "Stockholm";
toolForcingInstruction = `\n\n[SYSTEM INSTRUCTION: User asked about weather. You MUST call get_weather tool with city="${cityMatch}". Do NOT respond with text.]`;
}
else if (lowerQ.includes("skämt") || lowerQ.includes("vits")) {
toolForcingInstruction = `\n\n[SYSTEM INSTRUCTION: User asked for a joke. You MUST call get_joke tool. Do NOT respond with text.]`;
}
else if (lowerQ.includes("citat")) {
toolForcingInstruction = `\n\n[SYSTEM INSTRUCTION: User asked for a quote. You MUST call get_quote tool. Do NOT respond with text.]`;
}
}

// === USER MESSAGE
const userContent =
mode === "knowledge"
? `Fråga: ${userQuestion}\n\nKONTEKST:\n${retrievedContext || ""}`
: userQuestion + toolForcingInstruction; 

// === TOOLS CHAT-MODE
let tools = [];
if (mode === "chat") {
tools = globalAvailableTools;
}

// === SEND TO OPENAI
const messages = [
{ role: "system", content: systemPrompt },
{ role: "user", content: userContent }
];

// === CALL MODEL (med tool-forcing för väder/skämt/citat)
const apiParams = {
model: "gpt-4o-mini",
messages,
max_tokens: mode === "chat" ? 600 : 700,
temperature: mode === "chat" ? 0.7 : 0.0,
top_p: 1.0
};

// FORCE TOOL USAGE för väder/skämt/citat (garanterar att LLM använder tool)
if (mode === "chat" && tools && tools.length > 0) {
const lowerQ = userQuestion.toLowerCase();

if (lowerQ.includes("väder")) {
apiParams.tools = tools;
apiParams.tool_choice = { type: "function", function: { name: "get_weather" } };
console.log("[TOOL FORCING] Tvingar get_weather för väderfrågа");
}
else if (lowerQ.includes("skämt") || lowerQ.includes("vits")) {
apiParams.tools = tools;
apiParams.tool_choice = { type: "function", function: { name: "get_joke" } };
console.log("[TOOL FORCING] Tvingar get_joke för skämtfrågа");
}
else if (lowerQ.includes("citat")) {
apiParams.tools = tools;
apiParams.tool_choice = { type: "function", function: { name: "get_quote" } };
console.log("[TOOL FORCING] Tvingar get_quote för citatfrågа");
}
else {
// För andra chat-frågor: tools tillgängliga men inte tvingade
apiParams.tools = tools;
}
}

const resp = await openai.chat.completions.create(apiParams);
const text = resp.choices?.[0]?.message?.content?.trim() || "";

// === CHAT-MODE LOGIC
if (mode === "chat") {

// 1. Tool-call detection
const toolCall = resp.choices?.[0]?.message?.tool_calls;
if (toolCall && toolCall.length > 0) {
return {
type: "tool_request",
model: "gpt-4o-mini",
messages,
tools,
max_tokens: 600,
temperature: 0.7
};
}

// 2. Fallback vid tom text
if (!text || text.length < 1) {
return {
type: "answer",
answer: "Jag kan hjälpa dig! Vill du att jag kollar vädret, drar ett skämt eller ska jag söka i vår kunskapsbas åt dig?",
messages,
model: "gpt-4o-mini"
};
}

// 3. Vanligt chat-svar (utan tool)
return {
type: "answer",
answer: text,
messages,
model: "gpt-4o-mini"
};
}

// === KNOWLEDGE MODE RETURN ANSWER
let finalAnswer = text;

if (isFirstMessage && timeGreeting) {
if (!finalAnswer.toLowerCase().startsWith(timeGreeting.trim().toLowerCase())) {
finalAnswer = `${timeGreeting}${finalAnswer}`;
}
}

if (!finalAnswer || finalAnswer.length < 2) {
finalAnswer = "Jag hittar ingen information i vår kunskapsbas om det här.";
}

finalAnswer = safeBold(finalAnswer);


return {
type: "answer",
answer: finalAnswer,
messages,
model: "gpt-4o-mini"
};
}

// === SAFEBOLD (28/11)
function safeBold(str) {
return str.replace(/(\d{3,5})\s?kr/gi, '**$1 kr**');
}

// === JOKE HELPER
async function get_joke() {
try {

const jokes = [
"Varför kör MC-förare alltid så snabbt? För att hålla sig varma!",
"Varför välter inte motorcyklar? För att de är tvåhjuliga med balans i blodet!"
];

const joke = jokes[Math.floor(Math.random() * jokes.length)];

return { joke };
} catch (e) {
return { joke: "Jag har inga skämt just nu 😅" };
}
}

// === QUOTE HELPER
async function get_quote() {
try {
const quotes = [
"Den bästa tiden att börja var igår. Den näst bästa är idag.",
"Framgång kommer av små steg tagna varje dag.",
"Gör ditt bästa idag – framtiden tackar dig."
];

const quote = quotes[Math.floor(Math.random() * quotes.length)];

return { quote };
} catch (e) {
return { quote: "Kunde inte hämta ett citat just nu." };
}
}

// === WEATHER HELPER
async function fetchWeather(rawCity) {
const city = (rawCity || 'Stockholm').toString().toLowerCase().trim();

// Normalisera stad via CITY_ALIASES
const normalizedCity = CITY_ALIASES[city] || city;
const targetCity = normalizedCity || 'Stockholm';

const apiKey = process.env.OPENWEATHER_API_KEY;
if (!apiKey) {
return { error: "OpenWeather API-nyckel saknas" };
}

const url = `https://api.openweathermap.org/data/2.5/weather?q=${targetCity},SE&appid=${apiKey}&units=metric&lang=sv`;

try {
const res = await fetch(url);
const data = await res.json();

if (data.cod !== 200) {
return { error: `Kunde inte hämta väder för ${targetCity}` };
}

return {
city: data.name,
temperature: Math.round(data.main.temp),
description: data.weather[0].description
};
} catch (e) {
console.error('[WEATHER ERROR]', e.message);
return { error: "Väder-API:t svarar inte" };
}
}

// === KALKULATOR HELPER
async function calculate_price(amount, unit_price) {
try {
const total = amount * unit_price;
return { total };
} catch (e) {
return { error: "Kunde inte räkna ut priset." };
}
}

// === IMAGE GENERATION HELPER
async function generate_image(prompt) {
try {
const res = await openai.images.generate({
model: "gpt-image-1",
prompt: prompt,
size: "1024x1024"
});

// Bilddata (Base64)
const imageBase64 = res.data[0].b64_json;
return { image: imageBase64 };

} catch (e) {
console.error("Image generation error:", e);
return { error: "Kunde inte generera bilden." };
}
}

// === GLOBAL AVAILABLE TOOLS
const globalAvailableTools = [
{
type: "function",
function: {
name: "get_weather",
description: "Hämtar väder för en svensk stad.",
parameters: {
type: "object",
properties: {
city: { type: "string", description: "Stad i Sverige" }
},
required: ["city"]
}
}
},
{
type: "function",
function: {
name: "get_joke",
description: "Returnerar ett slumpmässigt skämt."
}
},
{
type: "function",
function: {
name: "get_quote",
description: "Returnerar ett inspirerande citat."
}
},
{
type: "function",
function: {
name: "calculate_price",
description: "Räknar ut totalpris.",
parameters: {
type: "object",
properties: {
amount: { type: "number" },
unit_price: { type: "number" }
},
required: ["amount", "unit_price"]
}
}
},
{
type: "function",
function: {
name: "generate_image",
description: "Genererar en bild baserat på en prompt.",
parameters: {
type: "object",
properties: {
prompt: { type: "string" }
},
required: ["prompt"]
}
}
}
];

// ==== KUNSKAPSDATABAS: LADDNING OCH INDEXERING
const loadKnowledgeBase = () => {
console.log('Laddar kunskapsdatabas...\n');

let files = [];
try {
files = fs.readdirSync(KNOWLEDGE_PATH);
} catch (err) {
console.error(`[FATAL FILE ERROR] Kunde inte läsa: ${KNOWLEDGE_PATH}`);
console.error(`Fel: ${err.message}`);
process.exit(1);
}

let tempChunks = [];
let officeCount = 0;
let basfaktaCount = 0;
knownCities = [];
cityOffices = {};
officePrices = {};

// ==== 1. ITERERA OCH PARSA FILER
files.forEach(file => {
const filePath = path.join(KNOWLEDGE_PATH, file);
try {
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

if (file === 'basfakta_nollutrymme.json') {
console.log(`Basfakta: ${file} (Kritiska Svar)`);
if (data.critical_answers) {
criticalAnswers = data.critical_answers;
console.log(`  Laddade ${criticalAnswers.length} kritiska svar.`);
}
}

else if (file.startsWith('basfakta_')) {
basfaktaCount++;
console.log(`Basfakta: ${file}`);
if (data.sections) {
data.sections.forEach((section, idx) => {
const chunk = {
id: `${file}_${idx}`,
title: section.title,
text: section.answer || section.content || '',
keywords: section.keywords || [],
type: 'basfakta',
source: file
};
tempChunks.push(chunk);
});
}
}

else if (data.city && data.prices) {

const cityKey = data.city.toLowerCase();

if (!officeData[cityKey]) {
officeData[cityKey] = [];
}
officeData[cityKey].push(data);

if (!officeContactData[cityKey]) {
officeContactData[cityKey] = data; 
}
officeContactData[data.id.toLowerCase()] = data;

officeCount++;

const officeName = data.area ? `${data.city} - ${data.area}` : data.city;

if (data.city && data.area) {
knownAreas[data.area.toLowerCase()] = data.city;
}
console.log(`Kontor: ${officeName}`);

if (!knownCities.includes(data.city)) knownCities.push(data.city);
if (!cityOffices[data.city]) cityOffices[data.city] = [];
cityOffices[data.city].push(officeName);

const priceData = {
AM: null,
BIL: null,
MC: null,
LASTBIL: null,
INTRO: null
};

const bookingLinks = data.booking_links || null;

data.prices.forEach(price => {
let vehicle = extractVehicle(price.service_name);

if (!vehicle && /(mc|motorcykel|a1|a2|a-körkort)/i.test(price.service_name)) {
vehicle = "MC";
}

let linkKey = vehicle;
if (linkKey === 'BIL') linkKey = 'CAR';

const bookingUrl = (bookingLinks && linkKey) ? bookingLinks[linkKey] : null;

if (vehicle) {
if (!priceData[vehicle]) priceData[vehicle] = price.price;

const priceChunk = {
id: `${file}_price_${vehicle}_${price.service_name.replace(/\s+/g, '_')}`,
title: `${price.service_name} i ${officeName}`,
text: `${price.service_name} kostar ${price.price} SEK i ${officeName}.`,
city: data.city,
area: data.area || null,
office: officeName,
vehicle: vehicle,
price: price.price,
service_name: price.service_name,
booking_url: bookingUrl,
booking_links: bookingLinks,
keywords: [
...(price.keywords || []),
data.city,
vehicle,
'pris',
'kostnad',
`${price.price}`,
officeName,
...(data.area ? [data.area] : [])
],
type: 'price',
source: file
};

tempChunks.push(priceChunk);
}
});

const kontorDoc = {
id: `kontor_${file}`,
title: `Kontor i ${data.city} - ${data.area || 'generellt'}`,
text: `Kontor i ${data.city} ${data.area || ''}.`,
city: data.city,
area: data.area || null,
office: officeName,
booking_links: bookingLinks,
type: 'kontor_info',
source: file
};
tempChunks.push(kontorDoc);
officePrices[officeName] = priceData;

if (data.sections) {
data.sections.forEach((section, idx) => {
const chunk = {
id: `${file}_section_${idx}`,
title: section.title,
text: section.answer || section.content || '',
city: data.city,
area: data.area || null,
office: officeName,
booking_links: bookingLinks,
keywords: section.keywords || [],
type: 'office_info',
source: file
};
tempChunks.push(chunk);
});
}
}
} catch (err) {
console.error(`[FEL] Kunde inte läsa eller parsa fil: ${filePath}`, err.message);
}
});
allChunks = [...tempChunks];

// Mini-helper för extractVehicle (endast för loadKnowledgeBase)
function extractVehicle(text) {
const lower = (text || "").toLowerCase();
if (/(^|\b)(am|moped|moppe)\b/.test(lower)) return "AM";
if (/(^|\b)(b96|be|släp)\b/.test(lower)) return "SLÄP";
if (/(^|\b)(bil|personbil)\b/.test(lower)) return "BIL";
if (/(^|\b)(mc|a1|a2|motorcykel|motorcyklar)\b/.test(lower)) return "MC";
if (/(^|\b)(lastbil|c1|c|ce|ykb)\b/.test(lower)) return "LASTBIL";
if (/(^|\b)(introduktion|handledarkurs|handledare|handledarutbildning)\b/.test(lower)) return "INTRO";
return null;
}

// ==== 2. VERIFIERING OCH KONSOLLOGGNING
console.log('\nVERIFIERING AV CHUNKS:');
const typeCount = {};
const cityCount = {};
allChunks.forEach(chunk => {
typeCount[chunk.type] = (typeCount[chunk.type] || 0) + 1;
if (chunk.city) cityCount[chunk.city] = (cityCount[chunk.city] || 0) + 1;
});

console.log('Typ av chunks:');
Object.entries(typeCount)
.sort((a, b) => b[1] - a[1])
.forEach(([type, count]) => {
console.log(`  ${type}: ${count}`);
});

console.log('\nStäder med chunks:');
Object.entries(cityCount)
.sort((a, b) => b[1] - a[1])
.forEach(([city, count]) => {
console.log(`  ${city}: ${count}`);
});

// --- 3. MINISEARCH INDEXERING
if (miniSearch) {
try {
miniSearch.removeAll();
console.log('[MINISEARCH] Rensade gamla chunks');
} catch (e) {
console.log('[MINISEARCH] Skapar ny instans');
}
}

miniSearch = new MiniSearch({
fields: ['title', 'text', 'city', 'area', 'office', 'keywords', 'vehicle'],
storeFields: ['title', 'text', 'city', 'area', 'office', 'vehicle', 'type', 'price', 'id', 'booking_url', 'booking_links'],
searchOptions: {
prefix: true,
fuzzy: 0.2,
boost: {
keywords: 6,
office: 5,
city: 4,
area: 3,
vehicle: 2,
title: 3,
text: 1
}
}
});

miniSearch.addAll(allChunks);
console.log('MiniSearch indexering klar');

// === Bygg chunkMap korrekt efter indexering
rebuildChunkMap();
console.log('[CHUNKMAP] Klar efter loadKnowledgeBase\n');

// === INITIERA INTENT ENGINE
try {

// Vi skickar in de dynamiskt laddade listorna från servern
intentEngine = new IntentEngine(knownCities, CITY_ALIASES, VEHICLE_MAP, knownAreas);
console.log('[IntentEngine] ✅ Motor initierad.');

} catch (e) {
console.error('[FATAL] Kunde inte initiera IntentEngine:', e.message);
process.exit(1);
}
};
loadKnowledgeBase();

// ==== APP.POST SEARCH ALL // ==== 
app.post('/search_all', async (req, res) => {

// ==== SÄKERHETSKONTROLL
const clientKey = req.headers['x-api-key'];
if (clientKey !== CLIENT_API_KEY) {
console.log(`[SÄKERHET] Obehörig åtkomst! Förväntat: ${CLIENT_API_KEY}, Fick: ${clientKey}`);
return res.status(401).json({
error: 'Ogiltig API-nyckel'
});
}

const isFirstMessage = req.body.isFirstMessage || false;
let queries = [];

if (Array.isArray(req.body.queries) && req.body.queries.length > 0) {
queries = req.body.queries;
} else if (req.body.query) {
queries = [req.body.query];
} else if (req.body.question) {
queries = [req.body.question];
} else {
return res.status(400).json({ error: 'Query saknas' });
}

const query = queries[0] || "";

if (!query.trim()) {
return res.status(400).json({ error: 'Tom fråga mottagen' });
}

const queryLower = (query || '').toLowerCase();
let forceHighConfidence = false;

function qHas(...terms) {
return terms.some(t => queryLower.includes(t));
}

function qReg(re) {
return re.test(queryLower);
}

function qHasWordVariants(base) {
const re = new RegExp(`\\b${base}(er)?\\b`, 'i');
return re.test(queryLower);
}

let sessionId = null;
try {

console.log(`[${req.id}] [SEARCH] "${query}"`);

// ==== SÖKINITIERING OCH DETEKTERING AV STAD/FORNDON

// --- 2. NLU-ANALYS (Deterministisk - STEG 1)
if (!intentEngine) {
console.error("[FATAL] IntentEngine är inte initierad!");
return res.status(500).json({ error: "Internt serverfel: NLU-motorn är offline." });
}

// === SESSION-HANTERING
let sessionId = req.body.sessionId || null;
let session;

if (!sessionId || !sessions.has(sessionId)) {
sessionId = generateSessionId();
session = createEmptySession(sessionId);
console.log(`[SESSION] Ny: ${sessionId}`);
} else {
session = sessions.get(sessionId);
console.log(`[SESSION] Befintlig: ${sessionId}`);
}

// Spara user message
appendToSession(sessionId, 'user', query);

// === ANVÄND SESSION CONTEXT
const contextPayload = {
savedCity: session.locked_context.city,
savedArea: session.locked_context.area,
savedVehicle: session.locked_context.vehicle
};

const nluResult = intentEngine.parseIntent(query, contextPayload);
const queryLower = (query || '').toLowerCase();

console.log(`[IntentEngine] Resultat: Intent=${nluResult.intent}, Fordon=${nluResult.slots?.vehicle || 'null'}, Stad=${nluResult.slots?.city || 'null'}`);

// Tvinga 'weather' intent om den missade
if (nluResult.intent !== 'weather' && query.toLowerCase().includes('väder')) {
nluResult.intent = 'weather';
nluResult.confidence = 0.95;
console.log("[IntentEngine] ⚠️ Överskrev intent till 'weather' (Force-fix Kiruna).");
}

// ===== KONTEXTLÅSNING
const savedContext = {
savedCity: session.locked_context.city,
savedArea: session.locked_context.area,
savedVehicle: session.locked_context.vehicle
};

const explicitContext = { 
// Tvinga fram det sparade värdet om NLU är tyst (null/undefined)
explicitCity: nluResult.slots.city || savedContext.savedCity,
explicitArea: nluResult.slots.area,
explicitVehicle: nluResult.slots.vehicle 
};

const lockedContext = contextLock.resolveContext(savedContext, explicitContext);

console.log('\n[CONTEXT DEBUG] ╔═══════════════════════════════════╗');
console.log('[NLU INPUT] Saved:', {
city: session.locked_context.city,
area: session.locked_context.area,
vehicle: session.locked_context.vehicle
});
console.log('[NLU OUTPUT] Explicit:', {
city: nluResult.slots.city,
area: nluResult.slots.area,
vehicle: nluResult.slots.vehicle,
intent: nluResult.intent
});
console.log('[ContextLock] LÅST:', {
city: lockedContext.city,
area: lockedContext.area,
vehicle: lockedContext.vehicle
});
console.log('[CONTEXT DEBUG] ╚═══════════════════════════════════╝\n');

const detectedCity = lockedContext.city;
const detectedArea = lockedContext.area;
const detectedVehicleType = lockedContext.vehicle;
const lockedCity = lockedContext.city;
const lockedVehicle = lockedContext.vehicle;

// SPARA CONTEXT DIREKT (inte efter mode-klassificering)
session.locked_context.city = lockedContext.city;
session.locked_context.area = lockedContext.area;
session.locked_context.vehicle = lockedContext.vehicle;

// SPARA isFirstMessage för RAG-användning
const wasFirstMessage = session.isFirstMessage;
session.isFirstMessage = false;

// ==== INTELLIGENT KLASSIFICERING – CHAT / RAG?
const toolsKeywords = ["väder", "skämt", "citat", "bild", "rita", "generera", "vits"];
const ragBlockers = ["köra", "körkort", "lektion", "kurs", "am", "mc", "risk", "handledare", "avboka", "pris", "telefon", "kontakt", "adress", "öppettider", "mail", "mejl"];

// HÖG PRIO: Väder/skämt/citat ALLTID till chat (även om RAG-ord finns)
const isToolQuery = toolsKeywords.some(kw => queryLower.includes(kw));
let forcedMode = null;

// === HÖGSTA PRIO: tool-queries (väder/skämt)
if (!forcedMode && isToolQuery) {
// Specialfall: "Väder att köra motorcykel i" = fortfarande tool-query
const hasStrongRAGIntent = /kostar|pris|boka|paket|kurs(?!.*väder)|lektion(?!.*väder)/.test(queryLower);

if (!hasStrongRAGIntent) {
console.log("[MODE FORCE] tool-query (väder/skämt/citat) → Tvingar CHAT mode");
forcedMode = 'chat';
}
}

// === REGEL 1: CONTEXT INHERITANCE (Prisfråga + Område)
if (!forcedMode && 
session.locked_context.vehicle && 
session.locked_context.city &&
nluResult.slots.area && 
nluResult.intent === 'unknown') {

const lastUserMsg = session.messages
.filter(m => m.role === 'user')
.slice(-2, -1)[0];

if (lastUserMsg && /pris|kostar|kostnad/i.test(lastUserMsg.content)) {
console.log('[CONTEXT INHERITANCE] Användaren specificerar område efter prisfråga → Tvingar KNOWLEDGE mode');
forcedMode = 'knowledge';
nluResult.intent = 'price_lookup';
}
}

// === REGEL 2: FORCING-LOGIK
if (!forcedMode && nluResult && nluResult.intent === 'contact_info') {
console.log("[MODE FORCE] contact_info detected → Tvingar KNOWLEDGE mode");
forcedMode = 'knowledge';
}
else if (!forcedMode && nluResult && nluResult.intent === 'price_lookup') {
console.log("[MODE FORCE] price_lookup detected → Tvingar KNOWLEDGE mode");
forcedMode = 'knowledge';
}
else if (!forcedMode && isToolQuery && ragBlockers.some(kw => queryLower.includes(kw))) {
console.log("[MODE FORCE] Tool-keyword + RAG-term Krock → Tvingar KNOWLEDGE mode");
forcedMode = 'knowledge';
}
else if (!forcedMode && isToolQuery) {
console.log(`[MODE FORCE] Tool-keyword upptäckt → Tvingar CHAT mode`);
forcedMode = 'chat';
}
else if (!forcedMode && (queryLower.includes('har') || queryLower.includes('finns')) && (nluResult.slots.city || nluResult.slots.area)) {
console.log(`[MODE FORCE] 'Har/Finns' + Plats -> Tvingar KNOWLEDGE mode`);
forcedMode = 'knowledge';
}

// === REGEL 3: GPT-KLASSIFICERING
if (forcedMode) {
mode = forcedMode;
console.log(`[KLASSIFICERING SKIPPAD] → Använder forcerat ${mode.toUpperCase()} mode`);
} else {
try {
const classify = await openai.chat.completions.create({
model: "gpt-4o-mini",
messages: [
{ role: "system", content: "Svara ENDAST med 'knowledge' eller 'chat'. 'knowledge' = frågan handlar om körkort, priser, kurser, trafikskola, kontaktuppgifter eller företagets tjänster. 'chat' = allt annat (väder, skämt, allmänt prato). Om osäker → 'knowledge'." },
{ role: "user", content: query }
],
max_tokens: 10,
temperature: 0
}, { timeout: 15000 });

const classificationContent = classify.choices?.[0]?.message?.content || "knowledge";
mode = classificationContent.trim().toLowerCase();
if (mode !== 'chat' && mode !== 'knowledge') mode = 'knowledge';
console.log(`[KLASSIFICERING] → ${mode.toUpperCase()} mode`);

} catch (e) {
console.error("[KLASSIFICERING FEL] → fallback till knowledge", e.message);
mode = 'knowledge';
}
}

// === EXTRA FORCE LOGIK (Efter klassificering)
if (nluResult.intent === 'weather') {

    // Väder-frågor ska ALLTID gå till chat-mode → tool-call
mode = 'chat';
console.log("[EXTRA FORCE] Väder-fråga detekterad → tvingar chat-mode (tool-call)");
} 
else if (mode !== 'chat') {

    // Alla andra fall – behåll dina gamla säkerhetsregler
if (nluResult && nluResult.intent === 'contact_info') {
mode = 'knowledge';
console.log("[EXTRA FORCE] contact_info → tvingar knowledge-mode");
}

if (nluResult &&
(nluResult.slots && (nluResult.slots.area || nluResult.slots.service)) ||
(nluResult.intent !== 'unknown' && nluResult.intent !== 'intent_info')) {
mode = 'knowledge';
console.log("[EXTRA FORCE] Har slots eller känd intent → tvingar knowledge-mode");
}

if ((queryLower.includes('har') || queryLower.includes('finns')) &&
(nluResult.slots && (nluResult.slots.city || nluResult.slots.area))) {
mode = 'knowledge';
console.log("[EXTRA FORCE] 'har/finns' + plats → tvingar knowledge-mode");
}
}

// ==== RAG: SÖKNING OCH POÄNGSÄTTNING AV DATA

// ==== 8. SEARCH EXECUTION (MiniSearch + Query Expansion)
let searchQuery = query;
if (detectedArea && !query.toLowerCase().includes(detectedArea.toLowerCase())) {
searchQuery = `${query} ${detectedArea}`;
} else if (detectedCity && !query.toLowerCase().includes(detectedCity.toLowerCase()) && !detectedArea) {
searchQuery = `${query} ${detectedCity}`;
}

const expandedQuery = normalizedExpandQuery(searchQuery);
const allResults = miniSearch.search(expandedQuery, {
fuzzy: 0.2,
prefix: true,
boost: {
keywords: 6,
office: 5,
city: 4,
area: 3,
vehicle: 2,
title: 3,
text: 1
}
});
console.log(`[SEARCH] "${searchQuery}" -> ${allResults.length} träffar`);

// ==== 9. FÖRSTA FILTRERING + FALLBACK-CHUNKS
let selectedChunks = allResults
.sort((a, b) => (b.score || 0) - (a.score || 0))
.slice(0, 25);
if (selectedChunks.length < 15) {

const extra = allChunks
.filter(c => !selectedChunks.map(s => s.id).includes(c.id))
.slice(0, 15 - selectedChunks.length);
selectedChunks = selectedChunks.concat(extra);
}
console.log(`[RAG] Använder ${selectedChunks.length} chunks (min 15)`);

// ==== OMPOÄNGSÄTTNING OCH RANKING
let uniqueResults = Array.from(new Map(allResults.map(item => [item.id, item])).values());
uniqueResults = uniqueResults.map(result => {

const fullChunk = allChunks.find(c => c.id === result.id);
if (fullChunk) {
let finalScore = result.score;

// 1. AREA BOOST: Prioritera exakt område
if (detectedArea && fullChunk.area === detectedArea) {
finalScore += 600;
console.log(`[AREA BOOST] +600 för ${fullChunk.title} (${detectedArea})`);
}
// 2. CITY BOOST: Prioritera stad (om inget område är specifikt)
else if (detectedCity && fullChunk.city === detectedCity && !detectedArea) {
finalScore += 200;
console.log(`[CITY BOOST] +200 för ${fullChunk.title} (${detectedCity})`);
}

// 3. VEHICLE BOOST: Massiv boost för rätt fordon (slår generisk Basfakta)
if (detectedVehicleType && fullChunk.vehicle === detectedVehicleType) {
finalScore += 6000;
console.log(`[VEHICLE BOOST] +6000 för ${fullChunk.title} (${detectedVehicleType})`);
}

// 4. PERFECT MATCH: Stad + Fordon + Pris (Garanterar att denna vinner över allt)
if (detectedCity && detectedVehicleType &&
fullChunk.city === detectedCity &&
fullChunk.vehicle === detectedVehicleType &&
fullChunk.type === 'price') {
finalScore += 2000000;
console.log(`[PERFECT MATCH] +200000 för ${fullChunk.title} (Lokal Pris!)`);
}
return {...result,
score: finalScore,
type: fullChunk.type,
keywords: fullChunk.keywords ?? [],
text: fullChunk.text
};
}

return { ...result,
score: result.score,
type: result.type,
keywords: result.keywords ?? [],
text: result.text
};
});

uniqueResults.sort((a, b) => b.score - a.score);

// === CONTACT_INFO BOOST
if (nluResult.intent === "contact_info" && (lockedCity || detectedArea)) {
uniqueResults = uniqueResults.map(r => {
const fullChunk = allChunks.find(c => c.id === r.id);
if (!fullChunk) return r;

// KONTROLLERA OMRÅDE
if (detectedArea && fullChunk.area && 
fullChunk.area.toLowerCase() !== detectedArea.toLowerCase()) {
return r;
}

// SUPER-DUPER BOOST för office_info chunks
if (fullChunk.type === 'office_info' && 
fullChunk.city && lockedCity &&
fullChunk.city.toLowerCase() === lockedCity.toLowerCase()) {

if (detectedArea && fullChunk.area && 
fullChunk.area.toLowerCase() === detectedArea.toLowerCase()) {
return { 
...r, 
score: r.score + 100000,  // ✅ +100000 (högre än pris)
match: { ...(r.match || {}), contactBoost: true, level: 'area_office_info' }
};
}

if (!detectedArea) {
return { ...r, score: r.score + 90000 };
}
}

// Rätt kontorsfil (andra typer, t.ex. kontor_info)
if (fullChunk.city && lockedCity && 
fullChunk.city.toLowerCase() === lockedCity.toLowerCase() &&
!fullChunk.source.includes("basfakta_")) {

if (detectedArea && fullChunk.area && 
fullChunk.area.toLowerCase() === detectedArea.toLowerCase()) {
return { ...r, score: r.score + 60000 };
}

if (!detectedArea) {
return { ...r, score: r.score + 50000 };
}
}

// Basfakta STRAFF
if (fullChunk.source.includes("basfakta_")) {
return { ...r, score: r.score - 20000 };
}

return r;
});

// Sortera igen efter boost
uniqueResults.sort((a, b) => b.score - a.score);
}

// ==== 11. FORCE-ADD-FÖRBEREDELSE
let topResults = uniqueResults;
let mustAddChunks = [];

// Filtrera bort pris-chunks vid kontaktfrågor
if (nluResult.intent === "contact_info") {
console.log('[CONTACT FIX] Filtrerar chunks för kontaktfråga...');

// Separera chunks efter typ
const officeInfoChunks = topResults.filter(r => {
const fullChunk = allChunks.find(c => c.id === r.id);
return fullChunk && fullChunk.type === 'office_info';
});

const kontorInfoChunks = topResults.filter(r => {
const fullChunk = allChunks.find(c => c.id === r.id);
return fullChunk && fullChunk.type === 'kontor_info';
});

const basfaktaChunks = topResults.filter(r => {
const fullChunk = allChunks.find(c => c.id === r.id);
return fullChunk && fullChunk.type === 'basfakta' && 
fullChunk.source.includes('basfakta_om_foretaget');
});

// Om vi har office_info, använd BARA dessa + max 3 andra (INTE priser)
if (officeInfoChunks.length > 0) {
const otherChunks = topResults
.filter(r => {
const fullChunk = allChunks.find(c => c.id === r.id);
return fullChunk && 
fullChunk.type !== 'office_info' && 
fullChunk.type !== 'kontor_info' &&
fullChunk.type !== 'price';
})
.slice(0, 3);

topResults = [...officeInfoChunks, ...kontorInfoChunks, ...basfaktaChunks, ...otherChunks];
console.log(`[CONTACT FIX] Använde ${officeInfoChunks.length} office_info + ${kontorInfoChunks.length} kontor_info + ${basfaktaChunks.length} basfakta + ${otherChunks.length} andra`);
} else {
// Fallback: Om ingen office_info, använd basfakta om företaget
topResults = [...kontorInfoChunks, ...basfaktaChunks];
console.log(`[CONTACT FIX] Ingen office_info hittades, använder ${kontorInfoChunks.length} kontor_info + ${basfaktaChunks.length} basfakta`);
}
}

// ==== FORCE-ADD ENGINE (STEG 1 Integration)
const forceAddEngine = new ForceAddEngine(allChunks);
const forceAddResult = forceAddEngine.execute(queryLower, nluResult, lockedCity);

mustAddChunks.push(...forceAddResult.mustAddChunks);
if (forceAddResult.forceHighConfidence) {
forceHighConfidence = true;
}

console.log(`[ForceAddEngine] Integration klar. ${forceAddResult.mustAddChunks.length} chunks tillagda.`);

// EMERGENCY FALLBACK (efter forceAddEngine)
if (Array.isArray(criticalAnswers) && forceAddResult.mustAddChunks.length === 0) {
for (const entry of criticalAnswers) {
const matches = entry.match_keywords.some(kw => queryLower.includes(kw));
if (matches) {
const timeGreeting = wasFirstMessage ? "God morgon! " : "";
console.log(`[EMERGENCY FALLBACK] Aktiv. Match på ID: ${entry.id}.`);

// Spara assistant svar
appendToSession(sessionId, 'assistant', timeGreeting + entry.answer);

return res.json({
sessionId: sessionId,
answer: timeGreeting + entry.answer,
emergency_mode: true,
context: [],
locked_context: {
city: lockedContext.city,
area: lockedContext.area,
vehicle: lockedContext.vehicle
},
debug: {
nlu: nluResult,
fallback_id: entry.id 
}
});
}
}
}

// ==== FINAL KONTEXT BOOSTAR & KONTORSINJEKTION

// --- 24. ALL BASFAKTA FINAL SCORE BOOST
const allBasfakta = mustAddChunks.filter(c => isBasfaktaType(c));
allBasfakta.forEach(c => c.score *= 1.8); // Boost alla basfakta
mustAddChunks = [...allBasfakta, ...mustAddChunks.filter(c => !isBasfaktaType(c))]; // Basfakta först

// --- 25. KONTORSFILER (City/Area-specifika Force-Add)
if (detectedCity || detectedArea) {
console.log(`[🏢 KONTORS FORCE-ADD] Detected: City="${detectedCity}", Area="${detectedArea}"`);
const officeChunks = allChunks.filter(c => {
const isOfficeFile = c.source && !c.source.includes('basfakta_');

if (!isOfficeFile) return false;
const matchesCity = c.city && detectedCity &&
c.city.toLowerCase() === detectedCity.toLowerCase();
const matchesArea = detectedArea ?
(c.area && c.area.toLowerCase() === detectedArea.toLowerCase()) :
true; // Om inget område anges, ta alla från staden
return matchesCity && matchesArea;
});

const withBooking = officeChunks.filter(c =>
c.text?.toLowerCase().includes('boka här') ||
c.text?.toLowerCase().includes('boka') ||
(c.keywords || []).some(k => k.toLowerCase().includes('boka'))
);

const withoutBooking = officeChunks.filter(c => !withBooking.includes(c));
mustAddChunks.push(...withBooking);
mustAddChunks.push(...withoutBooking.slice(0, 3));
console.log(`[🏢 KONTORS FORCE-ADD] ✅ Added ${withBooking.length} chunks WITH booking`);
console.log(`[🏢 KONTORS FORCE-ADD] ℹ️  Added ${Math.min(3, withoutBooking.length)} chunks WITHOUT booking`);
console.log(`[🏢 KONTORS FORCE-ADD] Total office chunks: ${officeChunks.length} available\n`);
}
// ==== SLUTLIG RESULTATHANTERING OCH MERGE

// --- 26. OMSORTERING EFTER STAD/OMRÅDE (Prioritera lokala träffar)
if (detectedArea && detectedCity) {
const areaResults = uniqueResults.filter(r =>
r.area && r.area.toLowerCase() === detectedArea.toLowerCase() && r.city === detectedCity
);
const cityResults = uniqueResults.filter(r =>
r.city === detectedCity && (!r.area || r.area.toLowerCase() !== detectedArea.toLowerCase())
);
const otherResults = uniqueResults.filter(r => r.city !== detectedCity);
topResults = [...areaResults, ...cityResults, ...otherResults];
} else if (detectedCity) {
const cityResults = uniqueResults.filter(r => r.city === detectedCity);
const otherResults = uniqueResults.filter(r => r.city !== detectedCity);
topResults = [...cityResults, ...otherResults];
}

// --- 27. MERGE AV FORCE-ADDS OCH SLUTLIG TRIMMING
const topResultsMap = new Map(topResults.map(r => [r.id, r]));

// Använd den fordonstyp som detekterades tidigt i flödet, t.ex. 'MC', 'AM' eller 'BIL'.
const requiredVehicle = detectedVehicleType;

mustAddChunks.forEach(chunk => {
//let forcedScore = 9999; // Standard tvingad poäng (för de flesta Basfakta och icke-matchande priser)
let forcedScore = chunk.score || 0;

// EXTRABOOST: Högsta prioritet (10000) om chunken är fordonsspecifik OCH matchar frågans fordonstyp.
// Detta fångar den lokala prischunken (från kontorsfilen) och driver den till toppen.
if (requiredVehicle && chunk.vehicle && chunk.vehicle.toUpperCase() === requiredVehicle.toUpperCase()) {
forcedScore = 10000;
console.log(`[FORCE BOOST] Högsta prio 10000 för matchande mustAdd-chunk (${requiredVehicle})`);

} else if (chunk.score && chunk.score > 0) {
// Om chunken redan har en exceptionellt hög poäng från tidigare steg (t.ex. steg 22)
// behålls den poängen som bas, annars används standard 9999.
forcedScore = chunk.score;
} else {
// Alla andra generella Basfakta-chunks och kontorschunks som inte matchade fordonet
forcedScore = 9999;
}

// Skapa ett nytt objekt med den dynamiska poängen
const forcedChunk = {
id: chunk.id,
title: chunk.title,
text: chunk.text,
score: forcedScore, // Använd den dynamiska poängen
type: chunk.type,
city: chunk.city,
area: chunk.area,
office: chunk.office,
vehicle: chunk.vehicle,
price: chunk.price,
keywords: chunk.keywords || [],
source: chunk.source,
booking_url: chunk.booking_url,
booking_links: chunk.booking_links,
match: { score: forcedScore }
};

// Lägg till eller skriv över i mappen
topResultsMap.set(chunk.id, forcedChunk);});

// Konvertera tillbaka till array
topResults = Array.from(topResultsMap.values());

// Sortera efter den nya poängen (10000 > 9999)
topResults.sort((a, b) => b.score - a.score);

// Trimma listan till max 18 chunks
topResults = topResults.slice(0, 18).filter(r => r.score > 0);

console.log(`\n✅ MERGE COMPLETE: ${topResults.length} chunks i topResults`);

// Verifiera att booking_links finns
const withBooking = topResults.filter(r => r.booking_links);
console.log(`📊 Chunks med booking_links efter merge: ${withBooking.length}/${topResults.length}`);
console.log('\n🔍 DEBUG - CHUNKS SOM SKICKAS TILL RAG:');
console.log(`Detected City: "${detectedCity}" | Area: "${detectedArea}"`);

topResults.forEach((r, idx) => {

const hasBooking = r.text?.toLowerCase().includes('boka här') ||
r.text?.toLowerCase().includes('boka') ||
(r.keywords || []).some(k => k.toLowerCase().includes('boka'));

const isOfficeFile = r.source && !r.source.includes('basfakta_');
console.log(`${idx + 1}. [${r.type}] ${r.title.slice(0, 40)}... | Score: ${r.score.toFixed(2)} | Office: ${isOfficeFile ? '✅' : '❌'} | Booking: ${hasBooking ? '✅' : '❌'}`);
});

console.log('='.repeat(70) + '\n');

// HÖGKONFIDENS-SKYDDET (För policyfrågor m.fl. som tvingar in chunks)
if (!forceHighConfidence) {

const hasBasfakta = topResults.some(r => isBasfaktaType(r));
const bestScore = topResults[0]?.score || 0;

// LOW_CONFIDENCE-kontrollen: Förhindrar att svara om det är för vagt OCH ingen Basfakta.
if (!hasBasfakta && bestScore < LOW_CONFIDENCE_THRESHOLD) {
console.log('[LOW_CONFIDENCE] Ingen basfakta + låg score → fråga om mer info');
const clarification = `För att ge ett korrekt svar behöver jag lite mer info — vilken stad eller vilket kontor menar du, eller vilken exakt tjänst (t.ex. 'Risk 1', 'MC paket', 'introduktionskurs')?`;
return res.json({
answer: clarification,
context: [],
debug: {
low_confidence: true,
best_score: bestScore
}
});
}
}

// === STRIKT STADSFILTRERING (Löser Göteborg->Stockholm-buggen)
if (lockedCity) {
const originalCount = topResults.length;
topResults = topResults.filter(chunk => {

    // Om chunk har en stad, MÅSTE den staden matcha lockedCity.
const chunkCity = (chunk.city || '').toString().toLowerCase();

// Behåll chunken om:
// 1) Ingen stad är angiven (t.ex. en global policy-chunk) ELLER
// 2) Staden på chunken matchar den låsta staden.
return chunkCity === '' || chunkCity === lockedCity.toLowerCase();
});
console.log(`[RAG-FILTER] Filtrerat bort ${originalCount - topResults.length} chunks som inte matchade låst stad: ${lockedCity}`);
}

let filteredResults = topResults;

if (detectedVehicleType) {
const originalCount = topResults.length;

filteredResults = topResults.filter(chunk => {
const noVehicle = !chunk.vehicle;
const matchesVehicle = chunk.vehicle === detectedVehicleType;
const isGeneral = chunk.type === 'basfakta' || chunk.type === 'office_info';

// Om ForceAdd har satt en score över 9999, ignorera fordonsfiltret.
const isForceAdded = (chunk.score || 0) >= 9999; 
if (isForceAdded) {
return true; 
}

return noVehicle || matchesVehicle || isGeneral;
});

console.log(`[VEHICLE FILTER] ${detectedVehicleType}: ${filteredResults.length}/${originalCount} chunks (tog bort ${originalCount - filteredResults.length} fel fordonstyp)`);

if (filteredResults.length < 3 && originalCount >= 3) {
console.log('[VEHICLE FILTER] För få chunks kvar, använder originalResults');
filteredResults = topResults;
}
}

// === SMART CONTEXT BUILDER MED TOKEN-LIMIT
const MAX_CONTEXT_TOKENS = 3000; // ~2400 ord
let contextTokens = 0;
const contextParts = [];

for (const r of filteredResults) {

// Trygg fallback om chunkMap inte finns eller inte är en Map — använd allChunks som fallback
const chunk =
(typeof chunkMap !== 'undefined' &&
chunkMap &&
typeof chunkMap.get === 'function')
? chunkMap.get(r.id)
: allChunks.find(c => c.id === r.id);

if (!chunk) continue;

let text = `${r.title}: ${chunk.text || ''}`;
if (chunk.price) text += ` - ${chunk.price} SEK`;

// Uppskatta tokens (1 token ≈ 4 tecken för svenska)
const estimatedTokens = Math.ceil(text.length / 4);

if (contextTokens + estimatedTokens > MAX_CONTEXT_TOKENS) {
console.log(`[CONTEXT] Stoppade vid ${contextParts.length} chunks (${contextTokens} tokens)`);
break; // Stoppa om vi når limit
}

contextParts.push(text);
contextTokens += estimatedTokens;
}

const retrievedContext = contextParts.join('\n\n');
console.log(`[CONTEXT] Skickar ${contextTokens} tokens till RAG`);

// ==== GENERATE ANSWER
let finalAnswer;

const ragResult = await generate_rag_answer(
query,
retrievedContext,
detectedCity,
detectedArea,
wasFirstMessage,
mode
);

if (ragResult.type === 'answer') {
finalAnswer = ragResult.answer;
} else if (ragResult.type === 'tool_request') {
console.log('[CHAT MODE] Kör LLM med tools...');
try {

// 1. Initialt anrop
const initial = await openai.chat.completions.create({
model: ragResult.model,
messages: ragResult.messages,
tools: ragResult.tools,
max_tokens: ragResult.max_tokens,
temperature: ragResult.temperature
}, { timeout: 30000 });

const msg = initial.choices?.[0]?.message;

// 2. Om inga tool_calls
if (!msg?.tool_calls || msg.tool_calls.length === 0) {
finalAnswer = msg?.content?.trim() || 'Jag kunde inte formulera ett svar.';
console.log('[CHAT MODE] Svar utan tools ✅');
} else {

// 3. Kör tools
console.log(`[TOOLS] ${msg.tool_calls.length} tool(s) anropas...`);
const toolResults = [];

for (const call of msg.tool_calls) {
let args = {};
try {
args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
} catch (e) {
console.error(`[TOOL] Kunde inte parse args för ${call.function?.name}: ${e.message}`);
args = {};
}

console.log(`[TOOL CALL] ${call.function?.name}(${JSON.stringify(args)})`);

let result;
try {
switch (call.function?.name) {
case "get_weather":
result = await fetchWeather(args.city);
break;
case "get_joke":
result = await get_joke();
break;
case "get_quote":
result = await get_quote();
break;
case "calculate_price":
result = await calculate_price(args.amount, args.unit_price);
break;
case "generate_image":
result = await generate_image(args.prompt);
break;
default:
result = { error: `Okänt verktyg: ${call.function?.name}` };
}
} catch (toolError) {
console.error(`[TOOL ERROR] ${call.function?.name}:`, toolError.message);
result = { error: `Kunde inte köra ${call.function?.name}` };
}

toolResults.push({
role: "tool",
tool_call_id: call.id,
content: JSON.stringify(result)
});
}

// 4. Andra LLM-anropet (TOOL)
console.log('[CHAT MODE] Kör andra LLM-anrop med tool-resultat...');
const final = await openai.chat.completions.create({
model: ragResult.model,
messages: [
...ragResult.messages,
msg,
...toolResults
],
max_tokens: 600,
temperature: 0.7
}, { timeout: 30000 });

finalAnswer = final?.choices?.[0]?.message?.content?.trim() || 'Tekniskt fel.';
console.log('[CHAT MODE] Svar genererat med tools ✅');
}
} catch (chatError) {
console.error('[CHAT MODE ERROR]', chatError.message);
finalAnswer = 'Något gick fel i chat-läget. Försök igen.';
}
}

// === BOKNINGSLÄNKAR – KONTOR > FALLBACK (MARKDOWN HYPERLÄNKAR)
const GENERAL_FALLBACK_LINKS = {
'AM': { type: 'info', text: 'Boka din AM-kurs via vår hemsida här', linkText: 'här', url: 'https://mydrivingacademy.com/two-wheels/ta-am-korkort/' },
'MC': { type: 'info', text: 'För mer MC-information, kolla vår hemsida', linkText: 'hemsida', url: 'https://mydrivingacademy.com/two-wheels/home/' },
'BIL': { type: 'info', text: 'För mer information om bilkörkort, kolla vår hemsida', linkText: 'hemsida', url: 'https://mydrivingacademy.com/kom-igang/' },
'INTRO': { type: 'book', text: 'Boka Handledarkurs/Introduktionskurs här', linkText: 'här', url: 'https://mydrivingacademy.com/handledarutbildning/' },
'RISK1': { type: 'book', text: 'Boka Riskettan (Risk 1) här', linkText: 'här', url: 'https://mydrivingacademy.com/riskettan/' },
'RISK2': { type: 'book', text: 'Boka Risktvåan/Halkbana (Risk 2) här', linkText: 'här', url: 'https://mydrivingacademy.com/halkbana/' },
'TEORI': { type: 'book', text: 'Plugga körkortsteori i appen Mitt Körkort här', linkText: 'här', url: 'https://mydrivingacademy.com/app/' },
'B96/BE': { type: 'book', text: 'Boka Släpvagnsutbildning (B96/BE) här', linkText: 'här', url: 'https://mydrivingacademy.com/slapvagn/' },
'TUNG': { type: 'book', text: 'Boka utbildning för Tung Trafik (C/CE) här', linkText: 'här', url: 'https://mydrivingacademy.com/tungtrafik/' },
'POLICY': { type: 'info', text: 'Läs våra köpvillkor och policy här', linkText: 'här', url: 'https://mydrivingacademy.com/privacy-policy/' }
};

let bookingLinkAdded = false;
let finalBookingLink = null;
let linkVehicleType = null;

// 1. Kontorsspecifik bokningslänk från booking_links (AM/MC/CAR)
const officeChunk = topResults.find(r => r.booking_links && typeof r.booking_links === 'object');
if (officeChunk && officeChunk.booking_links) {
const links = officeChunk.booking_links;
const city = officeChunk.city || 'ditt kontor';

let serviceKey = null;

// Prioritet 1: Använd detectedVehicleType från tidigare
if (detectedVehicleType) {
serviceKey = detectedVehicleType.toUpperCase();
if (serviceKey === 'BIL') serviceKey = 'CAR';
console.log(`[BOOKING LINK] Använder detectedVehicleType: ${serviceKey}`);
}
// Prioritet 2: Kolla i den URSPRUNGLIGA frågan (query)
else if (/\bam\b/.test(queryLower) || queryLower.includes('moped')) {
serviceKey = 'AM';
console.log('[BOOKING LINK] Detekterat AM från query');
}
else if (/\bmc\b/.test(queryLower) || queryLower.includes('motorcykel')) {
serviceKey = 'MC';
console.log('[BOOKING LINK] Detekterat MC från query');
}

// Prioritet 3: Kolla vilken typ av chunk som har högst score
else {
const topPriceChunk = topResults.find(r => r.type === 'price' && r.vehicle);
if (topPriceChunk && topPriceChunk.vehicle) {
serviceKey = topPriceChunk.vehicle === 'BIL' ? 'CAR' : topPriceChunk.vehicle;
console.log(`[BOOKING LINK] Använder vehicle från price chunk: ${serviceKey}`);
}
}

// Återanvänd sessionens fordonstyp innan vi gör en generisk fallback
if (!serviceKey && session.detectedVehicleType) {
const sessionVehicleKey = session.detectedVehicleType.toUpperCase();

// Kontrollera om den sparade fordonstypen har en länk i kontorsdata (links)
if (links[sessionVehicleKey]) {
serviceKey = sessionVehicleKey;
console.log(`[BOOKING LINK] Återanvänder sessionens fordonstyp: ${serviceKey}`);
}
}

// Prioritet 4: Fallback till det som finns i booking_links
if (!serviceKey) {
serviceKey = links.AM ? 'AM' : links.MC ? 'MC' : links.CAR ? 'CAR' : null;
console.log(`[BOOKING LINK] Fallback till tillgänglig länk: ${serviceKey}`);
}

console.log(`[BOOKING DEBUG] Detected serviceKey: ${serviceKey}`);

// Lägg till länk om serviceKey hittades
if (serviceKey && links[serviceKey]) {

// LAGRA URL & FORDONSTYP
finalBookingLink = links[serviceKey];
linkVehicleType = serviceKey;

// Markera att en länk har hittats (viktigt för att hoppa över fallbacks nedan)
bookingLinkAdded = true; 

console.log(`[BOOKING LINK] Kontorslänk funnen för ${serviceKey} i ${city}. Lagrad för final check.`);}}

// Fallback – bara om ingen kontorslänk
if (!bookingLinkAdded) {
let fallbackType = null;

// 1. HÖGSTA PRIO: Policy/Admin-frågor (Tvingar länk och stänger av flödet)
if (queryLower.includes('policy') ||
queryLower.includes('kundavtal') ||
queryLower.includes('villkor') ||
queryLower.includes('orgnr') ||
queryLower.includes('organisationsnummer') ||
queryLower.includes('ångerrätt') ||
queryLower.includes('återbetalning') ||
queryLower.includes('faktura')) {

const fallbackData = GENERAL_FALLBACK_LINKS['POLICY'];

if (fallbackData) {
const markdownLink = `[${fallbackData.linkText}](${fallbackData.url})`;
const fullLine = fallbackData.text.replace(fallbackData.linkText, markdownLink);

finalAnswer += `\n\n---\n\n${fullLine}`;
bookingLinkAdded = true;
console.log('[BOOKING LINK] Tvingade in POLICY-länken och satte session.linkSent');
}
}

// 2. FORTSÄTTNING: Om ingen policy-länk lades till, fortsätt med standarddetekteringen
else if (detectedVehicleType) {
fallbackType = detectedVehicleType.toUpperCase();
if (fallbackType === 'BIL') fallbackType = 'CAR';
}

else if (/\bam\b/.test(queryLower) || queryLower.includes('moped')) {
fallbackType = 'AM';
}

else if (/\bmc\b/i.test(queryLower) || queryLower.includes('motorcykel')) {
fallbackType = 'MC';
}

else if (queryLower.includes('handledar') || queryLower.includes('introduktionskurs')) {
fallbackType = 'INTRO';
}

else if (queryLower.includes('riskettan') || queryLower.includes('risk 1')) {
fallbackType = 'RISK1';
}

else if (queryLower.includes('risktvåan') || queryLower.includes('risk 2') || queryLower.includes('halkbana')) {
fallbackType = 'RISK2';
}

else if (queryLower.includes('teori') || queryLower.includes('mitt körkort') || queryLower.includes('app')) {
fallbackType = 'TEORI';
}

else if (queryLower.includes('lastbil') || /\bce\b/.test(queryLower) || /\bc\b(?![a-zåäö])/i.test(queryLower) || /\bc1\b/.test(queryLower) ||
queryLower.includes('tung trafik'))	{
fallbackType = 'TUNG';
}

else if ((queryLower.includes('lektion') || queryLower.includes('körlektion')) && !/\bmc\b/i.test(queryLower) && !queryLower.includes('motorcykel') && !queryLower.includes('duo')) {
fallbackType = 'BIL';
}

if (fallbackType) {
const fallbackData = GENERAL_FALLBACK_LINKS[fallbackType];
if (fallbackData) {

// 1. LAGRA URL & FORDONSTYP
finalBookingLink = fallbackData.url;
linkVehicleType = fallbackType;

// 2. Markera att en länk har hittats 
bookingLinkAdded = true; 
console.log(`[BOOKING LINK - FALLBACK] Generell länk funnen för ${fallbackType}. Lagrad för final check.`);
}
}
}

// 🎯 VEHICLE-SPECIFIK BOKNINGSLÄNK KONTROLL & BYPASS
if (finalBookingLink) {

// Antag att linkVehicleType har värdena 'BIL', 'MC', 'AM'
// normalisera nyckeln för att matcha kontorsfilernas struktur (CAR, MC, AM)
const vehicleKey = (linkVehicleType || 'CAR').toUpperCase().replace('BIL', 'CAR'); 

// 1. Kontrollera om användaren har bett EXPLICIT om en länk (BYPASS-LOGIK)
const isExplicitRequest = nluResult.intent === 'booking_link' ||
nluResult.intent === 'booking' ||          // NYTT – bra att ha med
nluResult.intent === 'contact_info' ||     // NYTT – bra vid "var kan jag boka?"
/bokningslänk|skicka länk|länk för (bil|mc|am|kurs)/i.test(req.body.prompt);

// 2. Kontrollera om just DENNA länk (för denna fordonstyp) redan har skickats
const linkAlreadySent = session.linksSentByVehicle[vehicleKey] === true;

// Kritiskt: Lägg till länken om den är uttryckligen begärd ELLER om länken är ny
if (isExplicitRequest || !linkAlreadySent) {

let linkText;
switch (vehicleKey) {
case 'MC':
linkText = 'Boka din MC-kurs här';
break;
case 'AM':
linkText = 'Boka din AM-kurs här';
break;
case 'CAR':
default: 
linkText = 'Boka din körlektion här';
break;
}

// Lägg till länken i det slutgiltiga svaret
finalAnswer += `\n\n✅ [${linkText}](${finalBookingLink})`;

// Uppdatera spårningen för denna specifika länk
session.linksSentByVehicle[vehicleKey] = true;

console.log(`[BOOKING LINK] Ny länk skickad: ${vehicleKey}. Explicit: ${isExplicitRequest ? 'Ja' : 'Nej'}`);
bookingLinkAdded = true; // Markera att vi har lagt till en länk
} 
}

// === SPARA ASSISTANT-SVAR
appendToSession(sessionId, 'assistant', finalAnswer);

// RETURNERA KORREKT SESSIONID + CONTEXT
res.json({
sessionId: sessionId,
answer: finalAnswer,
context: topResults.map(r => ({
title: r.title,
text: r.text.slice(0, 200),
city: r.city,
type: r.type,
score: r.score
})),
locked_context: {
city: lockedContext.city,
area: lockedContext.area,
vehicle: lockedContext.vehicle
},
debug: {
nlu: nluResult,
detected_city: lockedCity,
detected_area: detectedArea,
detected_vehicle: lockedVehicle,
chunks_used: topResults.length,
retrieved_context: retrievedContext 
}
});

} catch (e) {
console.error(`[FATAL ERROR] ${e.message}\n${e.stack}`);
res.status(500).json({
answer: 'Jag förstår inte riktigt vad du menar nu? Kan du omformulera din fråga.',
sessionId: sessionId
});
}
});

// === ROOT ROUTE
app.get('/', (req, res) => {
res.send(`Atlas-Bot API v${VERSION} – ansluten och redo`);
});

// === GLOBAL ERROR HANDLERS
process.on('unhandledRejection', (reason, promise) => {
console.error('UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (error) => {
console.error('UNCAUGHT EXCEPTION:', error);
});

// Express error handler (måste vara sist bland middlewares)
app.use((err, req, res, next) => {
console.error(`[ERROR] ${err.message}`);
console.error(err.stack);
res.status(err.statusCode || 500).json({
error: err.message || 'Internt serverfel',
code: err.code || 'INTERNAL_ERROR'
});
});

// === STARTA SERVERN
app.listen(PORT, '0.0.0.0', () => {
console.log('='.repeat(70));
console.log('SERVER REDO');
console.log(`URL: http://localhost:${PORT}`);
console.log(`Extern åtkomst: http://<din-ip>:${PORT}`);
console.log(`Version: ${VERSION}`);
console.log(`Chunks: ${allChunks.length}`);
console.log(`Städer: ${knownCities.join(', ')}`);
console.log('='.repeat(70));
});