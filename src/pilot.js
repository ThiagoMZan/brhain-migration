import sql from 'mssql';
import pg from 'pg';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {sourceColumns,targetColumns} from './catalog.js';
import {compare} from './compare.js';
import {safeError} from './errors.js';

// Intentionally scoped to this approved pilot. Other tables/types require another plan.
export const columns=['id_brh_banco','nr_codigo','ds_nome','dt_created','id_usercreated','dt_updated','id_userupdated','ds_recordthumbprint'];
export const sourceProjection=columns.map(c=>{
 const q=`[${c.toUpperCase()}]`;
 if(c==='id_brh_banco') return `CONVERT(varchar(20),${q}) AS [${c}]`;
 if(c.startsWith('dt_')) return `CONVERT(varchar(23),${q},121) AS [${c}]`;
 return `${q} AS [${c}]`;
}).join(',');
export const targetProjection=columns.map(c=>c==='id_brh_banco'?`${c}::text AS ${c}`:
 c.startsWith('dt_')?`to_char(${c},'YYYY-MM-DD HH24:MI:SS.US') AS ${c}`:c).join(',');
const names=columns.join(',');
const updates=columns.slice(1).map(c=>`${c}=EXCLUDED.${c}`).join(',');
export const upsert=`INSERT INTO public.brh_banco (${names}) VALUES (${columns.map((_,i)=>'$'+(i+1)).join(',')})
 ON CONFLICT (id_brh_banco) DO UPDATE SET ${updates}
 WHERE (${columns.slice(1).map(c=>'brh_banco.'+c).join(',')}) IS DISTINCT FROM (${columns.slice(1).map(c=>'EXCLUDED.'+c).join(',')})`;
export const canonical=row=>JSON.stringify(columns.map(c=>c.startsWith('dt_') && row[c]!=null?
 row[c].replace(/0+$/,'').replace(/\.$/,''):row[c]));

