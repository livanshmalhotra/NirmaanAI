import React, { useState } from 'react';
import { useBuilding } from '../../context/BuildingContext';
import { KARNATAKA_DISTRICTS, getDistrictById } from '../../data/karnataka_db';
import { API_BASE_URL } from '../../utils/constants';
import { SHAPES } from '../../utils/shapes';
import './ConfigurationModal.css';

interface ConfigurationModalProps {
  onComplete: () => void;
}

export function ConfigurationModal({ onComplete }: ConfigurationModalProps) {
  const { dispatch } = useBuilding();

  const [budgetLakhs, setBudgetLakhs] = useState<string>('50');
  const [plotSqft, setPlotSqft] = useState<string>('2400');
  const [floorSqft, setFloorSqft] = useState<string>('1200');
  const [error, setError] = useState<string | null>(null);
  const [shape, setShape] = useState<string>('rectangle');
  const [districtId, setDistrictId] = useState<string>('bengaluru-urban');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectedDistrict = getDistrictById(districtId);

  const handleSubmit = async (e: React.SyntheticEvent) => {
    e.preventDefault();

    const budgetVal = parseInt(budgetLakhs, 10);
    const plotVal = parseInt(plotSqft, 10);
    const floorVal = parseInt(floorSqft, 10);
    if (isNaN(budgetVal) || budgetVal <= 0) return;
    if (isNaN(plotVal) || isNaN(floorVal) || plotVal <= 0 || floorVal <= 0) return;
    if (floorVal >= plotVal) {
      setError('Built-up area per floor must be less than the total plot area.');
      return;
    }

    setError(null);
    setIsSubmitting(true);

    try {
      const totalBudgetInr = budgetVal * 100000;

      const res = await fetch(`${API_BASE_URL}/api/configure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          total_budget: totalBudgetInr,
          plot_area_sqft: plotVal,
          floor_area_sqft: floorVal,
          shape,
          district_id: districtId,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail ?? 'Failed to configure building');
      }

      const updatedState = await res.json();
      dispatch({ type: 'SET_STATE', payload: updatedState });

      if (selectedDistrict) {
        dispatch({ type: 'SET_DISTRICT', payload: selectedDistrict });
      }

      onComplete();
    } catch (err) {
      console.error('Configuration error:', err);
      setError(err instanceof Error ? err.message : String(err));
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content glass-panel">
        <h2 className="modal-title">Project Setup</h2>
        <p className="modal-subtitle">Configure your building project before starting.</p>

        <form onSubmit={handleSubmit} className="setup-form">

          {/* District */}
          <div className="form-group">
            <label htmlFor="district">District (Karnataka)</label>
            <select
              id="district"
              value={districtId}
              onChange={e => setDistrictId(e.target.value)}
              className="setup-input"
              required
            >
              <option value="" disabled>Select a district</option>
              {KARNATAKA_DISTRICTS.map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
            {selectedDistrict && (
              <div style={{
                marginTop: '0.65rem', fontSize: '0.68rem', 
                display: 'flex', gap: '0.5rem', flexWrap: 'wrap', lineHeight: 1.6,
              }}>
                {[
                  { text: selectedDistrict.region, color: '#6e6890' },
                  { text: selectedDistrict.thermal.climateZone, color: '#a57c3a' },
                  { text: `Seismic Zone ${selectedDistrict.seismic.zone}`, color: '#b0604f' },
                  { text: `Wind ${selectedDistrict.wind.basicWindSpeed} km/h`, color: '#4f7d78' },
                ].map(({ text, color }) => (
                  <span key={text} style={{ 
                    color, 
                    background: `${color}12`, 
                    border: `1px solid ${color}30`, 
                    borderRadius: '20px', 
                    padding: '0.15rem 0.6rem', 
                    fontWeight: 600,
                    whiteSpace: 'nowrap'
                  }}>{text}</span>
                ))}
              </div>
            )}
          </div>

          {/* Budget */}
          <div className="form-group">
            <label htmlFor="budget">Total Budget (in ₹ Lakhs)</label>
            <input
              id="budget"
              type="number"
              min="1"
              value={budgetLakhs}
              onChange={e => setBudgetLakhs(e.target.value)}
              className="setup-input"
              required
            />
          </div>

          {/* Plot + built-up area */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.85rem' }}>
            <div className="form-group">
              <label htmlFor="plot">Total Plot Area (sq. ft.)</label>
              <input
                id="plot"
                type="number"
                min="200"
                step="50"
                value={plotSqft}
                onChange={e => setPlotSqft(e.target.value)}
                className="setup-input"
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="floor">Built-up Area / Floor</label>
              <input
                id="floor"
                type="number"
                min="100"
                step="50"
                value={floorSqft}
                onChange={e => setFloorSqft(e.target.value)}
                className="setup-input"
                required
              />
            </div>
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-tertiary)', marginTop: '-0.9rem' }}>
            {(() => {
              const plot = parseInt(plotSqft, 10), floor = parseInt(floorSqft, 10);
              if (!plot || !floor) return 'Enter both areas.';
              if (floor >= plot) return <span style={{ color: '#9a5040' }}>Built-up area must be less than the plot area.</span>;
              return `${plot - floor} sq ft of open land left for parking, garden and setbacks. You'll size and place every room yourself.`;
            })()}
          </div>

          {/* Shape */}
          <div className="form-group">
            <label>Building Shape</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem' }}>
              {SHAPES.map(sh => {
                const active = sh.id === shape;
                const W = 44, D = W / sh.ratio;
                return (
                  <button
                    key={sh.id}
                    type="button"
                    title={sh.hint}
                    onClick={() => setShape(sh.id)}
                    style={{
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.3rem',
                      padding: '0.5rem 0.25rem', borderRadius: '10px', cursor: 'pointer',
                      background: active ? 'rgba(110,104,144,0.18)' : 'rgba(60,52,44,0.048)',
                      border: `1px solid ${active ? '#6e6890' : 'var(--border-color)'}`,
                      color: active ? '#4f4a6e' : 'var(--text-secondary)',
                    }}
                  >
                    <svg width="48" height="40" viewBox={`-2 -2 ${W + 4} ${Math.max(D, 32) + 4}`}>
                      {sh.id === 'pyramid'
                        ? [1, 0.72, 0.44].map(k => (
                            <rect key={k} x={(W - W * k) / 2} y={(D - D * k) / 2} width={W * k} height={D * k}
                              fill={`rgba(194,190,214,${0.25 + (1 - k) * 0.4})`} stroke="#5f5a80" strokeWidth="1" />
                          ))
                        : sh.rects.map(([x, z, w, d], i) => (
                            <rect key={i} x={x * W} y={z * D} width={w * W} height={d * D}
                              fill="rgba(95,90,128,0.35)" stroke="#5f5a80" strokeWidth="1" />
                          ))}
                    </svg>
                    <span style={{ fontSize: '0.68rem', fontWeight: 600 }}>{sh.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {error && (
            <div style={{ fontSize: '0.78rem', color: '#9a5040', background: 'rgba(154,80,64,0.08)', border: '1px solid rgba(154,80,64,0.3)', borderRadius: '8px', padding: '0.6rem 0.75rem' }}>
              {error}
            </div>
          )}

          <button type="submit" className="setup-button" disabled={isSubmitting}>
            {isSubmitting ? 'Starting...' : 'Start Building'}
          </button>
        </form>
      </div>
    </div>
  );
}
