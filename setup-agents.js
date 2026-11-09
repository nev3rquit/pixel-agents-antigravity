/**
 * Setup automatico 1-Click per creare gli Agenti Primari (Gemini) + Alterego (Claude)
 * definiti in team.config.json su qualsiasi PC con Antigravity installato.
 *
 * Uso: node setup-agents.js
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveLanguageServer, getLanguageServerEnv, listAvailableModels } = require('./antigravity-path');

const SERVER_EXE = resolveLanguageServer();
const CONFIG_FILE = path.join(__dirname, 'agents.config.json');
const TEAM_CONFIG_FILE = path.join(__dirname, 'team.config.json');

if (!SERVER_EXE || !fs.existsSync(SERVER_EXE)) {
  console.error('❌ Impossibile trovare Antigravity in:', SERVER_EXE);
  console.error('Assicurati che Antigravity sia installato e aperto su questo PC,');
  console.error('oppure imposta ANTIGRAVITY_HOME (cartella di installazione) o ANTIGRAVITY_LS_PATH (eseguibile).');
  process.exit(1);
}

const DEFAULT_SPECS = [
  { id: 10, name: 'Alberto (CEO)', model: 'flash', alteregoModel: 'claude-sonnet-5-5-medium', systemPrompt: 'Sei Alberto, CEO di AziendaAI. Coordini Luigi (Backend), Gabri (Frontend) e Carlo (QA). Rispondi solo PRONTO.' },
  { id: 6,  name: 'Luigi (Backend)', model: 'flash', alteregoModel: 'claude-sonnet-5-5-medium', systemPrompt: 'Sei Luigi, Backend Developer di AziendaAI (Node.js, API, RPC). Rispondi solo PRONTO.' },
  { id: 7,  name: 'Gabri (Frontend)', model: 'flash', alteregoModel: 'claude-sonnet-5-5-medium', systemPrompt: 'Sei Gabri, Frontend Developer di AziendaAI (UI, Canvas, Dashboard). Rispondi solo PRONTO.' },
  { id: 8,  name: 'Carlo (QA & Security)', model: 'flash', alteregoModel: 'claude-sonnet-5-5-medium', systemPrompt: 'Sei Carlo, QA & Security Revisor di AziendaAI. Rispondi solo PRONTO.' }
];

let SPECS = DEFAULT_SPECS;
try {
  if (fs.existsSync(TEAM_CONFIG_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(TEAM_CONFIG_FILE, 'utf8'));
    if (Array.isArray(parsed) && parsed.length > 0) SPECS = parsed;
  }
} catch (err) {
  console.warn('⚠️ Impossibile leggere team.config.json, uso configurazione standard:', err.message);
}

let LS_ENV = process.env;

function spawnAgent(title, model, prompt) {
  let out;
  try {
    out = execFileSync(SERVER_EXE, [
      'agentapi', 'new-conversation',
      `--model=${model}`,
      `--title=${title}`,
      prompt
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true, env: LS_ENV });
  } catch (err) {
    let msg = err.message;
    try { msg = JSON.parse(err.stdout).error || msg; } catch {}
    throw new Error(msg);
  }

  const match = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!match) throw new Error(`UUID non trovato nell'output: ${out}`);
  return match[0];
}

(async () => {
LS_ENV = await getLanguageServerEnv();
if (!LS_ENV) {
  console.error('❌ Nessuna istanza attiva di Antigravity trovata in ~/.gemini/antigravity/daemon.');
  console.error('Apri Antigravity e riprova.');
  process.exit(1);
}

// Override opzionali del modello (utile se il proprio piano Antigravity non include i modelli di team.config.json)
const PRIMARY_MODEL = process.env.PRIMARY_MODEL;
const ALTEREGO_MODEL = process.env.ALTEREGO_MODEL;
const TIERS = ['flash_lite', 'flash', 'pro'];
const plan = SPECS.map(s => ({
  s,
  model: PRIMARY_MODEL || s.model || 'flash',
  alterModel: ALTEREGO_MODEL || s.alteregoModel || 'claude-sonnet-5-5-medium'
}));

// Verifica preventiva dei modelli: evita di creare agenti a meta' se un modello non e' disponibile
const available = await listAvailableModels(LS_ENV);
if (available.length > 0) {
  const ids = new Set(available.map(m => m.id));
  const missing = [...new Set(plan.flatMap(p => [p.model, p.alterModel]))].filter(m => !TIERS.includes(m) && !ids.has(m));
  if (missing.length > 0) {
    console.error(`❌ Modelli non disponibili sul tuo piano Antigravity: ${missing.join(', ')}`);
    console.error('Modelli disponibili:');
    for (const m of available) console.error(`   - ${m.id}  (${m.label})`);
    console.error('\nModifica team.config.json oppure usa un override, ad es.:');
    console.error(`   ALTEREGO_MODEL=${(available.find(m => m.id.startsWith('claude')) || available[0]).id} node setup-agents.js`);
    process.exit(1);
  }
}

console.log(`🚀 Creazione di ${SPECS.length} Agenti Primari (Gemini) + ${SPECS.length} Alterego (Claude) da team.config.json...`);
const config = { primary: {}, alterego: {} };

for (const { s, model, alterModel } of plan) {
  const id = String(s.id);
  const title = s.name || s.title || `Agent ${id}`;
  const rolePrompt = s.systemPrompt || s.role || `Sei ${title}, membro del team AziendaAI. Rispondi solo PRONTO.`;

  process.stdout.write(`  • Creazione ${title} (Primario ${model})... `);
  config.primary[id] = spawnAgent(title, model, rolePrompt);
  console.log(`✅ [${config.primary[id]}]`);

  process.stdout.write(`  • Creazione ${title} - Alterego (${alterModel})... `);
  config.alterego[id] = spawnAgent(`${title} - Alterego`, alterModel, `${rolePrompt} (Versione Alterego Claude concisa).`);
  console.log(`✅ [${config.alterego[id]}]`);
}

fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
console.log('\n🎉 Configurazione salvata con successo in agents.config.json!');
console.log(process.platform === 'win32'
  ? 'Ora puoi avviare AziendaAI con un doppio click su start.vbs'
  : 'Ora puoi avviare AziendaAI con ./start.sh');
})().catch(err => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
