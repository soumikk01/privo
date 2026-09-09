# Third-party code notice

This project vendors source code from **page-agent** (https://github.com/alibaba/page-agent),
Copyright (c) 2026 SimonLuvRamen, licensed under the MIT License.

Vendored, unmodified (engine):
- `src/vendor/core/` — from `packages/core/src` (agent loop, tools, prompts)
- `src/vendor/page-controller/` — from `packages/page-controller/src` (DOM serialization + actions)
- `src/vendor/llms/` — from `packages/llms/src` (OpenAI-compatible LLM client)

Vendored, lightly adapted (extension glue, changes marked with `[deccan]` comments):
- `src/agent/` — from `packages/extension/src/agent` (MultiPageAgent, TabsController, RemotePageController, tab tools, system prompt)

The upstream MIT license text is kept at `src/vendor/LICENSE`.
Snapshot taken from upstream v1.12.2 (2026-08). To pull upstream fixes, diff these
folders against the same paths in the upstream repo.
