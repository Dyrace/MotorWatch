import express from 'express';
import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initAuth } from './auth.js';
import { registerPhysicalConfigRoutes } from './physical-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'motorwatch.sqlite');
fs.mkdirSync(dataDir, { recursive: true });
const SQL = await initSqlJs();
const db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
db.run(`CREATE TABLE IF NOT EXISTS readings (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 motor_id TEXT NOT NULL,
 source TEXT NOT NULL,
 timestamp TEXT NOT NULL,
 temperature_c REAL NOT NULL,
 vibration_level REAL NOT NULL,
 accel_x REAL,
 accel_y REAL,
 accel_z REAL,
 status TEXT NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value REAL NOT NULL)`);
db.run('CREATE INDEX IF NOT EXISTS idx_readings_motor_time ON readings(motor_id,timestamp)');
db.run('CREATE TABLE IF NOT EXISTS system_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
db.run("INSERT OR IGNORE INTO system_config(key,value) VALUES ('retention_enabled','false')");
const DEFAULT_LIMITS = {temperatureWarning:50, temperatureCritical:70, vibrationWarning:2, vibrationCritical:5};
for (const [key, value] of Object.entries(DEFAULT_LIMITS)) db.run('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)',[key,value]);
function getLimits() {
 const out={};
 for(const row of list('SELECT key,value FROM settings'))out[row.key]=Number(row.value);
 return out;
}
function persist() {
 const tmp = dbPath + '.tmp';
 fs.writeFileSync(tmp, Buffer.from(db.export()));
 fs.renameSync(tmp, dbPath);
}
persist();
function classify(t, v, source = 'simulation') {
  const LIMITS = source === 'esp32_physical'
    ? physicalConfig.getLimits()
    : getLimits();
 if(t>=LIMITS.temperatureCritical||v>=LIMITS.vibrationCritical)return 'CRITICO';
 if(t>=LIMITS.temperatureWarning||v>=LIMITS.vibrationWarning)return 'ADVERTENCIA';
 return 'NORMAL';
}
function list(sql,params=[]) {
 const statement=db.prepare(sql);statement.bind(params);const rows=[];
 while(statement.step())rows.push(statement.getAsObject());statement.free();return rows;
}
function format(row){return {...row,temperature:Number(row.temperature_c),vibration:Number(row.vibration_level),time:row.timestamp};}
const app=express();app.use(express.json({limit:'16kb'}));
const auth=initAuth(db,persist,list,dataDir);
auth.routes(app);
const physicalConfig = registerPhysicalConfigRoutes(app, {
    db,
    persist,
    list,
    auth
  });

app.get('/api/health',(_req,res)=>res.json({ok:true,database:'sqlite',source:'api'}));
// Las fechas llegan en UTC ISO desde el navegador. Fin exclusivo.
function reportFilters(query) {
 const motorId=query.motor_id??'MOTOR_01';
 const start=query.start,end=query.end;
 if(typeof motorId!=='string'||! /^[A-Za-z0-9_-]{1,40}$/.test(motorId))
   return {error:'motor_id inválido'};
 if(typeof start!=='string'||typeof end!=='string'||! /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(start)||! /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(end))
   return {error:'start y end deben ser fechas ISO UTC completas'};
 const from=Date.parse(start),to=Date.parse(end);
 if(!Number.isFinite(from)||!Number.isFinite(to)||new Date(from).toISOString()!==start||new Date(to).toISOString()!==end||to<=from||to-from>24*60*60*1000)
   return {error:'Rango inválido. Máximo 24 horas; la fecha final debe ser posterior.'};
 return {motorId,start,end};
}
const reportWhere='FROM readings WHERE motor_id=? AND timestamp>=? AND timestamp<?';
app.get('/api/reports/summary',auth.requireUser,(req,res)=>{
 const f=reportFilters(req.query);
 if(f.error)return res.status(400).json({error:f.error});
 const row=list('SELECT COUNT(*) AS count, MIN(timestamp) AS first, MAX(timestamp) AS last '+reportWhere,[f.motorId,f.start,f.end])[0];
 res.json({motorId:f.motorId,start:f.start,end:f.end,count:row.count,first:row.first,last:row.last});
});
app.get('/api/reports/download',auth.requireUser,(req,res)=>{
 const f=reportFilters(req.query);
 if(f.error)return res.status(400).json({error:f.error});
 const headers=['id','motor_id','source','timestamp','temperature_c','vibration_level','accel_x','accel_y','accel_z','status'];
 const cell=value=>{
  const str=String(value??'');
  // Protección al abrir CSV en Excel: ningún campo de texto puede ejecutar fórmulas.
  return '"'+(/^[=+@\-\t\r]/.test(str)?"'"+str:str).replaceAll('"','""')+'"';
 };
 const stmt=db.prepare('SELECT '+headers.join(',')+' '+reportWhere+' ORDER BY timestamp,id');
 stmt.bind([f.motorId,f.start,f.end]);
 res.setHeader('Content-Type','text/csv; charset=utf-8');
 res.setHeader('Content-Disposition',`attachment; filename="motorwatch-${f.motorId}-${f.start.slice(0,10)}.csv"`);
 res.write('\uFEFF'+headers.join(',')+'\r\n');
 try {while(stmt.step()){const row=stmt.getAsObject();res.write(headers.map(h=>cell(row[h])).join(',')+'\r\n');}}
 finally {stmt.free();res.end();}
});
const retentionEnabled=()=>list("SELECT value FROM system_config WHERE key='retention_enabled'")[0]?.value==='true';
const retentionCutoff=()=>new Date(Date.now()-7*24*60*60*1000).toISOString();
function purgeExpired() {
 if(!retentionEnabled())return 0;
 const cutoff=retentionCutoff();
 const count=list('SELECT COUNT(*) AS n FROM readings WHERE timestamp<?',[cutoff])[0].n;
 if(count){db.run('DELETE FROM readings WHERE timestamp<?',[cutoff]);persist();}
 return count;
}
app.get('/api/retention',auth.requireUser,auth.requireAdmin,(_req,res)=>{
 res.json({days:7,enabled:retentionEnabled(),eligibleForDeletion:list('SELECT COUNT(*) AS n FROM readings WHERE timestamp<?',[retentionCutoff()])[0].n});
});
app.put('/api/retention',auth.requireUser,auth.requireAdmin,(req,res)=>{
 if(typeof req.body?.enabled!=='boolean')return res.status(400).json({error:'enabled debe ser booleano'});
 db.run("UPDATE system_config SET value=? WHERE key='retention_enabled'",[req.body.enabled?'true':'false']);
 persist();
 const removed=purgeExpired();
 res.json({days:7,enabled:retentionEnabled(),removed});
});
purgeExpired();
const retentionTimer=setInterval(purgeExpired,60*60*1000);
retentionTimer.unref();
app.get('/api/config',auth.requireUser,(_req,res)=>res.json({limits:getLimits()}));
// Umbrales disponibles para dispositivos autorizados
/*app.get('/api/device/config', (req, res) => {

  if (!auth.deviceAllowed(req)) {
    return res.status(401).json({
      error: 'Clave de dispositivo inválida'
    });
  }

  res.json({
    limits: getLimits()
  });
});*/
app.put('/api/config',auth.requireUser,auth.requireAdmin,(req,res)=>{
 const incoming=req.body?.limits;
 if(!incoming || typeof incoming!=='object' || Array.isArray(incoming))return res.status(400).json({error:'Enviar un objeto limits'});
 const keys=Object.keys(DEFAULT_LIMITS);
 if(Object.keys(incoming).length!==keys.length || keys.some(k=>typeof incoming[k]!=='number'||!Number.isFinite(incoming[k])||incoming[k]<0||incoming[k]>200))return res.status(400).json({error:'Los cuatro umbrales deben ser números entre 0 y 200'});
 if(incoming.temperatureWarning>=incoming.temperatureCritical || incoming.vibrationWarning>=incoming.vibrationCritical)return res.status(400).json({error:'Advertencia debe ser menor que crítico'});
 for(const k of keys)db.run('UPDATE settings SET value=? WHERE key=?',[incoming[k],k]);
 persist();res.json({limits:getLimits()});
});
app.get('/api/device-status', auth.requireUser, (req, res) => {
  const motorId = req.query.motor_id ?? 'MOTOR_01';
  if (typeof motorId !== 'string' ||
      !['MOTOR_01','MOTOR_FISICO_01'].includes(motorId)) {
    return res.status(400).json({error:'motor_id inválido'});
  }
  const source = motorId === 'MOTOR_FISICO_01' ? 'esp32_physical' : 'esp32';
  const last = list(
    'SELECT id,timestamp,motor_id FROM readings WHERE motor_id=? AND source=? ORDER BY id DESC LIMIT 1',
    [motorId, source]
  )[0] ?? null;
  const ageSeconds = last ? Math.max(0, (Date.now() - new Date(last.timestamp).getTime())/1000) : null;
  res.json({
    online: ageSeconds !== null && Number.isFinite(ageSeconds) && ageSeconds <= 20,
    lastSeen:last?.timestamp ?? null,
    ageSeconds,
    motorId,
    source,
    timeoutSeconds:20
  });
});
app.get('/api/readings', auth.requireUser, (req, res) => {
  const motorId = req.query.motor_id;
  if (motorId !== undefined &&
      (typeof motorId !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(motorId))) {
    return res.status(400).json({error:'motor_id inválido'});
  }
  const n = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 100, 1), 500);
  const rows = motorId
    ? list('SELECT * FROM readings WHERE motor_id=? ORDER BY id DESC LIMIT ?', [motorId, n])
    : list('SELECT * FROM readings ORDER BY id DESC LIMIT ?', [n]);
  res.json({readings:rows.map(format)});
});
app.get('/api/latest',auth.requireUser,(_req,res)=>{
 const rows=list('SELECT * FROM readings ORDER BY id DESC LIMIT 1');
 res.json({reading:rows.length?format(rows[0]):null});
});
app.get('/api/alerts',auth.requireUser,(_req,res)=>res.json({alerts:list("SELECT * FROM readings WHERE status <> 'NORMAL' ORDER BY id DESC LIMIT 100").map(format)}));
// Etapa 5: resúmenes por lecturas recientes. No es un pronóstico de fallas.
app.get('/api/analytics',auth.requireUser,(req,res)=>{
 const motorId=typeof req.query.motor_id==='string'?req.query.motor_id:'MOTOR_01';
 if(!/^[A-Za-z0-9_-]{1,40}$/.test(motorId))return res.status(400).json({error:'motor_id inválido'});
 const limit=Math.min(Math.max(Number.parseInt(req.query.limit,10)||60,1),500);
 const records=list('SELECT * FROM readings WHERE motor_id=? ORDER BY id DESC LIMIT ?',[motorId,limit]).reverse();
 const n=records.length;
 const avg=(field)=>n?Number((records.reduce((sum,r)=>sum+Number(r[field]),0)/n).toFixed(2)):null;
 const max=(field)=>n?Number(Math.max(...records.map(r=>Number(r[field]))).toFixed(2)):null;
 const counts={NORMAL:0,ADVERTENCIA:0,CRITICO:0};
 for(const r of records)if(Object.hasOwn(counts,r.status))counts[r.status]++;
 res.json({motorId, count:n, scope:'latest_readings', limit, firstTimestamp:n?records[0].timestamp:null,lastTimestamp:n?records[n-1].timestamp:null,
  averages:{temperature_c:avg('temperature_c'),vibration_level:avg('vibration_level')},
  maximums:{temperature_c:max('temperature_c'),vibration_level:max('vibration_level')},
  counts,series:records.map(r=>({id:r.id,timestamp:r.timestamp,temperature_c:r.temperature_c,vibration_level:r.vibration_level,status:r.status,source:r.source}))});
});

