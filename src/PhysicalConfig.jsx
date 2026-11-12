import React, { useEffect, useState } from 'react';

const FIELDS = [
  ['temperatureWarning', 'Temperatura advertencia (°C)'],
  ['temperatureCritical', 'Temperatura crítica (°C)'],
  ['vibrationWarning', 'Movimiento advertencia (m/s²)'],
  ['vibrationCritical', 'Movimiento crítico (m/s²)'],
];

// Coloca <PhysicalConfig /> SOLO en la sección Configuración del administrador.
// Express verifica el rol de todos modos.
export default function PhysicalConfig() {
  const [limits, setLimits] = useState(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/config/physical', { credentials: 'same-origin' })
      .then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`); return data; })
      .then(data => setLimits(data.limits))
      .catch(e => setMessage(`Error al cargar: ${e.message}`));
  }, []);

  async function save(e) {
    e.preventDefault();
    setMessage('');
    const vals = Object.values(limits);
    if (vals.some(v => !Number.isFinite(v) || v < 0 || v > 200) ||
        limits.temperatureWarning >= limits.temperatureCritical ||
        limits.vibrationWarning >= limits.vibrationCritical) {
      setMessage('Valores inválidos: use 0–200 y advertencia menor que crítico.');
      return;
    }
    setSaving(true);
    try {
      const r = await fetch('/api/config/physical', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limits }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setLimits(data.limits);
      setMessage('Guardado. El ESP32 consultará los nuevos límites en su siguiente actualización (≈30 s).');
    } catch (e) { setMessage(`No se pudo guardar: ${e.message}`); }
    finally { setSaving(false); }
  }

  return (
    <section style={{ marginTop: 24, padding: 20, border: '1px solid #cbd5e1', borderRadius: 12 }}>
      <h3>Umbrales del prototipo físico</h3>
      <p>Independientes de Wokwi. Valores de demostración, no límites industriales.</p>
      {limits && <form onSubmit={save}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
          {FIELDS.map(([key, label]) => <label key={key} style={{ display: 'grid', gap: 4 }}>
            {label}
            <input type="number" min="0" max="200" step="0.1" value={limits[key]}
              onChange={e => setLimits(prev => ({ ...prev, [key]: Number(e.target.value) }))} required />
          </label>)}
        </div>
        <button type="submit" disabled={saving} style={{ marginTop: 14 }}>
          {saving ? 'Guardando...' : 'Guardar umbrales físicos'}
        </button>
      </form>}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
