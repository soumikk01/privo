# Deccan Page Agent — Internal Cost Analysis

> Internal use only. Real numbers — all LLM costs from Anthropic's published API pricing.
> Purpose: understand what each agent task actually costs to run so we can budget correctly.

---

## 1. Token model (how costs accumulate per task)

Each agent step sends a full context to the LLM — the system prompt, all previous steps, and the current browser state. Context grows with every step.

### Per-step input composition

| Component | Tokens (est.) | Notes |
|---|---|---|
| System prompt (deccan + vendor) | ~4,500 | Fixed. Sent every step. Cacheable. |
| Flow instructions (`FLOW_INSTRUCTIONS`) | ~400 | Fixed per task. |
| Browser state (DOM tree) | 2,000 – 12,000 | Varies by page complexity. 6,000 typical. |
| Step info + user request | ~300 | Short. Fixed per task. |
| Agent history | 400 × (step − 1) | Grows linearly. Each step adds ~400 tokens of history. |

### Per-step output

| Component | Tokens (est.) |
|---|---|
| Reflection (evaluation, memory, next goal) | ~200 |
| Tool call (action selection + args) | ~150 – 400 |
| **Average output** | **~350** |

### Total tokens by task size

Formula:
- **Input** = Σ (4,500 + 400 + 6,000 + 300 + 400×(i−1)) for i = 1 to N  
  = N × 11,200 + 200 × N × (N−1)
- **Output** = N × 350

| Task size | Steps | Est. input tokens | Est. output tokens |
|---|---|---|---|
| Trivial | 3 | 34K | 1.1K |
| Simple | 7 | 80K | 2.5K |
| Medium | 15 | 210K | 5.3K |
| Heavy | 30 | 510K | 10.5K |
| Complex | 60 | 1.28M | 21K |

---

## 2. LLM API cost by model

### Model pricing (Anthropic published rates)

| Model | Input ($/M) | Output ($/M) | Cache write ($/M) | Cache read ($/M) | Notes |
|---|---|---|---|---|---|
| `claude-haiku-3-5` | $0.80 | $4.00 | $1.00 | $0.08 | Cheapest. Lower reasoning quality. |
| **`claude-sonnet-4-6`** | **$3.00** | **$15.00** | **$3.75** | **$0.30** | **Current model in use.** |
| `claude-sonnet-5` | $3.00 | $15.00 | $3.75 | $0.30 | Same price tier as 4.6. Latest. |
| `claude-opus-5` | $15.00 | $75.00 | $18.75 | $1.50 | 5× cost. Best reasoning. |

> **Note:** The current backend uses the OpenAI-compat endpoint (`/v1/chat/completions`).
> Anthropic's OpenAI-compat endpoint does **not** expose prompt caching. The native
> `/v1/messages` endpoint does — see Section 7.

---

### Cost per task — `claude-sonnet-4-6` (current, no caching)

| Task size | Steps | Input tokens | Output tokens | Input cost | Output cost | **Total** |
|---|---|---|---|---|---|---|
| Trivial | 3 | 34K | 1.1K | $0.10 | $0.02 | **$0.12** |
| Simple | 7 | 80K | 2.5K | $0.24 | $0.04 | **$0.28** |
| Medium | 15 | 210K | 5.3K | $0.63 | $0.08 | **$0.71** |
| Heavy | 30 | 510K | 10.5K | $1.53 | $0.16 | **$1.69** |
| Complex | 60 | 1.28M | 21K | $3.84 | $0.32 | **$4.16** |

---

### Cost per task — `claude-haiku-3-5` (cheapest option)

| Task size | Steps | Input cost | Output cost | **Total** | vs Sonnet |
|---|---|---|---|---|---|
| Trivial | 3 | $0.027 | $0.004 | **$0.03** | −75% |
| Simple | 7 | $0.064 | $0.010 | **$0.07** | −75% |
| Medium | 15 | $0.168 | $0.021 | **$0.19** | −73% |
| Heavy | 30 | $0.408 | $0.042 | **$0.45** | −73% |
| Complex | 60 | $1.024 | $0.084 | **$1.11** | −73% |

> Quality risk: Haiku frequently fails multi-step browser agent tasks — incorrect element selection, missed navigation steps, poor self-correction. Real-world task success rate is significantly lower than Sonnet, meaning more retries, effectively erasing the cost saving.

---

### Cost per task — `claude-opus-5` (premium option)

| Task size | Steps | Input cost | Output cost | **Total** | vs Sonnet |
|---|---|---|---|---|---|
| Trivial | 3 | $0.51 | $0.08 | **$0.59** | +392% |
| Simple | 7 | $1.20 | $0.19 | **$1.39** | +396% |
| Medium | 15 | $3.15 | $0.40 | **$3.55** | +400% |
| Heavy | 30 | $7.65 | $0.79 | **$8.44** | +399% |
| Complex | 60 | $19.2 | $1.58 | **$20.78** | +400% |

> Only justified for high-value workflows where task failure is expensive, or compliance-critical captures that require maximum accuracy.

---

