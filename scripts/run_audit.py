#!/usr/bin/env python3
"""
Mosaic Wellness — Deterministic Invoice Audit Engine
Processes finance_invoices.json against rate card and GST reference.
Outputs audit_results.json with all findings and financial recovery.
"""

import json
import hashlib
import csv
import sys
import os
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"
OUTPUT_DIR = Path(__file__).parent.parent / "output"


def load_data():
    """Load and validate all three source datasets."""
    with open(DATA_DIR / "finance_invoices.json") as f:
        invoices = json.load(f)
    with open(DATA_DIR / "finance_rate_card.json") as f:
        rate_card = json.load(f)
    with open(DATA_DIR / "finance_gst_reference.json") as f:
        gst_ref = json.load(f)

    # Validation
    assert isinstance(invoices, list), "Invoices must be a list"
    assert len(invoices) > 0, "No invoices found"
    for inv in invoices:
        assert "invoice_id" in inv, f"Missing invoice_id"
        assert "vendor_name" in inv, f"Missing vendor_name in {inv.get('invoice_id')}"
        assert "line_items" in inv, f"Missing line_items in {inv['invoice_id']}"
        for li in inv["line_items"]:
            for field in ["description", "quantity", "unit_price", "amount", "gst_rate", "hsn_code"]:
                assert field in li, f"Missing {field} in line item of {inv['invoice_id']}"

    print(f"[DATA] Loaded {len(invoices)} invoices")
    print(f"[DATA] Loaded {sum(len(v) for v in rate_card.values())} rate card entries across {len(rate_card)} vendors")
    print(f"[DATA] Loaded {len(gst_ref)} GST reference entries")

    return invoices, rate_card, gst_ref


def build_indexes(rate_card, gst_ref):
    """Create O(1) lookup maps for rate card and GST reference."""
    rate_map = {}
    for vendor, items in rate_card.items():
        for desc, price in items.items():
            rate_map[f"{vendor}|{desc}"] = price

    gst_map = {str(k): v for k, v in gst_ref.items()}

    return rate_map, gst_map


def detect_duplicates(invoices):
    """
    Detect duplicate invoices using canonical fingerprinting.
    Fingerprint = vendor + sorted line items (desc, qty, unit_price, amount, gst_rate, hsn) + total.
    Does NOT use invoice_id or date as identity.
    """
    fingerprints = {}

    for inv in invoices:
        canon_lines = []
        for li in sorted(inv["line_items"], key=lambda x: (x["description"], x["quantity"], x["unit_price"])):
            canon_lines.append(
                f"{li['description']}|{li['quantity']}|{li['unit_price']}|{li['amount']}|{li['gst_rate']}|{li['hsn_code']}"
            )
        fp_str = f"{inv['vendor_name']}|{'||'.join(canon_lines)}|{inv['total']}"
        fp_hash = hashlib.sha256(fp_str.encode()).hexdigest()
        fingerprints.setdefault(fp_hash, []).append(inv)

    duplicate_ids = set()
    duplicate_pairs = {}
    findings = []

    for fp_hash, group in fingerprints.items():
        if len(group) > 1:
            group.sort(key=lambda x: (x["invoice_date"], x["invoice_id"]))
            primary = group[0]
            for dup in group[1:]:
                duplicate_ids.add(dup["invoice_id"])
                duplicate_pairs[dup["invoice_id"]] = primary["invoice_id"]
                findings.append({
                    "invoiceId": dup["invoice_id"],
                    "vendor": dup["vendor_name"],
                    "category": "DUPLICATE",
                    "status": "OVERCHARGE",
                    "expected": 0,
                    "actual": dup["total"],
                    "variance": dup["total"],
                    "financialImpact": round(dup["total"], 2),
                    "explanation": f"Duplicate of {primary['invoice_id']}. Full gross total is recoverable.",
                    "suppressed": False,
                })

    print(f"[DUPLICATE] Found {len(duplicate_ids)} duplicate invoices")
    return duplicate_ids, duplicate_pairs, findings


