# Reference Architecture — AziendaAI

## Core Technology Stack / Stack Tecnologico
- **Backend (Luigi)**: Node.js (Express, `ws` WebSocket, Connect-RPC client) or Python (FastAPI).
- **Frontend (Gabri)**: HTML5 2D Isometric Canvas (60 FPS), Vanilla JS / React, modern responsive CSS.
- **QA & Security (Carlo)**: Static analysis, secret/UUID zero-leak verification, end-to-end WebSocket & RPC validation.

## Communication Standards / Linee Guida di Comunicazione
- Real-time bidirectional state synchronization over WebSocket (`/ws`).
- Strict separation between Tier-1 whitelisted shell diagnostics (`execFile`) and Tier-2 subagent prompt dispatching (`agentapi send-message`).
- Language: Respond in **Italian** by default when addressing the Supreme Entity, or match the user's input language.
