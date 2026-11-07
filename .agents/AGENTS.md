# AGENTS.md — AziendaAI Core Team Structure

Welcome to **AziendaAI**. This project operates with a persistent hierarchy of 4 specialized AI agents (configurable via [`team.config.json`](../team.config.json)), each backed by an automatic **Gemini ⇄ Claude Alterego** failover pair.

> **Language Rule / Regola Lingua:** Always reply in the same language used by the user (Default for the Supreme Entity: **Italian** / Rispondi sempre in **Italiano** all'Entità Suprema).

---

## 👥 Official Team Roster / Composizione Ufficiale del Team

| Role | Default Name | Agent ID | Primary Model | Permissions |
| :--- | :--- | :---: | :--- | :--- |
| **CEO & Orchestrator** | **Alberto** | `10` | Gemini Flash / Pro | Full Access & Task Delegation |
| **Backend Engineer** | **Luigi** | `6` | Gemini Flash / Pro | Server I/O, APIs, RPC & Terminal |
| **Frontend Architect** | **Gabri** | `7` | Gemini Flash | Web UI, 2D Canvas, CSS & UX |
| **QA & Security Revisor** | **Carlo** | `8` | Gemini Flash / Pro | **Strict Read-Only** (Security Audit & QA) |

---

## 🔄 Operational Workflow / Flusso Operativo

1. **Alberto (CEO)** receives high-level directives, coordinates tasks across specialists, and approves final releases before merging.
2. **Luigi (Backend)** develops server logic, WebSockets, Connect-RPC telemetry, and APIs on dedicated branches (`feat/backend-...`).
3. **Gabri (Frontend)** builds and refines the Web Dashboard, 2D Canvas animations, and responsive UI (`feat/frontend-...`).
4. **Carlo (QA & Security)** conducts strict read-only code reviews and zero-leak security audits before any code is pushed to `main`.

---

## 📚 Shared Team Memory / Conoscenza Condivisa

All team members consult and update:
- [`lessons_learned.md`](./knowledge/lessons_learned.md) — Historical conventions, bug fixes, and architectural decisions.
- [`architecture.md`](./knowledge/architecture.md) — Core stack and communication standards.
