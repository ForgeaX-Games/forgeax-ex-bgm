# Marketplace Card Spec — `marketplace-card.json`

Each plugin SHOULD ship a `marketplace-card.json` in its repo root. It is the **SSOT
for the plugin's marketplace listing** (the rich card + detail modal on the public site).
The website is *derived* from this file by `scripts/website/build-marketplace.mjs` — never
hand-write card copy into the website HTML.

If this file is absent, the build auto-derives a thin card from `forgeax-extension.json` +
git history. Ship this file to get a real, 100+character, multi-section listing.

## Schema (bilingual; every text field has `zh` + `en`)

```jsonc
{
  "summary": {            // REQUIRED. 100+ chars each. What it is + what it does, concretely.
    "zh": "…(≥100 字)…",
    "en": "…(100+ chars)…"
  },
  "sections": [           // REQUIRED. 2–4 modules. Each a focused aspect of the plugin.
    {
      "title":  { "zh": "能做什么", "en": "What it does" },
      "body":   { "zh": "多行用 \\n 分隔会渲染成要点列表", "en": "newline-separated -> bullet list" }
    },
    { "title": { "zh": "关键能力", "en": "Key capabilities" }, "body": { "zh": "…", "en": "…" } },
    { "title": { "zh": "怎么用",   "en": "How to use" },       "body": { "zh": "…", "en": "…" } }
  ],
  "history": [            // REQUIRED. Curated, newest first. Clean (no internal names).
    { "version": "0.1.0", "date": "2026-05-15", "notes": { "zh": "首版…", "en": "First release…" } }
  ]
}
```

## Rules

- **Write from the source, not the manifest blurb.** Read README / docs / SKILL.md /
  AGENT.md / persona + the real `server/**` & `src/**` before writing. Describe what the
  code actually does; mark unfinished features honestly ("规划中 / planned").
- **`summary` ≥ 100 characters** in each language; concrete, no marketing fluff.
- **2–4 `sections`** — split the description into modules (e.g. overview / capabilities /
  pipeline / how-to-use). A `body` with `\n` renders as a bullet list.
- **`history`** is curated and **must not contain internal org or vendor names**
  (individual handles, company names, or vendor churn — see studio mirror scrub gate).
  Derive it from real milestones, newest first.
- Keep it bilingual (`zh` + `en`) and in the site's neutral, factual tone.
