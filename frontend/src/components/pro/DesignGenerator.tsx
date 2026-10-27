import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { Sparkles, Check, X, AlertTriangle, Info, Loader2, LayoutGrid, FileText, ShieldCheck } from 'lucide-react';
import { BuildingProvider, useBuilding } from '../../context/BuildingContext';
import { DesignProvider } from '../../context/DesignContext';
import { DesignPanel } from '../visualizer/DesignPanel';
import { BuildingVisualizer } from '../visualizer/BuildingVisualizer';
import { StatsPanel } from '../stats/StatsPanel';
import { PresetDialog } from '../planner/PresetDialog';
import {
  applyDraft, discardDraft, generateDesign, getDraft, setApiWorkspace,
  type DesignBrief, type DraftInfo, type GenerateResult, type DesignEvaluation,
} from '../../services/api';
import { formatCurrency } from '../../utils/formatters';
import { SHAPES } from '../../utils/shapes';

const EXAMPLES = [
  '3BHK on two floors with parking for 1 car and a garden',
  '2BHK with a study, budget 35 lakh',
  '4 bedrooms, 3 bathrooms, kitchen, hall and dining on 2 floors, parking for 2 cars',
];

const label: React.CSSProperties = { fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.1em', color: 'var(--text-tertiary)' };
const input: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '0.45rem 0.6rem', background: 'rgba(60,52,44,0.048)',
  border: '1px solid var(--border-subtle)', borderRadius: '8px', color: '#2b2926', fontSize: '0.78rem', fontFamily: 'inherit',
};

function Note({ tone, icon, children }: { tone: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'flex-start', fontSize: '0.7rem', lineHeight: 1.5,
      color: 'var(--text-secondary)', background: `${tone}0d`, border: `1px solid ${tone}30`, borderRadius: '8px', padding: '0.45rem 0.55rem' }}>
      <span style={{ color: tone, flexShrink: 0, marginTop: '1px' }}>{icon}</span><div>{children}</div>
    </div>
  );
}

function List({ title, items, tone, icon }: { title: string; items: string[]; tone: string; icon: ReactNode }) {
  if (!items.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      <div style={label}>{title}</div>
      {items.map(t => <Note key={t} tone={tone} icon={icon}>{t}</Note>)}
    </div>
  );
}

