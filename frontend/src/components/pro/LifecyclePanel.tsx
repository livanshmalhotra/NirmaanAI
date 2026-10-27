import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Wrench, Thermometer, Droplets, Layers, AlertTriangle, Info, Plus, X, Loader2, BookOpen, CalendarClock } from 'lucide-react';
import { useBuilding } from '../../context/BuildingContext';
import {
  compareLifecycle, fetchLifecycle, fetchLifecycleSources, getDraft,
  type LifecycleAlternative, type LifecycleOptions, type LifecycleReport, type LifecycleSummary, type Workspace,
} from '../../services/api';
import { formatCurrency } from '../../utils/formatters';

const DEFAULTS: LifecycleOptions = {
  horizon_years: 30, discount_pct: 0, structure: 'rcc_framed', wall_material: 'burnt_clay_brick',
  exterior_wall_in: null, plaster_mm: 15, roof_insulation: false, exterior_finish: 'exterior_emulsion',
  glass_u: null, glass_shgc: null, occupants: null, town: null, roof_type: 'concrete',
};

const WALLS: Record<LifecycleOptions['wall_material'], string> = {
  burnt_clay_brick: 'Burnt clay brick', fly_ash_brick: 'Fly ash brick', concrete_block: 'Solid concrete block', aac_block: 'AAC block',
};

const label: React.CSSProperties = { fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-tertiary)' };
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '0.4rem 0.5rem', background: 'rgba(60,52,44,0.048)',
  border: '1px solid var(--border-subtle)', borderRadius: '7px', color: '#2b2926', fontSize: '0.74rem', fontFamily: 'inherit',
};
const card: React.CSSProperties = { background: 'rgba(60,52,44,0.024)', border: '1px solid var(--border-subtle)', borderRadius: '12px', padding: '0.9rem 1rem' };

function Field({ name, children }: { name: string; children: ReactNode }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.66rem', color: 'var(--text-secondary)' }}>{name}{children}</label>;
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.7rem' }}>
        {icon}<span style={{ fontSize: '0.78rem', fontWeight: 700 }}>{title}</span>
      </div>
      {children}
    </div>
  );
}

const Src = ({ children }: { children: ReactNode }) => (
  <div style={{ fontSize: '0.6rem', color: 'var(--text-tertiary)', marginTop: '0.15rem', lineHeight: 1.45 }}>{children}</div>
);

function Stat({ name, value, sub, tone = '#2b2926' }: { name: string; value: string; sub?: string; tone?: string }) {
  return (
    <div style={{ ...card, padding: '0.7rem 0.8rem' }}>
      <div style={label}>{name}</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 800, color: tone, marginTop: '0.2rem' }}>{value}</div>
      {sub && <div style={{ fontSize: '0.62rem', color: 'var(--text-tertiary)', marginTop: '0.15rem' }}>{sub}</div>}
    </div>
  );
}

