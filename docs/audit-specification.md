# Mosaic Wellness — Invoice Audit Specification

## 1. Objective

Automated Accounts Payable invoice-audit system for Mosaic Wellness finance dataset. Processes 508 invoices (1,811 line items) across 15 vendors, cross-references against contracted rate card and GST reference, detects anomalies, and quantifies recoverable overcharge.

## 2. Source Data

| Dataset | File | Purpose |
|---------|------|---------|
| Invoices | `finance_invoices.json` | 508 invoices, 1,811 line items |
| Rate Card | `finance_rate_card.json` | Contracted pricing for 15 vendors × 7 items |
| GST Reference | `finance_gst_reference.json` | 14 HSN codes with expected GST rates |

## 3. Core Principle: Detection ≠ Financial Recovery

Every finding has two dimensions:
- **Audit Status**: Is there an inconsistency? (OVERCHARGE / UNDERCHARGE / MATCH)
- **Financial Impact**: Does the inconsistency cause the company to pay more? (₹ amount or ₹0)

Undercharges are audit findings but contribute ₹0 to recovery.

## 4. Audit Engines

### Rule 1 — Calculation Audit
```
expected_amount = quantity × unit_price
variance = invoice_amount - expected_amount

variance > 0 → OVERCHARGE (impact = variance)
variance < 0 → UNDERCHARGE (impact = ₹0)
variance = 0 → MATCH (impact = ₹0)
```

### Rule 2 — GST Audit
```
expected_gst_rate = GST_reference[HSN_code]
gst_variance = invoice_gst_rate - expected_gst_rate

If gst_variance > 0:
  gst_overcharge = taxable_amount × (variance / 100)
  Status: GST OVERCHARGE

If gst_variance < 0:
  Status: GST UNDERCHARGE, impact = ₹0

If HSN not in reference:
  Status: UNKNOWN_HSN, impact = ₹0
```

### Rule 3 — Surcharge / Uncontracted Charge Audit
```
If vendor + description NOT IN rate_card:
  Status: UNCONTRACTED_SURCHARGE
  Impact = line_amount × (1 + gst_rate / 100)
```
Both base charge and billed GST are unauthorized.

### Rule 4 — Subtotal Audit
```
calculated_subtotal = Σ(line_item.amount)
variance = invoice.subtotal - calculated_subtotal

variance > 0 → HEADER OVERSTATEMENT (impact = variance)
variance < 0 → HEADER UNDERSTATEMENT (impact = ₹0)
```

### Rule 5 — Duplicate Invoice Audit

**Fingerprint**: vendor + sorted(line descriptions, quantities, unit prices, amounts, GST rates, HSN codes) + invoice total.

**Do NOT use** invoice_id or invoice_date as identity fields.

Group by fingerprint. Sort by date. Earliest = primary, later = duplicate.

**Impact**: duplicate invoice gross total.

**Critical**: Once duplicate, suppress all line-level financial impacts to prevent double-counting.

## 5. Anti-Double-Counting Rules

1. Rate card and calculation audits share the same monetary dimension — coordinate to avoid counting the same variance twice.
2. Duplicate invoices: suppress all line-level impacts (GST, calculation, surcharge, subtotal) on the duplicate. Only the duplicate's gross total counts.

## 6. Finding Ledger Schema

```typescript
interface AuditFinding {
  id: string;
  invoiceId: string;
  vendor: string;
  lineDesc?: string;
  category: "CALCULATION" | "GST" | "SURCHARGE" | "SUBTOTAL" | "DUPLICATE";
  status: "OVERCHARGE" | "UNDERCHARGE" | "MATCH" | "UNKNOWN";
  expected?: number;
  actual?: number;
  variance?: number;
  financialImpact: number;
  explanation: string;
  suppressed: boolean;
}
```

## 7. Final Recovery Calculation

```
Gross positive findings
  → Duplicate suppression
    → Final recovery ledger
      → SUM(financialImpact)
        → FINAL OVERCHARGE
```

The final number is never hard-coded. It is independently calculated from source data.
