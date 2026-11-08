// Collaudo Tecnico Completo Backend AziendaAI (Luigi)
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const routing = require('../routing');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

function httpRequest(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost',
      port: PORT,
      path: urlPath,
      method: method,
      headers: {
        ...(data ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        } : {})
      },
      timeout: 10000
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
        } catch (e) {
          resolve({ status: res.statusCode, rawBody: raw });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP Timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function runTests() {
  console.log('====================================================');
  console.log('🚀 AVVIO COLLAUDO FORMALE BACKEND AZIENDAAI (LUIGI)');
  console.log('====================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(title, condition, extra = '') {
    if (condition) {
      console.log(`✅ [PASS] ${title} ${extra ? '(' + extra + ')' : ''}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${title} ${extra ? '(' + extra + ')' : ''}`);
      failed++;
    }
  }

  // 1. TEST UNITARIO & SICUREZZA: ANTI-PATH TRAVERSAL IN routing.setTargetProject
  console.log('\n--- 1. Sicurezza Anti-Path Traversal & Confinamento Cartelle (routing.js) ---');
  
  const emptyRes = routing.setTargetProject('');
  assert('Rifiuto percorso vuoto', emptyRes.ok === false && emptyRes.error.includes('vuoto'));

  const nullByteRes = routing.setTargetProject('my-project\0/sensitive');
  assert('Rifiuto null bytes', nullByteRes.ok === false);

  const rootDriveRes = routing.setTargetProject('C:\\');
  assert('Rifiuto root disco C:\\', rootDriveRes.ok === false);

  const sysWinRes = routing.setTargetProject('C:\\Windows');
  assert('Rifiuto cartella di sistema C:\\Windows', sysWinRes.ok === false && sysWinRes.error.includes('protetta'));

  const sysProgRes = routing.setTargetProject('C:\\Program Files');
  assert('Rifiuto cartella di sistema C:\\Program Files', sysProgRes.ok === false && sysProgRes.error.includes('protetta'));

  const nonExistentRes = routing.setTargetProject('C:\\cartella_inesistente_xyz_123');
  assert('Rifiuto directory non esistente', nonExistentRes.ok === false && nonExistentRes.error.includes('non trovata'));

  const validAzienda = routing.setTargetProject(path.resolve(__dirname, '..'));
  assert('Accettazione directory valida di progetto (AziendaAI)', validAzienda.ok === true && validAzienda.projectName === 'AziendaAI');

  // 2. COLLAUDO ENDPOINT REST
  console.log('\n--- 2. Collaudo Endpoint REST (server.js) ---');

  // GET /api/project
  const getProj = await httpRequest('GET', '/api/project');
  assert('GET /api/project risponde 200', getProj.status === 200);
  assert('GET /api/project ritorna projectPath e projectName', getProj.body && Boolean(getProj.body.projectPath));

  // POST /api/project valido
  const postProjValid = await httpRequest('POST', '/api/project', { projectPath: path.resolve(__dirname, '..') });
  assert('POST /api/project (valido) risponde 200', postProjValid.status === 200 && postProjValid.body.ok === true);

  // POST /api/project traversal/system (invalido)
  const postProjInvalid = await httpRequest('POST', '/api/project', { projectPath: 'C:\\Windows' });
  assert('POST /api/project (cartella protetta) risponde 400', postProjInvalid.status === 400 && postProjInvalid.body.ok === false);

  // GET /api/tasks/queue
  const getQueue = await httpRequest('GET', '/api/tasks/queue');
  assert('GET /api/tasks/queue risponde 200', getQueue.status === 200);
  assert('GET /api/tasks/queue ritorna array queue e modalita', getQueue.body && Array.isArray(getQueue.body.queue));

  // POST /api/tasks/clear (filter=completed)
  const postClearCompleted = await httpRequest('POST', '/api/tasks/clear', { filter: 'completed' });
  assert('POST /api/tasks/clear (filter=completed) risponde 200', postClearCompleted.status === 200 && postClearCompleted.body.success === true);

  // POST /api/ceo-report
  const postReport = await httpRequest('POST', '/api/ceo-report', { postToDiscord: false });
  assert('POST /api/ceo-report risponde 200', postReport.status === 200 && postReport.body.ok === true);
  assert('POST /api/ceo-report contiene report markdown e statistiche', postReport.body && typeof postReport.body.report === 'string' && postReport.body.stats !== undefined);

  // 3. COLLAUDO WEBSOCKET: STATO INIZIALE & MESSAGGI DI COORDINAMENTO
  console.log('\n--- 3. Collaudo WebSocket & Sincronizzazione Live ---');

  await new Promise((resolveWs, rejectWs) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const received = [];

    ws.on('open', () => {
      console.log('🔌 Connesso a ws://localhost:' + PORT + '/ws');
      // Invia comandi di coordinamento
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'toggleLoungeBreak', active: true }));
      }, 200);

      setTimeout(() => {
        // Test pausa divano granulare per singolo agente (Luigi, agentId 6)
        ws.send(JSON.stringify({ type: 'breakMode', active: true, agentId: 6 }));
      }, 400);

      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'callStandupMeeting', topic: 'Allineamento Generale Team: Sprint Sync' }));
      }, 600);

      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'setTargetProject', projectPath: path.resolve(__dirname, '..') }));
      }, 800);

      setTimeout(() => {
        // Reset finale obbligatorio: riporta la lounge break a false per non lasciare lo stato alterato all'avvio dashboard!
        ws.send(JSON.stringify({ type: 'toggleLoungeBreak', active: false }));
      }, 1000);

      setTimeout(() => {
        ws.close();
      }, 1300);
    });

    ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());
        received.push(msg);
      } catch {}
    });

    ws.on('close', () => {
      // Verifiche sui messaggi ricevuti
      const hasInit = received.some(m => m.type === 'officeAccess');
      assert('WS Initial Handshake: officeAccess ricevuto', hasInit);

      const hasLayout = received.some(m => m.type === 'layoutLoaded');
      assert('WS Initial Sync: layoutLoaded ricevuto', hasLayout);

      const hasSprites = received.some(m => m.type === 'characterSpritesLoaded');
      assert('WS Initial Sync: characterSpritesLoaded ricevuto', hasSprites);

      const hasAgents = received.some(m => m.type === 'existingAgents');
      assert('WS Initial Sync: existingAgents ricevuto', hasAgents);

      const hasQueueSync = received.some(m => m.type === 'tasksQueueUpdated');
      assert('WS Initial Sync: tasksQueueUpdated (Kanban sync) ricevuto', hasQueueSync);

      const hasLoungeInit = received.some(m => m.type === 'loungeBreakState');
      assert('WS Initial Sync: loungeBreakState ricevuto', hasLoungeInit);

      const hasLoungeToggle = received.some(m => m.type === 'loungeBreakState' && m.active === true && m.reason === 'manual_toggle');
      assert('WS Coordination: toggleLoungeBreak broadcast ricevuto', hasLoungeToggle);

      const hasGranularLounge = received.some(m => m.type === 'loungeBreakState' && m.agentId === 6 && Array.isArray(m.agentIds) && m.agentIds.includes(6));
      assert('WS Coordination: breakMode granulare per singolo agente (Luigi id 6) ricevuto', hasGranularLounge);

      const hasStandup = received.some(m => m.type === 'standupMeetingStarted' && m.topic.includes('Allineamento Generale Team'));
      assert('WS Coordination: standupMeetingStarted broadcast ricevuto', hasStandup);

      const hasProjChanged = received.some(m => m.type === 'targetProjectChanged');
      assert('WS Coordination: targetProjectChanged broadcast ricevuto', hasProjChanged);

      resolveWs();
    });

    ws.on('error', rejectWs);
  });

  console.log('\n====================================================');
  console.log(`📊 ESITO COLLAUDO BACKEND: ${passed} PASSATI, ${failed} FALLITI`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
