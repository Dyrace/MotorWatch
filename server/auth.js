import {randomBytes, createHash, scryptSync, timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function initAuth(db, persist, list, dataDir) {
  db.run('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 0)');
  db.run('CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)');
  const tokenPath=path.join(dataDir,'device-token.txt');
  const attempts=new Map();
  if(!fs.existsSync(tokenPath)){
    const token=randomBytes(32).toString('hex');
    fs.writeFileSync(tokenPath,token+'\n',{mode:0o600,flag:'wx'});
    console.log('Clave ESP32 generada en server/data/device-token.txt. Añádela a X-Device-Token; no la compartas.');
  }
  const deviceToken=fs.readFileSync(tokenPath,'utf8').trim();
  const digest=v=>createHash('sha256').update(v).digest('hex');
  const hashPassword=value=>{
    const salt=randomBytes(16).toString('hex');
    return salt+':'+scryptSync(value,salt,64).toString('hex');
  };
  const verify=(password,hash)=>{
    const [salt,expected]=String(hash).split(':');
    if(!salt||!expected||expected.length!==128)return false;
    const a=scryptSync(password,salt,64),b=Buffer.from(expected,'hex');
    return a.length===b.length && timingSafeEqual(a,b);
  };
  const validUsername=name=>typeof name==='string' && /^[a-zA-Z][a-zA-Z0-9_.-]{2,31}$/.test(name);
  const validPassword=p=>typeof p==='string' && p.length>=12 && p.length<=128;
  const publicUser=user=>({id:user.id,username:user.username,role:user.role,active:!!user.active,mustChange:!!user.must_change});
  function createUser(username,password,role='technician',mustChange=false) {
    if(!validUsername(username)||!validPassword(password)||!['admin','technician'].includes(role))throw Error('Usuario inválido o contraseña menor de 12 caracteres.');
    db.run('INSERT INTO users(username,password_hash,role,active,must_change) VALUES (?,?,?,?,?)',[username,hashPassword(password),role,1,mustChange?1:0]);
    persist();
  }
  function cookie(req) {
    const values=String(req.headers.cookie??'').split(';');
    const hit=values.map(s=>s.trim()).find(s=>s.startsWith('mw_session='));
    return hit?hit.slice('mw_session='.length):null;
  }
  function identify(req) {
    const token=cookie(req);
    if(!token||! /^[a-f0-9]{64}$/.test(token))return null;
    const rows=list('SELECT u.id,u.username,u.role,u.active,u.must_change,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?',[digest(token)]);
    const found=rows[0];
    return found&&found.active&&found.expires_at>Date.now()?found:null;
  }
  function setCookie(res,token,maxAge=8*60*60) {
    res.append('Set-Cookie',`mw_session=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${maxAge}`);
  }
  function clearCookie(res){res.append('Set-Cookie','mw_session=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0');}
  function csrf(req,res,next) {
    if(!['POST','PUT','PATCH','DELETE'].includes(req.method))return next();
    const origin=req.get('Origin');
    // ESP32 HTTP POST does not send browser Origin. The device endpoint is
    // authenticated separately. Browser requests must have a matching Origin.
    if(req.path==='/api/readings' && !origin)return next();
    if(!origin)return res.status(403).json({error:'Se requiere Origin de navegador'});
    try{
      const host=new URL(origin).host;
      if(host!==req.get('Host') && !['localhost:5173','127.0.0.1:5173'].includes(host) && !/^192\.168\.\d{1,3}\.\d{1,3}:5173$/.test(host) && !/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}:5173$/.test(host))
        return res.status(403).json({error:'Origen no permitido'});
    }catch{return res.status(403).json({error:'Origen inválido'});}
    next();
  }
  function requireUser(req,res,next) {
    const user=identify(req);
    if(!user)return res.status(401).json({error:'Inicia sesión para continuar'});
    req.currentUser=user;
    if(user.must_change && !['/api/auth/me','/api/auth/password','/api/auth/logout'].includes(req.path))
      return res.status(403).json({error:'Debes cambiar la contraseña inicial'});
    next();
  }
  const requireAdmin=(req,res,next)=>req.currentUser?.role==='admin'?next():res.status(403).json({error:'Solo administradores'});
  function deviceAllowed(req) {
    const incoming=req.get('X-Device-Token')??'';
    if(incoming.length!==deviceToken.length)return false;
    return timingSafeEqual(Buffer.from(incoming),Buffer.from(deviceToken));
  }
  function routes(app){
    app.use(csrf);
    app.get('/api/auth/me',(req,res)=>{
      const u=identify(req);res.json({user:u?publicUser(u):null});
    });
    app.post('/api/auth/login',(req,res)=>{
      const key=req.ip??'local';
      const now=Date.now(),tracked=attempts.get(key)??{count:0,until:now+15*60*1000};
      if(now>tracked.until){tracked.count=0;tracked.until=now+15*60*1000;}
      if(tracked.count>=10)return res.status(429).json({error:'Demasiados intentos. Intenta nuevamente más tarde.'});
      const username=req.body?.username,password=req.body?.password;
      if(!validUsername(username)||typeof password!=='string'||password.length>128)return res.status(401).json({error:'Credenciales incorrectas'});
      const row=list('SELECT * FROM users WHERE username=?',[username])[0];
      if(!row||!row.active||!verify(password,row.password_hash)){
        tracked.count++;attempts.set(key,tracked);
        return res.status(401).json({error:'Credenciales incorrectas'});
      }
      attempts.delete(key);
      const token=randomBytes(32).toString('hex');
      db.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)',[digest(token),row.id,Date.now()+8*60*60*1000]);
      persist();setCookie(res,token);
      res.json({user:publicUser(row)});
    });
    app.post('/api/auth/logout',requireUser,(req,res)=>{
      const token=cookie(req);
      if(token)db.run('DELETE FROM sessions WHERE token_hash=?',[digest(token)]);
      persist();clearCookie(res);res.json({ok:true});
    });
    app.post('/api/auth/password',requireUser,(req,res)=>{
      const {currentPassword,newPassword}=req.body??{};
      if(!validPassword(newPassword))return res.status(400).json({error:'La nueva contraseña debe contener entre 12 y 128 caracteres'});
      const user=list('SELECT * FROM users WHERE id=?',[req.currentUser.id])[0];
      if(typeof currentPassword!=='string'||!verify(currentPassword,user.password_hash))return res.status(401).json({error:'Contraseña actual incorrecta'});
      db.run('UPDATE users SET password_hash=?,must_change=0 WHERE id=?',[hashPassword(newPassword),user.id]);
      db.run('DELETE FROM sessions WHERE user_id=?',[user.id]);
      persist();clearCookie(res);res.json({ok:true,message:'Contraseña actualizada. Inicia sesión nuevamente.'});
    });
    app.get('/api/users',requireUser,requireAdmin,(_req,res)=>{
      res.json({users:list('SELECT id,username,role,active,must_change FROM users ORDER BY id').map(publicUser)});
    });
    app.post('/api/users',requireUser,requireAdmin,(req,res)=>{
      const {username,password,role}=req.body??{};
      if(!validUsername(username)||!validPassword(password)||!['admin','technician'].includes(role))return res.status(400).json({error:'Nombre, rol o contraseña inválidos (mínimo 12 caracteres)'});
      if(list('SELECT id FROM users WHERE username=?',[username]).length)return res.status(409).json({error:'El usuario ya existe'});
      createUser(username,password,role,true);
      res.status(201).json({ok:true});
    });
    app.patch('/api/users/:id',requireUser,requireAdmin,(req,res)=>{
      const id=Number(req.params.id),active=req.body?.active;
      if(!Number.isSafeInteger(id)||typeof active!=='boolean')return res.status(400).json({error:'ID o estado inválido'});
      const existing=list('SELECT * FROM users WHERE id=?',[id])[0];
      if(!existing)return res.status(404).json({error:'Usuario inexistente'});
      if(existing.id===req.currentUser.id&&!active)return res.status(400).json({error:'No puedes desactivar tu cuenta'});
      if(existing.role==='admin'&&!active){
        const n=list("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1")[0].n;
        if(n<=1)return res.status(400).json({error:'Debe permanecer un administrador activo'});
      }
      db.run('UPDATE users SET active=? WHERE id=?',[active?1:0,id]);
      if(!active)db.run('DELETE FROM sessions WHERE user_id=?',[id]);
      persist();res.json({ok:true});
    });
  }
  return {routes,requireUser,requireAdmin,deviceAllowed,createUser,validPassword};
}