/* ── The brief form and what the generator made of it ── */
function BriefPanel({ onGenerate, busy, result, error }: {
  onGenerate: (prompt: string, overrides: DesignBrief) => void; busy: boolean; result: GenerateResult | null; error: string | null;
}) {
  const [prompt, setPrompt] = useState('');
  const [f, setF] = useState({ budget: '', floors: '', plot: '', floorArea: '', shape: '', cars: '', garden: false });
  const num = (s: string) => (s.trim() === '' ? null : Number(s));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const budget = num(f.budget);
    onGenerate(prompt, {
      budget_inr: budget ? Math.round(budget * 100_000) : null,
      floors: num(f.floors), plot_area_sqft: num(f.plot), floor_area_sqft: num(f.floorArea),
      shape: f.shape || null, parking_cars: num(f.cars) ?? 0, garden: f.garden,
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        <div style={label}>DESCRIBE THE HOME YOU WANT</div>
        <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={4} required minLength={3}
          placeholder="e.g. 3BHK on two floors with parking for 1 car and a garden, budget 60 lakh"
          style={{ ...input, resize: 'vertical', lineHeight: 1.5 }} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
          {EXAMPLES.map(ex => (
            <button key={ex} type="button" onClick={() => setPrompt(ex)} style={{
              fontSize: '0.62rem', padding: '0.2rem 0.5rem', borderRadius: '20px', cursor: 'pointer',
              background: 'rgba(110,104,144,0.08)', border: '1px solid rgba(110,104,144,0.3)', color: '#5f5a80',
            }}>{ex}</button>
          ))}
        </div>
        <details>
          <summary style={{ ...label, cursor: 'pointer' }}>EXACT FIGURES (OPTIONAL — OVERRIDE THE TEXT)</summary>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.45rem', marginTop: '0.5rem' }}>
            {([['budget', 'Budget (lakh ₹)'], ['floors', 'Floors'], ['plot', 'Plot (sq ft)'], ['floorArea', 'Built-up / floor (sq ft)'], ['cars', 'Parking (cars)']] as const).map(([k, l]) => (
              <label key={k} style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
                {l}
                <input type="number" min={k === 'cars' ? 0 : 1} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} style={input} />
              </label>
            ))}
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
              Shape
              <select value={f.shape} onChange={e => setF({ ...f, shape: e.target.value })} style={input}>
                <option value="">Let the generator choose</option>
                {SHAPES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={f.garden} onChange={e => setF({ ...f, garden: e.target.checked })} /> Garden
            </label>
          </div>
        </details>
        <button type="submit" disabled={busy || prompt.trim().length < 3} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.45rem', padding: '0.65rem',
          background: '#5d6b80', border: 'none', borderRadius: '10px', color: '#fff',
          fontSize: '0.82rem', fontWeight: 700, cursor: busy ? 'wait' : 'pointer', opacity: busy || prompt.trim().length < 3 ? 0.6 : 1,
        }}>
          {busy ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Sparkles size={15} />}
          {busy ? 'Generating and checking designs…' : 'Generate design'}
        </button>
        <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
      </form>

      {error && <Note tone="#b0604f" icon={<X size={13} />}>{error}</Note>}

      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.7rem' }}>
            <span style={{ fontWeight: 700, color: result.feasible ? '#5c7d59' : '#b0604f' }}>
              {result.feasible ? 'Design generated' : 'No design generated'}
            </span>
            <span style={{ color: 'var(--text-tertiary)' }}>
              · brief read by {result.parser === 'gemini' ? 'Gemini AI' : 'built-in rules'} · {result.searched} layout(s) built and checked
            </span>
          </div>
          <List title="NOTES" items={result.notes} tone="#6b665e" icon={<Info size={12} />} />
          <List title="WHY IT ISN'T POSSIBLE" items={result.reasons} tone="#b0604f" icon={<X size={12} />} />
          <List title="PLEASE TELL ME" items={result.missing} tone="#a57c3a" icon={<AlertTriangle size={12} />} />
          <List title="WHY THIS DESIGN" items={result.why ?? []} tone="#5c7d59" icon={<Check size={12} />} />
          <List title="TAKEN FROM YOUR CURRENT SETUP" items={result.from_setup} tone="#4f7d78" icon={<Info size={12} />} />
          <List title="ASSUMPTIONS" items={result.assumptions} tone="#5f5a80" icon={<Info size={12} />} />
          <List title="WARNINGS" items={result.warnings} tone="#a57c3a" icon={<AlertTriangle size={12} />} />
          <div>
            <div style={label}>REQUIREMENTS AS UNDERSTOOD</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: '0.25rem' }}>
              {(result.brief.rooms ?? []).map(r => `${r.count} ${r.type}${r.count > 1 ? 's' : ''}${r.area_sqft ? ` (${r.area_sqft} sq ft)` : ''}`).join(', ') || '—'}
              {result.brief.floors ? ` · ${result.brief.floors} floor(s)` : ''}
              {result.brief.budget_inr ? ` · budget ${formatCurrency(result.brief.budget_inr)}` : ''}
              {result.brief.parking_cars ? ` · parking ${result.brief.parking_cars} car(s)` : ''}
              {result.brief.garden ? ' · garden' : ''}
            </div>
          </div>
          {result.alternatives.length > 0 && (
            <div>
              <div style={label}>OTHER WORKABLE LAYOUTS (NOT CHOSEN)</div>
              {result.alternatives.map(a => (
                <div key={`${a.shape}${a.floors}`} style={{ fontSize: '0.68rem', color: 'var(--text-tertiary)', marginTop: '0.2rem' }}>
                  {a.floors} {a.shape} floor(s) · rooms ×{a.size_scale} · {formatCurrency(a.cost)} · {a.code_warnings} IS 1893 warning(s)
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Live checks of the draft as the user edits it ── */
function DraftChecks({ onApply, onDiscard, busy }: { onApply: () => void; onDiscard: () => void; busy: string | null }) {
  const { state } = useBuilding();
  const [info, setInfo] = useState<DraftInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      getDraft().then(d => { if (live) { setInfo(d); setErr(null); } }).catch(e => { if (live) setErr(e.message); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [state]);
  const ev: DesignEvaluation | undefined = info?.evaluation;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem', padding: '0.75rem', borderRadius: '12px',
      background: 'rgba(93,107,128,0.036)', border: '1px solid rgba(110,104,144,0.3)' }}>
      <div style={{ ...label, color: '#5f5a80' }}>GENERATED DESIGN — NOT YET YOUR BUILDING</div>
      {err && <Note tone="#b0604f" icon={<X size={12} />}>{err}</Note>}
      {ev && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', fontSize: '0.7rem' }}>
            {[
              ['Estimated cost', formatCurrency(ev.cost)],
              ['Left in budget', formatCurrency(ev.remaining)],
              ['Floors · rooms', `${ev.floors} · ${ev.rooms}`],
              ['IS 1893 VB/W', ev.seismic_demand === null ? '—' : `${(ev.seismic_demand * 100).toFixed(1)} %`],
            ].map(([k, v]) => (
              <div key={k} style={{ background: 'rgba(60,52,44,0.036)', borderRadius: '8px', padding: '0.4rem 0.5rem' }}>
                <div style={{ color: 'var(--text-tertiary)', fontSize: '0.6rem' }}>{k}</div>
                <div style={{ fontWeight: 700, color: '#2b2926' }}>{v}</div>
              </div>
            ))}
          </div>
          {info?.current && (
            <div style={{ fontSize: '0.65rem', color: 'var(--text-tertiary)' }}>
              Your current building: {info.current.floors} floor(s), {info.current.rooms} room(s), {formatCurrency(info.current.cost)}.
            </div>
          )}
          {ev.valid
            ? <Note tone="#5c7d59" icon={<ShieldCheck size={12} />}>Passes every check: budget, room fit, compliance, structure{ev.code_warnings.length ? '' : ' and IS 1893'}.</Note>
            : ev.issues.map(i => <Note key={i} tone="#b0604f" icon={<X size={12} />}>{i}</Note>)}
          {ev.code_warnings.map(w => <Note key={w.rule} tone="#a57c3a" icon={<AlertTriangle size={12} />}>IS 1893 {w.rule}: {w.detail}</Note>)}
          {ev.boq_approximate && <Note tone="#6b665e" icon={<Info size={12} />}>{ev.boq_notes[0]}</Note>}
        </>
      )}
      <div style={{ display: 'flex', gap: '0.45rem' }}>
        <button onClick={onApply} disabled={!ev?.valid || busy !== null} title={ev?.valid ? 'Replace your building with this design' : 'Fix the issues above first'} style={{
          flex: 1, padding: '0.55rem', borderRadius: '9px', border: 'none', fontWeight: 700, fontSize: '0.76rem',
          background: ev?.valid ? '#5c7d59' : 'rgba(60,52,44,0.096)', color: ev?.valid ? '#ffffff' : 'var(--text-tertiary)',
          cursor: ev?.valid && !busy ? 'pointer' : 'not-allowed',
        }}>{busy === 'apply' ? 'Applying…' : 'Apply as my building'}</button>
        <button onClick={onDiscard} disabled={busy !== null} style={{
          padding: '0.55rem 0.8rem', borderRadius: '9px', fontWeight: 700, fontSize: '0.76rem', cursor: 'pointer',
          background: 'transparent', border: '1px solid rgba(176,96,79,0.4)', color: '#7f3f32',
        }}>{busy === 'discard' ? '…' : 'Discard'}</button>
      </div>
    </div>
  );
}

/** While the draft is open, every request from its editor goes to the draft workspace. */
function DraftScope() {
  useLayoutEffect(() => {
    setApiWorkspace('draft');
    return () => setApiWorkspace('main');
  }, []);
  return null;
}

function Column({ tabs }: { tabs: [string, string, ReactNode, ReactNode][] }) {
  const [tab, setTab] = useState(tabs[0][0]);
  return (
    <div style={{ width: '360px', flexShrink: 0, display: 'flex', flexDirection: 'column', height: '100%',
      background: '#fbfaf7', borderRight: '1px solid var(--border-subtle)' }}>
      {tabs.length > 1 && (
        <div style={{ display: 'flex', gap: '0.3rem', padding: '0.6rem 0.85rem', borderBottom: '1px solid var(--border-subtle)' }}>
          {tabs.map(([id, text, icon]) => (
            <button key={id} onClick={() => setTab(id)} style={{
              flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', padding: '0.5rem',
              borderRadius: '8px', fontSize: '0.74rem', fontWeight: 700, cursor: 'pointer',
              background: tab === id ? 'rgba(93,107,128,0.135)' : 'transparent',
              border: `1px solid ${tab === id ? 'rgba(110,104,144,0.6)' : 'var(--border-subtle)'}`,
              color: tab === id ? '#2b2926' : 'var(--text-secondary)',
            }}>{icon}{text}</button>
          ))}
        </div>
      )}
      {tabs.map(([id, , , body]) => (
        // Both stay mounted so the brief and its result survive switching tabs
        <div key={id} style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: tab === id ? 'flex' : 'none', flexDirection: 'column',
          padding: id === 'edit' ? 0 : '0.85rem', gap: '0.85rem' }}>{body}</div>
      ))}
    </div>
  );
}