### Cost per task — `claude-sonnet-4-6` with prompt caching (native API — future)

The 4,500-token system prompt is fixed every step — ideal cache target. Cache read at $0.30/M vs $3.00/M saves 90% on that portion.

| Task size | Steps | Uncached | Cache saving | **Net cost** | **Saving** |
|---|---|---|---|---|---|
| Trivial | 3 | $0.12 | $0.04 | **$0.08** | 34% |
| Simple | 7 | $0.28 | $0.13 | **$0.15** | 47% |
| Medium | 15 | $0.71 | $0.18 | **$0.53** | 26% |
| Heavy | 30 | $1.69 | $0.36 | **$1.33** | 21% |
| Complex | 60 | $4.16 | $0.73 | **$3.43** | 18% |

---

### Model selection summary

| Goal | Best model | Why |
|---|---|---|
| Minimize cost, accept more retries | `claude-haiku-3-5` | 73–75% cheaper but agent quality drops |
| Best cost/quality balance (recommended) | **`claude-sonnet-4-6`** | Reliable browser agent behaviour, reasonable cost |
| Latest model, same cost | `claude-sonnet-5` | Same pricing as 4.6, newer capabilities |
| Maximum accuracy, cost not a constraint | `claude-opus-5` | 4× cost, strongest reasoning and self-correction |

---

## 3. Infrastructure costs

### Self-hosted (current architecture)

| Component | Monthly cost | Notes |
|---|---|---|
| VPS (Hetzner CX21 / DigitalOcean 2GB) | $6 – $12 | Single Fastify instance, handles ~500 tasks/day easily |
| Domain + TLS (Let's Encrypt) | $1 – $12/yr | Negligible |
| Storage (JSON file / SQLite) | $0 | Current approach, fine up to ~500K captures |
| Backup (Hetzner snapshots) | $2 | Weekly |
| **Total infra** | **~$10 – $15/month** |

### Cloudflare Workers (scale-out option)

| Component | Monthly cost | Notes |
|---|---|---|
| Workers Paid plan | $5 | 10M requests/month included |
| D1 database | $0 – $0.75 | 5GB free, $0.75/GB-month after |
| R2 storage (if PNGs stored in cloud) | $0 – $15 | 10GB free; $0.015/GB after |
| **Total infra** | **$5 – $20/month** |

### Cost per task (infra)

At 1,000 tasks/month on a $12/month VPS: **$0.012 per task infra cost** — negligible vs LLM cost.

---

## 4. Unit economics

### Blended cost per task (realistic distribution)

Real-world usage skews toward medium tasks. Assuming:
- 30% trivial/simple (avg. 5 steps) → $0.20
- 50% medium (15 steps) → $0.71
- 15% heavy (30 steps) → $1.69
- 5% complex (60 steps) → $4.16

**Weighted average API cost per task: ~$0.76**  
Add $0.012 infra: **~$0.78 all-in cost per task**

### At scale (with prompt caching on native API)

**Weighted average API cost per task: ~$0.57**  
Add $0.012 infra: **~$0.58 all-in cost per task**

---

## 5. Monthly API budget estimates (internal use)

How much we spend on the Anthropic API depends entirely on how many tasks the team runs and at what complexity. Use this to set a monthly budget.

| Usage scenario | Tasks/month | Avg complexity | Est. API spend |
|---|---|---|---|
| Light internal use | 50 | Medium | ~$36 |
| Active internal use | 200 | Medium | ~$142 |
| Heavy internal use | 500 | Medium | ~$355 |
| Heavy, mixed complexity | 500 | Blended ($0.78 avg) | ~$390 |

At **$3/M input + $15/M output** on Sonnet 4.6, a medium 15-step task costs **$0.71**. That's the number to budget against per task.

---

## 6. The one highest-leverage cost reduction

**Switch the LLM proxy from the OpenAI-compat endpoint to the native Anthropic `/v1/messages` endpoint with prompt caching enabled.**

Required change: update `OpenAIClient.ts` (vendor) to use the Messages API format, or proxy through a thin adapter that rewrites the request and adds `anthropic-beta: prompt-caching-2024-07-31` with cache_control markers on the system prompt.

Expected impact:
- ~20–35% reduction in per-task API cost across all task sizes
- Biggest absolute saving on high-step tasks (complex workflows)
- At 1,000 tasks/month × $0.78 avg → saves ~$200–$270/month at scale

**Cost to implement: ~2–3 days engineering.**

---

## 7. Key risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Anthropic price increase | Medium | High | Switch to native API + prompt caching first (see Section 6) |
| Team running very long tasks (200+ steps) | Low | High | Add step-count logging; warn in UI when step count is high |
| Agent fails and retries repeatedly (wasted spend) | Medium | Medium | Log failed task costs; add max-retry guard in MultiPageAgent |
| Claude API latency spike | Medium | Low | Already mitigated — stepDelay=0, latency is irreducible |
| Backend breach exposes captures | Low | High | HMAC signing, no PII in capture records, EXTENSION_SECRET rotation |

---

*Word count: ~1,100. Last updated: 2026-08-26.*
