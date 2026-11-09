/**
 * ghost-workspace.js — Ghost Workspace in Docker & Isolated Sandbox (Idea #6)
 * Permette ad AziendaAI di testare codice, dipendenze o comandi rischiosi in un
 * container Docker effimero o in una cartella di sandbox isolata senza sporcare né
 * compromettere il workspace principale.
 */

const { execFile, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const GHOST_ROOT = path.join(os.homedir(), '.gemini', 'antigravity', 'ghost_sandboxes');

// Assicura che la directory per i ghost sandbox esista
try {
  if (!fs.existsSync(GHOST_ROOT)) {
    fs.mkdirSync(GHOST_ROOT, { recursive: true });
  }
} catch (_) {}

/**
 * Controlla se Docker è installato e se il daemon è attualmente attivo.
 */
function checkDockerStatus() {
  return new Promise((resolve) => {
    execFile('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
      if (err) {
        return resolve({
          available: false,
          version: null,
          engine: 'local-ghost',
          status: 'Docker non disponibile o daemon arrestato. Fallback su Ghost Sandbox Locale attivo.'
        });
      }
      resolve({
        available: true,
        version: (stdout || '').trim(),
        engine: 'docker',
        status: `Docker Daemon attivo (v${(stdout || '').trim()})`
      });
    });
  });
}

/**
 * Esegue un comando all'interno del Ghost Sandbox.
 * Se Docker è disponibile, avvia un container effimero (`docker run --rm`).
 * Altrimenti, clona i file rilevanti in un sandbox isolato temporaneo ed esegue lì.
 */
async function executeGhostCommand({ command, projectPath, imageName = 'node:alpine', timeoutMs = 30000 }) {
  const startTime = Date.now();
  const cleanCmd = String(command || '').trim();
  const targetDir = projectPath || process.cwd();

  if (!cleanCmd) {
    return {
      success: false,
      exitCode: 1,
      output: 'Nessun comando fornito per il Ghost Workspace.',
      engine: 'none',
      durationMs: 0
    };
  }

  const dockerStatus = await checkDockerStatus();

  if (dockerStatus.available) {
    // Esecuzione in Container Docker Isolato
    // Monta la cartella del progetto in sola lettura (/workspace:ro) o in volume temporaneo
    return new Promise((resolve) => {
      // Normalizzazione del path Windows per Docker (es. C:\foo -> //c/foo o c:/foo)
      const dockerPath = targetDir.replace(/\\/g, '/');
      const dockerArgs = [
        'run',
        '--rm',
        '--network', 'none', // Sandbox isolata senza accesso rete esterno per sicurezza
        '-v', `${dockerPath}:/workspace:ro`,
        '-w', '/workspace',
        imageName,
        'sh', '-c', cleanCmd
      ];

      execFile('docker', dockerArgs, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        const durationMs = Date.now() - startTime;
        const exitCode = err ? (err.code || 1) : 0;
        const out = (stdout || stderr || (err ? err.message : '')).trim();

        resolve({
          success: exitCode === 0,
          exitCode: exitCode,
          output: out || (exitCode === 0 ? 'Comando Ghost completato nel container con successo.' : 'Errore esecuzione container.'),
          engine: 'docker',
          containerImage: imageName,
          durationMs
        });
      });
    });
  } else {
    // Modalità Fallback: Ghost Sandbox Isolato su Filesystem Locale
    return new Promise((resolve) => {
      const sandboxId = `ghost_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const sandboxDir = path.join(GHOST_ROOT, sandboxId);

      try {
        fs.mkdirSync(sandboxDir, { recursive: true });
        
        // Copia leggera dei soli file manifest e config (package.json, js, ecc.) senza node_modules pesanti
        copyShallowProject(targetDir, sandboxDir);

        // Esegui il comando confinato nella cartella sandbox
        const isWin = process.platform === 'win32';
        const shellCmd = isWin ? `cmd.exe /d /s /c "${cleanCmd}"` : cleanCmd;

        exec(shellCmd, {
          cwd: sandboxDir,
          timeout: timeoutMs,
          windowsHide: true,
          env: { ...process.env, GHOST_SANDBOX: '1', NODE_ENV: 'test' }
        }, (err, stdout, stderr) => {
          const durationMs = Date.now() - startTime;
          const exitCode = err ? (err.code || 1) : 0;
          let out = (stdout || stderr || (err ? err.message : '')).trim();

          // Pulizia immediata della sandbox temporanea
          try {
            fs.rmSync(sandboxDir, { recursive: true, force: true });
          } catch (_) {}

          resolve({
            success: exitCode === 0,
            exitCode: exitCode,
            output: out || (exitCode === 0 ? 'Ghost Sandbox Locale: esecuzione terminata con successo.' : 'Errore esecuzione sandbox locale.'),
            engine: 'local-ghost',
            sandboxId: sandboxId,
            durationMs
          });
        });
      } catch (err) {
        resolve({
          success: false,
          exitCode: 1,
          output: `Errore inizializzazione Ghost Sandbox: ${err.message}`,
          engine: 'local-ghost',
          durationMs: Date.now() - startTime
        });
      }
    });
  }
}

/**
 * Helper per copiare i file di base nel sandbox isolato escludendo cartelle giganti (.git, node_modules)
 */
function copyShallowProject(src, dest) {
  try {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'scratch') {
        continue;
      }
      const sPath = path.join(src, entry.name);
      const dPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(dPath, { recursive: true });
        // Copia a profondità 1 o 2 per mantenere la struttura cartelle
        try {
          const subEntries = fs.readdirSync(sPath, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isFile()) {
              fs.copyFileSync(path.join(sPath, sub.name), path.join(dPath, sub.name));
            }
          }
        } catch (_) {}
      } else if (entry.isFile()) {
        fs.copyFileSync(sPath, dPath);
      }
    }
  } catch (_) {}
}

module.exports = {
  checkDockerStatus,
  executeGhostCommand,
  GHOST_ROOT
};
