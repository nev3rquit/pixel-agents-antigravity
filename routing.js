// Routing Gemini <-> Claude (alterego) + Coda di ripresa post-riposo e lettura da agents.config.json
const fs = require('fs');
const path = require('path');

const DEFAULT_PRIMARY = {
  10: '00000000-0000-4000-8000-000000000010', // Alberto (CEO) — esegui `node setup-agents.js` per generare i tuoi UUID
  6:  '00000000-0000-4000-8000-000000000006', // Luigi (Backend)
  7:  '00000000-0000-4000-8000-000000000007', // Gabri (Frontend)
  8:  '00000000-0000-4000-8000-000000000008'  // Carlo (QA)
};

const DEFAULT_ALTEREGO = {
  10: '00000000-0000-4000-9000-000000000010', // alberto-ceo-alterego
  6:  '00000000-0000-4000-9000-000000000006', // luigi-backend-alterego
  7:  '00000000-0000-4000-9000-000000000007', // gabri-frontend-alterego
  8:  '00000000-0000-4000-9000-000000000008'  // carlo-revisor-alterego
};

let PRIMARY = { ...DEFAULT_PRIMARY };
let ALTEREGO = { ...DEFAULT_ALTEREGO };

try {
  const cfgPath = path.join(__dirname, 'agents.config.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.primary) {
      for (const [k, v] of Object.entries(cfg.primary)) if (v) PRIMARY[Number(k)] = v;
    }
    if (cfg.alterego) {
      for (const [k, v] of Object.entries(cfg.alterego)) if (v) ALTEREGO[Number(k)] = v;
    }
  }
} catch (_) {}

// Stati: 'gemini' (agenti primari) -> 'claude' (alterego) -> 'rest' (tutti a riposo)
const state = {
  claudeActive: false,
  mode: null,
  resumeAt: null,
  geminiResetAt: null,
  claudeResetAt: null,
  restQueue: [],
  targetProject: path.resolve(__dirname)
};

function getTargetProject() {
  return state.targetProject || path.resolve(__dirname);
}

function setTargetProject(newPath) {
  const cleaned = String(newPath || '').trim().replace(/^"|"$/g, '');
  if (!cleaned) return { ok: false, error: 'Percorso vuoto' };
  const resolved = path.resolve(cleaned);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { ok: false, error: `Cartella non trovata: ${resolved}` };
  }
  state.targetProject = resolved;
  return { ok: true, projectPath: resolved, projectName: path.basename(resolved) };
}

function updateMode({ g5h, c5h, cWeekly, resumeAt, geminiResetAt, claudeResetAt }) {
  const prev = state.mode;
  const claudeLow = c5h < 0.02 || cWeekly < 0.02;
  const claudeOk = c5h > 0.02 && cWeekly > 0.02;
  const claudeRecovered = c5h > 0.10 && cWeekly > 0.10;
  let next = prev || 'gemini';
  if (g5h > 0.10) next = 'gemini';
  else if (!prev || prev === 'gemini') {
    if (g5h < 0.02) next = claudeOk ? 'claude' : 'rest';
  } else if (prev === 'claude') {
    if (claudeLow) next = 'rest';
  } else if (prev === 'rest') {
    if (claudeRecovered) next = 'claude';
  }
  state.mode = next;
  state.claudeActive = next === 'claude';
  state.resumeAt = next === 'rest' ? (resumeAt || state.resumeAt) : null;
  state.geminiResetAt = geminiResetAt || state.geminiResetAt;
  state.claudeResetAt = claudeResetAt || state.claudeResetAt;
  return { mode: next, changed: next !== prev, prev: prev || 'init' };
}

function getMode() { return state.mode || 'gemini'; }
function isResting() { return state.mode === 'rest'; }
function restMessage() {
  const gTime = state.geminiResetAt || 'N/A';
  const cTime = state.claudeResetAt || 'N/A';
  const nextWake = state.resumeAt || gTime;
  const qCount = state.restQueue.length;
  return `💤 Agenti a riposo per quota 5h esaurita. Prossimo risveglio automatico alle **${nextWake}** (🤖 Reset Gemini 5h: **${gTime}** | 🧠 Reset Claude 5h: **${cTime}**).${qCount > 0 ? ` 📥 Task in coda pronti a partire al risveglio: **${qCount}**.` : ''}`;
}

function enqueueRestTask(task) {
  state.restQueue.push({ ...task, queuedAt: new Date().toISOString() });
  return state.restQueue.length;
}

function flushRestQueue() {
  return state.restQueue.splice(0, state.restQueue.length);
}

function setClaudeActive(v) { state.claudeActive = !!v; }
function isClaudeActive() { return state.claudeActive; }
function resolveSubagent(agentId) {
  const id = Number(agentId) || 10;
  return (state.claudeActive ? ALTEREGO[id] : PRIMARY[id]) || PRIMARY[10];
}

function allSessionsMap() {
  const m = {};
  for (const [a, s] of Object.entries(PRIMARY)) m[s] = Number(a);
  for (const [a, s] of Object.entries(ALTEREGO)) m[s] = Number(a);
  return m;
}

module.exports = {
  updateMode,
  getMode,
  isResting,
  restMessage,
  enqueueRestTask,
  flushRestQueue,
  getTargetProject,
  setTargetProject,
  PRIMARY,
  ALTEREGO,
  setClaudeActive,
  isClaudeActive,
  resolveSubagent,
  allSessionsMap
};
