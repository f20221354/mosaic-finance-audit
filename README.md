# Mosaic Wellness — Invoice Audit Intelligence

Deterministic invoice-audit system for Mosaic Wellness Accounts Payable. Processes 508 invoices (1,811 line items) across 15 vendors, cross-references against contracted rate card and GST reference, and quantifies recoverable overcharge.

## Final Answer

**₹1,75,64,529.47** — Total recoverable overcharge.

| Category | Recovery (₹) | % of Total | Findings |
|----------|-------------:|-----------:|---------:|
| Duplicate Billing | 1,62,56,034.78 | 92.55% | 8 |
| GST Mismatch | 12,00,082.26 | 6.83% | 15 |
| Calculation Error | 61,181.58 | 0.35% | 23 |
| Uncontracted Surcharge | 29,044.50 | 0.17% | 12 |
| Subtotal Mismatch | 18,186.35 | 0.10% | 7 |

## Architecture

```
Source Data (3 JSONs)  →  Audit Engine (6 rules)  →  Finding Ledger  →  Recovery Ledger  →  Dashboard
```

- **Calculation Audit**: qty × unit_price vs billed amount
- **GST Audit**: HSN code lookup vs billed GST rate
- **Rate Card Audit**: contracted price vs billed price
- **Surcharge Audit**: uncontracted vendor+description combos
- **Subtotal Audit**: Σ line amounts vs stated subtotal
- **Duplicate Audit**: canonical fingerprint matching (suppresses line-level impacts)

## Quick Start

```bash
npm install
npm run dev       # → http://localhost:3000
npm run build     # → static export in /out
```

## Deploy to Vercel

```bash
# Option 1: Vercel CLI
npm i -g vercel
vercel

# Option 2: Push to GitHub → connect in vercel.com
git init
git add .
git commit -m "Mosaic Invoice Audit Intelligence"
git remote add origin https://github.com/YOUR_USERNAME/mosaic-finance-audit.git
git push -u origin main
# Then import at vercel.com/new
```

## Project Structure

```
mosaic-finance-audit/
├── app/
│   ├── layout.js          # Root layout
│   ├── globals.css        # Design tokens
│   └── page.js            # Dashboard (audit engine + UI)
├── data/
│   ├── finance_invoices.json
│   ├── finance_rate_card.json
│   └── finance_gst_reference.json
├── lib/
│   └── audit-engine.js    # Standalone audit engine module
├── scripts/
│   └── run_audit.py       # Python audit engine (CLI)
├── docs/
│   └── audit-specification.md
├── next.config.js
├── vercel.json
└── README.md
```

## Key Design Principles

1. **Detection ≠ Financial Recovery** — Undercharges are flagged but contribute ₹0.
2. **Duplicate Suppression** — Duplicate invoices suppress line-level impacts to prevent double-counting.
3. **No hard-coded answers** — Everything calculated from source data.
4. **Every finding has evidence** — Expected vs actual, variance, and explanation.
5. **No database, no backend, no login** — Pure client-side static app.

## Technology

- **Next.js 14** (static export)
- **React 18** (client-side rendering)
- **Vercel** (deployment)
- **Python 3** (standalone audit engine for CLI verification)
