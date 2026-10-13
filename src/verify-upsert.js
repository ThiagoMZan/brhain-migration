// Manual integration check for the approved pilot. All test writes are rolled back.
import pg from 'pg';
import assert from 'node:assert/strict';
import {columns,canonical,targetProjection,upsert} from './pilot.js';
import {safeError} from './errors.js';
const e=process.env;
const client=new pg.Client({host:e.PGHOST||'127.0.0.1',port:Number(e.PGPORT||5432),database:e.PGDATABASE||'DEV_AMIL',user:e.PGUSER||'USER_AD_DEV_AMIL',password:e.PGPASSWORD,connectionTimeoutMillis:15000,statement_timeout:15000});
let begun=false;
try{
 await client.connect();await client.query('BEGIN');begun=true;
 const original=(await client.query(`SELECT ${targetProjection} FROM public.brh_banco ORDER BY id_brh_banco LIMIT 1 FOR UPDATE`)).rows[0];
 assert.ok(original);
 await client.query('UPDATE public.brh_banco SET ds_nome=$1 WHERE id_brh_banco=$2',['__UPSERT_ROLLBACK_TEST__',original.id_brh_banco]);
 assert.equal((await client.query(upsert,columns.map(c=>original[c]))).rowCount,1);
 assert.equal((await client.query(upsert,columns.map(c=>original[c]))).rowCount,0);
 const stored=(await client.query(`SELECT ${targetProjection} FROM public.brh_banco WHERE id_brh_banco=$1`,[original.id_brh_banco])).rows[0];
 assert.equal(canonical(original),canonical(stored));
 await client.query('ROLLBACK');begun=false;
 console.log('UPSERT verificado: conflito atualiza conteúdo, repetição não altera, auditoria/PK preservadas; teste revertido.');
}catch(error){console.error(safeError(error,'teste transacional UPSERT'));process.exitCode=1;}
finally{if(begun)await client.query('ROLLBACK').catch(()=>{});await client.end();}