export async function runPilot(execute=false,restart=false){
 let pool,client,sourceTx,targetTx=false,stage='configuração';
 const report={table:'BRH_BANCO',mode:execute?'upsert':'plan',startedAt:new Date().toISOString(),status:'running',batches:[],sequenceAdjustment:'pending-explicit-authorization'};
 const path=`reports/brh-banco-${Date.now()}.json`,checkpoint='checkpoints/brh-banco.json';
 try{
  const e=process.env;
  if(!e.MSSQL_PASSWORD||!e.PGPASSWORD) throw new Error('MISSING_LOCAL_CREDENTIALS');
  if((e.MSSQL_SCHEMA||'dbo')!=='dbo'||(e.PGSCHEMA||'public')!=='public'||
    (e.MSSQL_DATABASE||'BRHDEVAMIL_YXUYVT')!=='BRHDEVAMIL_YXUYVT'||(e.PGDATABASE||'DEV_AMIL')!=='DEV_AMIL') throw new Error('PILOT_ENVIRONMENT_MISMATCH');
  pool=new sql.ConnectionPool({server:e.MSSQL_HOST||'127.0.0.1',port:Number(e.MSSQL_PORT||1433),
   database:'BRHDEVAMIL_YXUYVT',user:e.MSSQL_USER||'sa',password:e.MSSQL_PASSWORD,pool:{min:0,max:1},requestTimeout:60000,
   options:{encrypt:e.MSSQL_ENCRYPT!=='false',trustServerCertificate:e.MSSQL_TRUST_CERTIFICATE==='true'}});
  client=new pg.Client({host:e.PGHOST||'127.0.0.1',port:Number(e.PGPORT||5432),database:'DEV_AMIL',
   user:e.PGUSER||'USER_AD_DEV_AMIL',password:e.PGPASSWORD,statement_timeout:60000,connectionTimeoutMillis:15000});
  stage='conexão SQL Server';await pool.connect();stage='conexão PostgreSQL';await client.connect();
  // Session advisory lock prevents concurrent runs of this pilot without persistent objects.
  await client.query('SELECT pg_advisory_lock(179094,1)');
  stage='estrutura';
  const a=(await pool.request().input('schema',sql.NVarChar,'dbo').query(sourceColumns)).recordset;
  const b=(await client.query(targetColumns,['public'])).rows;
  const table=compare(a,b,['BRH_BANCO'])[0];
  if(table.issues.length||table.source.length!==8||table.target.length!==8||
    table.source.some(c=>!columns.includes(c.column_name.toLowerCase())||c.computed||c.identity)||
    table.target.some(c=>c.computed||c.identity)) throw new Error('PILOT_STRUCTURE_CHANGED');
  const expected=['bigint','int','varchar','datetime','int','datetime','int','varchar'];
  if(columns.some((c,i)=>table.source.find(x=>x.column_name.toLowerCase()===c)?.type!==expected[i])) throw new Error('PILOT_TYPES_CHANGED');
  const triggers=(await client.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='public.brh_banco'::regclass AND NOT tgisinternal AND tgenabled<>'D'`)).rows;
  if(triggers.length) throw new Error('PILOT_ACTIVE_TRIGGERS_REQUIRE_REVIEW');
  sourceTx=new sql.Transaction(pool);await sourceTx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  const sq=()=>new sql.Request(sourceTx);
  report.sourceCount=(await sq().query('SELECT CONVERT(varchar(30),COUNT_BIG(*)) AS n FROM dbo.BRH_BANCO')).recordset[0].n;
  report.targetCountBefore=(await client.query('SELECT count(*)::text AS n FROM public.brh_banco')).rows[0].n;
  report.sequence=(await client.query('SELECT last_value::text,is_called FROM public.brh_banco_sq')).rows[0];
  report.targetMaxId=(await client.query('SELECT max(id_brh_banco)::text AS n FROM public.brh_banco')).rows[0].n;
  if(!execute){report.status='planned';return report;}
  // Until overwrite preimage backup is implemented, this first pilot requires empty target,
  // or a checkpoint from the same verified source/target configuration.
  const fingerprint=createHash('sha256').update(JSON.stringify({source:e.MSSQL_HOST||'127.0.0.1',sourcePort:e.MSSQL_PORT||'1433',target:e.PGHOST||'127.0.0.1',targetPort:e.PGPORT||'5432',a:table.source,b:table.target})).digest('hex');
  let saved=null;
  try{saved=JSON.parse(await readFile(checkpoint,'utf8'));}catch(err){if(err.code!=='ENOENT')throw err;}
  if(saved && saved.fingerprint!==fingerprint)throw new Error('CHECKPOINT_CONFIG_MISMATCH');
  if(report.targetCountBefore!=='0'&&!saved)throw new Error('EXISTING_TARGET_REQUIRES_PREIMAGE_BACKUP');
  let last=!restart && saved?.status==='running'?saved.lastPk:null;
  report.resumedAfter=last;
  await mkdir('checkpoints',{recursive:true});
  const save=async status=>{await writeFile(checkpoint+'.tmp',JSON.stringify({fingerprint,lastPk:last,status},null,2));await rename(checkpoint+'.tmp',checkpoint);};
  await save('running');
  for(;;){
   stage='leitura keyset SQL Server';
   const request=sq().input('batch',sql.Int,25).input('last',sql.VarChar(20),last);
   const rows=(await request.query(`SELECT TOP (@batch) ${sourceProjection} FROM dbo.BRH_BANCO AS b
    WHERE @last IS NULL OR b.ID_BRH_BANCO>CONVERT(bigint,@last) ORDER BY b.ID_BRH_BANCO`)).recordset;
   if(!rows.length)break;
   stage='UPSERT e validação do lote PostgreSQL';await client.query('BEGIN');targetTx=true;
   let changed=0;
   for(const row of rows){
    changed+=(await client.query(upsert,columns.map(c=>row[c]))).rowCount;
    const stored=(await client.query(`SELECT ${targetProjection} FROM public.brh_banco WHERE id_brh_banco=$1`,[row.id_brh_banco])).rows[0];
    if(canonical(row)!==canonical(stored))throw new Error('BATCH_CONTENT_MISMATCH');
   }
   await client.query('COMMIT');targetTx=false;
   last=rows.at(-1).id_brh_banco;
   report.batches.push({rows:rows.length,changed,lastPk:last});await save('running');
  }
  stage='validação completa por PK';
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');targetTx=true;
  const sh=createHash('sha256'),th=createHash('sha256');let cursor=null,validated=0;
  for(;;){
   const rows=(await sq().input('batch',sql.Int,25).input('last',sql.VarChar(20),cursor).query(`SELECT TOP (@batch) ${sourceProjection} FROM dbo.BRH_BANCO AS b WHERE @last IS NULL OR b.ID_BRH_BANCO>CONVERT(bigint,@last) ORDER BY b.ID_BRH_BANCO`)).recordset;
   if(!rows.length)break;
   for(const row of rows){
    const stored=(await client.query(`SELECT ${targetProjection} FROM public.brh_banco WHERE id_brh_banco=$1`,[row.id_brh_banco])).rows[0];
    if(!stored||canonical(row)!==canonical(stored))throw new Error('FINAL_CONTENT_MISMATCH');
    sh.update(canonical(row)+'\n');th.update(canonical(stored)+'\n');validated++;
   }cursor=rows.at(-1).id_brh_banco;
  }
  report.targetCountAfter=(await client.query('SELECT count(*)::text AS n FROM public.brh_banco')).rows[0].n;
  report.targetMaxId=(await client.query('SELECT max(id_brh_banco)::text AS n FROM public.brh_banco')).rows[0].n;
  report.validation={rows:validated,sourceHash:sh.digest('hex'),targetHash:th.digest('hex'),allSourceRowsMatch:true,
   countsEqual:report.sourceCount===report.targetCountAfter};
  if(BigInt(validated)!==BigInt(report.sourceCount))throw new Error('SOURCE_COUNT_MISMATCH');
  await client.query('ROLLBACK');targetTx=false;
  await save('complete');report.status='validated';
  return report;
 }catch(error){report.status='failed';report.failure=/^(PILOT_|CHECKPOINT_|EXISTING_TARGET_|BATCH_CONTENT_|FINAL_CONTENT_|SOURCE_COUNT_|MISSING_LOCAL_)[A-Z_]+$/.test(error.message)?`${stage}: ${error.message}`:safeError(error,stage);throw Object.assign(new Error(report.failure),{report});}
 finally{
  if(targetTx)await client.query('ROLLBACK').catch(()=>{});
  if(sourceTx)await sourceTx.rollback().catch(()=>{});
  if(client)await client.end().catch(()=>{});if(pool)await pool.close().catch(()=>{});
  report.finishedAt=new Date().toISOString();await mkdir('reports',{recursive:true});await writeFile(path,JSON.stringify(report,null,2));
  console.log(`Relatório do piloto: ${path}; status: ${report.status}`);
 }
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/pilot.js')){
 const args=process.argv.slice(2);
 if(args.some(a=>!['--execute','--restart'].includes(a)) || (args.includes('--restart')&&!args.includes('--execute'))){console.error('Uso: npm.cmd run pilot -- [--execute [--restart]]');process.exitCode=1;}
 else await runPilot(args.includes('--execute'),args.includes('--restart')).catch(error=>{console.error(error.message);process.exitCode=1;});
}