def run_line_audits(invoices, rate_map, gst_map, duplicate_ids):
    """Run calculation, GST, surcharge audits on every line item."""
    findings = []

    for inv in invoices:
        inv_id = inv["invoice_id"]
        vendor = inv["vendor_name"]
        is_dup = inv_id in duplicate_ids
        line_sum = 0.0

        for li in inv["line_items"]:
            desc = li["description"]
            qty = li["quantity"]
            up = li["unit_price"]
            amt = li["amount"]
            gst_rate = li["gst_rate"]
            hsn = str(li["hsn_code"])
            line_sum += amt

            rate_key = f"{vendor}|{desc}"

            # --- SURCHARGE CHECK ---
            if rate_key not in rate_map:
                gross_impact = round(amt * (1 + gst_rate / 100), 2)
                findings.append({
                    "invoiceId": inv_id,
                    "vendor": vendor,
                    "lineDesc": desc,
                    "category": "SURCHARGE",
                    "status": "OVERCHARGE",
                    "expected": 0,
                    "actual": amt,
                    "variance": amt,
                    "financialImpact": gross_impact if not is_dup else 0,
                    "explanation": f'Uncontracted charge: "{desc}" not in {vendor} rate card. '
                                   f'Base ₹{amt:,.2f} + GST {gst_rate}% = ₹{gross_impact:,.2f}',
                    "suppressed": is_dup,
                })
            else:
                # --- CALCULATION CHECK ---
                expected_amt = round(qty * up, 2)
                calc_var = round(amt - expected_amt, 2)
                if abs(calc_var) > 0.01:
                    status = "OVERCHARGE" if calc_var > 0 else "UNDERCHARGE"
                    impact = calc_var if (calc_var > 0 and not is_dup) else 0
                    findings.append({
                        "invoiceId": inv_id,
                        "vendor": vendor,
                        "lineDesc": desc,
                        "category": "CALCULATION",
                        "status": status,
                        "expected": expected_amt,
                        "actual": amt,
                        "variance": calc_var,
                        "financialImpact": round(impact, 2),
                        "explanation": f"{qty} × ₹{up:,.2f} = ₹{expected_amt:,.2f}, billed ₹{amt:,.2f}",
                        "suppressed": is_dup and calc_var > 0,
                    })

            # --- GST CHECK ---
            if hsn in gst_map:
                expected_gst = gst_map[hsn]
                gst_var = gst_rate - expected_gst
                if abs(gst_var) > 0.001:
                    gst_impact = round(amt * abs(gst_var) / 100, 2)
                    status = "OVERCHARGE" if gst_var > 0 else "UNDERCHARGE"
                    impact = gst_impact if (gst_var > 0 and not is_dup) else 0
                    findings.append({
                        "invoiceId": inv_id,
                        "vendor": vendor,
                        "lineDesc": desc,
                        "category": "GST",
                        "status": status,
                        "expected": expected_gst,
                        "actual": gst_rate,
                        "variance": gst_var,
                        "financialImpact": round(impact, 2),
                        "explanation": f"HSN {hsn}: expected {expected_gst}%, billed {gst_rate}%",
                        "suppressed": is_dup and gst_var > 0,
                    })

        # --- SUBTOTAL CHECK ---
        calc_subtotal = round(line_sum, 2)
        sub_var = round(inv["subtotal"] - calc_subtotal, 2)
        if abs(sub_var) > 0.01:
            status = "OVERCHARGE" if sub_var > 0 else "UNDERCHARGE"
            impact = sub_var if (sub_var > 0 and not is_dup) else 0
            findings.append({
                "invoiceId": inv_id,
                "vendor": vendor,
                "category": "SUBTOTAL",
                "status": status,
                "expected": calc_subtotal,
                "actual": inv["subtotal"],
                "variance": sub_var,
                "financialImpact": round(impact, 2),
                "explanation": f"Lines sum ₹{calc_subtotal:,.2f}, stated ₹{inv['subtotal']:,.2f}",
                "suppressed": is_dup and sub_var > 0,
            })

    return findings


