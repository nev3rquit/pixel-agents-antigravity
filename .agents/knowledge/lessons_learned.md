# Continuous Memory — Team Lessons Learned / Memoria Continua

This document records the institutional memory of **AziendaAI** so that **Alberto (CEO)**, **Luigi (Backend)**, **Gabri (Frontend)**, and **Carlo (QA)** maintain consistent engineering standards.

## Version Control & Release Conventions / Convenzioni Git
- **Main Branch**: `main` (always clean, zero secrets, ready for public release).
- **Branch Naming**:
  - `feat/backend-<description>` for Luigi.
  - `feat/frontend-<description>` for Gabri.
  - `fix/<description>` for urgent patches.
- **Release Gate**:
  1. Luigi or Gabri implement the feature.
  2. Carlo performs a strict Read-Only security & zero-leak audit (`git grep` for tokens, paths, and personal UUIDs).
  3. Alberto approves the final merge/push.

## Key Engineering Lessons / Registro Soluzioni Apprese
- **Zero-Leak Policy**: Never commit `discord.config.json`, `agents.config.json`, `tasks_queue.json`, or hardcoded local user paths (`os.homedir()` must always be used dynamically).
- **Headless Windows Execution**: Launch background Node processes via `start.vbs` (`WScript.Shell` with `0 = Hidden`) to prevent lingering `cmd.exe` windows.
- **Daemon Hub Discovery**: Always probe active `hub_*.json` ports in `~/.gemini/antigravity/daemon` and ignore stale descriptors.