// Se limita a 500 filas y se exporta únicamente un motor seleccionado.
app.get('/api/readings.csv',auth.requireUser,(req,res)=>{
 const motorId=typeof req.query.motor_id==='string'?req.query.motor_id:'MOTOR_01';
 if(!/^[A-Za-z0-9_-]{1,40}$/.test(motorId))return res.status(400).json({error:'motor_id inválido'});
 const rows=list('SELECT * FROM readings WHERE motor_id=? ORDER BY id DESC LIMIT 500',[motorId]);
 const headers=['id','motor_id','source','timestamp','temperature_c','vibration_level','accel_x','accel_y','accel_z','status'];
 const cell=value=>'"'+String(value??'').replaceAll('"','""')+'"';
 const csv='\uFEFF'+headers.join(',')+'\r\n'+rows.map(r=>headers.map(h=>cell(r[h])).join(',')).join('\r\n');
 res.setHeader('Content-Type','text/csv; charset=utf-8');
 res.setHeader('Content-Disposition','attachment; filename="motorwatch-historial.csv"');
 res.send(csv);
});

app.post('/api/readings',(req,res,next)=>{
 // Los dispositivos usan clave propia; los operadores utilizan su sesión.
 if (['esp32', 'esp32_physical'].includes(req.body?.source)){
   if(!auth.deviceAllowed(req))return res.status(401).json({error:'Clave de dispositivo inválida'});
   return next();
 }
 return auth.requireUser(req,res,()=>auth.requireAdmin(req,res,next));
},(req,res)=>{
 const b=req.body??{};
 const t=b.temperature_c, v=b.vibration_level;
 if(typeof t!=='number'||!Number.isFinite(t)||t < -55||t > 125 || typeof v!=='number'||!Number.isFinite(v)||v<0||v>200)
   return res.status(400).json({error:'temperature_c (-55 a 125) y vibration_level (0 a 200) deben ser números válidos'});
 const motor=typeof b.motor_id==='string'?b.motor_id:'MOTOR_01';
 const source=typeof b.source==='string'?b.source:'simulation';
 if(!/^[A-Za-z0-9_-]{1,40}$/.test(motor)||!['simulation', 'esp32', 'esp32_physical'].includes(source) )return res.status(400).json({error:'motor_id o source inválido'});
 const axes=['accel_x','accel_y','accel_z'].map(k=>b[k]===undefined||b[k]===null?null:b[k]);
 if(axes.some(x=>x!==null&&(typeof x!=='number'||!Number.isFinite(x)||Math.abs(x)>500)))return res.status(400).json({error:'Aceleraciones inválidas'});
 const timestamp=new Date().toISOString();
 const status = classify(t, v, source);
 db.run('INSERT INTO readings (motor_id,source,timestamp,temperature_c,vibration_level,accel_x,accel_y,accel_z,status) VALUES (?,?,?,?,?,?,?,?,?)',
 [motor,source,timestamp,t,v,...axes,status]);
 persist();
 const id=list('SELECT last_insert_rowid() AS id')[0].id;
 res.status(201).json({reading:format({id,motor_id:motor,source,timestamp,temperature_c:t,vibration_level:v,accel_x:axes[0],accel_y:axes[1],accel_z:axes[2],status})});
});
app.use((err,_req,res,_next)=>{if(err instanceof SyntaxError&&'body'in err)return res.status(400).json({error:'JSON inválido'});console.error(err);res.status(500).json({error:'Error interno'});});
const port = Number(process.env.PORT) || 3001;

app.listen(port, '0.0.0.0', () => {
  console.log(`MotorWatch API activa en el puerto ${port}`);
  console.log(`Acceso local: http://localhost:${port}/api/health`);
});