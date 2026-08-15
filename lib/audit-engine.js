/**
 * Mosaic Wellness — Deterministic Invoice Audit Engine
 * 
 * Processes finance_invoices.json against rate card and GST reference.
 * Produces finding ledger with financial impact calculations.
 * 
 * Core principle: Detection ≠ Financial Recovery.
 * Undercharges are flagged but contribute ₹0 to recovery.
 * Duplicate invoices suppress all line-level impacts.
 */

import invoicesData from '@/data/finance_invoices.json';
import rateCardData from '@/data/finance_rate_card.json';
import gstRefData from '@/data/finance_gst_reference.json';
import { createHash } from 'crypto';

// We use a simple hash for browser (no crypto needed at runtime since we pre-compute)
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(36);
}

export function runAudit() {
  const invoices = invoicesData;
  const rateCard = rateCardData;
  const gstRef = gstRefData;

  // Build O(1) reference indexes
  const rateMap = new Map();
  for (const [vendor, items] of Object.entries(rateCard)) {
    for (const [desc, price] of Object.entries(items)) {
      rateMap.set(`${vendor}|${desc}`, price);
    }
  }

  const gstMap = new Map();
  for (const [hsn, rate] of Object.entries(gstRef)) {
    gstMap.set(String(hsn), rate);
  }

  // ====== DUPLICATE DETECTION ======
  const fingerprints = new Map();

  for (const inv of invoices) {
    const sortedLines = [...inv.line_items].sort((a, b) => {
      if (a.description !== b.description) return a.description.localeCompare(b.description);
      if (a.quantity !== b.quantity) return a.quantity - b.quantity;
      return a.unit_price - b.unit_price;
    });

    const canonLines = sortedLines.map(li =>
      `${li.description}|${li.quantity}|${li.unit_price}|${li.amount}|${li.gst_rate}|${li.hsn_code}`
    );
    const fpStr = `${inv.vendor_name}|${canonLines.join('||')}|${inv.total}`;
    const fpHash = simpleHash(fpStr);

    if (!fingerprints.has(fpHash)) fingerprints.set(fpHash, []);
    fingerprints.get(fpHash).push(inv);
  }

  const duplicateIds = new Set();
  const duplicatePairs = {};
  const findings = [];
  let fid = 0;

  function addFinding(obj) {
    fid++;
    findings.push({ id: `F-${String(fid).padStart(4, '0')}`, ...obj });
  }

  for (const [, group] of fingerprints) {
    if (group.length > 1) {
      group.sort((a, b) => a.invoice_date.localeCompare(b.invoice_date) || a.invoice_id.localeCompare(b.invoice_id));
      const primary = group[0];
      for (let i = 1; i < group.length; i++) {
        const dup = group[i];
        duplicateIds.add(dup.invoice_id);
        duplicatePairs[dup.invoice_id] = primary.invoice_id;
        addFinding({
          invoiceId: dup.invoice_id,
          vendor: dup.vendor_name,
          category: 'DUPLICATE',
          status: 'OVERCHARGE',
          expected: 0,
          actual: dup.total,
          variance: dup.total,
          financialImpact: Math.round(dup.total * 100) / 100,
          explanation: `Duplicate of ${primary.invoice_id}. Full gross total is recoverable.`,
          suppressed: false,
        });
      }
    }
  }

  // ====== LINE-LEVEL AUDITS ======
  for (const inv of invoices) {
    const invId = inv.invoice_id;
    const vendor = inv.vendor_name;
    const isDup = duplicateIds.has(invId);
    let lineSum = 0;

    for (const li of inv.line_items) {
      const { description: desc, quantity: qty, unit_price: up, amount: amt, gst_rate: gstRate, hsn_code } = li;
      const hsn = String(hsn_code);
      lineSum += amt;
      const rateKey = `${vendor}|${desc}`;

      // SURCHARGE
      if (!rateMap.has(rateKey)) {
        const grossImpact = Math.round(amt * (1 + gstRate / 100) * 100) / 100;
        addFinding({
          invoiceId: invId, vendor, lineDesc: desc,
          category: 'SURCHARGE', status: 'OVERCHARGE',
          expected: 0, actual: amt, variance: amt,
          financialImpact: isDup ? 0 : grossImpact,
          explanation: `Uncontracted charge: "${desc}" not in ${vendor} rate card. Base ₹${amt.toLocaleString('en-IN', { minimumFractionDigits: 2 })} + GST ${gstRate}% = ₹${grossImpact.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
          suppressed: isDup,
        });
      } else {
        // CALCULATION
        const expectedAmt = Math.round(qty * up * 100) / 100;
        const calcVar = Math.round((amt - expectedAmt) * 100) / 100;
        if (Math.abs(calcVar) > 0.01) {
          const status = calcVar > 0 ? 'OVERCHARGE' : 'UNDERCHARGE';
          const impact = (calcVar > 0 && !isDup) ? calcVar : 0;
          addFinding({
            invoiceId: invId, vendor, lineDesc: desc,
            category: 'CALCULATION', status,
            expected: expectedAmt, actual: amt, variance: calcVar,
            financialImpact: Math.round(impact * 100) / 100,
            explanation: `${qty} × ₹${up.toLocaleString('en-IN', { minimumFractionDigits: 2 })} = ₹${expectedAmt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}, billed ₹${amt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
            suppressed: isDup && calcVar > 0,
          });
        }
      }

      // GST
      if (gstMap.has(hsn)) {
        const expectedGst = gstMap.get(hsn);
        const gstVar = gstRate - expectedGst;
        if (Math.abs(gstVar) > 0.001) {
          const gstImpact = Math.round(amt * Math.abs(gstVar) / 100 * 100) / 100;
          const status = gstVar > 0 ? 'OVERCHARGE' : 'UNDERCHARGE';
          const impact = (gstVar > 0 && !isDup) ? gstImpact : 0;
          addFinding({
            invoiceId: invId, vendor, lineDesc: desc,
            category: 'GST', status,
            expected: expectedGst, actual: gstRate, variance: gstVar,
            financialImpact: Math.round(impact * 100) / 100,
            explanation: `HSN ${hsn}: expected ${expectedGst}%, billed ${gstRate}%`,
            suppressed: isDup && gstVar > 0,
          });
        }
      }
    }

    // SUBTOTAL
    const calcSubtotal = Math.round(lineSum * 100) / 100;
    const subVar = Math.round((inv.subtotal - calcSubtotal) * 100) / 100;
    if (Math.abs(subVar) > 0.01) {
      const status = subVar > 0 ? 'OVERCHARGE' : 'UNDERCHARGE';
      const impact = (subVar > 0 && !isDup) ? subVar : 0;
      addFinding({
        invoiceId: invId, vendor,
        category: 'SUBTOTAL', status,
        expected: calcSubtotal, actual: inv.subtotal, variance: subVar,
        financialImpact: Math.round(impact * 100) / 100,
        explanation: `Lines sum ₹${calcSubtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}, stated ₹${inv.subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
        suppressed: isDup && subVar > 0,
      });
    }
  }

  // ====== AGGREGATION ======
  const categories = {};
  for (const f of findings) {
    if (!categories[f.category]) {
      categories[f.category] = { total: 0, count: 0, overcharges: 0, undercharges: 0 };
    }
    categories[f.category].count++;
    categories[f.category].total += f.financialImpact;
    if (f.status === 'OVERCHARGE') categories[f.category].overcharges++;
    if (f.status === 'UNDERCHARGE') categories[f.category].undercharges++;
  }

  const grandTotal = Object.values(categories).reduce((s, c) => s + c.total, 0);
  const flaggedInvoices = new Set(findings.filter(f => f.financialImpact > 0).map(f => f.invoiceId));

  for (const [, data] of Object.entries(categories)) {
    data.total = Math.round(data.total * 100) / 100;
    data.pct = grandTotal > 0 ? Math.round(data.total / grandTotal * 10000) / 100 : 0;
  }

  // Invoice summaries
  const invoiceSummaries = invoices.map(inv => {
    const invFindings = findings.filter(f => f.invoiceId === inv.invoice_id);
    const totalImpact = invFindings.reduce((s, f) => s + f.financialImpact, 0);
    const cats = [...new Set(invFindings.filter(f => f.financialImpact > 0).map(f => f.category))];
    return {
      id: inv.invoice_id,
      vendor: inv.vendor_name,
      vendorType: inv.vendor_type,
      date: inv.invoice_date,
      subtotal: inv.subtotal,
      gstAmount: inv.gst_amount,
      total: inv.total,
      lines: inv.line_items,
      lineCount: inv.line_items.length,
      impact: Math.round(totalImpact * 100) / 100,
      cats,
      dupOf: duplicatePairs[inv.invoice_id] || null,
    };
  });

  return {
    summary: {
      totalInvoices: invoices.length,
      totalLines: invoices.reduce((s, i) => s + i.line_items.length, 0),
      flaggedInvoices: flaggedInvoices.size,
      totalFindings: findings.length,
      totalRecovery: Math.round(grandTotal * 100) / 100,
      categories,
    },
    findings,
    invoices: invoiceSummaries,
    duplicatePairs,
  };
}
