# Feasibility Deep-Dive — Page-Agent-Style Extension

> Deccan AI · Internal · 2026-08-25
> Basis: source-level read of [alibaba/page-agent](https://github.com/alibaba/page-agent) v1.12.2 (MIT)
> Web report: https://claude.ai/code/artifact/ea068b8b-d905-4131-8072-1883f20dcac8

## Verdict

**Feasible — and we didn't start from zero.** page-agent is MIT-licensed and already ships a
production Chrome extension built from reusable packages. This repo is the outcome of the
recommended path: our own extension shell on top of the copied engine, plus the screenshot
capability upstream lacks.

## What page-agent actually is

A TypeScript monorepo that lets an LLM control web pages through natural language, in two form
factors: an embeddable JS library (the demo site) and a full Manifest V3 Chrome extension
(WXT + React, side panel, multi-tab, on the Chrome Web Store).

Key architectural finding: **the agent is text-only — there is zero screenshot code anywhere
upstream.** On every step the content script serializes the DOM into indexed interactive
elements (`[12]<button>Login</button>`), sends that text plus scroll/viewport info to any
OpenAI-compatible LLM, and executes the returned tool call.

Built-in tools: `done`, `wait`, `ask_user`, `click_element_by_index`, `input_text`,
`select_dropdown_option`, `scroll`, `scroll_horizontally`, `execute_javascript`, plus tab tools
in the extension: `open_new_tab`, `switch_to_tab`, `close_tab`.

Upstream packages and what we did with them:

| Package | Role | Lines | Our decision |
| --- | --- | --- | --- |
| `@page-agent/page-controller` | DOM serialize + actions, simulated cursor | ~3,900 | **Copied unmodified** → `src/vendor/page-controller` |
| `@page-agent/core` | Agent loop, tools, prompts | ~1,700 | **Copied unmodified** → `src/vendor/core` |
| `@page-agent/llms` | OpenAI-compatible client (BYO key, Ollama OK) | ~800 | **Copied unmodified** → `src/vendor/llms` |
| extension `src/agent/` glue | Multi-tab messaging (panel ↔ background ↔ content) | ~1,350 | **Copied, 1 marked change** → `src/agent` |
| `@page-agent/ui`, React panel, page API, MCP hub, i18n | UI & integrations | ~4,700+ | **Skipped** — replaced by our minimal shell |

## Build options considered

| Option | Effort to v1 | Call |
| --- | --- | --- |
| A. Fork the whole repo | 3–5 days | Fastest, but carries their monorepo + UI |
| **B. Own shell + copied engine** | **~1–1.5 weeks** | **Chosen — this repo** |
| C. From scratch | 2–3 months | Not justified; the DOM serializer alone encodes years of edge cases |

## Screenshot capability (the gap we filled / are filling)

1. ✅ **Viewport capture** — `chrome.tabs.captureVisibleTab` via the background worker,
   exposed to the agent as the `capture_screenshot` tool; gallery in the side panel.
   Note: MV3 rate-limits this API (~2 calls/sec) — irrelevant at agent cadence.
2. ⬜ **Full-page capture** — scroll-and-stitch (content script scrolls, background captures,
   canvas stitches; the GoFullPage approach). Sticky headers & lazy-load need handling.
3. ⬜ Optional: `chrome.debugger` + CDP `Page.captureScreenshot(captureBeyondViewport)` —
   one-shot full page, but shows the "is debugging this browser" banner and draws extra
   Web Store scrutiny.
4. ⬜ **Hybrid vision mode** — attach the screenshot to the LLM request for canvas-heavy pages
   (Figma, Docs, maps, charts) where text-only DOM agents go blind.

## Expectations / roadmap

- **Week 1 (done)**: scaffold — engine vendored, own MV3 shell, panel UI, viewport screenshots.
  Verified: `tsc` clean, Vite builds clean, Playwright smoke test (SW registers, content script
  injects, panel error-free, screenshot pipeline produces PNG → gallery).
- **Week 2**: full-page capture, element crop, run 15–20 real tasks against our target sites
  with the team's LLM endpoint; measure success rate / latency / token cost.
- **Weeks 3–4**: safety rails + hardening → go/no-go for wider internal rollout.

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Prompt injection — page text feeds the LLM; a malicious page can steer the agent | High | Domain allowlist, confirmation gates on sensitive actions; `execute_javascript` stays disabled in extension context (upstream default) |
| LLM API key stored client-side | Medium | Fine for internal dev; route through a company proxy before wider rollout |
| Text-only agent fails on canvas/visual pages | Medium | Hybrid vision mode (roadmap item 4) |
| Chrome Web Store review of `<all_urls>` + automation | Medium | Distribute internally (unpacked / enterprise policy) first |
| Cross-origin iframes, shadow DOM edge cases | Medium | Upstream handles much; test early on real target sites |
| Upstream churn (active project) | Low | `src/vendor` stays byte-identical to v1.12.2; diff against upstream to pull fixes |

## Licensing

Upstream is MIT (© 2026 SimonLuvRamen). Obligation: keep the license/copyright notice —
satisfied by `src/vendor/LICENSE` and `NOTICE.md`. Internal or commercial use is permitted.