def aggregate_results(invoices, all_findings, duplicate_pairs):
    """Aggregate findings into summary and output structure."""
    # Assign IDs
    for i, f in enumerate(all_findings, 1):
        f["id"] = f"F-{i:04d}"

    # Category totals
    categories = {}
    for f in all_findings:
        cat = f["category"]
        if cat not in categories:
            categories[cat] = {"total": 0, "count": 0, "overcharges": 0, "undercharges": 0}
        categories[cat]["count"] += 1
        categories[cat]["total"] += f["financialImpact"]
        if f["status"] == "OVERCHARGE":
            categories[cat]["overcharges"] += 1
        elif f["status"] == "UNDERCHARGE":
            categories[cat]["undercharges"] += 1

    grand_total = sum(c["total"] for c in categories.values())
    flagged = set(f["invoiceId"] for f in all_findings if f["financialImpact"] > 0)

    # Category percentages
    for cat, data in categories.items():
        data["total"] = round(data["total"], 2)
        data["pct"] = round(data["total"] / grand_total * 100, 2) if grand_total > 0 else 0

    summary = {
        "totalInvoices": len(invoices),
        "totalLines": sum(len(inv["line_items"]) for inv in invoices),
        "flaggedInvoices": len(flagged),
        "totalFindings": len(all_findings),
        "totalRecovery": round(grand_total, 2),
        "categories": categories,
    }

    return summary


def main():
    print("=" * 60)
    print("MOSAIC WELLNESS — INVOICE AUDIT ENGINE")
    print("=" * 60)

    invoices, rate_card, gst_ref = load_data()
    rate_map, gst_map = build_indexes(rate_card, gst_ref)
    dup_ids, dup_pairs, dup_findings = detect_duplicates(invoices)
    line_findings = run_line_audits(invoices, rate_map, gst_map, dup_ids)
    all_findings = dup_findings + line_findings
    summary = aggregate_results(invoices, all_findings, dup_pairs)

    # Print results
    print(f"\n{'='*60}")
    print(f"AUDIT RESULTS")
    print(f"{'='*60}")
    print(f"Invoices audited:     {summary['totalInvoices']}")
    print(f"Line items processed: {summary['totalLines']}")
    print(f"Flagged invoices:     {summary['flaggedInvoices']}")
    print(f"Total findings:       {summary['totalFindings']}")
    print(f"Total recovery:       ₹{summary['totalRecovery']:,.2f}")
    print()

    cat_order = ["DUPLICATE", "GST", "CALCULATION", "SURCHARGE", "SUBTOTAL"]
    for cat in cat_order:
        if cat in summary["categories"]:
            c = summary["categories"][cat]
            print(f"  {cat:20s}  ₹{c['total']:>14,.2f}  ({c['pct']:5.2f}%)  [{c['count']} findings]")

    # Save results
    OUTPUT_DIR.mkdir(exist_ok=True)

    output = {
        "summary": summary,
        "findings": all_findings,
        "duplicatePairs": dup_pairs,
    }
    with open(OUTPUT_DIR / "audit_results.json", "w") as f:
        json.dump(output, f, indent=2)

    # CSV export
    with open(OUTPUT_DIR / "audit_findings.csv", "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            "Finding ID", "Invoice", "Vendor", "Category", "Status",
            "Line Description", "Expected", "Actual", "Variance",
            "Financial Impact (₹)", "Explanation", "Suppressed"
        ])
        for finding in all_findings:
            writer.writerow([
                finding["id"],
                finding["invoiceId"],
                finding["vendor"],
                finding["category"],
                finding["status"],
                finding.get("lineDesc", ""),
                finding.get("expected", ""),
                finding.get("actual", ""),
                finding.get("variance", ""),
                finding["financialImpact"],
                finding["explanation"],
                finding["suppressed"],
            ])

    print(f"\n[OUTPUT] audit_results.json → {OUTPUT_DIR / 'audit_results.json'}")
    print(f"[OUTPUT] audit_findings.csv → {OUTPUT_DIR / 'audit_findings.csv'}")
    print(f"\n{'='*60}")
    print(f"FINAL RECOVERABLE OVERCHARGE: ₹{summary['totalRecovery']:,.2f}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
