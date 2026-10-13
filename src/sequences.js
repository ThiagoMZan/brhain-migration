import pg from 'pg';
import {loadEnvFile} from 'node:process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {qp,hash} from './workflow-model.js';
import {safeError} from './errors.js';
import {nextSequenceValue} from './sequence-model.js';

const inventorySql=`SELECT c.oid::text AS oid,n.nspname AS schema,c.relname AS name,
 s.seqstart::text AS start,s.seqincrement::text AS increment,s.seqmin::text AS min,
 s.seqmax::text AS max,s.seqcache::text AS cache,s.seqcycle AS cycle
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_sequence s ON s.seqrelid=c.oid
 WHERE c.relkind='S' AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' ORDER BY n.nspname,c.relname`;
const columnsSql=`SELECT t.oid::text AS oid,n.nspname AS schema,t.relname AS table,a.attname AS column,
 a.attnum,a.atttypid::regtype::text AS type,
 coalesce((SELECT array_position(i.indkey::smallint[],a.attnum) IS NOT NULL FROM pg_index i WHERE i.indrelid=t.oid AND i.indisprimary),false) AS pk,
 pg_get_expr(ad.adbin,ad.adrelid) AS expression
 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_attribute a ON a.attrelid=t.oid
 LEFT JOIN pg_attrdef ad ON ad.adrelid=t.oid AND ad.adnum=a.attnum
 WHERE t.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
 AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema' ORDER BY n.nspname,t.relname,a.attnum`;
const linksSql=`SELECT s.oid::text AS sequence_oid,t.oid::text AS table_oid,a.attnum,'ownership' AS kind
 FROM pg_class s JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=s.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
 JOIN pg_class t ON t.oid=d.refobjid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid WHERE s.relkind='S'
 UNION ALL
 SELECT s.oid::text,t.oid::text,a.attnum,'default' FROM pg_class s
 JOIN pg_depend d ON d.refclassid='pg_class'::regclass AND d.refobjid=s.oid AND d.classid='pg_attrdef'::regclass
 JOIN pg_attrdef ad ON ad.oid=d.objid JOIN pg_class t ON t.oid=ad.adrelid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=ad.adnum WHERE s.relkind='S'`;