/* ── What-if choices ── */
function Options({ opt, set }: { opt: LifecycleOptions; set: (o: LifecycleOptions) => void }) {
  const n = (s: string) => (s === '' ? null : Number(s));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
      <div style={label}>WHAT-IF CHOICES</div>
      <Field name="Horizon (years)">
        <input type="number" min={1} max={100} value={opt.horizon_years} style={input}
          onChange={e => set({ ...opt, horizon_years: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
      </Field>
      <Field name="Discount rate (% a year, 0 = plain totals)">
        <input type="number" min={0} max={20} step={0.5} value={opt.discount_pct} style={input}
          onChange={e => set({ ...opt, discount_pct: Math.max(0, Math.min(20, Number(e.target.value) || 0)) })} />
      </Field>
      <Field name="Structure">
        <select value={opt.structure} style={input} onChange={e => set({ ...opt, structure: e.target.value as LifecycleOptions['structure'] })}>
          <option value="rcc_framed">RCC framed</option><option value="load_bearing">Load bearing</option>
        </select>
      </Field>
      <Field name="Exterior wall material">
        <select value={opt.wall_material} style={input} onChange={e => set({ ...opt, wall_material: e.target.value as LifecycleOptions['wall_material'] })}>
          {Object.entries(WALLS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </Field>
      <Field name='Exterior wall thickness (in, blank = as drawn)'>
        <input type="number" min={4.5} max={18} step={0.5} value={opt.exterior_wall_in ?? ''} style={input}
          onChange={e => set({ ...opt, exterior_wall_in: n(e.target.value) })} />
      </Field>
      <Field name="Plaster each side (mm)">
        <input type="number" min={0} max={40} value={opt.plaster_mm} style={input} onChange={e => set({ ...opt, plaster_mm: Number(e.target.value) || 0 })} />
      </Field>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
        <input type="checkbox" checked={opt.roof_insulation} onChange={e => set({ ...opt, roof_insulation: e.target.checked })} />
        40 mm PUF roof insulation
      </label>
      <Field name="Exterior finish">
        <select value={opt.exterior_finish} style={input} onChange={e => set({ ...opt, exterior_finish: e.target.value as LifecycleOptions['exterior_finish'] })}>
          <option value="exterior_emulsion">Exterior emulsion (repaint every 5 yrs)</option>
          <option value="exterior_cement_paint">Water-proofing cement paint (every 3 yrs)</option>
        </select>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
        <Field name="Glass U (blank = single clear)">
          <input type="number" min={0.1} max={7} step={0.1} value={opt.glass_u ?? ''} style={input} onChange={e => set({ ...opt, glass_u: n(e.target.value) })} />
        </Field>
        <Field name="Glass SHGC">
          <input type="number" min={0.05} max={1} step={0.05} value={opt.glass_shgc ?? ''} style={input} onChange={e => set({ ...opt, glass_shgc: n(e.target.value) })} />
        </Field>
      </div>
      <Field name="Roof (for rainwater runoff)">
        <select value={opt.roof_type} style={input} onChange={e => set({ ...opt, roof_type: e.target.value as LifecycleOptions['roof_type'] })}>
          <option value="concrete">Concrete</option><option value="tiled">Tiled</option><option value="gi_sheet">GI sheet</option><option value="asbestos">Asbestos</option>
        </select>
      </Field>
      <Field name="Occupants">
        <input type="number" min={1} max={60} value={opt.occupants ?? ''} placeholder="needed for water demand" style={input}
          onChange={e => set({ ...opt, occupants: n(e.target.value) })} />
      </Field>
      <Field name="Town population (IS 1172 Table 1)">
        <select value={opt.town ?? ''} style={input} onChange={e => set({ ...opt, town: (e.target.value || null) as LifecycleOptions['town'] })}>
          <option value="">Not set</option><option value="over_100k">Over 1 lakh</option><option value="20k_100k">20,000 – 1 lakh</option>
        </select>
      </Field>
      <button onClick={() => set(DEFAULTS)} style={{ ...input, cursor: 'pointer', color: 'var(--text-secondary)' }}>Reset to the design as drawn</button>
    </div>
  );
}

/* ── One design's report ── */
function Report({ r }: { r: LifecycleReport }) {
  const m = r.maintenance, e = r.envelope, w = r.water, s = r.summary;
  const longTerm = s.maintenance_priced;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.6rem' }}>
        <Stat name="TO BUILD (KPWD SR)" value={formatCurrency(r.initial_cost)} sub="bill of quantities, as on the Home page" />
        <Stat name={`MAINTENANCE · ${s.horizon_years} YRS`} value={formatCurrency(longTerm)} tone="#a57c3a"
          sub={`priced items only${r.options.discount_pct ? ` · present value ${formatCurrency(s.maintenance_priced_pv)}` : ''}`} />
        <Stat name="CPWD YARDSTICK" value={formatCurrency(m.yardstick.total)} tone="#5f5a80" sub="benchmark: repairs + electrical, 2019 Delhi rates" />
        <Stat name="RETV (ENS 2018)" value={e.retv === null ? '—' : `${e.retv} W/m²`} tone={e.retv === null ? '#8f897f' : e.retv_ok ? '#5c7d59' : '#b0604f'}
          sub={e.retv === null ? 'not calculated' : `limit ${e.retv_max} · lower is cooler`} />
        <Stat name="ROOF U-VALUE" value={`${e.u_roof} W/m²K`} tone={e.roof_ok ? '#5c7d59' : '#b0604f'} sub={`ENS limit ${e.u_roof_max}`} />
        <Stat name="RAINWATER / YEAR" value={w.harvest ? `${Math.round(w.harvest.annual_litres / 1000)} kL` : '—'} tone="#4f7d78"
          sub={w.harvest ? `${w.harvest.rain_mm} mm measured rain` : 'rainfall unavailable'} />
      </div>

      {r.missing.length > 0 && (
        <div style={{ ...card, borderColor: 'rgba(165,124,58,0.35)', background: 'rgba(165,124,58,0.05)' }}>
          <div style={{ ...label, color: '#a57c3a', marginBottom: '0.35rem' }}>MISSING INFORMATION</div>
          {r.missing.map(x => <div key={x} style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>• {x}</div>)}
        </div>
      )}

      <Section icon={<Wrench size={15} color="#a57c3a" />} title="Maintenance — priced (CPWD periodicity × quantity × KPWD rate)">
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.7rem' }}>
          <thead><tr style={{ ...label, textAlign: 'left' }}>
            {['TASK', 'EVERY', 'QUANTITY', 'RATE', 'PER TIME', 'TIMES', 'TOTAL'].map(h => <th key={h} style={{ padding: '0.3rem', borderBottom: '1px solid var(--border-subtle)' }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {m.priced.map(p => (
              <tr key={p.task} style={{ borderBottom: '1px solid var(--border-subtle)', verticalAlign: 'top' }}>
                <td style={{ padding: '0.4rem 0.3rem' }}>{p.task}<Src>{p.source} · {p.rate_ref}</Src></td>
                <td style={{ padding: '0.4rem 0.3rem' }}>{p.every_years} yr</td>
                <td style={{ padding: '0.4rem 0.3rem' }}>{p.quantity} {p.unit}</td>
                <td style={{ padding: '0.4rem 0.3rem' }}>₹{p.rate}</td>
                <td style={{ padding: '0.4rem 0.3rem' }}>{formatCurrency(p.cost_per_event)}</td>
                <td style={{ padding: '0.4rem 0.3rem' }} title={`Due in years ${p.due_years.join(', ')}`}>{p.events}</td>
                <td style={{ padding: '0.4rem 0.3rem', fontWeight: 700 }}>{formatCurrency(p.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <Src>KPWD 2023-24 rates held constant; GST and price rises not included. CPWD yardstick for comparison: annual repairs {formatCurrency(m.yardstick.annual_repair)},
          special repairs {formatCurrency(m.yardstick.special_repair)}, electrical {formatCurrency(m.yardstick.electrical)} — {m.yardstick.basis}. {m.yardstick.source}.</Src>
      </Section>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.9rem' }}>
        <Section icon={<CalendarClock size={15} color="#4f7d78" />} title="Schedule — recurring work without a price">
          {m.unpriced.map(u => (
            <div key={u.task} style={{ fontSize: '0.7rem', marginBottom: '0.45rem' }}>
              <b>{u.task}</b> — every {u.every_years < 1 ? `${u.every_years * 12} months` : `${u.every_years} yr`}
              <Src>{u.source}. Not priced — {u.why}.</Src>
            </div>
          ))}
          <div style={{ ...label, margin: '0.6rem 0 0.3rem' }}>INSPECTIONS (CPWD CH. 7.2)</div>
          {m.inspections.map(i => <div key={i.text} style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginBottom: '0.2rem' }}>• {i.text}</div>)}
          <Src>{m.inspections[0]?.source}</Src>
        </Section>
        <Section icon={<Layers size={15} color="#5f5a80" />} title="Service life and replacements">
          {m.replacements.map(c => (
            <div key={c.component} style={{ fontSize: '0.7rem', marginBottom: '0.45rem' }}>
              <b>{c.component}</b> — {c.life_years} yr life · {c.replacements_in_horizon ? `replace ${c.replacements_in_horizon}× (year ${c.due_years.join(', ')})` : 'no replacement within the horizon'}
              <Src>{c.source}. Not priced: equipment isn't in the KPWD civil Schedule of Rates.</Src>
            </div>
          ))}
          <div style={{ fontSize: '0.7rem', marginTop: '0.5rem' }}>
            <b>Whole building</b> — {r.building_life.years} yr expected economic life ({r.building_life.structure === 'rcc_framed' ? 'RCC framed' : 'load bearing'})
            {r.building_life.warning && <div style={{ color: '#a57c3a' }}>{r.building_life.warning}</div>}
            <Src>{r.building_life.source}. {r.building_life.note}</Src>
          </div>
        </Section>
      </div>

      <Section icon={<Thermometer size={15} color="#b0604f" />} title={`Envelope and thermal comfort — Eco-Niwas Samhita 2018 · ${e.climate_zone ?? 'climate unknown'} climate (measured)`}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.9rem', fontSize: '0.7rem' }}>
          <div>
            <div style={label}>WALL U = {e.u_wall} W/m²K</div>
            {e.wall_layers.map((l, i) => <div key={i} style={{ color: 'var(--text-secondary)' }}>{l.layer}: R {l.R}</div>)}
            <div style={{ ...label, marginTop: '0.5rem' }}>ROOF U = {e.u_roof} W/m²K ({e.roof_ok ? 'meets' : 'exceeds'} the {e.u_roof_max} limit)</div>
            {e.roof_layers.map((l, i) => <div key={i} style={{ color: 'var(--text-secondary)' }}>{l.layer}: R {l.R}</div>)}
            <Src>{e.sources.u_values}; {e.sources.roof_limit}</Src>
          </div>
          <div>
            <div style={label}>FACADES (BUILDING TURNED {r.site.label ? 'AS ON THE SITE MAP' : ''})</div>
            {e.facades.map(f => (
              <div key={f.side} style={{ color: 'var(--text-secondary)' }}>
                {f.side} faces {f.faces} ({f.bearing_deg}°): wall {f.wall_m2} m², glass {f.window_m2} m², ω {f.omega}
              </div>
            ))}
            <Src>{e.sources.orientation}</Src>
            <div style={{ marginTop: '0.5rem' }}>
              {e.retv !== null
                ? <>RETV <b>{e.retv} W/m²</b> — {e.retv_ok ? 'within' : 'above'} the {e.retv_max} W/m² limit (a {e.coefficients?.a}, b {e.coefficients?.b}, c {e.coefficients?.c}).<Src>{e.retv_source}</Src></>
                : <span style={{ color: '#a57c3a' }}>{e.retv_note}</span>}
            </div>
            <div style={{ marginTop: '0.4rem' }}>Glass: U {e.glass.u}, SHGC {e.glass.shgc}<Src>{e.glass.source}</Src></div>
            <div style={{ marginTop: '0.4rem' }}>Window-to-floor {e.window_to_floor_pct ?? '—'} %<Src>{e.wfr_note}</Src></div>
          </div>
        </div>
        <div style={{ marginTop: '0.6rem', display: 'flex', gap: '0.4rem', fontSize: '0.66rem', color: 'var(--text-tertiary)' }}>
          <Info size={12} style={{ flexShrink: 0, marginTop: '2px' }} /><span>{e.energy_note} {e.assumptions.join('. ')}.</span>
        </div>
      </Section>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.9rem' }}>
        <Section icon={<Droplets size={15} color="#4f7d78" />} title="Water">
          <div style={{ fontSize: '0.7rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {w.harvest
              ? <div>Rooftop harvest: <b>{w.harvest.annual_litres.toLocaleString()} L/year</b> = {w.harvest.rain_mm} mm × {w.harvest.roof_m2} m² × {w.harvest.runoff_coefficient}
                  <Src>{w.harvest.source}. Rain: {w.harvest.rain_source}.</Src></div>
              : <div style={{ color: '#a57c3a' }}>Rainfall for the site couldn't be measured.</div>}
            {w.demand_litres_per_day
              ? <div>Demand: <b>{w.demand_litres_per_day[0].toLocaleString()}–{w.demand_litres_per_day[1].toLocaleString()} L/day</b>; flushing {w.flushing_litres_per_year?.toLocaleString()} L/year
                  {w.harvest_share_of_flushing_pct !== undefined && <> — harvested rain could cover about <b>{w.harvest_share_of_flushing_pct} %</b> of flushing.</>}
                  <Src>{w.per_capita[r.options.town ?? 'over_100k']?.source}; {w.flushing_lphd.source}</Src></div>
              : <div style={{ color: 'var(--text-tertiary)' }}>Enter occupants and the town population band for the demand (IS 1172: {w.per_capita.over_100k.lphd.join('–')} L/head/day over 1 lakh, {w.per_capita['20k_100k'].lphd.join('–')} for 20,000–1 lakh).</div>}
          </div>
        </Section>
        <Section icon={<Layers size={15} color="#5c7d59" />} title="Adaptability and durability">
          {r.adaptability.map(a => (
            <div key={a.topic} style={{ fontSize: '0.7rem', marginBottom: '0.4rem' }}><b>{a.topic}</b> — <span style={{ color: 'var(--text-secondary)' }}>{a.detail}</span></div>
          ))}
          {m.coastal && <div style={{ fontSize: '0.7rem', color: '#a57c3a' }}>Coastal district: CPWD gives conduit wiring a shorter life here (15 vs 20 years).</div>}
        </Section>
      </div>
    </div>
  );
}

/* ── Side-by-side comparison ── */
const ROWS: [string, (s: LifecycleSummary) => string][] = [
  ['To build (KPWD SR)', s => formatCurrency(s.initial_cost)],
  ['Maintenance, priced items', s => formatCurrency(s.maintenance_priced)],
  ['… present value', s => formatCurrency(s.maintenance_priced_pv)],
  ['Build + maintain', s => formatCurrency(s.initial_cost + s.maintenance_priced)],
  ['CPWD yardstick (benchmark)', s => formatCurrency(s.yardstick_total)],
  ['RETV W/m² (limit 15)', s => (s.retv === null ? '—' : String(s.retv))],
  ['Wall U W/m²K', s => String(s.u_wall)],
  ['Roof U W/m²K (limit 1.2)', s => String(s.u_roof)],
  ['Rainwater L/year', s => (s.harvest_litres === null ? '—' : s.harvest_litres.toLocaleString())],
];

function Comparison({ alts, onRemove }: { alts: LifecycleAlternative[]; onRemove: (i: number) => void }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof compareLifecycle>>['alternatives'] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const key = JSON.stringify(alts);
  useEffect(() => {
    if (!alts.length) { setRows(null); return; }
    let live = true;
    compareLifecycle(alts).then(r => { if (live) { setRows(r.alternatives); setErr(null); } }).catch(e => { if (live) setErr(e.message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!alts.length) return null;
  return (
    <Section icon={<Layers size={15} color="#5f5a80" />} title={`Design alternatives over ${alts[0].options.horizon_years} years`}>
      {err && <div style={{ color: '#b0604f', fontSize: '0.72rem' }}>{err}</div>}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.7rem' }}>
          <thead><tr>
            <th />
            {alts.map((a, i) => (
              <th key={i} style={{ textAlign: 'left', padding: '0.3rem', borderBottom: '1px solid var(--border-subtle)', fontWeight: 700 }}>
                {a.label} <button onClick={() => onRemove(i)} title="Remove" style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer' }}><X size={11} /></button>
                <div style={{ fontWeight: 400, color: 'var(--text-tertiary)', fontSize: '0.6rem' }}>
                  {a.design === 'draft' ? 'generated design' : 'your building'} · {WALLS[a.options.wall_material]}{a.options.roof_insulation ? ' · PUF roof' : ''}
                  {a.options.exterior_wall_in ? ` · ${a.options.exterior_wall_in}" wall` : ''} · {a.options.exterior_finish === 'exterior_emulsion' ? 'emulsion' : 'cement paint'}
                </div>
              </th>
            ))}
          </tr></thead>
          <tbody>
            {ROWS.map(([name, fmt]) => (
              <tr key={name} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <td style={{ padding: '0.35rem 0.3rem', color: 'var(--text-tertiary)' }}>{name}</td>
                {(rows ?? alts.map(() => null)).map((r, i) => (
                  <td key={i} style={{ padding: '0.35rem 0.3rem' }}>{r?.error ?? (r?.summary ? fmt(r.summary) : '…')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Src>The KPWD estimate comes from plinth-area relations, so it doesn't change with wall material, insulation or finish — those choices
        show up in maintenance and in the envelope figures. Energy in kWh isn't estimated (see the envelope note).</Src>
    </Section>
  );
}

/**
 * Pro: what a design needs over its life — maintenance, replacements, envelope
 * performance, water — next to what it costs to build, with what-if choices
 * and side-by-side alternatives. Every figure comes from the backend.
 */
export function LifecyclePanel() {
  const { state } = useBuilding();
  const [design, setDesign] = useState<Workspace>('main');
  const [hasDraft, setHasDraft] = useState(false);
  const [opt, setOpt] = useState<LifecycleOptions>(DEFAULTS);
  const [report, setReport] = useState<LifecycleReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alts, setAlts] = useState<LifecycleAlternative[]>([]);
  const [sources, setSources] = useState<Awaited<ReturnType<typeof fetchLifecycleSources>> | null>(null);

  useEffect(() => {
    getDraft().then(d => setHasDraft(d.exists)).catch(() => setHasDraft(false));
    fetchLifecycleSources().then(setSources).catch(() => setSources(null));
  }, []);

  // Recalculate when the choices, the chosen design or the building itself change
  const buildingKey = useMemo(() => JSON.stringify([state.floors, state.constraints, state.location, state.site.features]), [state]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      fetchLifecycle(opt, design)
        .then(r => { if (live) { setReport(r); setError(null); } })
        .catch(e => { if (live) { setReport(null); setError(e.message); } })
        .finally(() => { if (live) setLoading(false); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [opt, design, buildingKey]);

  const addAlternative = () => {
    const base = alts[0]?.options.horizon_years ?? opt.horizon_years;
    const n = alts.length + 1;
    setAlts([...alts, { label: `Option ${n}`, design, options: { ...opt, horizon_years: base } }].slice(0, 6));
  };

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <div style={{ width: '280px', flexShrink: 0, overflowY: 'auto', padding: '1rem', borderRight: '1px solid var(--border-subtle)', background: '#fbfaf7',
        display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
        <div>
          <div style={label}>DESIGN</div>
          <div style={{ display: 'flex', gap: '0.3rem', marginTop: '0.35rem' }}>
            {([['main', 'My building'], ['draft', 'Generated design']] as [Workspace, string][]).map(([w, l]) => (
              <button key={w} disabled={w === 'draft' && !hasDraft} onClick={() => setDesign(w)}
                title={w === 'draft' && !hasDraft ? 'Generate a design on the AI Generate tab first' : ''} style={{
                  flex: 1, padding: '0.4rem', borderRadius: '7px', fontSize: '0.68rem', fontWeight: 700,
                  cursor: w === 'draft' && !hasDraft ? 'not-allowed' : 'pointer', opacity: w === 'draft' && !hasDraft ? 0.45 : 1,
                  background: design === w ? 'rgba(110,104,144,0.25)' : 'transparent',
                  border: `1px solid ${design === w ? 'rgba(110,104,144,0.6)' : 'var(--border-subtle)'}`, color: '#2b2926',
                }}>{l}</button>
            ))}
          </div>
        </div>
        <Options opt={opt} set={setOpt} />
        <button onClick={addAlternative} disabled={!report || !!report.error || alts.length >= 6} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', padding: '0.55rem', borderRadius: '9px',
          background: '#5d6b80', border: 'none', color: '#fff', fontWeight: 700, fontSize: '0.74rem', cursor: 'pointer',
          opacity: !report || report.error ? 0.5 : 1,
        }}><Plus size={13} /> Add these choices to the comparison</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div>
            <div style={label}>LIFECYCLE & MAINTENANCE</div>
            <h2 style={{ margin: '0.2rem 0 0', fontSize: '1.2rem' }}>{design === 'draft' ? 'Generated design' : 'Your building'}{report?.site ? ` · ${report.site.label}` : ''}</h2>
          </div>
          {loading && <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>
            <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Recalculating…</span>}
          <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
        </div>
        {error && <div style={{ ...card, color: '#7f3f32', fontSize: '0.75rem' }}><AlertTriangle size={13} /> {error}</div>}
        {report?.error && <div style={{ ...card, color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{report.error}</div>}
        {report && !report.error && <Report r={report} />}
        <Comparison alts={alts} onRemove={i => setAlts(alts.filter((_, j) => j !== i))} />
        {sources && (
          <details style={card}>
            <summary style={{ cursor: 'pointer', fontSize: '0.75rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <BookOpen size={14} /> Sources ({Object.keys(sources.sources).length} official documents + KPWD SR 2023-24 + ERA5 climate)
            </summary>
            <div style={{ marginTop: '0.5rem', fontSize: '0.68rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <div>{sources.note} Built {sources.generated} by backend/scripts/build_lifecycle_data.py.</div>
              {Object.entries(sources.sources).map(([k, s]) => (
                <div key={k}><a href={s.url} target="_blank" rel="noreferrer" style={{ color: '#46607f' }}>{s.title}</a> — {s.publisher}
                  <Src>retrieved {s.retrieved} · sha256 {s.sha256.slice(0, 16)}…</Src></div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
