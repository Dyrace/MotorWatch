// MotorWatch: configuración independiente para el prototipo físico.
// Se registra desde server/index.js; NO reemplaza la API actual.

const DEFAULT_PHYSICAL = {
  temperatureWarning: 25,
  temperatureCritical: 30,
  vibrationWarning: 2,
  vibrationCritical: 5,
};

export function registerPhysicalConfigRoutes(app, { db, persist, list, auth }) {
  db.run(`CREATE TABLE IF NOT EXISTS physical_settings (
    key TEXT PRIMARY KEY,
    value REAL NOT NULL
  )`);

  for (const [key, value] of Object.entries(DEFAULT_PHYSICAL)) {
    db.run('INSERT OR IGNORE INTO physical_settings (key,value) VALUES (?,?)', [key, value]);
  }
  persist();

  const getLimits = () => {
    const limits = { ...DEFAULT_PHYSICAL };
    for (const row of list('SELECT key,value FROM physical_settings')) {
      if (Object.hasOwn(limits, row.key)) limits[row.key] = Number(row.value);
    }
    return limits;
  };

  // Solo usuarios con sesión pueden leer; únicamente administradores modifican.
  app.get('/api/config/physical', auth.requireUser, (_req, res) => {
    res.json({ limits: getLimits() });
  });

  app.put('/api/config/physical', auth.requireUser, auth.requireAdmin, (req, res) => {
    const incoming = req.body?.limits;
    const keys = Object.keys(DEFAULT_PHYSICAL);
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming) ||
        Object.keys(incoming).length !== keys.length ||
        keys.some(k => typeof incoming[k] !== 'number' ||
          !Number.isFinite(incoming[k]) || incoming[k] < 0 || incoming[k] > 200) ||
        incoming.temperatureWarning >= incoming.temperatureCritical ||
        incoming.vibrationWarning >= incoming.vibrationCritical) {
      return res.status(400).json({
        error: 'Se requieren cuatro umbrales entre 0 y 200; advertencia debe ser menor que crítico.'
      });
    }

    for (const key of keys) {
      db.run('UPDATE physical_settings SET value=? WHERE key=?', [incoming[key], key]);
    }
    persist();
    res.json({ limits: getLimits() });
  });

  // El ESP32 usa su propia clave; no requiere una sesión de trabajador.
  // No usar este endpoint para Wokwi: su configuración original permanece independiente.
  app.get('/api/device/config', (req, res) => {
    if (!auth.deviceAllowed(req)) {
      return res.status(401).json({ error: 'Clave de dispositivo inválida' });
    }
    if (req.query.source !== 'esp32_physical') {
      return res.status(400).json({ error: 'source debe ser esp32_physical' });
    }
    res.json({ limits: getLimits() });
  });

  return { getLimits };
}
