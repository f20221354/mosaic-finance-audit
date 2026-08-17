'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import invoicesRaw from '@/data/finance_invoices.json';
import rateCardRaw from '@/data/finance_rate_card.json';
import gstRefRaw from '@/data/finance_gst_reference.json';

// Monetary amounts inside finding explanations are stored as {{123.45}} tokens
// rather than pre-formatted strings. The global format toggle can then re-render
// the same finding as "₹1,62,56,034.78" or "₹1.63Cr" without re-running the audit.
const M = (n) => `{{${n}}}`;
const renderExpl = (text, fmt) => String(text).replace(/\{\{(-?[\d.]+)\}\}/g, (_, n) => fmt(Number(n)));

// ====== INLINE AUDIT ENGINE (no crypto dependency) ======
function computeAudit(invoices, userIds) {
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
        add({ invoiceId: iid, vendor: v, lineDesc: d, category: 'SURCHARGE', status: 'OVERCHARGE', expected: 0, actual: a, variance: a, financialImpact: isDup ? 0 : gi, explanation: `Uncontracted: "${d}". Base + GST ${gr}% = ${M(gi)}`, suppressed: isDup });
      } else {
        const ea = Math.round(q * u * 100) / 100;
        const cv = Math.round((a - ea) * 100) / 100;
        if (Math.abs(cv) > 0.01) {
          add({ invoiceId: iid, vendor: v, lineDesc: d, category: 'CALCULATION', status: cv > 0 ? 'OVERCHARGE' : 'UNDERCHARGE', expected: ea, actual: a, variance: cv, financialImpact: cv > 0 && !isDup ? Math.round(cv * 100) / 100 : 0, explanation: `${q} × ${M(u)} = ${M(ea)}, billed ${M(a)}`, suppressed: isDup && cv > 0 });
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
      add({ invoiceId: iid, vendor: v, category: 'SUBTOTAL', status: sv > 0 ? 'OVERCHARGE' : 'UNDERCHARGE', expected: cs, actual: inv.subtotal, variance: sv, financialImpact: sv > 0 && !isDup ? Math.round(sv * 100) / 100 : 0, explanation: `Lines sum ${M(cs)}, stated ${M(inv.subtotal)}`, suppressed: isDup && sv > 0 });
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

  // Findings are bucketed by invoice once instead of re-scanning the finding list
  // per invoice — the engine now re-runs on every user edit, so the O(N×F) scan
  // that was fine as a one-shot is not.
  const byInvoice = new Map();
  for (const f of findings) {
    if (!byInvoice.has(f.invoiceId)) byInvoice.set(f.invoiceId, []);
    byInvoice.get(f.invoiceId).push(f);
  }

  const invSummaries = invoices.map(inv => {
    const fs = byInvoice.get(inv.invoice_id) || [];
    const impact = Math.round(fs.reduce((s, f) => s + f.financialImpact, 0) * 100) / 100;
    return {
      id: inv.invoice_id, vendor: inv.vendor_name, type: inv.vendor_type || 'other',
      date: inv.invoice_date, subtotal: inv.subtotal, gst: inv.gst_amount, total: inv.total,
      lines: inv.line_items, impact,
      pct: inv.total > 0 ? Math.round(impact / inv.total * 10000) / 100 : 0,
      cats: [...new Set(fs.filter(f => f.financialImpact > 0).map(f => f.category))],
      dupOf: dupPairs[inv.invoice_id] || null,
      userAdded: !!(userIds && userIds.has(inv.invoice_id)),
    };
  });

  return {
    summary: { totalInvoices: invoices.length, totalLines: invoices.reduce((s, i) => s + i.line_items.length, 0), flaggedInvoices: flagged.size, totalFindings: findings.length, totalRecovery: Math.round(gt * 100) / 100, categories: cats },
    findings, invoices: invSummaries, duplicatePairs: dupPairs,
  };
}

// ====== HELPERS ======
const fmtFull = (n) => '₹' + Math.abs(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Trailing zeros are trimmed only when a decimal point is actually present —
// a blind /0+$/ strip would turn "100" into "1".
const trimZeros = (s) => (s.indexOf('.') === -1 ? s : s.replace(/0+$/, '').replace(/\.$/, ''));

// Indian abbreviation scale: thousands, then lakhs (1e5), then crores (1e7).
const fmtCompact = (n) => {
  const a = Math.abs(Number(n) || 0);
  if (a >= 1e7) return '₹' + trimZeros((a / 1e7).toFixed(2)) + 'Cr';
  if (a >= 1e5) return '₹' + trimZeros((a / 1e5).toFixed(2)) + 'L';
  if (a >= 1e3) return '₹' + trimZeros((a / 1e3).toFixed(2)) + 'K';
  return '₹' + trimZeros(a.toFixed(2));
};

const fmtN = (n) => Number(n).toLocaleString('en-IN');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const pctOf = (part, whole) => (whole > 0 ? (part / whole) * 100 : 0);

// ---- date helpers for the range slicer ----
// Invoice dates are ISO 'YYYY-MM-DD' strings, so range membership is a plain
// string comparison: exact, and immune to the timezone shifts that Date parsing
// would introduce. Day numbers are only used to drive the slider's integer
// track, and convert back through UTC so they never drift by a day.
const DAY_MS = 86400000;
const isoToDay = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
const dayToIso = (d) => new Date(d * DAY_MS).toISOString().slice(0, 10);
const shiftIso = (iso, days) => dayToIso(isoToDay(iso) + days);
const clampIso = (iso, lo, hi) => (iso < lo ? lo : iso > hi ? hi : iso);
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

// Quarter boundaries, used to offer Q1–Q4 presets for each year in the data.
const QUARTERS = [
  { label: 'Q1', from: '01-01', to: '03-31' },
  { label: 'Q2', from: '04-01', to: '06-30' },
  { label: 'Q3', from: '07-01', to: '09-30' },
  { label: 'Q4', from: '10-01', to: '12-31' },
];

// Category hues resolve through CSS custom properties so each theme gets its own
// validated step — the dark values are too light to hold contrast as text on a
// white card. See the token block in globals.css.
const CAT_COLORS = { DUPLICATE: 'var(--cat-duplicate)', GST: 'var(--cat-gst)', CALCULATION: 'var(--cat-calculation)', SURCHARGE: 'var(--cat-surcharge)', SUBTOTAL: 'var(--cat-subtotal)' };
const CAT_BG = { DUPLICATE: 'var(--cat-duplicate-bg)', GST: 'var(--cat-gst-bg)', CALCULATION: 'var(--cat-calculation-bg)', SURCHARGE: 'var(--cat-surcharge-bg)', SUBTOTAL: 'var(--cat-subtotal-bg)' };
const CAT_LABELS = { DUPLICATE: 'Duplicate Billing', GST: 'GST Mismatch', CALCULATION: 'Calculation Error', SURCHARGE: 'Uncontracted Charge', SUBTOTAL: 'Subtotal Mismatch' };
const CAT_ORDER = ['DUPLICATE', 'GST', 'CALCULATION', 'SURCHARGE', 'SUBTOTAL'];

// Vendor roster and their vendor_type, derived once from the shipped dataset so
// the Add Data form offers exactly the vendors the rate card can price.
const VENDOR_LIST = Object.keys(rateCardRaw).sort();
const VENDOR_TYPES = (() => {
  const m = {};
  for (const inv of invoicesRaw) if (!m[inv.vendor_name]) m[inv.vendor_name] = inv.vendor_type;
  return m;
})();
const HSN_CODES = Object.keys(gstRefRaw);
const CUSTOM_DESC = '__custom__';

// asc / desc are spelled out per column rather than as a generic
// "Ascending / Descending": "Z → A" and "Highest first" say what the click
// will actually do, which a bare direction word does not.
const SORT_COLUMNS = [
  { key: 'id', label: 'Invoice ID', align: 'left', defaultDir: 1, asc: 'A → Z', desc: 'Z → A' },
  { key: 'vendor', label: 'Vendor', align: 'left', defaultDir: 1, asc: 'A → Z', desc: 'Z → A' },
  { key: 'date', label: 'Date', align: 'left', defaultDir: -1, asc: 'Oldest first', desc: 'Newest first' },
  { key: 'issues', label: 'Issues', align: 'left', defaultDir: -1, asc: 'Fewest issues', desc: 'Most issues' },
  { key: 'total', label: 'Billed', align: 'right', defaultDir: -1, asc: 'Lowest first', desc: 'Highest first' },
  { key: 'impact', label: 'Recovery', align: 'right', defaultDir: -1, asc: 'Lowest first', desc: 'Highest first' },
  { key: 'pct', label: 'Recovery %', align: 'right', defaultDir: -1, asc: 'Lowest first', desc: 'Highest first' },
];
const dirLabel = (col, dir) => (dir > 0 ? col.asc : col.desc);

const sortVal = (inv, key) => {
  if (key === 'date') return new Date(inv.date).getTime();
  if (key === 'issues') return inv.cats.length;
  return inv[key];
};

const blankLine = () => ({ description: '', customDesc: '', quantity: '', unit_price: '', amount: '', amountTouched: false, gst_rate: '', hsn_code: '' });
const blankForm = () => ({ invoice_id: '', vendor_name: '', invoice_date: '', lines: [blankLine()], subtotal: '', subtotalTouched: false, gst_amount: '', gstTouched: false, total: '', totalTouched: false });

// ====== STYLES ======
// Layout that has to change with viewport width lives in globals.css under a
// class name — inline styles cannot express a media query, and an inline
// declaration would win over the responsive rule anyway. Anything left in this
// object is either viewport-independent or a value computed from state.
// Class-driven layout: .dash .dash-header .header-actions .kpi-row .cat-grid
// .split .vbar .explorer-head .filter-bar .pager .detail-grid .finding-grid
// .form-grid-3 .line-grid-2 .line-grid-3 .data-table
const S = {
  logoBox: { display: 'flex', alignItems: 'center', gap: 12 },
  logoMark: { width: 36, height: 36, background: 'linear-gradient(135deg, var(--accent), var(--purple))', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, color: '#fff', flex: '0 0 auto' },
  totalBadge: { background: 'var(--red-bg)', border: '1px solid var(--red-border)', padding: '8px 16px', borderRadius: 8, textAlign: 'right' },
  kpi: { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 20 },
  catCard: (active) => ({ background: 'var(--surface)', border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`, borderRadius: 10, padding: 16, cursor: 'pointer', transition: 'all 0.15s', position: 'relative', overflow: 'hidden', boxShadow: active ? '0 0 0 1px var(--accent)' : 'none' }),
  tableWrap: { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' },
  th: { padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid var(--border)', background: 'var(--surface2)', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' },
  td: { padding: '10px 16px', fontSize: 13, whiteSpace: 'nowrap' },
  tfootTd: { padding: '12px 16px', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', background: 'var(--surface2)', borderTop: '2px solid var(--border2)' },
  tag: (bg, color) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: bg, color, marginRight: 4 }),
  overlay: (open) => ({ position: 'fixed', top: 0, right: 0, bottom: 0, width: 580, maxWidth: '100vw', background: 'var(--surface)', borderLeft: '1px solid var(--border)', zIndex: 100, overflowY: 'auto', transform: open ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 0.25s ease', boxShadow: 'var(--shadow-panel)' }),
  backdrop: (open) => ({ position: 'fixed', inset: 0, background: 'var(--backdrop)', zIndex: 99, opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none', transition: 'opacity 0.2s' }),
  btn: { padding: '8px 16px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500, fontFamily: 'inherit' },
  filterBtn: (active) => ({ padding: '5px 12px', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: 'pointer', border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`, background: active ? 'var(--accent)' : 'var(--surface2)', color: active ? '#fff' : 'var(--text2)', transition: 'all 0.15s' }),
  // No width here — .search-box (240px → 100% on mobile) supplies it, and the
  // sort select overrides it inline with width:'auto'.
  searchBox: { background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 12px', color: 'var(--text)', fontSize: 13, outline: 'none', fontFamily: 'inherit' },
  dropdown: { position: 'absolute', top: 'calc(100% + 4px)', right: 0, minWidth: 260, maxHeight: 320, overflowY: 'auto', background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 8, boxShadow: '0 10px 30px var(--backdrop)', zIndex: 40, padding: 4 },
  dropRow: { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 10px', border: 'none', background: 'none', color: 'var(--text)', fontSize: 12, fontFamily: 'inherit', textAlign: 'left', cursor: 'pointer', borderRadius: 5 },
  segWrap: { display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', background: 'var(--surface2)' },
  segBtn: (active) => ({ padding: '8px 12px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit', background: active ? 'var(--accent)' : 'transparent', color: active ? '#fff' : 'var(--text2)', transition: 'all 0.15s' }),
  modalWrap: { position: 'fixed', inset: 0, zIndex: 200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 24, overflowY: 'auto' },
  modal: { position: 'relative', width: '100%', maxWidth: 780, background: 'var(--surface)', border: '1px solid var(--border2)', borderRadius: 12, boxShadow: '0 24px 60px var(--backdrop)', margin: 'auto' },
  label: { display: 'block', fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 4 },
  input: { width: '100%', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', color: 'var(--text)', fontSize: 13, outline: 'none', fontFamily: 'inherit' },
  sectionH: { fontSize: 12, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600, marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid var(--border)' },
  toast: { position: 'fixed', right: 20, bottom: 20, zIndex: 300, background: 'var(--surface)', border: '1px solid var(--green)', borderLeft: '4px solid var(--green)', borderRadius: 8, padding: '12px 16px', boxShadow: '0 12px 30px var(--backdrop)', maxWidth: 380, fontSize: 13 },
};

// ====== MAIN COMPONENT ======
export default function Dashboard() {
  // --- session data layer: user edits live in state and shadow the shipped JSON ---
  const [overrides, setOverrides] = useState(() => new Map());
  const workingInvoices = useMemo(() => {
    if (overrides.size === 0) return invoicesRaw;
    const base = invoicesRaw.map(i => overrides.get(i.invoice_id) || i);
    const known = new Set(invoicesRaw.map(i => i.invoice_id));
    const added = [...overrides.entries()].filter(([id]) => !known.has(id)).map(([, inv]) => inv);
    return [...base, ...added];
  }, [overrides]);
  const overrideIds = useMemo(() => new Set(overrides.keys()), [overrides]);

  // The audit always runs over the COMPLETE dataset, never the date-filtered
  // subset. Duplicate detection works by matching an invoice against its earlier
  // twin, so auditing a slice would make the duplicate finding — the single
  // largest recovery category — disappear whenever a range cut the pair apart.
  // The date range is applied afterwards, to aggregation only.
  const data = useMemo(() => computeAudit(workingInvoices, overrideIds), [workingInvoices, overrideIds]);

  // Declared here, above the `from`/`to` derivation that reads it — a later
  // `const` would be in its temporal dead zone at that point.
  // null means "all time" rather than the concrete bounds, so adding an invoice
  // outside the current span widens the range instead of hiding the new record.
  const [range, setRange] = useState(null);

  // Widest selectable span, recomputed so a session invoice dated outside the
  // shipped data still lands inside the slicer.
  const [dataMin, dataMax] = useMemo(() => {
    const ds = workingInvoices.map(i => i.invoice_date).filter(Boolean).sort();
    return ds.length ? [ds[0], ds[ds.length - 1]] : ['2025-01-01', '2025-12-31'];
  }, [workingInvoices]);

  const from = clampIso(range?.from ?? dataMin, dataMin, dataMax);
  const to = clampIso(range?.to ?? dataMax, dataMin, dataMax);
  const isFullRange = from === dataMin && to === dataMax;

  // Every visual on the page reads from `view`, so the slicer governs the whole
  // dashboard the way a Power BI slicer governs a report page. Findings are kept
  // if their invoice falls in range; the categories, KPI counts and totals are
  // then recomputed from that subset.
  const view = useMemo(() => {
    const invoices = data.invoices.filter(i => i.date >= from && i.date <= to);
    const ids = new Set(invoices.map(i => i.id));
    const findings = data.findings.filter(f => ids.has(f.invoiceId));

    const cats = {};
    for (const f of findings) {
      if (!cats[f.category]) cats[f.category] = { total: 0, count: 0 };
      cats[f.category].count++;
      cats[f.category].total += f.financialImpact;
    }
    const gt = Object.values(cats).reduce((s, c) => s + c.total, 0);
    for (const c of Object.values(cats)) {
      c.total = round2(c.total);
      c.pct = gt > 0 ? Math.round((c.total / gt) * 10000) / 100 : 0;
    }
    const flagged = new Set(findings.filter(f => f.financialImpact > 0).map(f => f.invoiceId));

    return {
      invoices,
      findings,
      cats,
      summary: {
        totalInvoices: invoices.length,
        totalLines: invoices.reduce((s, i) => s + i.lines.length, 0),
        flaggedInvoices: flagged.size,
        totalFindings: findings.length,
        totalRecovery: round2(gt),
      },
    };
  }, [data, from, to]);

  const [catFilters, setCatFilters] = useState([]);
  const [vendorFilters, setVendorFilters] = useState([]);
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [vendorOpen, setVendorOpen] = useState(false);
  const [vendorQuery, setVendorQuery] = useState('');
  const [sortKey, setSortKey] = useState('impact');
  const [sortDir, setSortDir] = useState(-1);
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState(null);
  const [compact, setCompact] = useState(false);
  const [toast, setToast] = useState(null);
  const perPage = 25;

  const searchRef = useRef(null);
  const vendorRef = useRef(null);
  const explorerRef = useRef(null);

  // Active money formatter — every monetary render in the tree goes through this
  // one function so the header toggle reaches KPIs, cards, chart, table and panel.
  const fmt = useCallback((n) => (compact ? fmtCompact(n) : fmtFull(n)), [compact]);

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

  // Date-scoped, for every visual. `data.*` remains available for the few places
  // that must see the whole dataset regardless of the slicer.
  const { summary: sum, findings, invoices, cats } = view;
  // The vendor checklist is built from the full dataset so options never vanish
  // mid-selection when the range narrows.
  const allVendors = useMemo(() => [...new Set(data.invoices.map(i => i.vendor))].sort(), [data.invoices]);

  // --- Add / Update Data modal ---
  const [modalOpen, setModalOpen] = useState(false);
  const [userEmail, setUserEmail] = useState('');
  const [emailDraft, setEmailDraft] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankForm);
  const [formErrors, setFormErrors] = useState([]);
  const modalStep = userEmail ? 2 : 1;

  const filtered = useMemo(() => {
    let list = invoices.filter(i => i.impact > 0 || i.cats.length > 0 || i.userAdded);
    if (catFilters.length) list = list.filter(i => i.cats.some(c => catFilters.includes(c)));
    if (vendorFilters.length) list = list.filter(i => vendorFilters.includes(i.vendor));
    if (search) { const s = search.toLowerCase(); list = list.filter(i => i.id.toLowerCase().includes(s) || i.vendor.toLowerCase().includes(s)); }
    const sorted = [...list].sort((a, b) => {
      const av = sortVal(a, sortKey), bv = sortVal(b, sortKey);
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * sortDir;
      if (av < bv) return -sortDir;
      if (av > bv) return sortDir;
      return 0;
    });
    return sorted;
  }, [invoices, catFilters, vendorFilters, search, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(page, totalPages);
  const pageInvs = filtered.slice((safePage - 1) * perPage, safePage * perPage);

  // Totals reflect the whole filtered selection, not just the visible page.
  const totals = useMemo(() => {
    const billed = filtered.reduce((s, i) => s + i.total, 0);
    const recovery = filtered.reduce((s, i) => s + i.impact, 0);
    return { count: filtered.length, billed, recovery, pct: pctOf(recovery, billed) };
  }, [filtered]);

  // Autocomplete runs over every invoice — not just the flagged subset, and not
  // just the date range — so any invoice ID the user types can be opened from the
  // box. Matches outside the selected range are marked rather than hidden.
  const searchMatches = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return [];
    return data.invoices
      .filter(i => i.id.toLowerCase().includes(s) || i.vendor.toLowerCase().includes(s))
      .slice(0, 40)
      .map(i => ({ ...i, outOfRange: i.date < from || i.date > to }));
  }, [data.invoices, search, from, to]);

  const handleSort = useCallback((key) => {
    setSortKey(prev => {
      if (prev === key) { setSortDir(d => d * -1); return prev; }
      setSortDir(SORT_COLUMNS.find(c => c.key === key)?.defaultDir ?? -1);
      return key;
    });
    setPage(1);
  }, []);

  // The explicit Sort control and the header clicks drive the same two pieces
  // of state, so the two stay in lockstep whichever one the user reaches for.
  const selectSortKey = useCallback((key) => {
    setSortKey(key);
    setSortDir(SORT_COLUMNS.find(c => c.key === key)?.defaultDir ?? -1);
    setPage(1);
  }, []);

  const toggleSortDir = useCallback(() => { setSortDir(d => d * -1); setPage(1); }, []);

  const applyRange = useCallback((f, t) => {
    setRange({ from: f, to: t });
    setPage(1);
  }, []);

  const resetRange = useCallback(() => { setRange(null); setPage(1); }, []);

  // Relative presets are anchored to the LATEST INVOICE, not to today. The
  // dataset ends in Dec 2025, so "last 90 days" measured from the current date
  // would select nothing at all.
  const presets = useMemo(() => {
    const out = [{ label: 'All time', from: dataMin, to: dataMax, hint: `Every invoice — ${fmtDate(dataMin)} to ${fmtDate(dataMax)}` }];
    for (const [label, days] of [['Last 30d', 30], ['Last 90d', 90], ['Last 6m', 182]]) {
      out.push({
        label,
        from: clampIso(shiftIso(dataMax, -(days - 1)), dataMin, dataMax),
        to: dataMax,
        hint: `${days} days up to the latest invoice (${fmtDate(dataMax)}) — relative to the data, not today`,
      });
    }
    const years = [...new Set([dataMin.slice(0, 4), dataMax.slice(0, 4)])].sort();
    for (const y of years) {
      for (const q of QUARTERS) {
        const qf = `${y}-${q.from}`;
        const qt = `${y}-${q.to}`;
        // Skip quarters with no data behind them.
        if (qt < dataMin || qf > dataMax) continue;
        out.push({
          label: years.length > 1 ? `${q.label} ${y}` : q.label,
          from: clampIso(qf, dataMin, dataMax),
          to: clampIso(qt, dataMin, dataMax),
          hint: `${q.label} ${y}: ${fmtDate(qf)} – ${fmtDate(qt)}`,
        });
      }
    }
    return out;
  }, [dataMin, dataMax]);

  const toggleCat = useCallback((c) => {
    setCatFilters(prev => (c === null ? [] : prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]));
    setPage(1);
  }, []);

  const toggleVendor = useCallback((v) => {
    setVendorFilters(prev => (prev.includes(v) ? prev.filter(x => x !== v) : [...prev, v]));
    setPage(1);
  }, []);

  const openInvoice = useCallback((id) => {
    setDetailId(id);
    setSearchOpen(false);
  }, []);

  const focusVendor = useCallback((v) => {
    setVendorFilters([v]);
    setPage(1);
    setVendorOpen(false);
    explorerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Both popovers dismiss on an outside click; Escape unwinds the topmost layer.
  useEffect(() => {
    const onDown = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false);
      if (vendorRef.current && !vendorRef.current.contains(e.target)) setVendorOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (modalOpen) { setModalOpen(false); return; }
      if (searchOpen) { setSearchOpen(false); return; }
      if (vendorOpen) { setVendorOpen(false); return; }
      if (detailId) setDetailId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modalOpen, searchOpen, vendorOpen, detailId]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // Exports what the dashboard is currently showing, so the CSV honours the date
  // slicer; the filename records the range to keep extracts self-describing.
  const exportCSV = useCallback(() => {
    const rows = [['Finding ID', 'Invoice', 'Vendor', 'Category', 'Status', 'Line Description', 'Expected', 'Actual', 'Variance', 'Financial Impact', 'Explanation', 'Suppressed']];
    findings.forEach(f => rows.push([f.id, f.invoiceId, f.vendor, f.category, f.status, f.lineDesc || '', f.expected ?? '', f.actual ?? '', f.variance ?? '', f.financialImpact, renderExpl(f.explanation, fmtFull), f.suppressed]));
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = isFullRange ? 'mosaic_audit_findings.csv' : `mosaic_audit_findings_${from}_to_${to}.csv`;
    a.click();
  }, [findings, isFullRange, from, to]);

  // Vendor impact chart
  const vendorImpact = useMemo(() => {
    const map = {};
    invoices.forEach(i => { map[i.vendor] = (map[i.vendor] || 0) + i.impact; });
    return Object.entries(map).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  }, [invoices]);
  const maxVI = vendorImpact[0]?.[1] || 1;

  const totalBilled = useMemo(() => invoices.reduce((s, i) => s + i.total, 0), [invoices]);

  // Detail
  // Resolved against the full dataset, not the date-scoped view: an invoice found
  // through search may sit outside the current range and must still open.
  const detailInv = detailId ? data.invoices.find(i => i.id === detailId) : null;
  const detailFindings = useMemo(() => (detailId ? data.findings.filter(f => f.invoiceId === detailId) : []), [data.findings, detailId]);

  // ====== FORM PLUMBING ======
  const openAdd = useCallback(() => {
    setEditingId(null);
    setForm(blankForm());
    setFormErrors([]);
    setEmailDraft('');
    setModalOpen(true);
  }, []);

  const openEdit = useCallback((inv) => {
    setEditingId(inv.id);
    setFormErrors([]);
    setEmailDraft('');
    setForm({
      invoice_id: inv.id,
      vendor_name: inv.vendor,
      invoice_date: inv.date,
      // Every field is marked touched: the stored values are the audit evidence
      // and must survive a round-trip even when they disagree with the maths.
      lines: inv.lines.map(li => ({
        description: rateCardRaw[inv.vendor]?.[li.description] !== undefined ? li.description : CUSTOM_DESC,
        customDesc: rateCardRaw[inv.vendor]?.[li.description] !== undefined ? '' : li.description,
        quantity: String(li.quantity), unit_price: String(li.unit_price),
        amount: String(li.amount), amountTouched: true,
        gst_rate: String(li.gst_rate), hsn_code: String(li.hsn_code),
      })),
      subtotal: String(inv.subtotal), subtotalTouched: true,
      gst_amount: String(inv.gst), gstTouched: true,
      total: String(inv.total), totalTouched: true,
    });
    setModalOpen(true);
  }, []);

  const setLine = useCallback((idx, patch) => {
    setForm(f => ({ ...f, lines: f.lines.map((li, i) => (i === idx ? { ...li, ...patch } : li)) }));
  }, []);

  const lineAmount = (li) => (li.amountTouched ? num(li.amount) : round2(num(li.quantity) * num(li.unit_price)));
  const autoSubtotal = round2(form.lines.reduce((s, li) => s + lineAmount(li), 0));
  const autoGst = round2(form.lines.reduce((s, li) => s + lineAmount(li) * num(li.gst_rate) / 100, 0));
  const shownSubtotal = form.subtotalTouched ? form.subtotal : String(autoSubtotal);
  const shownGst = form.gstTouched ? form.gst_amount : String(autoGst);
  const autoTotal = round2(num(shownSubtotal) + num(shownGst));
  const shownTotal = form.totalTouched ? form.total : String(autoTotal);

  const resolvedDesc = (li) => (li.description === CUSTOM_DESC ? li.customDesc.trim() : li.description);

  const submitForm = useCallback((e) => {
    e.preventDefault();
    const errs = [];
    const id = form.invoice_id.trim();
    if (!id) errs.push('Invoice ID is required.');
    if (!form.vendor_name) errs.push('Vendor name is required.');
    if (!form.invoice_date) errs.push('Invoice date is required.');
    if (!editingId && workingInvoices.some(i => i.invoice_id === id)) errs.push(`Invoice ${id} already exists — open it in the explorer and use Edit instead.`);
    if (!form.lines.length) errs.push('At least one line item is required.');
    form.lines.forEach((li, i) => {
      const n = i + 1;
      if (!resolvedDesc(li)) errs.push(`Line ${n}: description is required.`);
      if (li.quantity === '' || num(li.quantity) <= 0) errs.push(`Line ${n}: quantity must be greater than zero.`);
      if (li.unit_price === '') errs.push(`Line ${n}: unit price is required.`);
      if (li.gst_rate === '') errs.push(`Line ${n}: GST rate is required.`);
      if (!String(li.hsn_code).trim()) errs.push(`Line ${n}: HSN code is required.`);
    });
    if (errs.length) { setFormErrors(errs); return; }

    const invoice = {
      invoice_id: id,
      vendor_name: form.vendor_name,
      vendor_type: VENDOR_TYPES[form.vendor_name] || 'other',
      invoice_date: form.invoice_date,
      line_items: form.lines.map(li => ({
        description: resolvedDesc(li),
        quantity: num(li.quantity),
        unit_price: round2(li.unit_price),
        amount: round2(lineAmount(li)),
        gst_rate: num(li.gst_rate),
        hsn_code: String(li.hsn_code).trim(),
      })),
      subtotal: round2(shownSubtotal),
      gst_amount: round2(shownGst),
      total: round2(shownTotal),
      payment_terms: 'Net 30',
    };

    setOverrides(prev => { const next = new Map(prev); next.set(id, invoice); return next; });
    setModalOpen(false);
    setFormErrors([]);
    setToast(`Invoice ${id} ${editingId ? 'updated' : 'added'}. Dashboard updated. Submitted by ${userEmail}`);
    if (editingId && editingId !== id) setDetailId(null);
  }, [form, editingId, workingInvoices, shownSubtotal, shownGst, shownTotal, userEmail]);

  const activeCol = SORT_COLUMNS.find(c => c.key === sortKey) || SORT_COLUMNS[0];
  const vendorLabel = vendorFilters.length === 0 ? 'All Vendors' : vendorFilters.length === 1 ? vendorFilters[0] : `${vendorFilters.length} vendors selected`;
  const vendorOptions = vendorQuery ? allVendors.filter(v => v.toLowerCase().includes(vendorQuery.toLowerCase())) : allVendors;

  return (
    <div className="dash">
      {/* HEADER */}
      <header className="dash-header">
        <div style={S.logoBox}>
          <div style={S.logoMark}>MA</div>
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 600, letterSpacing: -0.3 }}>Invoice Audit Intelligence</h1>
            <span style={{ color: 'var(--text3)', fontSize: 13 }}>Mosaic Wellness</span>
          </div>
        </div>
        <div className="header-actions">
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

          {/* Number format — segmented, applies to every monetary value on the page */}
          <div style={S.segWrap} role="group" aria-label="Number format">
            <button type="button" style={S.segBtn(!compact)} onClick={() => setCompact(false)} aria-pressed={!compact} title="Detailed — full numbers with 2 decimals">₹1,234</button>
            <button type="button" style={S.segBtn(compact)} onClick={() => setCompact(true)} aria-pressed={compact} title="Compact — K / L / Cr suffixes">1.2K</button>
          </div>

          <button type="button" onClick={openAdd} style={{ ...S.btn, background: 'var(--surface2)', border: '1px solid var(--border2)', color: 'var(--text)' }}>+ Add Data</button>
          <button type="button" onClick={exportCSV} style={{ ...S.btn, background: 'var(--accent)', color: '#fff' }}>↓ Export CSV</button>
          <div className="total-badge" style={S.totalBadge}>
            <div style={{ fontSize: 11, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>
              Total Recoverable
              {/* Never let a filtered figure be mistaken for the all-time total. */}
              {!isFullRange && <span style={{ ...S.tag('var(--accent-bg)', 'var(--accent)'), marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>filtered</span>}
            </div>
            <div className="mono" style={{ fontSize: 22, fontWeight: 700, color: 'var(--red)', marginTop: 2 }}>{fmt(sum.totalRecovery)}</div>
            {!isFullRange && (
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{fmtDate(from)} – {fmtDate(to)}</div>
            )}
          </div>
        </div>
      </header>

      {/* DATE SLICER — governs every visual on the page, Power BI style */}
      <section className="slicer" aria-label="Invoice date range">
        <div className="slicer-top">
          <div>
            <div className="slicer-title">Invoice Date Range</div>
            <div className="slicer-sub">
              <strong style={{ color: 'var(--text)' }}>{fmtDate(from)}</strong> to <strong style={{ color: 'var(--text)' }}>{fmtDate(to)}</strong>
              {' · '}
              <strong style={{ color: sum.totalInvoices === 0 ? 'var(--red)' : 'var(--accent)' }}>{fmtN(sum.totalInvoices)}</strong> of {fmtN(data.invoices.length)} invoices in range
            </div>
          </div>
          <div className="slicer-presets">
            {presets.map(p => {
              const on = from === p.from && to === p.to;
              return (
                <button key={p.label} type="button" title={p.hint} aria-pressed={on} style={S.filterBtn(on)} onClick={() => applyRange(p.from, p.to)}>{p.label}</button>
              );
            })}
          </div>
        </div>

        <div className="slicer-controls">
          <input
            type="date"
            className="slicer-date"
            aria-label="Range start date"
            value={from}
            min={dataMin}
            max={to}
            onChange={e => { const v = e.target.value; if (v) applyRange(clampIso(v, dataMin, to), to); }}
          />
          <span style={{ color: 'var(--text3)', fontSize: 12 }}>and</span>
          <input
            type="date"
            className="slicer-date"
            aria-label="Range end date"
            value={to}
            min={from}
            max={dataMax}
            onChange={e => { const v = e.target.value; if (v) applyRange(from, clampIso(v, from, dataMax)); }}
          />
          {!isFullRange && (
            <button type="button" onClick={resetRange} style={{ ...S.filterBtn(false), marginLeft: 4 }}>✕ Reset to all time</button>
          )}
        </div>

        {/* Dual-thumb track. Two overlaid range inputs: pointer events are enabled
            on the thumbs only, and the z-order flips at the midpoint so the thumb
            you need stays grabbable even when both sit on the same day. */}
        {(() => {
          const minD = isoToDay(dataMin);
          const maxD = isoToDay(dataMax);
          const fromD = isoToDay(from);
          const toD = isoToDay(to);
          const span = Math.max(1, maxD - minD);
          const leftPct = ((fromD - minD) / span) * 100;
          const rightPct = ((toD - minD) / span) * 100;
          const fromOnTop = fromD > (minD + maxD) / 2;
          return (
            <div className="slicer-slider">
              <span className="slicer-track" />
              <span className="slicer-fill" style={{ left: `${leftPct}%`, width: `${Math.max(0, rightPct - leftPct)}%` }} />
              <input
                type="range" min={minD} max={maxD} step={1} value={fromD}
                aria-label="Range start slider"
                style={{ zIndex: fromOnTop ? 4 : 3 }}
                onChange={e => { const v = Math.min(Number(e.target.value), toD); applyRange(dayToIso(v), to); }}
              />
              <input
                type="range" min={minD} max={maxD} step={1} value={toD}
                aria-label="Range end slider"
                style={{ zIndex: fromOnTop ? 3 : 4 }}
                onChange={e => { const v = Math.max(Number(e.target.value), fromD); applyRange(from, dayToIso(v)); }}
              />
            </div>
          );
        })()}

        <div className="slicer-scale">
          <span>{fmtDate(dataMin)}</span>
          <span>{fmtDate(dataMax)}</span>
        </div>

        {sum.totalInvoices === 0 && (
          <div style={{ marginTop: 10, background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: 'var(--text2)' }}>
            No invoices fall in this range — every figure below reads zero. Widen the range or reset to all time.
          </div>
        )}
      </section>

      {/* KPIs */}
      <div className="kpi-row">
        {[
          { label: 'Invoices Audited', value: fmtN(sum.totalInvoices), sub: `${fmtN(sum.totalLines)} line items processed` },
          { label: 'Flagged Invoices', value: fmtN(sum.flaggedInvoices), sub: `${pctOf(sum.flaggedInvoices, sum.totalInvoices).toFixed(1)}% of total`, color: 'var(--red)' },
          { label: 'Audit Findings', value: fmtN(sum.totalFindings), sub: `Across ${CAT_ORDER.filter(c => cats[c]).length} categories` },
          { label: 'Recovery Rate', value: `${pctOf(sum.totalRecovery, totalBilled).toFixed(2)}%`, sub: `Of ${fmt(totalBilled)} total billed` },
        ].map((kpi, i) => (
          <div key={i} style={S.kpi}>
            <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 500 }}>{kpi.label}</div>
            <div style={{ fontSize: 28, fontWeight: 700, marginTop: 6, letterSpacing: -1, color: kpi.color || 'var(--text)' }}>{kpi.value}</div>
            <div style={{ fontSize: 12, color: 'var(--text2)', marginTop: 4 }}>{kpi.sub}</div>
          </div>
        ))}
      </div>

      {/* CATEGORY CARDS */}
      <div className="cat-grid">
        {CAT_ORDER.filter(c => cats[c]).map(c => (
          <div key={c} style={S.catCard(catFilters.includes(c))} onClick={() => toggleCat(c)}>
            <div style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 500, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>{CAT_LABELS[c]}</div>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4, color: CAT_COLORS[c] }}>{fmt(cats[c].total)}</div>
            <div style={{ fontSize: 12, color: 'var(--text2)' }}>{cats[c].pct}% of recovery</div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{cats[c].count} finding{cats[c].count > 1 ? 's' : ''}</div>
            <div style={{ position: 'absolute', bottom: 0, left: 0, height: 3, background: CAT_COLORS[c], borderRadius: '0 0 10px 10px', width: `${cats[c].pct}%`, transition: 'width 0.4s ease' }} />
          </div>
        ))}
      </div>

      {/* VENDOR CHART + SUMMARY */}
      <div className="split">
        <div style={S.tableWrap}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ fontSize: 14, fontWeight: 600 }}>Leakage by Vendor</h3>
            <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>All {vendorImpact.length} vendors with recoverable overcharge · click a bar to filter the explorer</p>
          </div>
          <div style={{ padding: '16px 20px' }}>
            {vendorImpact.map(([v, amt]) => {
              const share = pctOf(amt, sum.totalRecovery);
              const selected = vendorFilters.length === 1 && vendorFilters[0] === v;
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => focusVendor(v)}
                  title={`Filter explorer to ${v}`}
                  className="vbar"
                  style={{ background: selected ? 'var(--accent-bg)' : 'none' }}
                >
                  <span className="vbar-name" style={{ color: selected ? 'var(--accent)' : 'var(--text2)', fontWeight: selected ? 600 : 400 }}>{v}</span>
                  <span className="vbar-track">
                    <span style={{ display: 'block', height: '100%', width: `${(amt / maxVI * 100).toFixed(1)}%`, background: CAT_COLORS.DUPLICATE, opacity: selected ? 0.95 : 0.7, borderRadius: 4, transition: 'width 0.5s ease' }} />
                  </span>
                  <span className="vbar-amt mono" style={{ color: 'var(--red)' }}>
                    {fmt(amt)} <span style={{ color: 'var(--text3)', fontWeight: 500 }}>({share.toFixed(2)}%)</span>
                  </span>
                </button>
              );
            })}
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
      <div style={S.tableWrap} ref={explorerRef}>
        <div className="explorer-head">
          <h3 style={{ fontSize: 14, fontWeight: 600 }}>Invoice Explorer <span style={{ color: 'var(--text3)', fontSize: 12, fontWeight: 400 }}>({filtered.length} results)</span></h3>

          {/* Search + invoice-ID autocomplete */}
          <div ref={searchRef} className="search-wrap">
            <input
              className="search-box"
              style={S.searchBox}
              placeholder="Search invoice ID or vendor…"
              value={search}
              onChange={e => { setSearch(e.target.value); setSearchOpen(true); setPage(1); }}
              onFocus={() => setSearchOpen(true)}
              aria-expanded={searchOpen && searchMatches.length > 0}
              aria-label="Search invoices"
            />
            {search && (
              <button
                type="button"
                onClick={() => { setSearch(''); setSearchOpen(false); setPage(1); }}
                aria-label="Clear search"
                style={{ position: 'absolute', right: 6, top: 6, border: 'none', background: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 4 }}
              >✕</button>
            )}
            {searchOpen && searchMatches.length > 0 && (
              <div className="drop" style={{ ...S.dropdown, width: 340, left: 'auto', right: 0 }} role="listbox">
                <div style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: 0.5, padding: '6px 10px' }}>
                  {searchMatches.length === 40 ? 'First 40 matches' : `${searchMatches.length} match${searchMatches.length > 1 ? 'es' : ''}`} — click to open
                </div>
                {searchMatches.map(m => (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={detailId === m.id}
                    onClick={() => openInvoice(m.id)}
                    style={S.dropRow}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
                  >
                    <span className="mono" style={{ width: 82, color: 'var(--accent)', fontWeight: 600 }}>{m.id}</span>
                    <span style={{ flex: 1, color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.vendor}</span>
                    {/* Searchable beyond the slicer, but say so rather than implying
                        it is part of the current selection. */}
                    {m.outOfRange && <span style={{ fontSize: 10, color: 'var(--text3)', whiteSpace: 'nowrap' }} title={`Dated ${fmtDate(m.date)} — outside the selected range`}>off-range</span>}
                    <span className="mono" style={{ color: 'var(--text)', fontWeight: 600 }}>{fmt(m.total)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* FILTER BAR — categories and vendors are both multi-select */}
        <div className="filter-bar">
          <button style={S.filterBtn(catFilters.length === 0)} onClick={() => toggleCat(null)}>All Categories</button>
          {CAT_ORDER.filter(c => cats[c]).map(c => (
            <button key={c} style={S.filterBtn(catFilters.includes(c))} onClick={() => toggleCat(c)} aria-pressed={catFilters.includes(c)}>
              {catFilters.includes(c) ? '✓ ' : ''}{CAT_LABELS[c]}
            </button>
          ))}
          <span className="bar-sep" style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />

          <div ref={vendorRef} style={{ position: 'relative' }}>
            <button
              type="button"
              onClick={() => setVendorOpen(o => !o)}
              aria-expanded={vendorOpen}
              style={{ ...S.filterBtn(vendorFilters.length > 0), minWidth: 180, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '5px 10px' }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 170 }}>{vendorLabel}</span>
              <span aria-hidden="true">▾</span>
            </button>
            {vendorOpen && (
              <div className="drop" style={{ ...S.dropdown, left: 0, right: 'auto', width: 300 }}>
                <input
                  autoFocus
                  value={vendorQuery}
                  onChange={e => setVendorQuery(e.target.value)}
                  placeholder="Filter vendors…"
                  style={{ ...S.input, marginBottom: 4 }}
                />
                <div style={{ display: 'flex', gap: 6, padding: '0 4px 6px' }}>
                  <button type="button" style={{ ...S.filterBtn(false), flex: 1, fontSize: 11 }} onClick={() => { setVendorFilters(vendorOptions); setPage(1); }}>Select all</button>
                  <button type="button" style={{ ...S.filterBtn(false), flex: 1, fontSize: 11 }} onClick={() => { setVendorFilters([]); setPage(1); }}>Clear</button>
                </div>
                {vendorOptions.map(v => (
                  <label
                    key={v}
                    style={{ ...S.dropRow, cursor: 'pointer' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
                  >
                    <input type="checkbox" checked={vendorFilters.includes(v)} onChange={() => toggleVendor(v)} style={{ accentColor: 'var(--accent)' }} />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
                  </label>
                ))}
                {vendorOptions.length === 0 && <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text3)' }}>No vendor matches.</div>}
              </div>
            )}
          </div>

          <span className="bar-sep" style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />

          {/* Explicit sort control — mirrors the clickable column headers for
              anyone who does not think to click them. */}
          <label htmlFor="sort-key" style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 500 }}>Sort</label>
          <select
            id="sort-key"
            value={sortKey}
            onChange={e => selectSortKey(e.target.value)}
            style={{ ...S.searchBox, width: 'auto', padding: '5px 8px', fontSize: 12, cursor: 'pointer' }}
          >
            {SORT_COLUMNS.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <button
            type="button"
            onClick={toggleSortDir}
            title={`Currently ${dirLabel(activeCol, sortDir)} — click to reverse`}
            aria-label={`Sort direction: ${dirLabel(activeCol, sortDir)}. Click to reverse.`}
            style={{ ...S.filterBtn(false), display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <span className="mono" aria-hidden="true" style={{ color: 'var(--accent)', fontWeight: 700 }}>{sortDir > 0 ? '↑' : '↓'}</span>
            {dirLabel(activeCol, sortDir)}
          </button>

          {(catFilters.length > 0 || vendorFilters.length > 0 || search) && (
            <button
              type="button"
              style={{ ...S.filterBtn(false), marginLeft: 'auto' }}
              onClick={() => { setCatFilters([]); setVendorFilters([]); setSearch(''); setPage(1); }}
            >✕ Reset filters</button>
          )}
        </div>

        {/* Below 640px .data-table restyles these rows as stacked cards, using
            each cell's data-label as its heading — see globals.css. */}
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {SORT_COLUMNS.map(col => {
                  const active = sortKey === col.key;
                  // Headers are focusable buttons in all but name: the hover and
                  // focus affordances live in globals.css so the muted "↕" reads
                  // as a control before the first click, not after it.
                  return (
                    <th
                      key={col.key}
                      className={`sort-th${active ? ' is-active' : ''}`}
                      style={{ ...S.th, textAlign: col.align, color: active ? 'var(--accent)' : 'var(--text2)' }}
                      onClick={() => handleSort(col.key)}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSort(col.key); } }}
                      tabIndex={0}
                      title={active ? `${col.label}: ${dirLabel(col, sortDir)} — click to reverse` : `Sort by ${col.label} (${dirLabel(col, col.defaultDir)})`}
                      aria-sort={active ? (sortDir > 0 ? 'ascending' : 'descending') : 'none'}
                    >
                      {col.label} <span className="sort-ind" aria-hidden="true">{active ? (sortDir > 0 ? '↑' : '↓') : '↕'}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {pageInvs.map(inv => (
                <tr key={inv.id} onClick={() => setDetailId(inv.id)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer', transition: 'background 0.1s' }} onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)'; }} onMouseLeave={e => { e.currentTarget.style.background = ''; }}>
                  <td data-label="Invoice ID" style={{ ...S.td, fontSize: 12 }}>
                    <button
                      type="button"
                      className="mono"
                      onClick={e => { e.stopPropagation(); openInvoice(inv.id); }}
                      style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', fontWeight: 700, color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}
                    >{inv.id}</button>
                    {inv.userAdded && <span style={S.tag('var(--accent-bg)', 'var(--accent)')}>&nbsp;SESSION</span>}
                  </td>
                  <td data-label="Vendor" style={S.td}>{inv.vendor}</td>
                  <td data-label="Date" style={{ ...S.td, color: 'var(--text3)' }}>{new Date(inv.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td data-label="Issues" style={S.td}>{inv.cats.length > 0 ? inv.cats.map(c => <span key={c} style={S.tag(CAT_BG[c], CAT_COLORS[c])}>{c}</span>) : <span style={{ color: 'var(--text3)' }}>—</span>}</td>
                  <td data-label="Billed" className="mono" style={{ ...S.td, textAlign: 'right', color: 'var(--text3)' }}>{fmt(inv.total)}</td>
                  <td data-label="Recovery" className="mono" style={{ ...S.td, textAlign: 'right', color: inv.impact > 0 ? 'var(--red)' : 'var(--text3)', fontWeight: inv.impact > 0 ? 700 : 400 }}>{inv.impact > 0 ? fmt(inv.impact) : '—'}</td>
                  <td data-label="Recovery %" className="mono" style={{ ...S.td, textAlign: 'right', color: inv.impact > 0 ? 'var(--red)' : 'var(--text3)' }}>{inv.impact > 0 ? `${inv.pct.toFixed(2)}%` : '—'}</td>
                </tr>
              ))}
              {pageInvs.length === 0 && (
                <tr><td colSpan={7} className="empty-cell" style={{ ...S.td, textAlign: 'center', color: 'var(--text3)', padding: '32px 16px' }}>No invoices match the current filters.</td></tr>
              )}
            </tbody>
            {/* Totals reflect the full filtered selection, not just this page */}
            <tfoot>
              <tr>
                <td colSpan={4} style={{ ...S.tfootTd, color: 'var(--text2)', fontWeight: 600 }}>Totals — {fmtN(totals.count)} invoice{totals.count === 1 ? '' : 's'} in selection</td>
                <td className="mono" style={{ ...S.tfootTd, textAlign: 'right' }}>{fmt(totals.billed)}</td>
                <td className="mono" style={{ ...S.tfootTd, textAlign: 'right', color: 'var(--red)' }}>{fmt(totals.recovery)}</td>
                <td className="mono" style={{ ...S.tfootTd, textAlign: 'right', color: 'var(--red)' }}>{totals.pct.toFixed(2)}%</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="totals-strip" style={{ padding: '10px 20px', background: 'var(--surface2)', borderTop: '1px solid var(--border)', fontSize: 13, fontWeight: 600 }}>
          <span style={{ color: 'var(--text2)' }}>Showing totals for {fmtN(totals.count)} invoices: </span>
          <span>Billed <span className="mono">{fmt(totals.billed)}</span></span>
          <span style={{ color: 'var(--text3)' }}> | </span>
          <span style={{ color: 'var(--red)' }}>Recovery <span className="mono">{fmt(totals.recovery)}</span> ({totals.pct.toFixed(2)}%)</span>
        </div>

        <div className="pager">
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>Showing {filtered.length === 0 ? 0 : (safePage - 1) * perPage + 1}–{Math.min(safePage * perPage, filtered.length)} of {filtered.length}</div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button style={{ ...S.btn, padding: '5px 10px', fontSize: 12, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text2)', opacity: safePage <= 1 ? 0.3 : 1 }} disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>‹ Prev</button>
            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
              let p = i + 1;
              if (totalPages > 5) {
                if (safePage <= 3) p = i + 1;
                else if (safePage >= totalPages - 2) p = totalPages - 4 + i;
                else p = safePage - 2 + i;
              }
              return <button key={p} style={{ ...S.btn, padding: '5px 10px', fontSize: 12, border: `1px solid ${safePage === p ? 'var(--accent)' : 'var(--border)'}`, background: safePage === p ? 'var(--accent)' : 'var(--surface2)', color: safePage === p ? '#fff' : 'var(--text2)' }} onClick={() => setPage(p)}>{p}</button>;
            })}
            <button style={{ ...S.btn, padding: '5px 10px', fontSize: 12, border: '1px solid var(--border)', background: 'var(--surface2)', color: 'var(--text2)', opacity: safePage >= totalPages ? 0.3 : 1 }} disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>Next ›</button>
          </div>
        </div>
      </div>

      {/* DETAIL PANEL */}
      <div style={S.backdrop(!!detailId)} onClick={() => setDetailId(null)} />
      <div className="detail-panel" style={S.overlay(!!detailId)}>
        {detailInv && (
          <>
            <div style={{ padding: 20, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
              <h2 style={{ fontSize: 16, fontWeight: 600 }}>{detailInv.id} <span style={{ color: 'var(--text3)', fontSize: 13, fontWeight: 400 }}>— {detailInv.vendor}</span></h2>
              <div className="panel-actions">
                <button onClick={() => openEdit(detailInv)} style={{ ...S.btn, background: 'var(--accent)', color: '#fff', padding: '6px 12px' }}>✎ Edit</button>
                <button onClick={() => setDetailId(null)} style={{ ...S.btn, background: 'none', border: '1px solid var(--border)', color: 'var(--text2)', padding: '6px 10px' }}>✕ Close</button>
              </div>
            </div>
            <div style={{ padding: 20 }}>
              {/* Overview */}
              <div style={{ marginBottom: 24 }}>
                <h4 style={S.sectionH}>Invoice Overview</h4>
                <div className="detail-grid">
                  {[
                    ['Vendor', detailInv.vendor], ['Type', String(detailInv.type).replace('_', ' ')],
                    ['Date', new Date(detailInv.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })],
                    ['Line Items', detailInv.lines.length],
                    ['Subtotal', fmt(detailInv.subtotal)], ['GST', fmt(detailInv.gst)],
                    ['Total Billed', fmt(detailInv.total)], ['Recoverable', `${fmt(detailInv.impact)} (${detailInv.pct.toFixed(2)}%)`],
                  ].map(([label, val], i) => (
                    <div key={i}>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 2 }}>{label}</div>
                      <div className={i >= 4 ? 'mono' : ''} style={{ fontSize: 14, fontWeight: 600, color: label === 'Recoverable' ? 'var(--red)' : 'var(--text)', textTransform: label === 'Type' ? 'capitalize' : 'none' }}>{val}</div>
                    </div>
                  ))}
                </div>
                {detailInv.userAdded && (
                  <div style={{ background: 'var(--accent-bg)', border: '1px solid var(--accent)', borderRadius: 6, padding: '10px 14px', marginTop: 12, fontSize: 12, color: 'var(--text2)' }}>
                    Session record — entered or edited by <strong>{userEmail || 'this session'}</strong>. It resets on page refresh.
                  </div>
                )}
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
                  <h4 style={S.sectionH}>Audit Findings ({detailFindings.length})</h4>
                  {detailFindings.map(f => (
                    <div key={f.id} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                        <span style={S.tag(CAT_BG[f.category], CAT_COLORS[f.category])}>{f.category}</span>
                        <span style={S.tag(f.status === 'OVERCHARGE' ? 'var(--red-bg)' : 'var(--green-bg)', f.status === 'OVERCHARGE' ? 'var(--red)' : 'var(--green)')}>{f.status}</span>
                        {f.lineDesc && <span style={{ color: 'var(--text3)', fontSize: 12 }}>— {f.lineDesc}</span>}
                        {f.suppressed && <span style={{ color: 'var(--text3)', fontSize: 11 }}>[suppressed]</span>}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text2)', lineHeight: 1.5 }}>{renderExpl(f.explanation, fmt)}</div>
                      {f.financialImpact > 0 && <div className="mono" style={{ fontSize: 16, fontWeight: 700, color: 'var(--red)', marginTop: 6 }}>{fmt(f.financialImpact)}</div>}
                      {f.expected != null && f.category !== 'DUPLICATE' && (
                        <div className="finding-grid">
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
                <h4 style={S.sectionH}>Line Items ({detailInv.lines.length})</h4>
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

      {/* ADD / UPDATE MODAL */}
      {modalOpen && (
        <>
          <div style={{ ...S.backdrop(true), zIndex: 199 }} onClick={() => setModalOpen(false)} />
          <div
            className="modal-wrap" style={S.modalWrap}
            role="dialog"
            aria-modal="true"
            aria-label={editingId ? 'Update invoice' : 'Add invoice'}
            onClick={e => { if (e.target === e.currentTarget) setModalOpen(false); }}
          >
            <div style={S.modal} onClick={e => e.stopPropagation()}>
              <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div>
                  <h2 style={{ fontSize: 16, fontWeight: 600 }}>{editingId ? `Update ${editingId}` : 'Add Invoice Data'}</h2>
                  <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 2 }}>
                    Step {modalStep} of 2 — {modalStep === 1 ? 'identify yourself' : 'invoice details'}
                  </p>
                </div>
                <button type="button" onClick={() => setModalOpen(false)} style={{ ...S.btn, background: 'none', border: '1px solid var(--border)', color: 'var(--text2)', padding: '6px 10px' }}>✕ Close</button>
              </div>

              <div style={{ padding: '10px 20px 0' }}>
                <div style={{ background: 'var(--orange-bg)', border: '1px solid var(--border2)', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: 'var(--text2)' }}>
                  Data is stored for this session only. Changes will reset on page refresh.
                </div>
              </div>

              {modalStep === 1 ? (
                <form
                  onSubmit={e => { e.preventDefault(); const v = emailDraft.trim(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { setFormErrors(['Enter a valid email address to continue.']); return; } setUserEmail(v); setFormErrors([]); }}
                  style={{ padding: 20 }}
                >
                  <label style={S.label} htmlFor="email-input">Your email ID</label>
                  <input id="email-input" autoFocus type="email" value={emailDraft} onChange={e => setEmailDraft(e.target.value)} placeholder="you@company.com" style={S.input} />
                  <p style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>Entries you submit are tagged to this address for the rest of the session.</p>
                  {formErrors.length > 0 && (
                    <div style={{ background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: 'var(--red)', marginTop: 12 }}>{formErrors[0]}</div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                    <button type="submit" style={{ ...S.btn, background: 'var(--accent)', color: '#fff' }}>Continue →</button>
                  </div>
                </form>
              ) : (
                <form onSubmit={submitForm} style={{ padding: 20 }}>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 16 }}>
                    Submitting as <strong style={{ color: 'var(--text2)' }}>{userEmail}</strong>
                    <button type="button" onClick={() => { setUserEmail(''); setEmailDraft(''); }} style={{ ...S.btn, background: 'none', border: 'none', color: 'var(--accent)', padding: '0 6px', fontSize: 12 }}>change</button>
                  </div>

                  {formErrors.length > 0 && (
                    <div style={{ background: 'var(--red-bg)', border: '1px solid var(--red-border)', borderRadius: 6, padding: '10px 14px', fontSize: 12, color: 'var(--red)', marginBottom: 16 }}>
                      {formErrors.map((er, i) => <div key={i}>• {er}</div>)}
                    </div>
                  )}

                  <div className="form-grid-3">
                    <div>
                      <label style={S.label} htmlFor="f-id">Invoice ID *</label>
                      {/* Locked while editing: re-keying the ID would leave the
                          original record in the dataset alongside the copy. */}
                      <input
                        id="f-id"
                        style={{ ...S.input, opacity: editingId ? 0.6 : 1, cursor: editingId ? 'not-allowed' : 'text' }}
                        value={form.invoice_id}
                        readOnly={!!editingId}
                        onChange={e => setForm(f => ({ ...f, invoice_id: e.target.value }))}
                        placeholder="INV-1001"
                      />
                    </div>
                    <div>
                      <label style={S.label} htmlFor="f-vendor">Vendor Name *</label>
                      <select id="f-vendor" style={S.input} value={form.vendor_name} onChange={e => setForm(f => ({ ...f, vendor_name: e.target.value }))}>
                        <option value="">Select vendor…</option>
                        {VENDOR_LIST.map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={S.label} htmlFor="f-date">Invoice Date *</label>
                      <input id="f-date" type="date" style={S.input} value={form.invoice_date} onChange={e => setForm(f => ({ ...f, invoice_date: e.target.value }))} />
                    </div>
                  </div>

                  <h4 style={S.sectionH}>Line Items ({form.lines.length})</h4>
                  {form.lines.map((li, idx) => {
                    const rateItems = form.vendor_name ? Object.keys(rateCardRaw[form.vendor_name] || {}) : [];
                    return (
                      <div key={idx} style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                          <span style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Line {idx + 1}</span>
                          {form.lines.length > 1 && (
                            <button type="button" onClick={() => setForm(f => ({ ...f, lines: f.lines.filter((_, i) => i !== idx) }))} style={{ ...S.btn, background: 'none', border: '1px solid var(--red-border)', color: 'var(--red)', padding: '3px 8px', fontSize: 11 }}>Remove</button>
                          )}
                        </div>
                        <div className="line-grid-2">
                          <div>
                            <label style={S.label}>Description *</label>
                            <select
                              style={S.input}
                              value={li.description}
                              onChange={e => {
                                const v = e.target.value;
                                // Contracted items pre-fill their rate-card price so the
                                // entry starts from the agreed rate rather than a blank.
                                const rate = rateCardRaw[form.vendor_name]?.[v];
                                setLine(idx, { description: v, ...(rate !== undefined ? { unit_price: String(rate) } : {}) });
                              }}
                              disabled={!form.vendor_name}
                            >
                              <option value="">{form.vendor_name ? 'Select item…' : 'Pick a vendor first'}</option>
                              {rateItems.map(d => <option key={d} value={d}>{d}</option>)}
                              <option value={CUSTOM_DESC}>Other / Custom…</option>
                            </select>
                            {li.description === CUSTOM_DESC && (
                              <input style={{ ...S.input, marginTop: 6 }} value={li.customDesc} onChange={e => setLine(idx, { customDesc: e.target.value })} placeholder="Custom description" />
                            )}
                          </div>
                          <div className="line-grid-2" style={{ marginBottom: 0 }}>
                            <div>
                              <label style={S.label}>Quantity *</label>
                              <input type="number" step="any" style={S.input} value={li.quantity} onChange={e => setLine(idx, { quantity: e.target.value })} />
                            </div>
                            <div>
                              <label style={S.label}>Unit Price *</label>
                              <input type="number" step="any" style={S.input} value={li.unit_price} onChange={e => setLine(idx, { unit_price: e.target.value })} />
                            </div>
                          </div>
                        </div>
                        <div className="line-grid-3">
                          <div>
                            <label style={S.label}>Amount (auto)</label>
                            <input
                              type="number" step="any" style={S.input}
                              value={li.amountTouched ? li.amount : String(round2(num(li.quantity) * num(li.unit_price)))}
                              onChange={e => setLine(idx, { amount: e.target.value, amountTouched: true })}
                            />
                          </div>
                          <div>
                            <label style={S.label}>GST Rate % *</label>
                            <input type="number" step="any" style={S.input} value={li.gst_rate} onChange={e => setLine(idx, { gst_rate: e.target.value })} />
                          </div>
                          <div>
                            <label style={S.label}>HSN Code *</label>
                            <input list="hsn-codes" style={S.input} value={li.hsn_code} onChange={e => setLine(idx, { hsn_code: e.target.value })} placeholder="3304" />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <datalist id="hsn-codes">{HSN_CODES.map(h => <option key={h} value={h} />)}</datalist>

                  <button type="button" onClick={() => setForm(f => ({ ...f, lines: [...f.lines, blankLine()] }))} style={{ ...S.btn, background: 'var(--surface2)', border: '1px dashed var(--border2)', color: 'var(--text2)', width: '100%', marginBottom: 20 }}>+ Add line item</button>

                  <h4 style={S.sectionH}>Totals — auto-calculated, editable</h4>
                  <div className="line-grid-3" style={{ marginBottom: 20 }}>
                    <div>
                      <label style={S.label}>Subtotal</label>
                      <input type="number" step="any" style={S.input} value={shownSubtotal} onChange={e => setForm(f => ({ ...f, subtotal: e.target.value, subtotalTouched: true }))} />
                    </div>
                    <div>
                      <label style={S.label}>GST Amount</label>
                      <input type="number" step="any" style={S.input} value={shownGst} onChange={e => setForm(f => ({ ...f, gst_amount: e.target.value, gstTouched: true }))} />
                    </div>
                    <div>
                      <label style={S.label}>Total</label>
                      <input type="number" step="any" style={S.input} value={shownTotal} onChange={e => setForm(f => ({ ...f, total: e.target.value, totalTouched: true }))} />
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <button type="button" onClick={() => { setForm(blankForm()); setEditingId(null); setFormErrors([]); }} style={{ ...S.btn, background: 'none', border: '1px solid var(--border)', color: 'var(--text2)' }}>Reset form</button>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button type="button" onClick={() => setModalOpen(false)} style={{ ...S.btn, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text2)' }}>Cancel</button>
                      <button type="submit" style={{ ...S.btn, background: 'var(--accent)', color: '#fff' }}>{editingId ? 'Save & re-audit' : 'Add & re-audit'}</button>
                    </div>
                  </div>
                </form>
              )}
            </div>
          </div>
        </>
      )}

      {/* TOAST */}
      {toast && (
        <div className="toast-card" style={S.toast} role="status">
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ color: 'var(--green)', fontWeight: 700 }}>✓</span>
            <span style={{ color: 'var(--text2)' }}>{toast}</span>
            <button type="button" onClick={() => setToast(null)} style={{ ...S.btn, background: 'none', border: 'none', color: 'var(--text3)', padding: 0, marginLeft: 'auto' }}>✕</button>
          </div>
        </div>
      )}

      {/* FOOTER */}
      <footer style={{ textAlign: 'center', padding: '32px 0 16px', color: 'var(--text3)', fontSize: 12 }}>
        Mosaic Wellness Invoice Audit Intelligence — Deterministic engine · {fmtN(sum.totalInvoices)} invoices · {fmtN(sum.totalLines)} line items
        {!isFullRange && <> · date range {fmtDate(from)} – {fmtDate(to)} of {fmtN(data.invoices.length)} audited</>}
        {overrides.size > 0 && <> · {overrides.size} session record{overrides.size === 1 ? '' : 's'}</>}
        {userEmail && <div style={{ marginTop: 4, opacity: 0.8 }}>Session: {userEmail}</div>}
      </footer>
    </div>
  );
}