/**
 * Pro: generate a complete design from a brief. The result opens in the normal
 * editor, on its own draft copy, so the user can inspect and change it; it only
 * replaces their building when they apply it.
 */
export function DesignGenerator({ onApplied }: { onApplied: () => void }) {
  const { dispatch } = useBuilding(); // the user's building, outside the draft
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [draft, setDraft] = useState<DraftInfo | null>(null);
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState<null | 'generate' | 'apply' | 'discard'>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDraft().then(setDraft).catch(e => setError(`Couldn't reach the server: ${e.message}`));
  }, []);

  const generate = async (prompt: string, overrides: DesignBrief) => {
    setBusy('generate'); setError(null);
    try {
      const r = await generateDesign(prompt, overrides);
      setResult(r);
      if (r.feasible) {
        setDraft(await getDraft());
        setGeneration(g => g + 1);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    setBusy('apply'); setError(null);
    try {
      dispatch({ type: 'SET_STATE', payload: await applyDraft() });
      setDraft({ exists: false });
      setResult(null);
      onApplied();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    setBusy('discard');
    try {
      setDraft(await discardDraft());
      setResult(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const brief = <BriefPanel onGenerate={generate} busy={busy === 'generate'} result={result} error={error} />;

  if (!draft?.exists || !draft.state) {
    return (
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <Column tabs={[['brief', 'Brief', <FileText key="b" size={14} />, brief]]} />
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem' }}>
          <div style={{ maxWidth: '440px', textAlign: 'center', color: 'var(--text-tertiary)', fontSize: '0.8rem', lineHeight: 1.7 }}>
            <Sparkles size={28} color="#5f5a80" style={{ marginBottom: '0.75rem' }} />
            <div style={{ color: '#2b2926', fontWeight: 700, fontSize: '1rem', marginBottom: '0.4rem' }}>Describe your home, get a complete design</div>
            Every candidate is built with the same engine as the editor, priced from the KPWD Schedule of Rates and checked
            against your budget, the compliance and structural rules and IS 1893. The best one opens here as an editable
            draft — your current building isn't touched until you apply it.
          </div>
        </div>
      </div>
    );
  }

  return (
    <BuildingProvider key={generation} workspace="draft" initial={draft.state}>
      <DesignProvider>
        <DraftScope />
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
          <Column tabs={[
            ['brief', 'Brief & checks', <FileText key="b" size={14} />,
              <><DraftChecks onApply={apply} onDiscard={discard} busy={busy} />{brief}</>],
            ['edit', 'Edit design', <LayoutGrid key="e" size={14} />, <DesignPanel />],
          ]} />
          <BuildingVisualizer />
          <StatsPanel />
        </div>
        <PresetDialog />
      </DesignProvider>
    </BuildingProvider>
  );
}
