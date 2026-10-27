import { useEffect, useState } from 'react';
import { useBuilding } from '../../context/BuildingContext';
import { getBoq, setIncludeGst, type BOQBreakdown, type BOQLine } from '../../services/api';
import { formatCurrency } from '../../utils/formatters';

const CATEGORIES: { key: BOQLine['category']; label: string; color: string }[] = [
  { key: 'material', label: 'Materials',            color: '#b0604f' },
  { key: 'labour',   label: 'Labour',               color: '#4f7d78' },
  { key: 'add_on',   label: 'Overhead & profit',    color: '#6e6890' },
  { key: 'fitting',  label: 'Flooring & fittings',  color: '#5c7d59' },
  { key: 'regional', label: 'Regional adjustment',  color: '#a57c3a' },
  { key: 'tax',      label: 'GST',                  color: '#6b665e' },
];

/** The building priced from the Karnataka PWD Schedule of Rates 2023-24, line by line. */
export function BoqCard() {
  const { state, dispatch } = useBuilding();
  const [boq, setBoq] = useState<BOQBreakdown | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);

  // Re-price whenever anything that affects cost changes
  const { used } = state.budget;
  const districtId = state.district.id;
  const gst = state.constraints.includeGst ?? false;
  useEffect(() => {
    let live = true;
    getBoq().then(b => { if (live) { setBoq(b); setError(false); } }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [used, districtId, gst]);

  const toggleGst = async () => {
    try {
      dispatch({ type: 'SET_STATE', payload: await setIncludeGst(!gst) });
    } catch { setError(true); }
  };

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.6rem' }}>
      <span style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}>COST BREAKDOWN · KPWD SR</span>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.6rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
        <input type="checkbox" checked={gst} onChange={toggleGst} style={{ margin: 0 }} /> GST 18%
      </label>
    </div>
  );

  if (error) return <div>{header}<div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>Estimate unavailable — is the backend running?</div></div>;
  if (!boq || boq.floors === 0) return <div>{header}<div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>Add a floor to see the bill of quantities.</div></div>;

  const byCat = CATEGORIES
    .map(c => ({ ...c, amount: boq.lines.filter(l => l.category === c.key).reduce((s, l) => s + l.amount, 0) }))
    .filter(c => c.amount > 0);
  const qty = (key: string) => boq.lines.find(l => l.key === key)?.qty ?? 0;

  return (
    <div>
      {header}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '1.15rem', fontWeight: 800, color: '#2b2926' }}>{formatCurrency(boq.total)}</span>
        <span style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)' }}>{boq.plinth_area_m2} m² plinth</span>
      </div>

      {/* Key quantities */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.3rem', margin: '0.5rem 0 0.6rem' }}>
        {[
          { label: 'Cement', value: `${Math.round(qty('cement_t') * 20)} bags` },
          { label: 'Steel', value: `${(qty('steel_kg') / 1000).toFixed(1)} t` },
          { label: 'M-Sand', value: `${Math.round(qty('sand_m3'))} m³` },
        ].map(q => (
          <div key={q.label} style={{ background: 'rgba(60,52,44,0.036)', border: '1px solid var(--border-subtle)', borderRadius: '6px', padding: '0.3rem 0.4rem' }}>
            <div style={{ fontSize: '0.52rem', color: 'var(--text-tertiary)', letterSpacing: '0.06em' }}>{q.label.toUpperCase()}</div>
            <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#2b2926' }}>{q.value}</div>
          </div>
        ))}
      </div>

      {byCat.map(c => {
        const pct = Math.round((100 * c.amount) / boq.total);
        return (
          <div key={c.key} style={{ marginBottom: '0.45rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.18rem', fontSize: '0.64rem' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: c.color }} />{c.label}
              </span>
              <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{formatCurrency(c.amount)} <span style={{ color: 'var(--text-tertiary)', fontWeight: 500 }}>{pct}%</span></span>
            </div>
            <div style={{ height: '3px', background: 'rgba(60,52,44,0.06)', borderRadius: '2px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: c.color, borderRadius: '2px', transition: 'width 0.6s ease' }} />
            </div>
          </div>
        );
      })}

      {(boq.placeholders_used > 0 || boq.regional_status !== 'verified' || boq.approximate) && (
        <div style={{ fontSize: '0.58rem', color: '#a57c3a', margin: '0.4rem 0', lineHeight: 1.4 }}>
          {boq.placeholders_used > 0 && `${boq.placeholders_used} placeholder rates (cement, steel, sand, wages) pending KPWD Vol 1. `}
          {boq.approximate && 'Outside the range the CBRI relations cover — approximate.'}
        </div>
      )}

      <button onClick={() => setOpen(o => !o)} style={{ background: 'none', border: 'none', padding: 0, fontSize: '0.62rem', color: '#4f7d78', cursor: 'pointer' }}>
        {open ? 'Hide' : 'Show'} bill of quantities ({boq.lines.length} lines)
      </button>
      {open && (
        <div style={{ marginTop: '0.4rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
          {boq.lines.map(l => (
            <div key={l.key} style={{ fontSize: '0.6rem', borderBottom: '1px solid rgba(60,52,44,0.048)', paddingBottom: '0.25rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.4rem' }}>
                <span style={{ color: 'var(--text-secondary)' }}>{l.label}</span>
                <span style={{ color: '#2b2926', fontWeight: 600, whiteSpace: 'nowrap' }}>{formatCurrency(l.amount)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.4rem', color: 'var(--text-tertiary)' }}>
                <span>{l.unit === 'LS' ? l.ref : `${l.qty} ${l.unit} × ₹${l.rate.toLocaleString('en-IN')}`}</span>
                <span style={{ whiteSpace: 'nowrap', color: l.status === 'verified' ? '#5c7d59' : l.status === 'placeholder' || l.status === 'interim' ? '#a57c3a' : 'var(--text-tertiary)' }}>
                  {l.status === 'verified' ? `${l.ref} · p.${l.page}` : l.status}
                </span>
              </div>
            </div>
          ))}
          {boq.notes.map(n => <div key={n} style={{ fontSize: '0.56rem', color: 'var(--text-tertiary)' }}>• {n}</div>)}
          <div style={{ fontSize: '0.56rem', color: 'var(--text-tertiary)' }}>Source: Karnataka PWD Schedule of Rates for Buildings 2023-24, Vol 2.</div>
        </div>
      )}
    </div>
  );
}
