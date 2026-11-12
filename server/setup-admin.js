import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes,scryptSync} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const dataDir=path.join(path.dirname(fileURLToPath(import.meta.url)),'data');
const dbPath=path.join(dataDir,'motorwatch.sqlite');
fs.mkdirSync(dataDir,{recursive:true});
const SQL=await initSqlJs();
const db=fs.existsSync(dbPath)?new SQL.Database(fs.readFileSync(dbPath)):new SQL.Database();
db.run('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, must_change INTEGER NOT NULL DEFAULT 0)');
const statement=db.prepare("SELECT COUNT(*) FROM users WHERE role='admin'");
statement.step();
const count=statement.get()[0];statement.free();
if(count>0){
  console.log('Ya hay al menos un administrador. No se ha modificado ninguna cuenta.');
  process.exit(0);
}
const username=process.argv[2]??'admin';
if(!/^[a-zA-Z][a-zA-Z0-9_.-]{2,31}$/.test(username))throw Error('Usa un nombre de 3 a 32 caracteres, empezando por una letra');
const password=randomBytes(18).toString('base64url');
const salt=randomBytes(16).toString('hex');
const hash=salt+':'+scryptSync(password,salt,64).toString('hex');
db.run('INSERT INTO users(username,password_hash,role,active,must_change) VALUES (?,?,?,?,1)',[username,hash,'admin',1]);
const temp=dbPath+'.tmp';
fs.writeFileSync(temp,Buffer.from(db.export()));
fs.renameSync(temp,dbPath);
console.log('ADMINISTRADOR CREADO');
console.log('Usuario:',username);
console.log('Contraseña temporal (anótala ahora):',password);
console.log('Al iniciar sesión tendrás que sustituirla por una contraseña propia.');
