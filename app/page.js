'use client';

import { useState, useMemo, useCallback, useEffect } from 'react';
import invoicesRaw from '@/data/finance_invoices.json';
import rateCardRaw from '@/data/finance_rate_card.json';
import gstRefRaw from '@/data/finance_gst_reference.json';

// ====== INLINE AUDIT ENGINE (no crypto dependency) ======
function computeAudit() {
  const invoices = invoicesRaw;
  const rateMap = new Map();
  for (const [vendor, items] of Object.entries(rateCardRaw)) {
    for (const [desc, price] of Object.entries(items)) {
      rateMap.set(`${vendor}|${desc}`, price);
    }
  }
  const gstMap = new Map();
  for (const [hsn, rate] of Object.entries(gstRefRaw)) {
    gstMap.set(String(hsn), rate);
  }

  // Duplicates
  const fps = new Map();
  for (const inv of invoices) {
    const sl = [...inv.line_items].sort((a, b) =>
      a.description.localeCompare(b.description) || a.quantity - b.quantity || a.unit_price - b.unit_price
    );
    const fp = `${inv.vendor_name}|${sl.map(l => `${l.description}|${l.quantity}|${l.unit_price}|${l.amount}|${l.gst_rate}|${l.hsn_code}`).join('||')}|${inv.total}`;
    if (!fps.has(fp)) fps.set(fp, []);
    fps.get(fp).push(inv);
  }

  const dupIds = new Set();
  const dupPairs = {};
  const findings = [];
  let fid = 0;
  const add = (obj) => { fid++; findings.push({ id: `F-${String(fid).padStart(4, '0')}`, ...obj }); };

  for (const [, grp] of fps) {
    if (grp.length > 1) {
      grp.sort((a, b) => a.invoice_date.localeCompare(b.invoice_date) || a.invoice_id.localeCompare(b.invoice_id));
      for (let i = 1; i < grp.length; i++) {
        const d = grp[i];
        dupIds.add(d.invoice_id);
        dupPairs[d.invoice_id] = grp[0].invoice_id;
        add({ invoiceId: d.invoice_id, vendor: d.vendor_name, category: 'DUPLICATE', status: 'OVERCHARGE', expected: 0, actual: d.total, variance: d.total, financialImpact: Math.round(d.total * 100) / 100, explanation: `Duplicate of ${grp[0].invoice_id}. Full gross total is recoverable.`, suppressed: false });
      }
    }
  }

  for (const inv of invoices) {
    const { invoice_id: iid, vendor_name: v } = inv;
    const isDup = dupIds.has(iid);
    let lsum = 0;
    for (const li of inv.line_items) {
      const { description: d, quantity: q, unit_price: u, amount: a, gst_rate: gr, hsn_code } = li;
      const hsn = String(hsn_code);
      lsum += a;
      const rk = `${v}|${d}`;
      if (!rateMap.has(rk)) {
        const gi = Math.round(a * (1 + gr / 100) * 100) / 100;
        add({ invoiceId: iid, vendor: v, lineDesc: d, category: 'SURCHARGE', status: 'OVERCHARGE', expected: 0, actual: a, variance: a, financialImpact: isDup ? 0 : gi, explanation: `Uncontracted: "${d}". Base + GST ${gr}% = ₹${gi.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, suppressed: isDup });
      } else {
        const ea = Math.round(q * u * 100) / 100;
        const cv = Math.round((a - ea) * 100) / 100;
        if (Math.abs(cv) > 0.01) {
          add({ invoiceId: iid, vendor: v, lineDesc: d, category: 'CALCULATION', status: cv > 0 ? 'OVERCHARGE' : 'UNDERCHARGE', expected: ea, actual: a, variance: cv, financialImpact: cv > 0 && !isDup ? Math.round(cv * 100) / 100 : 0, explanation: `${q} × ₹${u.toLocaleString('en-IN', { minimumFractionDigits: 2 })} = ₹${ea.toLocaleString('en-IN', { minimumFractionDigits: 2 })}, billed ₹${a.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, suppressed: isDup && cv > 0 });
        }
      }
      if (gstMap.has(hsn)) {
        const eg = gstMap.get(hsn);
        const gv = gr - eg;
        if (Math.abs(gv) > 0.001) {
          const gi2 = Math.round(a * Math.abs(gv) / 100 * 100) / 100;
          add({ invoiceId: iid, vendor: v, lineDesc: d, category: 'GST', status: gv > 0 ? 'OVERCHARGE' : 'UNDERCHARGE', expected: eg, actual: gr, variance: gv, financialImpact: gv > 0 && !isDup ? gi2 : 0, explanation: `HSN ${hsn}: expected ${eg}%, billed ${gr}%`, suppressed: isDup && gv > 0 });
        }
      }
    }
    const cs = Math.round(lsum * 100) / 100;
    const sv = Math.round((inv.subtotal - cs) * 100) / 100;
    if (Math.abs(sv) > 0.01) {
      add({ invoiceId: iid, vendor: v, category: 'SUBTOTAL', status: sv > 0 ? 'OVERCHARGE' : 'UNDERCHARGE', expected: cs, actual: inv.subtotal, variance: sv, financialImpact: sv > 0 && !isDup ? Math.round(sv * 100) / 100 : 0, explanation: `Lines sum ₹${cs.toLocaleString('en-IN', { minimumFractionDigits: 2 })}, stated ₹${inv.subtotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, suppressed: isDup && sv > 0 });
    }
  }

  const cats = {};
  for (const f of findings) {
    if (!cats[f.category]) cats[f.category] = { total: 0, count: 0 };
    cats[f.category].count++;
    cats[f.category].total += f.financialImpact;
  }
  const gt = Object.values(cats).reduce((s, c) => s + c.total, 0);
  for (const c of Object.values(cats)) { c.total = Math.round(c.total * 100) / 100; c.pct = gt > 0 ? Math.round(c.total / gt * 10000) / 100 : 0; }
  const flagged = new Set(findings.filter(f => f.financialImpact > 0).map(f => f.invoiceId));

  const invSummaries = invoices.map(inv => {
    const fs = findings.filter(f => f.invoiceId === inv.invoice_id);
    return {
      id: inv.invoice_id, vendor: inv.vendor_name, type: inv.vendor_type,
      date: inv.invoice_date, subtotal: inv.subtotal, gst: inv.gst_amount, total: inv.total,
      lines: inv.line_items, impact: Math.round(fs.reduce((s, f) => s + f.financialImpact, 0) * 100) / 100,
      cats: [...new Set(fs.filter(f => f.financialImpact > 0).map(f => f.category))],
      dupOf: dupPairs[inv.invoice_id] || null,
    };
  });

  return {
    summary: { totalInvoices: invoices.length, totalLines: invoices.reduce((s, i) => s + i.line_items.length, 0), flaggedInvoices: flagged.size, totalFindings: findings.length, totalRecovery: Math.round(gt * 100) / 100, categories: cats },
    findings, invoices: invSummaries, duplicatePairs: dupPairs,
  };
}

// ====== HELPERS ======
const fmt = (n) => '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtN = (n) => n.toLocaleString('en-IN');

// Category hues resolve through CSS custom properties so each theme gets its own
// validated step — the dark values are too light to hold contrast as text on a
// white card. See the token block in globals.css.
const CAT_COLORS = { DUPLICATE: 'var(--cat-duplicate)', GST: 'var(--cat-gst)', CALCULATION: 'var(--cat-calculation)', SURCHARGE: 'var(--cat-surcharge)', SUBTOTAL: 'var(--cat-subtotal)' };
const CAT_BG = { DUPLICATE: 'var(--cat-duplicate-bg)', GST: 'var(--cat-gst-bg)', CALCULATION: 'var(--cat-calculation-bg)', SURCHARGE: 'var(--cat-surcharge-bg)', SUBTOTAL: 'var(--cat-subtotal-bg)' };
const CAT_LABELS = { DUPLICATE: 'Duplicate Billing', GST: 'GST Mismatch', CALCULATION: 'Calculation Error', SURCHARGE: 'Uncontracted Charge', SUBTOTAL: 'Subtotal Mismatch' };
const CAT_ORDER = ['DUPLICATE', 'GST', 'CALCULATION', 'SURCHARGE', 'SUBTOTAL'];

// ====== STYLES ======
const S = {
  app: { maxWidth: 1360, margin: '0 auto', padding: 20 },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 0 24px', borderBottom: '1px solid var(--border)', marginBottom: 28, flexWrap: 'wrap', gap: 12 },
  logoBox: { display: 'flex', alignItems: 'center', gap: 12 },
  logoMark: { width: 36, height: 36, background: 'linear-gradient(135deg, var(--accent), var(--purple))', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, color: '#fff' },
  totalBadge: { background: 'var(--red-bg)', border: '1px solid var(--red-border)', padding: '8px 16px', borderRadius: 8, textAlign: 'right' },
  kpiRow: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 28 },
  kpi: { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 20 },
  catGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14, marginBottom: 28 },
  catCard: (active) => ({ background: 'var(--surface)', border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 10, padding: 16, cursor: 'pointer', transition: 'all 0.15s', position: 'relative', overflow: 'hidden', boxShadow: active ? '0 0 0 1px var(--accent)' : 'none' }),
  tableWrap: { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' },
  th: { padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid var(--border)', background: 'var(--surface2)', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' },
  td: { padding: '10px 16px', fontSize: 13, whiteSpace: 'nowrap' },
  tag: (bg, color) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: bg, color, marginRight: 4 }),
  overlay: (open) => ({ position: 'fixed', top: 0, right: 0, bottom: 0, width: 580, maxWidth: '100vw', background: 'var(--surface)', borderLeft: '1px solid var(--border)', zIndex: 100, overflowY: 'auto', transform: open ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 0.25s ease', boxShadow: 'var(--shadow-panel)' }),
  backdrop: (open) => ({ position: 'fixed', inset: 0, background: 'var(--backdrop)', zIndex: 99, opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none', transition: 'opacity 0.2s' }),
  btn: { padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500, fontFamily: 'inherit' },
  filterBtn: (active) => ({ padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer', border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`, background: active ? 'var(--accent)' : 'var(--surface2)', color: active ? '#fff' : 'var(--text2)', transition: 'all 0.15s' }),
  searchBox: { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 12px', color: 'var(--text)', fontSize: 13, width: 240, outline: 'none', fontFamily: 'inherit' },
};

// ====== MAIN COMPONENT ======
export default function Dashboard() {
  const data = useMemo(() => computeAudit(), []);
  const [catFilter, setCatFilter] = useState(null);
  const [vendorFilter, setVendorFilter] = useState('');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('impact');
  const [sortDir, setSortDir] = useState(-1);
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState(null);
  const perPage = 25;

  // Theme is read from the DOM after mount rather than during render: the
  // pre-paint script in layout.js is the source of truth, and touching
  // localStorage during render would desync the prerendered static HTML.
  const [theme, setTheme] = useState(null);
  useEffect(() => {
    setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
  }, []);

  // Read the live attribute rather than React state: the pre-paint script owns
  // data-theme, so the DOM is authoritative even if a click lands before the
  // mount effect has synced state.
  const toggleTheme = useCallback(() => {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('mosaic-theme', next); } catch (e) { /* storage unavailable */ }
    setTheme(next);
  }, []);

  const { summary: sum, findings, invoices, duplicatePairs } = data;
  const cats = sum.categories;
  const allVendors = useMemo(() => [...new Set(invoices.map(i => i.vendor))].sort(), [invoices]);

  const filtered = useMemo(() => {
    let list = invoices.filter(i => i.impact > 0 || i.cats.length > 0);
    if (catFilter) list = list.filter(i => i.cats.includes(catFilter));
    if (vendorFilter) list = list.filter(i => i.vendor === vendorFilter);
    if (search) { const s = search.toLowerCase(); list = list.filter(i => i.id.toLowerCase().includes(s) || i.vendor.toLowerCase().includes(s)); }
    list.sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (sortKey === 'date') { av = new Date(a.date); bv = new Date(b.date); }
      if (av < bv) return -sortDir;
      if (av > bv) return sortDir;
      return 0;
    });
    return list;
  }, [invoices, catFilter, vendorFilter, search, sortKey, sortDir]);

  const totalPages = Math.ceil(filtered.length / perPage);
  const pageInvs = filtered.slice((page - 1) * perPage, page * perPage);

  const handleSort = useCallback((key) => {
    setSortKey(prev => { if (prev === key) { setSortDir(d => d * -1); return prev; } setSortDir(-1); return key; });
    setPage(1);
  }, []);

  const handleCatFilter = useCallback((c) => { setCatFilter(prev => prev === c ? null : c); setPage(1); }, []);

  const exportCSV = useCallback(() => {
    const rows = [['Finding ID', 'Invoice', 'Vendor', 'Category', 'Status', 'Line Description', 'Expected', 'Actual', 'Variance', 'Financial Impact', 'Explanation', 'Suppressed']];
    findings.forEach(f => rows.push([f.id, f.invoiceId, f.vendor, f.category, f.status, f.lineDesc || '', f.expected ?? '', f.actual ?? '', f.variance ?? '', f.financialImpact, f.explanation, f.suppressed]));
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mosaic_audit_findings.csv';
    a.click();
  }, [findings]);

  // Vendor impact chart
  const vendorImpact = useMemo(() => {
    const map = {};
    invoices.forEach(i => { map[i.vendor] = (map[i.vendor] || 0) + i.impact; });
    return Object.entries(map).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  }, [invoices]);
  const maxVI = vendorImpact[0]?.[1] || 1;

  const totalBilled = useMemo(() => invoices.reduce((s, i) => s + i.total, 0), [invoices]);

  // Detail
  const detailInv = detailId ? invoices.find(i => i.id === detailId) : null;
  const detailFindings = detailId ? findings.filter(f => f.invoiceId === detailId) : [];

  return (
    <div style={S.app}>
      {/* HEADER */}
      <header style={S.header}>
        <div style={S.logoBox}>
          <div style={S.logoMark}>MA</div>
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 600, letterSpacing: -0.3 }}>Invoice Audit Intelligence</h1>
            <span style={{ color: 'var(--text3)', fontSize: 13 }}>Mosaic Wellness</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button
            type="button"
            onClick={toggleTheme}
            className="theme-toggle"
            aria-label="Toggle between light and dark theme"
            aria-pressed={theme === 'light'}
            title="Toggle light / dark theme"
          >
            <span className="to-light" aria-hidden="true">☀</span>
            <span className="to-dark" aria-hidden="true">☾</span>
          </button>
          <button onClick={exportCSV} style={{ ...S.btn, background: 'var(--accent)', color: '#fff' }}>↓ Export CSV</button>
          <div style={S.totalBadge}>
            <div style={{ fontSize: 11, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Total Recoverable</div>
            <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: 'var(--red)', marginTop: 2 }}>{fmt(sum.totalRecovery)}</div>
          </div>
        </div>
      </header>

      {/* KPIs */}
      <div style={S.kpiRow}>
        {[
          { label: 'Invoices Audited', value: fmtN(sum.totalInvoices), sub: `${fmtN(sum.totalLines)} line items processed` },
          { label: 'Flagged Invoices', value: fmtN(sum.flaggedInvoices), sub: `${(sum.flaggedInvoices / sum.totalInvoices * 100).toFixed(1)}% of total`, color: 'var(--red)' },
          { label: 'Audit Findings', value: fmtN(sum.totalFindings), sub: `Across ${CAT_ORDER.filter(c => cats[c]).length} categories` },
          { label: 'Recovery Rate', value: `${(sum.totalRecovery / totalBilled * 100).toFixed(2)}%`, sub: 'Of total billed amount' },
        ].map((kpi, i) => (
          <div key={i} style={S.kpi}>
            <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 500 }}>{kpi.label}</div>
            <div style={{ fontSize: 28, fontWeight: 700, marginTop: 6, letterSpacing: -1, color: kpi.color || 'var(--text)' }}>{kpi.value}</div>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>{kpi.sub}</div>
          </div>
        ))}
      </div>

      {/* CATEGORY CARDS */}
      <div style={S.catGrid}>
        {CAT_ORDER.filter(c => cats[c]).map(c => (
          <div key={c} style={S.catCard(catFilter === c)} onClick={() => handleCatFilter(c)}>
            <div style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>{CAT_LABELS[c]}</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4, color: CAT_COLORS[c] }}>{fmt(cats[c].total)}</div>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>{cats[c].pct}% of recovery</div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{cats[c].count} finding{cats[c].count > 1 ? 's' : ''}</div>
            <div style={{ position: 'absolute', bottom: 0, left: 0, height: 3, background: CAT_COLORS[c], borderRadius: '0 0 10px 10px', width: `${cats[c].pct}%`, transition: 'width 0.4s ease' }} />
          </div>
        ))}
      </div>

      {/* VENDOR CHART + SUMMARY */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 20, marginBottom: 28 }}>
        <div style={S.tableWrap}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ fontSize: 14, fontWeight: 600 }}>Leakage by Vendor</h3>
            <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>Top vendors by recoverable overcharge</p>
          </div>
          <div style={{ padding: '16px 20px' }}>
            {vendorImpact.slice(0, 8).map(([v, amt]) => (
              <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, marginBottom: 6 }}>
                <div style={{ width: 170, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v}>{v}</div>
                <div style={{ flex: 1, height: 22, background: 'var(--surface2)', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(amt / maxVI * 100).toFixed(1)}%`, background: CAT_COLORS.DUPLICATE, opacity: 0.7, borderRadius: 4, transition: 'width 0.5s ease' }} />
                </div>
                <div className="mono" style={{ width: 130, textAlign: 'right', fontWeight: 600, fontSize: 12, color: 'var(--red)' }}>{fmt(amt)}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={S.tableWrap}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ fontSize: 14, fontWeight: 600 }}>Audit Summary</h3>
            <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>Detection ≠ Financial Recovery</p>
          </div>
          <div style={{ padding: '16px 20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, paddingBottom: 8, borderBottom: '1px solid var(--border)', color: 'var(--text3)' }}>
              <span>Category</span><span>Recovery</span>
            </div>
            {CAT_ORDER.filter(c => cats[c]).map(c => (
              <div key={c} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '8px 0' }}>
                <span style={S.tag(CAT_BG[c], CAT_COLORS[c])}>{c}</span>
                <span className="mono" style={{ fontWeight: 600, color: CAT_COLORS[c] }}>{fmt(cats[c].total)}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, paddingTop: 10, borderTop: '2px solid var(--border)', fontWeight: 700 }}>
              <span>TOTAL</span>
              <span className="mono" style={{ color: 'var(--red)' }}>{fmt(sum.totalRecovery)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* INVOICE EXPLORER */}
      <div style={S.tableWrap}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600 }}>Invoice Explorer <span style={{ color: 'var(--text3)', fontSize: 12, fontWeight: 400 }}>({filtered.length} results)</span></h3>
          <input style={S.searchBox} placeholder="Search invoice ID or vendor…" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '12px 20px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', alignItems: 'center' }}>
          <button style={S.filterBtn(!catFilter)} onClick={() => handleCatFilter(null)}>All Categories</button>
          {CAT_ORDER.filter(c => cats[c]).map(c => (
            <button key={c} style={S.filterBtn(catFilter === c)} onClick={() => handleCatFilter(c)}>{CAT_LABELS[c]}</button>
          ))}
          <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />
          <select style={{ ...S.searchBox, width: 180 }} value={vendorFilter} onChange={e => { setVendorFilter(e.target.value); setPage(1); }}>
            <option value="">All Vendors</option>
            {allVendors.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {[['id', 'Invoice'], ['vendor', 'Vendor'], ['date', 'Date'], [null, 'Issues'], ['total', 'Billed'], ['impact', 'Recovery']].map(([key, label]) => (
                  <th key={label} style={{ ...S.th, textAlign: key === 'total' || key === 'impact' ? 'right' : 'left' }} onClick={key ? () => { handleSort(key); } : undefined}>
                    {label} {sortKey === key ? (sortDir > 0 ? '↑' : '↓') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageInvs.map(inv => (
                <tr key={inv.id} onClick={() => setDetailId(inv.id)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer', transition: 'background 0.1s' }} onMouseEnter={e => e.currentTarget.style.background = 'var(--surface2)'} onMouseLeave={e => e.currentTarget.style.background = ''}>
                  <td className="mono" style={{ ...S.td, fontSize: 12, fontWeight: 500 }}>{inv.id}</td>
                  <td style={S.td}>{inv.vendor}</td>
                  <td style={{ ...S.td, color: 'var(--text3)' }}>{new Date(inv.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td style={S.td}>{inv.cats.length > 0 ? inv.cats.map(c => <span key={c} style={S.tag(CAT_BG[c], CAT_COLORS[c])}>{c}</span>) : <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                  <td className="mono" style={{ ...S.td, textAlign: 'right', color: 'var(--text3)' }}>{fmt(inv.total)}</td>
                  <td className="mono" style={{ ...S.td, textAlign: 'right', color: inv.impact > 0 ? 'var(--red)' : 'var(--text3)', fontWeight: inv.impact > 0 ? 700 : 400 }}>{inv.impact > 0 ? fmt(inv.impact) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderTop: '1px solid var(--border)' }}>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>Showing {(page - 1) * perPage + 1}–{Math.min(page * perPage, filtered.length)} of {filtered.length}</div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button style={{ ...S.btn, padding: '5px 10px', fontSize: 12, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text2)', opacity: page <= 1 ? 0.3 : 1 }} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹ Prev</button>
            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
              let p = i + 1;
              if (totalPages > 5) {
                if (page <= 3) p = i + 1;
                else if (page >= totalPages - 2) p = totalPages - 4 + i;
                else p = page - 2 + i;
              }
              return <button key={p} style={{ ...S.btn, padding: '5px 10px', fontSize: 12, border: `1px solid ${page === p ? 'var(--accent)' : 'var(--border)'}`, background: page === p ? 'var(--accent)' : 'var(--surface2)', color: page === p ? '#fff' : 'var(--text2)' }} onClick={() => setPage(p)}>{p}</button>;
            })}
            <button style={{ ...S.btn, padding: '5px 10px', fontSize: 12, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text2)', opacity: page >= totalPages ? 0.3 : 1 }} disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next ›</button>
          </div>
        </div>
      </div>

      {/* DETAIL PANEL */}
      <div style={S.backdrop(!!detailId)} onClick={() => setDetailId(null)} />
      <div style={S.overlay(!!detailId)}>
        {detailInv && (
          <>
            <div style={{ padding: 20, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
              <h2 style={{ fontSize: 16, fontWeight: 600 }}>{detailInv.id} <span style={{ color: 'var(--text3)', fontSize: 13, fontWeight: 400 }}>— {detailInv.vendor}</span></h2>
              <button onClick={() => setDetailId(null)} style={{ ...S.btn, background: 'none', border: '1px solid var(--border)', color: 'var(--text2)', padding: '6px 10px' }}>✕ Close</button>
            </div>
            <div style={{ padding: 20 }}>
              {/* Overview */}
              <div style={{ marginBottom: 24 }}>
                <h4 style={{ fontSize: 12, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600, marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>Invoice Overview</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {[
                    ['Vendor', detailInv.vendor], ['Type', detailInv.type.replace('_', ' ')],
                    ['Date', new Date(detailInv.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })],
                    ['Line Items', detailInv.lines.length],
                    ['Subtotal', fmt(detailInv.subtotal)], ['GST', fmt(detailInv.gst)],
                    ['Total Billed', fmt(detailInv.total)], ['Recoverable', fmt(detailInv.impact)],
                  ].map(([label, val], i) => (
                    <div key={i}>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 2 }}>{label}</div>
                      <div className={i >= 4 ? 'mono' : ''} style={{ fontSize: 14, fontWeight: 600, color: label === 'Recoverable' ? 'var(--red)' : 'var(--text)', textTransform: label === 'Type' ? 'capitalize' : 'none' }}>{val}</div>
                    </div>
                  ))}
                </div>
                {detailInv.dupOf && (
                  <div style={{ background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 6, padding: '10px 14px', marginTop: 12, fontSize: 13 }}>
                    <strong style={{ color: 'var(--red)' }}>⚠ Duplicate Invoice</strong><br />
                    <span style={{ color: 'var(--text2)' }}>This is a duplicate of <strong>{detailInv.dupOf}</strong>. Line-level impacts are suppressed; full gross total is recoverable.</span>
                  </div>
                )}
              </div>

              {/* Findings */}
              {detailFindings.length > 0 && (
                <div style={{ marginBottom: 24 }}>
                  <h4 style={{ fontSize: 12, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600, marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>Audit Findings ({detailFindings.length})</h4>
                  {detailFindings.map(f => (
                    <div key={f.id} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                        <span style={S.tag(CAT_BG[f.category], CAT_COLORS[f.category])}>{f.category}</span>
                        <span style={S.tag(f.status === 'OVERCHARGE' ? 'var(--red-bg)' : 'var(--green-bg)', f.status === 'OVERCHARGE' ? 'var(--red)' : 'var(--green)')}>{f.status}</span>
                        {f.lineDesc && <span style={{ color: 'var(--text3)', fontSize: 12 }}>— {f.lineDesc}</span>}
                        {f.suppressed && <span style={{ color: 'var(--text3)', fontSize: 11 }}>[suppressed]</span>}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.5 }}>{f.explanation}</div>
                      {f.financialImpact > 0 && <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--red)', marginTop: 6 }}>{fmt(f.financialImpact)}</div>}
                      {f.expected != null && f.category !== 'DUPLICATE' && (
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 8, fontSize: 12 }}>
                          <div><span style={{ color: 'var(--text3)' }}>Expected</span><br /><strong className="mono">{f.category === 'GST' ? `${f.expected}%` : fmt(f.expected)}</strong></div>
                          <div><span style={{ color: 'var(--text3)' }}>Actual</span><br /><strong className="mono">{f.category === 'GST' ? `${f.actual}%` : fmt(f.actual)}</strong></div>
                          <div><span style={{ color: 'var(--text3)' }}>Variance</span><br /><strong className="mono" style={{ color: f.variance > 0 ? 'var(--red)' : 'var(--green)' }}>{f.category === 'GST' ? `${f.variance > 0 ? '+' : ''}${f.variance}%` : `${f.variance > 0 ? '+' : ''}${fmt(f.variance)}`}</strong></div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Line Items */}
              <div>
                <h4 style={{ fontSize: 12, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600, marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid var(--border)' }}>Line Items ({detailInv.lines.length})</h4>
                {detailInv.lines.map((li, idx) => {
                  const hasIssue = detailFindings.some(f => f.lineDesc === li.description && f.financialImpact > 0);
                  return (
                    <div key={idx} style={{ background: 'var(--surface2)', border: `1px solid ${hasIssue ? 'var(--flagged-border)' : 'var(--border)'}`, borderRadius: 6, padding: 12, marginBottom: 8, fontSize: 13 }}>
                      <div style={{ fontWeight: 600, marginBottom: 6 }}>
                        {li.description} {hasIssue && <span style={S.tag('var(--red-bg)', 'var(--red)')}>FLAGGED</span>}
                      </div>
                      {[['Quantity', li.quantity], ['Unit Price', fmt(li.unit_price)], ['Amount', fmt(li.amount)], ['GST Rate', `${li.gst_rate}%`], ['HSN', li.hsn_code]].map(([l, v]) => (
                        <div key={l} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text2)', fontSize: 12, marginTop: 3 }}>
                          <span>{l}</span><span className="mono">{v}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      {/* FOOTER */}
      <footer style={{ textAlign: 'center', padding: '32px 0 16px', color: 'var(--text3)', fontSize: 12 }}>
        Mosaic Wellness Invoice Audit Intelligence — Deterministic engine · {fmtN(sum.totalInvoices)} invoices · {fmtN(sum.totalLines)} line items
      </footer>
    </div>
  );
}