const qualified=item=>qp(item.schema)+'.'+qp(item.name||item.table);
const args=process.argv.slice(2);
if(args.includes('--help'))console.log('npm.cmd run sequences:planejar -- --env .env [--map sequences-map.json]\nnpm.cmd run sequences:ajustar -- --env .env --plan reports/sequences-ID.json [--map sequences-map.json] --maintenance\nAbrange todas as sequences de schemas de usuário no banco configurado. Planejar não altera o banco.');
else{
 const report={version:1,runId:randomUUID(),startedAt:new Date().toISOString(),status:'running',sequences:[]};
 let client,begun=false,stage='configuração';
 try{
  const options={command:args.shift(),env:'.env',maintenance:false};
  if(!['plan','apply'].includes(options.command))throw new Error('INVALID_COMMAND');
  for(let i=0;i<args.length;i++){
   const a=args[i];if(['--env','--plan','--map'].includes(a)&&args[i+1]&&!args[i+1].startsWith('--'))options[a.slice(2)]=args[++i];
   else if(a==='--maintenance')options.maintenance=true;else throw new Error('INVALID_ARGUMENT');
  }
  if(options.command==='apply'&&(!options.plan||!options.maintenance))throw new Error('APPLY_REQUIRES_PLAN_AND_MAINTENANCE');
  loadEnvFile(options.env);const e=process.env;
  for(const k of ['PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD'])if(!e[k])throw new Error('MISSING_PG_CONFIGURATION');
  report.environment={host:e.PGHOST,port:Number(e.PGPORT),database:e.PGDATABASE,user:e.PGUSER};report.command=options.command;
  const maps=options.map?JSON.parse(await readFile(options.map,'utf8')):[];
  if(!Array.isArray(maps))throw new Error('INVALID_MAPPING');
  const plan=options.command==='apply'?JSON.parse(await readFile(options.plan,'utf8')):null;
  client=new pg.Client({...report.environment,password:e.PGPASSWORD,connectionTimeoutMillis:15000,statement_timeout:60000});
  stage='conexão PostgreSQL';await client.connect();
  await client.query(options.command==='apply'?'BEGIN':'BEGIN READ ONLY');begun=true;
  // Fail instead of silently calculating maxima from rows hidden by RLS.
  await client.query('SET LOCAL row_security=off');
  if(options.command==='apply'){
   await client.query("SET LOCAL lock_timeout='10s'");
   if(!(await client.query('SELECT pg_try_advisory_xact_lock(179094,2) AS acquired')).rows[0].acquired)throw new Error('IMPORT_IN_PROGRESS');
  }
  stage='inventário';const sequences=(await client.query(inventorySql)).rows,columns=(await client.query(columnsSql)).rows,links=(await client.query(linksSql)).rows;
  report.inventoryCount=sequences.length;
  const integerTypes=['smallint','integer','bigint'];
  for(const s of sequences){
   const item={...s,consumers:[],issues:[],status:'pending'};
   const add=(c,kind)=>{const existing=item.consumers.find(x=>x.oid===c.oid&&x.attnum===c.attnum);if(existing){if(!existing.kinds.includes(kind))existing.kinds.push(kind);}else item.consumers.push({...c,kinds:[kind]});};
   for(const link of links.filter(l=>l.sequence_oid===s.oid)){
    const c=columns.find(c=>c.oid===link.table_oid&&c.attnum===link.attnum);
    if(c){add(c,link.kind);if(link.kind==='default'&&!/^nextval\('[^']*(?:''[^']*)*'::regclass\)$/.test(c.expression||''))item.issues.push('NON_DIRECT_DEFAULT_REQUIRES_MAPPING_STRATEGY');}
    else item.issues.push('CONSUMER_NOT_VISIBLE');
   }
   // Platform generator: table name lowercased + _sq; require an unambiguous single-column integer PK.
   if(s.name.endsWith('_sq')){
    const tableName=s.name.slice(0,-3),pk=columns.filter(c=>c.schema===s.schema&&c.table.toLowerCase()===tableName&&c.pk);
    if(pk.length===1&&integerTypes.includes(pk[0].type))add(pk[0],'platform-name');
    else if(columns.some(c=>c.schema===s.schema&&c.table.toLowerCase()===tableName))item.issues.push('PLATFORM_PK_AMBIGUOUS');
   }
   for(const map of maps.filter(m=>m.sequenceSchema===s.schema&&m.sequence===s.name)){
    const c=columns.find(c=>c.schema===map.tableSchema&&c.table===map.table&&c.column===map.column);
    if(!c)throw new Error('MAPPING_COLUMN_NOT_FOUND');add(c,'explicit-map');
   }
   if(!item.consumers.length)item.issues.push('NO_COLUMN_MAPPING');
   if(item.consumers.some(c=>!integerTypes.includes(c.type)))item.issues.push('NON_INTEGER_CONSUMER');
   if(s.cycle)item.issues.push('CYCLIC_SEQUENCE_REQUIRES_STRATEGY');
   report.sequences.push(item);
  }
  if(maps.some(m=>!sequences.some(s=>s.schema===m.sequenceSchema&&s.name===m.sequence)))throw new Error('MAPPING_SEQUENCE_NOT_FOUND');
  report.fingerprint=hash({environment:report.environment,maps,inventory:report.sequences.map(({status,...s})=>s)});
  if(options.command==='apply'){
   if(plan.status!=='ready'||plan.command!=='plan'||plan.fingerprint!==report.fingerprint)throw new Error('PLAN_NOT_READY_OR_INVENTORY_CHANGED');
   if(report.sequences.some(s=>s.issues.length))throw new Error('UNRESOLVED_SEQUENCES');
   // Lock tables in deterministic order before calculating maxima/minima again.
   const tables=[...new Set(report.sequences.flatMap(s=>s.consumers.map(qualified)))].sort();
   for(const table of tables)await client.query(`LOCK TABLE ${table} IN SHARE ROW EXCLUSIVE MODE`);
  }
  for(const s of report.sequences){
   stage=`sequence ${s.schema}.${s.name}`;
   if(s.issues.length){s.status='blocked';console.log(`${s.schema}.${s.name}: ${s.issues.join(', ')}`);continue;}
   // Acquire transactional sequence lock first on apply, avoiding an unlocked read/restart race.
   if(options.command==='apply')await client.query(`ALTER SEQUENCE ${qualified(s)} INCREMENT BY ${BigInt(s.increment)}`);
   const state=(await client.query(`SELECT last_value::text AS last,is_called AS "isCalled" FROM ${qualified(s)}`)).rows[0];
   s.before=state;s.extrema=[];
   for(const c of s.consumers){
    const value=(await client.query(`SELECT ${BigInt(s.increment)>0n?'max':'min'}(${qp(c.column)})::text AS value FROM ${qualified(c)}`)).rows[0].value;
    s.extrema.push({schema:c.schema,table:c.table,column:c.column,value});
   }
   try{s.next=nextSequenceValue({...s,...state},s.extrema.map(x=>x.value));}
   catch(error){s.issues.push(error.message);s.status='blocked';if(options.command==='apply')throw error;continue;}
   s.currentNext=(BigInt(state.last)+(state.isCalled?BigInt(s.increment):0n)).toString();
   s.needsAdjustment=s.next!==s.currentNext;
   if(options.command==='apply'&&s.needsAdjustment){
    await client.query(`ALTER SEQUENCE ${qualified(s)} RESTART WITH ${BigInt(s.next)}`);
    const after=(await client.query(`SELECT last_value::text AS last,is_called AS "isCalled" FROM ${qualified(s)}`)).rows[0];
    if(after.last!==s.next||after.isCalled)throw new Error('SEQUENCE_VERIFICATION_FAILED');s.after=after;s.status='adjusted';
   }else s.status=s.needsAdjustment?'adjustment-needed':'aligned';
  }
  report.coverage={total:sequences.length,mapped:report.sequences.filter(s=>s.consumers.length).length,blocked:report.sequences.filter(s=>s.issues.length).length,
   needsAdjustment:report.sequences.filter(s=>s.needsAdjustment).length};
  if(options.command==='apply'){await client.query('COMMIT');begun=false;report.status='applied';}
  else{await client.query('ROLLBACK');begun=false;report.status=report.coverage.blocked?'blocked':'ready';if(report.coverage.blocked)process.exitCode=2;}
  console.log(`Sequences: ${report.coverage.total}; mapeadas: ${report.coverage.mapped}; pendências: ${report.coverage.blocked}; ${options.command==='apply'?'ajustadas':'a ajustar'}: ${report.coverage.needsAdjustment}.`);
 }catch(error){report.status='failed';report.failure=safeError(error,stage);if(/^[A-Z][A-Z_]+$/.test(error.message))report.reason=error.message;
  console.error(report.reason||report.failure);process.exitCode=1;
 }finally{
  if(begun){await client.query('ROLLBACK').catch(()=>{});if(report.command==='apply')report.rolledBack=true;}
  if(client)await client.end().catch(()=>{});
  report.finishedAt=new Date().toISOString();await mkdir('reports',{recursive:true});const file=`reports/sequences-${report.runId}.json`;
  await writeFile(file,JSON.stringify(report,null,2));console.log(`Relatório: ${file}; status: ${report.status}`);
 }
}
