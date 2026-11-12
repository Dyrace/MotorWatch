import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, AlertTriangle, Bell, Clock3, Cpu, Gauge, LayoutDashboard, LineChart, Download, Settings, Thermometer, Wifi, WifiOff, Users, LogOut, FileDown } from 'lucide-react';
import './styles.css';
import PhysicalConfig from './PhysicalConfig.jsx';

const LIMITS = { temperatureWarning: 50, temperatureCritical: 70, vibrationWarning: 2, vibrationCritical: 5 };
const MOTOR_OPTIONS = [
  { id: 'MOTOR_01', name: 'Wokwi (ESP32 simulado)', source: 'esp32' },
  { id: 'MOTOR_FISICO_01', name: 'Prototipo físico (ESP32 real)', source: 'esp32_physical' }
];
const MOTOR_BY_ID = Object.fromEntries(MOTOR_OPTIONS.map(m => [m.id, m]));
const DEMO = [
  { temperature: 38.5, vibration: 0.4 },
  { temperature: 43.2, vibration: 1.1 },
  { temperature: 53.6, vibration: 2.4 },
  { temperature: 61.8, vibration: 3.1 },
  { temperature: 73.4, vibration: 5.5 },
  { temperature: 41.0, vibration: 0.8 }
];
function getStatus(t, v, limits) {
  if (t >= limits.temperatureCritical || v >= limits.vibrationCritical) return 'CRÍTICO';
  if (t >= limits.temperatureWarning || v >= limits.vibrationWarning) return 'ADVERTENCIA';
  return 'NORMAL';
}
const statusClass = status => status === 'CRÍTICO' ? 'critical' : status === 'ADVERTENCIA' ? 'warning' : 'normal';
const dateText = date => new Date(date).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'medium' });
const menu = [
  ['Panel principal', LayoutDashboard], ['Detalle del motor', Cpu], ['Tendencias', LineChart], ['Historial', Clock3], ['Reportes', FileDown], ['Alertas', Bell], ['Configuración', Settings]
];
function App() {
  const [page, setPage] = useState('Panel principal');
  const [selectedMotor, setSelectedMotor] = useState('MOTOR_01');
  const motorInfo = MOTOR_BY_ID[selectedMotor];
  const [limits, setLimits] = useState(LIMITS);
  const [draftLimits, setDraftLimits] = useState(LIMITS);
  const [saving, setSaving] = useState(false);
  const [configMessage, setConfigMessage] = useState('');
  const [device, setDevice] = useState({online:false,lastSeen:null,ageSeconds:null,timeoutSeconds:20});
  const [intervalSeconds, setIntervalSeconds] = useState(5);
  const [running, setRunning] = useState(false);
  const [index, setIndex] = useState(0);
  const [readings, setReadings] = useState([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [analytics, setAnalytics] = useState(null);
  const [analyticsError, setAnalyticsError] = useState('');
  const [physicalLimits, setPhysicalLimits] = useState(null);
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMessage, setAuthMessage] = useState('');
  const [credentials,setCredentials] = useState({username:'',password:''});
  const [passwordChange,setPasswordChange] = useState({currentPassword:'',newPassword:''});
  const current = readings[0] ?? { temperature: 0, vibration: 0, time: new Date().toISOString() };
  const status = readings.length ? (current.status === 'CRITICO' ? 'CRÍTICO' : current.status) : 'SIN DATOS';
  const alerts = useMemo(() => readings.filter(r => r.status !== 'NORMAL'), [readings]);
  const activeLimits = selectedMotor === 'MOTOR_FISICO_01' ? (physicalLimits ?? limits) : limits;
  async function refresh(motorId = selectedMotor, signal) {
    try {
      const query = new URLSearchParams({ motor_id: motorId, limit: '100' });
      const response = await fetch('/api/readings?' + query, { signal });
      if (!response.ok) throw new Error('No se pudieron consultar las lecturas del motor');
      const data = await response.json();
      if (signal?.aborted) return;
      setReadings(data.readings ?? []);
      try {
        const analysisResponse = await fetch('/api/analytics?' + new URLSearchParams({ motor_id: motorId, limit: '60' }), { signal });
        if (!analysisResponse.ok) throw new Error('No se pudieron consultar las tendencias');
        const nextAnalysis = await analysisResponse.json();
        if (!signal?.aborted) { setAnalytics(nextAnalysis); setAnalyticsError(''); }
      } catch(e) { if (e.name !== 'AbortError' && !signal?.aborted) setAnalyticsError(e.message); }
      const deviceResponse = await fetch('/api/device-status?' + new URLSearchParams({ motor_id: motorId }), { signal });
      if (deviceResponse.ok) {
        const nextDevice = await deviceResponse.json();
        if (!signal?.aborted) setDevice(nextDevice);
      } else if (!signal?.aborted) throw new Error('No se pudo consultar el estado del dispositivo');
      if (!signal?.aborted) { setConnected(true); setError(''); }
    } catch(e) {
      if (e.name !== 'AbortError' && !signal?.aborted) { setConnected(false); setError(e.message); }
    }
  }
  async function sendDemo(next) {
    try {
      const response = await fetch('/api/readings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({motor_id:'MOTOR_01',source:'simulation',temperature_c:DEMO[next].temperature,vibration_level:DEMO[next].vibration}) });
      if (!response.ok) throw new Error('No se pudo guardar la lectura');
      await refresh(selectedMotor);
    } catch(e) { setError(e.message); setConnected(false); }
  }
  useEffect(() => {
    fetch('/api/auth/me').then(r=>r.json()).then(d=>setUser(d.user)).catch(()=>setAuthMessage('No se pudo conectar al servidor.')).finally(()=>setAuthLoading(false));
  }, []);
  useEffect(() => {
    if (!user || user.mustChange) return;
    fetch('/api/config').then(r => { if (!r.ok) throw new Error('Sin configuración'); return r.json(); })
      .then(d => { setLimits(d.limits); setDraftLimits(d.limits); })
      .catch(() => setConfigMessage('No se pudo cargar la configuración del servidor.'));
    fetch('/api/config/physical').then(r => { if (!r.ok) throw new Error('Sin configuración física'); return r.json(); })
      .then(d => setPhysicalLimits(d.limits)).catch(() => {});
  }, [user?.id, user?.mustChange]);
  useEffect(() => {
    if (!user || user.mustChange || selectedMotor !== 'MOTOR_FISICO_01') return;
    let active = true;
    const load = async () => {
      try {
        const r = await fetch('/api/config/physical');
        if (r.ok) { const d = await r.json(); if (active) setPhysicalLimits(d.limits); }
      } catch (_) { /* Se conserva la configuración conocida si la API está temporalmente fuera de línea */ }
    };
    load();
    const timer = setInterval(load, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [user?.id, user?.mustChange, selectedMotor]);
  useEffect(() => {
    if (!user || user.mustChange) return;
    setReadings([]); setAnalytics(null); setDevice({online:false,lastSeen:null,ageSeconds:null,timeoutSeconds:20});
    const controller = new AbortController();
    const update = () => refresh(selectedMotor, controller.signal);
    update();
    const timer = setInterval(update, 2000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [user?.id, user?.mustChange, selectedMotor]);
  async function login(e) {
    e.preventDefault();setAuthMessage('');
    try {const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});const d=await r.json();
      if(!r.ok)throw Error(d.error||'Acceso denegado');setUser(d.user);setCredentials({username:'',password:''});
    }catch(err){setAuthMessage(err.message)}
  }
  async function logout(){
    await fetch('/api/auth/logout',{method:'POST'}).catch(()=>{});
    setUser(null);setRunning(false);setReadings([]);setPage('Panel principal');setSelectedMotor('MOTOR_01');
  }
  async function changePassword(e){
    e.preventDefault();setAuthMessage('');
    try{const r=await fetch('/api/auth/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(passwordChange)});
      const d=await r.json();if(!r.ok)throw Error(d.error);setUser(null);setPasswordChange({currentPassword:'',newPassword:''});setAuthMessage('Contraseña cambiada. Inicia sesión de nuevo.');
    }catch(err){setAuthMessage(err.message)}
  }
  async function saveLimits(candidate) {
    setSaving(true);setConfigMessage('');
    try {
      const response=await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({limits:candidate})});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||'No se pudo guardar');
      setLimits(data.limits);setDraftLimits(data.limits);setConfigMessage('Umbrales guardados en SQLite. Se aplicarán a las nuevas lecturas.');
    }catch(e){setConfigMessage(e.message)}finally{setSaving(false)}
  }

  useEffect(() => {
    if (!running || !user || user.mustChange) return;
    const timer = setInterval(() => setIndex(previous => {
      const next=(previous+1)%DEMO.length;
      sendDemo(next);
      return next;
    }), intervalSeconds*1000);
    return () => clearInterval(timer);
  }, [running,intervalSeconds,user?.id,user?.mustChange]);

  function updateLimit(key, value) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) setDraftLimits(old => ({ ...old, [key]: parsed }));
  }
  if(authLoading)return <div className="auth-screen"><div className="auth-card">Conectando con MotorWatch...</div></div>;
  if(!user)return <div className="auth-screen"><form className="auth-card" onSubmit={login}>
    <Activity size={38}/><h1>MotorWatch</h1><p>Acceso de personal autorizado</p>
    <label>Usuario<input autoComplete="username" required value={credentials.username} onChange={e=>setCredentials(c=>({...c,username:e.target.value}))}/></label>
    <label>Contraseña<input type="password" autoComplete="current-password" required value={credentials.password} onChange={e=>setCredentials(c=>({...c,password:e.target.value}))}/></label>
    {authMessage && <p role="alert" className="form-error">{authMessage}</p>}
    <button className="primary" type="submit">Iniciar sesión</button>
  </form></div>;
  if(user.mustChange)return <div className="auth-screen"><form className="auth-card" onSubmit={changePassword}>
    <h1>Cambio de contraseña obligatorio</h1><p>Hola, {user.username}. Sustituye tu contraseña temporal antes de continuar.</p>
    <label>Contraseña actual<input type="password" autoComplete="current-password" required value={passwordChange.currentPassword} onChange={e=>setPasswordChange(c=>({...c,currentPassword:e.target.value}))}/></label>
    <label>Nueva contraseña (mínimo 12 caracteres)<input type="password" autoComplete="new-password" minLength={12} required value={passwordChange.newPassword} onChange={e=>setPasswordChange(c=>({...c,newPassword:e.target.value}))}/></label>
    {authMessage && <p role="alert" className="form-error">{authMessage}</p>}
    <button className="primary" type="submit">Guardar y volver a iniciar sesión</button>
    <button className="secondary" type="button" onClick={logout}>Salir</button>
  </form></div>;
  const isAdmin=user.role==='admin';
  const visibleMenu=[...menu.filter(([name])=>isAdmin || name!=='Configuración'),...(isAdmin?[['Personal',Users]]:[])];
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><Activity size={26}/><div><strong>MotorWatch</strong><small>Monitoreo IoT</small></div></div>
      <nav aria-label="Navegación principal">{visibleMenu.map(([name, Icon]) => <button key={name} className={page === name ? 'nav active' : 'nav'} onClick={() => setPage(name)}><Icon size={19}/><span>{name}</span></button>)}</nav>
      <div className="sidebar-note"><Wifi size={17}/> API + SQLite</div>
    </aside>
    <main className="main">{!connected && <div role="alert" className="api-error">API desconectada. Ejecuta npm run dev:all. {error}</div>}
      <header className="topbar"><div><span className="eyebrow">Sistema de mantenimiento predictivo · {isAdmin?'Administrador':'Técnico'}</span><h1>{page}</h1></div><div className="top-actions"><span className="pill demo">{device.online?<Wifi size={15}/>:<WifiOff size={15}/>} {motorInfo.name}: {device.online?'en línea':'sin señal'}</span><button className="secondary" onClick={logout} title="Cerrar sesión"><LogOut size={16}/> Salir</button></div></header>
      <section className="panel" style={{ marginBottom: '16px', padding: '12px 16px' }} aria-label="Selección del motor monitoreado">
        <label style={{ display: 'grid', gap: '6px', maxWidth: '380px' }}>Motor y fuente de monitoreo
          <select value={selectedMotor} onChange={e => { setSelectedMotor(e.target.value); setRunning(false); }}>
            {MOTOR_OPTIONS.map(m => <option key={m.id} value={m.id}>{m.name} — {m.id}</option>)}
          </select>
        </label>
      </section>
      {page === 'Panel principal' && <>
        <div className="hero"><div><span className="eyebrow">{selectedMotor} · Lecturas almacenadas</span><h2>Estado del motor</h2><span className={'state ' + statusClass(status)}>{status}</span><p>Última lectura: {readings.length ? dateText(current.time) : "Sin mediciones"}</p></div><div className="hero-icon"><Activity size={56}/></div></div>
        {!device.online && <div role="status" className="api-error">Sin señal reciente del ESP32: la última medición puede ser antigua. {device.lastSeen ? `Última comunicación: ${dateText(device.lastSeen)}.` : 'Todavía no se ha recibido ninguna medición del ESP32.'} Esta advertencia no significa que el motor esté en estado crítico.</div>}
        <div className="stats"><Metric icon={Thermometer} label="Temperatura" value={current.temperature.toFixed(1)} unit="°C"/><Metric icon={Gauge} label="Indicador de vibración" value={current.vibration.toFixed(2)} unit="m/s²"/><Metric icon={Bell} label="Alertas registradas" value={alerts.length} unit="de las últimas lecturas"/></div>
        <div className="two-cols"><section className="panel"><h3>Últimas mediciones</h3><ReadingsTable readings={readings.slice(0, 5)} limits={activeLimits}/></section><section className="panel"><h3>{isAdmin?'Control de demostración':'Supervisión del motor'}</h3><p>{isAdmin?'Las mediciones de prueba se envían a la API y se guardan en SQLite.':'Tu perfil permite consultar las mediciones y las alertas.'}</p>{isAdmin && selectedMotor === 'MOTOR_01' && <div className="controls"><button className="primary" onClick={() => setRunning(v => !v)}>{running ? 'Pausar simulación' : 'Reanudar simulación'}</button><button className="secondary" onClick={() => { const next = (index + 1) % DEMO.length; setIndex(next); sendDemo(next); }}>Siguiente lectura</button></div>}<p className="hint">Las lecturas del ESP32 llegan por la API y se muestran automáticamente.</p></section></div>
      </>}
      {page === 'Detalle del motor' && <div className="two-cols"><section className="panel"><h3>Motor monitoreado</h3><Info label="Identificador" value={selectedMotor}/><Info label="Fuente" value={current.source === 'esp32_physical' ? 'ESP32 físico' : current.source === 'esp32' ? 'Wokwi' : current.source === 'simulation' ? 'Demostración' : motorInfo.name}/><Info label="Temperatura" value={`${current.temperature.toFixed(1)} °C`}/><Info label="Indicador de vibración" value={`${current.vibration.toFixed(2)} m/s²`}/><Info label="Estado de la última lectura" value={status}/><Info label="Comunicación ESP32" value={device.online ? "En línea" : "Sin señal reciente"}/></section><section className="panel"><h3>Criterios de evaluación</h3><p>Temperatura: advertencia desde {activeLimits.temperatureWarning} °C; crítico desde {activeLimits.temperatureCritical} °C.</p><p>Vibración: advertencia desde {activeLimits.vibrationWarning} m/s²; crítico desde {activeLimits.vibrationCritical} m/s².</p><p className="hint">Este indicador es simplificado; no equivale a un análisis industrial de vibraciones.</p></section></div>}
      {page === 'Tendencias' && <section className="panel"><div className="section-head"><h3>Tendencias recientes · {selectedMotor}</h3><button className="secondary link-button" onClick={()=>setPage('Reportes')}><Download size={16}/> Reporte por jornada</button></div>
        <p>Resumen de las últimas {analytics?.count ?? 0} mediciones de este motor (máximo 60). Incluye lecturas del ESP32 y de demostración si existen en el historial.</p>
        {analyticsError && <div role="alert" className="api-error">{analyticsError}</div>}
        {analytics?.count ? <>
          <div className="trend-stats"><Metric icon={Thermometer} label="Temperatura promedio" value={analytics.averages.temperature_c.toFixed(1)} unit="°C"/><Metric icon={Thermometer} label="Temperatura máxima" value={analytics.maximums.temperature_c.toFixed(1)} unit="°C"/><Metric icon={Gauge} label="Vibración promedio" value={analytics.averages.vibration_level.toFixed(2)} unit="m/s²"/></div>
          <div className="trend-charts"><TrendChart data={analytics.series} field="temperature_c" title="Temperatura (°C)" color="#d35b42"/><TrendChart data={analytics.series} field="vibration_level" title="Indicador de vibración (m/s²)" color="#286eaf"/></div>
          <p><strong>Distribución por estado:</strong> NORMAL {analytics.counts.NORMAL} · ADVERTENCIA {analytics.counts.ADVERTENCIA} · CRÍTICO {analytics.counts.CRITICO}</p>
          <p className="hint">Periodo entre la primera y última lectura mostrada: {analytics.firstTimestamp ? dateText(analytics.firstTimestamp) : 'Sin datos'} — {analytics.lastTimestamp ? dateText(analytics.lastTimestamp) : 'Sin datos'}. Las gráficas representan lecturas sucesivas, no intervalos uniformes de tiempo. Los valores son indicadores de monitoreo, no probabilidades de falla.</p>
        </> : <p className="empty">Todavía no hay lecturas para graficar.</p>}
      </section>}
      {page === 'Historial' && <section className="panel"><div className="section-head"><h3>Historial guardado en SQLite</h3><span className="muted">{readings.length} registros</span></div><ReadingsTable readings={readings} limits={activeLimits}/><p className="hint">El historial persiste al recargar la página o reiniciar el servidor. Se muestran los 100 registros más recientes.</p></section>}
      {page === 'Reportes' && <Reports key={selectedMotor} selectedMotor={selectedMotor}/>}
      {page === 'Alertas' && <section className="panel"><h3>Alertas almacenadas</h3>{alerts.length === 0 ? <p className="empty">Aún no hay alertas. Usa «Siguiente lectura» en el panel para probarlas.</p> : <div className="alert-list">{alerts.map(r => { const s = r.status === 'CRITICO' ? 'CRÍTICO' : r.status; return <div className="alert" key={r.id}><AlertTriangle size={20} className={statusClass(s)}/><div><strong>{s} · {selectedMotor}</strong><p>{r.temperature.toFixed(1)} °C · {r.vibration.toFixed(2)} m/s²</p><small>{dateText(r.time)}</small></div></div>})}</div>}</section>}
      {page === 'Configuración' && isAdmin && <section className="panel settings"><h3>Configuración del prototipo</h3><Info label="Origen de datos" value={motorInfo.name}/><Info label="Conexión del ESP32" value={device.online ? "Conectado (lecturas recientes)" : "Sin lecturas ESP32 en los últimos 20 segundos"}/><label>Intervalo de actualización<select value={intervalSeconds} onChange={e => setIntervalSeconds(Number(e.target.value))}><option value={2}>2 segundos</option><option value={5}>5 segundos</option><option value={10}>10 segundos</option></select></label><h3>Umbrales de demostración</h3><div className="settings-grid">{[['temperatureWarning','Temperatura: advertencia (°C)'],['temperatureCritical','Temperatura: crítico (°C)'],['vibrationWarning','Vibración: advertencia (m/s²)'],['vibrationCritical','Vibración: crítico (m/s²)']].map(([key,label]) => <label key={key}>{label}<input type="number" min="0" step="0.1" value={draftLimits[key]} onChange={e => updateLimit(key,e.target.value)}/></label>)}</div><p className="hint">Los cambios se guardan en SQLite y se aplican a las lecturas futuras. No reclasifican el historial anterior. El prototipo físico consulta sus propios umbrales desde la API; este formulario controla los umbrales generales de Wokwi y demostración.</p><div className="controls"><button className="primary" disabled={saving} onClick={()=>saveLimits(draftLimits)}>{saving?'Guardando...':'Guardar umbrales en servidor'}</button><button className="secondary" disabled={saving} onClick={()=>saveLimits(LIMITS)}>Restaurar umbrales originales</button></div>{configMessage && <p role="status" className="hint">{configMessage}</p>}{user?.role === 'admin' && <PhysicalConfig />}</section>}
      {page === 'Personal' && isAdmin && <Personnel/>}
      {page === 'Configuración' && isAdmin && <RetentionPanel/>}
      <footer>MotorWatch · Monitoreo simulado y físico · Acceso de personal</footer>
    </main>
  </div>;
}
function localDatetime(date){
  const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);
  return local.toISOString().slice(0,16);
}
function Reports({ selectedMotor }){
  const [motor,setMotor]=useState(selectedMotor);
  const [start,setStart]=useState(()=>{const d=new Date();d.setHours(8,0,0,0);return localDatetime(d)});
  const [end,setEnd]=useState(()=>{const d=new Date();d.setHours(16,0,0,0);return localDatetime(d)});
  const [summary,setSummary]=useState(null);
  const [error,setError]=useState('');
  function parameters(){
    const a=new Date(start),b=new Date(end);
    if(!Number.isFinite(a.getTime())||!Number.isFinite(b.getTime())||b<=a||b-a>86400000)throw Error('Elige una jornada válida de máximo 24 horas.');
    const p=new URLSearchParams({motor_id:motor,start:a.toISOString(),end:b.toISOString()});
    return p.toString();
  }
  async function check(e){
    e.preventDefault();setError('');setSummary(null);
    try{
      const query=parameters();
      const response=await fetch('/api/reports/summary?'+query);
      const data=await response.json();
      if(!response.ok)throw Error(data.error||'No se pudo consultar el reporte');
      setSummary({...data,download:'/api/reports/download?'+query});
    }catch(err){setError(err.message)}
  }
  return <section className="panel reports">
    <h3>Reporte completo de jornada laboral</h3>
    <p>Selecciona el periodo de la jornada, inclusive si termina después de medianoche. El CSV incluirá todas las mediciones almacenadas de ese intervalo, sin límite de 500.</p>
    <form onSubmit={check} className="report-form">
      <label>Motor<select value={motor} onChange={e=>{setMotor(e.target.value);setSummary(null)}}>{MOTOR_OPTIONS.map(m => <option key={m.id} value={m.id}>{m.name} — {m.id}</option>)}</select></label>
      <label>Inicio (hora local)<input type="datetime-local" required value={start} onChange={e=>{setStart(e.target.value);setSummary(null)}}/></label>
      <label>Fin (hora local)<input type="datetime-local" required value={end} onChange={e=>{setEnd(e.target.value);setSummary(null)}}/></label>
      <button className="primary" type="submit">Consultar mediciones</button>
    </form>
    {error&&<p role="alert" className="form-error">{error}</p>}
    {summary&&<div className="report-result">
      <h3>Registros disponibles: {summary.count.toLocaleString('es-MX')}</h3>
      <p>Desde {summary.first?dateText(summary.first):'Sin datos'} hasta {summary.last?dateText(summary.last):'Sin datos'}.</p>
      {summary.count>0?<a className="primary link-button" href={summary.download}><Download size={16}/> Descargar jornada completa (CSV)</a>:<p>No hay registros para el periodo seleccionado.</p>}
    </div>}
    <p className="hint">La descarga no elimina mediciones. La conservación de 7 días se administra por separado.</p>
  </section>;
}
function RetentionPanel(){
  const [policy,setPolicy]=useState(null);
  const [message,setMessage]=useState('');
  async function refresh(){
    const r=await fetch('/api/retention');
    if(r.ok)setPolicy(await r.json());
  }
  useEffect(()=>{refresh()},[]);
  async function toggle(){
    if(!policy)return;
    const next=!policy.enabled;
    if(next&&!window.confirm(`Al activar la política se eliminarán de inmediato ${policy.eligibleForDeletion} mediciones con más de 7 días. ¿Ya respaldaste SQLite y descargaste los reportes necesarios?`))return;
    const r=await fetch('/api/retention',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:next})});
    const data=await r.json();
    setMessage(r.ok?`Configuración guardada. Registros eliminados: ${data.removed}.`:data.error);
    await refresh();
  }
  return <section className="panel settings">
    <h3>Conservación automática de registros</h3>
    <p>Política propuesta: conservar mediciones durante 7 días. La descarga de CSV no borra información.</p>
    <Info label="Eliminación automática" value={policy?.enabled?'Activada':'Desactivada (seguro al instalar)'}/>
    <Info label="Registros anteriores a 7 días" value={policy?String(policy.eligibleForDeletion):'Consultando...'}/>
    <p className="hint">Actívala solo después de respaldar el historial antiguo. Una vez activa, se depuran los registros vencidos al iniciar el servidor y aproximadamente cada hora.</p>
    <button className="secondary" onClick={toggle}>{policy?.enabled?'Desactivar eliminación automática':'Activar conservación de 7 días'}</button>
    {message&&<p role="status">{message}</p>}
  </section>;
}
function Personnel(){
  const [users,setUsers]=useState([]);
  const [form,setForm]=useState({username:'',password:'',role:'technician'});
  const [message,setMessage]=useState('');
  async function load(){const r=await fetch('/api/users');if(r.ok)setUsers((await r.json()).users)}
  useEffect(()=>{load()},[]);
  async function add(e){
    e.preventDefault();setMessage('');
    try{const r=await fetch('/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(form)});
      const data=await r.json();if(!r.ok)throw Error(data.error);setForm({username:'',password:'',role:'technician'});setMessage('Cuenta creada; debe cambiar su contraseña al primer acceso.');await load();
    }catch(err){setMessage(err.message)}
  }
  async function toggle(u){
    const r=await fetch('/api/users/'+u.id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({active:!u.active})});
    const d=await r.json();setMessage(r.ok?'Estado actualizado.':d.error);await load();
  }
  return <div className="two-cols">
    <section className="panel"><h3>Crear cuenta de personal</h3><form className="personnel-form" onSubmit={add}>
      <label>Usuario<input required minLength={3} maxLength={32} value={form.username} onChange={e=>setForm(f=>({...f,username:e.target.value}))}/></label>
      <label>Contraseña temporal (mínimo 12 caracteres)<input type="password" required minLength={12} value={form.password} onChange={e=>setForm(f=>({...f,password:e.target.value}))}/></label>
      <label>Rol<select value={form.role} onChange={e=>setForm(f=>({...f,role:e.target.value}))}><option value="technician">Técnico</option><option value="admin">Administrador</option></select></label>
      <button className="primary" type="submit">Registrar personal</button>
    </form>{message&&<p role="status">{message}</p>}</section>
    <section className="panel"><h3>Usuarios registrados</h3><div className="user-list">{users.map(u=><div className="user-item" key={u.id}>
      <div><strong>{u.username}</strong><small>{u.role==='admin'?'Administrador':'Técnico'} · {u.active?'Activo':'Desactivado'}</small></div>
      <button className="secondary" onClick={()=>toggle(u)}>{u.active?'Desactivar':'Activar'}</button>
    </div>)}</div></section>
  </div>;
}
function TrendChart({data,field,title,color}) {
  if (!data?.length) return null;
  const values=data.map(r=>Number(r[field]));
  const min=Math.min(0,...values), max=Math.max(1,...values);
  const width=620,height=210,left=40,right=14,top=15,bottom=29;
  const plotW=width-left-right,plotH=height-top-bottom;
  const x=i=>left+(data.length===1?plotW/2:(i/(data.length-1))*plotW);
  const y=v=>top+plotH-((v-min)/(max-min || 1))*plotH;
  const points=values.map((v,i)=>`${x(i)},${y(v)}`).join(' ');
  return <div className="chart-box"><h3>{title}</h3><svg role="img" aria-label={`${title}: ${data.length} lecturas, mínimo ${Math.min(...values).toFixed(2)}, máximo ${Math.max(...values).toFixed(2)}`} viewBox={`0 0 ${width} ${height}`}>
    {[0,1,2,3,4].map(n=>{const v=min+(max-min)*n/4; return <g key={n}><line x1={left} x2={width-right} y1={y(v)} y2={y(v)} stroke="#e3eaf2"/><text x={left-8} y={y(v)+4} textAnchor="end" fontSize="11" fill="#65758c">{v.toFixed(1)}</text></g>})}
    <polyline fill="none" stroke={color} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" points={points}/>
    {values.length===1 && <circle cx={x(0)} cy={y(values[0])} r="4" fill={color}/>}
    <text x={left} y={height-6} fontSize="11" fill="#65758c">Primera lectura</text><text x={width-right} y={height-6} textAnchor="end" fontSize="11" fill="#65758c">Última lectura</text>
  </svg></div>;
}
function Metric({ icon: Icon, label, value, unit }) { return <div className="metric"><div className="metric-icon"><Icon size={21}/></div><span>{label}</span><strong>{value}</strong><small>{unit}</small></div>; }
function Info({ label, value }) { return <div className="info"><span>{label}</span><strong>{value}</strong></div>; }
function ReadingsTable({ readings, limits }) { return <div className="table-wrap"><table><thead><tr><th>Fecha y hora</th><th>Temp.</th><th>Vibración</th><th>Estado</th></tr></thead><tbody>{readings.map(r => { const s = r.status === 'CRITICO' ? 'CRÍTICO' : r.status; return <tr key={r.id}><td>{dateText(r.time)}</td><td>{r.temperature.toFixed(1)} °C</td><td>{r.vibration.toFixed(2)} m/s²</td><td><span className={'table-state '+statusClass(s)}>{s}</span></td></tr>})}</tbody></table></div>; }
createRoot(document.getElementById('root')).render(<App/>);
