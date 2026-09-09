  <p align="center">
  <img src="./assets/privo-logo.svg" alt="Privo" width="96" height="96" />
</p>

<h1 align="center">Privo</h1>

<p align="center">
  <strong>Natural-language browser automation with verifiable captures.</strong>
</p>

<p align="center">
  Control the web through plain-language instructions — while keeping LLM credentials server-side
  and making important screenshots tamper-evident.
</p>

<p align="center">
  <code>Extension</code>
  ·
  <code>Backend</code>
  ·
  <code>TypeScript</code>
  ·
  <code>Turborepo</code>
  ·
  <code>Bun</code>
</p>

---

## What is Privo?

Privo is a browser-agent system built around two applications:

- **Browser Extension** — understands natural-language tasks, operates the active Chrome tab, manages multiple tabs, and produces sealed page captures.
- **Backend** — provides the LLM proxy, keeps the Anthropic API key off the client, and registers/verifies sealed captures.

The extension communicates with the backend locally over HTTP, with the default development server running on `localhost:8787`. 

---

## Architecture

```text
                           PRIVO
                             │
              ┌──────────────┴──────────────┐
              │                             │
              ▼                             ▼
      Browser Extension                 Backend API
      @privo/extension                 @privo/backend
              │                             │
      ┌───────┼────────┐             ┌──────┼──────────┐
      │       │        │             │      │          │
   Side     Service   Content      Auth   LLM       Capture
   Panel    Worker    Script       +      Proxy     Registry
      │       │        │             │      │          │
      └───────┴────────┘             │      ▼          ▼
              │                      │  Anthropic   SHA-256
              │                      │              + HMAC
              └──────── HTTP ────────┘
                    localhost:8787
