import sql from 'mssql';
import {loadEnvFile} from 'node:process';
import {mkdir,readFile,writeFile,rename,appendFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {configuration,connections} from './connections.js';
import * as catalog from './catalog.js';
import {compare} from './compare.js';
import {safeError} from './errors.js';
import {bulkUpsert} from './bulk.js';
import {coreTables,coreSelection,coreOrder} from './flows.js';
import {hash,qs,qp,tablePrefixes,matchesTablePrefix,isBusinessTable,buildTable,dependencyOrder,canonical,diagnosticLines} from './workflow-model.js';

function parse(args){
 const o={command:args.shift(),env:'.env',flow:'brh',tables:[],execute:false,restart:false,bulk:false,bulkBatchSize:5000};
 if(!['diagnose','import'].includes(o.command))throw new Error('INVALID_COMMAND');
 for(let i=0;i<args.length;i++){
  const a=args[i];
  if(['--env','--plan','--tables','--bulk-batch-size','--flow'].includes(a)){
   if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('MISSING_ARGUMENT');
   const v=args[++i];if(a==='--tables')o.tables=v.split(',').map(s=>s.trim().toLowerCase());else if(a==='--bulk-batch-size')o.bulkBatchSize=Number(v);else o[a.slice(2)]=v;
  }else if(a==='--execute')o.execute=true;else if(a==='--restart')o.restart=true;else if(a==='--bulk')o.bulk=true;else throw new Error('INVALID_ARGUMENT');
 }
 if(o.command==='diagnose'&&(o.execute||o.plan||o.restart))throw new Error('DIAGNOSE_READONLY');
 if(o.execute&&!o.plan)throw new Error('EXECUTION_REQUIRES_PLAN');
 if(o.restart&&!o.execute)throw new Error('RESTART_REQUIRES_EXECUTE');
 if(!['brh','core'].includes(o.flow))throw new Error('INVALID_FLOW');
 if(o.bulk&&(!o.execute||o.command!=='import'))throw new Error('BULK_REQUIRES_IMPORT_EXECUTE');
 if(!Number.isInteger(o.bulkBatchSize)||o.bulkBatchSize<1||o.bulkBatchSize>10000)throw new Error('INVALID_BULK_BATCH_SIZE');
 return o;
}
const args=process.argv.slice(2);
if(args.includes('--help')){
 console.log('Fluxo CORE: npm.cmd run core:diagnostico -- --env .env; npm.cmd run core:importar -- --env .env. Execução: acrescentar --execute --plan reports/core-import-ID.json --bulk. Usa somente as dez tabelas da lista, na ordem definida.');
 console.log('npm.cmd run brh:diagnostico -- [--env .env] [--tables BRH_BANCO]\nnpm.cmd run brh:importar -- [--env .env] [--tables BRH_BANCO]\nnpm.cmd run brh:importar -- --env .env --execute --plan reports/plano.json [--restart] [--bulk [--bulk-batch-size 5000]]\nPadrão: todas as tabelas BRH_ e APH_, exceto auxiliares geradoras *_sq. Importar sem --execute apenas gera plano.');
}else{
 let pool,client,pgTx=false,stage='configuração';
 const report={version:1,runId:randomUUID(),startedAt:new Date().toISOString(),status:'running',tables:[]};
 try{
  const options=parse(args);loadEnvFile(options.env);
  report.flow=options.flow;
  let approvedPlan;
  if(options.execute){
   approvedPlan=JSON.parse(await readFile(options.plan,'utf8'));
   if((approvedPlan.flow||'brh')!==options.flow)throw new Error('PLAN_FLOW_MISMATCH');
   const selection=approvedPlan.tables?.map(t=>t.table);
   if(!selection?.length)throw new Error('INVALID_PLAN');
   if(options.tables.length&&hash([...options.tables].sort())!==hash([...selection].sort()))throw new Error('PLAN_SELECTION_MISMATCH');
   options.tables=selection;
  }
  const config=configuration();report.environment=config;report.command=options.command;report.execute=options.execute;
  report.transport=options.bulk?'copy-staging-upsert':'parameterized-insert';
  if(options.bulk)report.bulkBatchSize=options.bulkBatchSize;
  report.countPolicy='skip-equal-counts-v1';
  if(options.execute)console.log('Preparando importação: conectando e verificando o plano/estrutura...');
  ({pool,client}=connections(config));stage='conexão SQL Server';await pool.connect();stage='conexão PostgreSQL';await client.connect();
  await client.query('BEGIN READ ONLY');pgTx=true;
  stage='catálogo';
  const source=(await pool.request().input('schema',sql.NVarChar,config.source.schema).query(catalog.sourceColumns)).recordset;
  const target=(await client.query(catalog.targetColumns,[config.target.schema])).rows;
  const sourceFks=(await pool.request().input('schema',sql.NVarChar,config.source.schema).query(catalog.sourceFks)).recordset;
  const targetFks=(await client.query(catalog.targetFks,[config.target.schema])).rows;
  report.columnPolicy='destination-columns-only-v1';
  report.tablePrefixes=options.flow==='brh'?[...tablePrefixes]:[];
  if(options.flow==='core')report.explicitTableOrder=[...coreTables];
  const compared=compare(source,target,[],{destinationColumnsOnly:true});
  const all=options.flow==='core'?coreSelection(compared,options.tables):compared.filter(t=>matchesTablePrefix(t.table));
  report.excluded=options.flow==='core'?[]:all.filter(t=>!isBusinessTable(t.table)).map(t=>({table:t.table,reason:'Gerador auxiliar SQL Server *_sq; usar sequence PostgreSQL, não copiar linhas'}));
  const tables=options.flow==='core'?all:all.filter(t=>isBusinessTable(t.table)&&(!options.tables.length||options.tables.includes(t.table)));
  if(!tables.length||options.tables.some(n=>!tables.some(t=>t.table===n)))throw new Error('TABLE_SELECTION_NOT_FOUND');
  const triggers=(await client.query(`SELECT t.relname AS table_name,g.tgname FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid JOIN pg_namespace s ON s.oid=t.relnamespace WHERE s.nspname=$1 AND NOT g.tgisinternal AND g.tgenabled<>'D'`,[config.target.schema])).rows;
  const rules=(await client.query(`SELECT tablename FROM pg_rules WHERE schemaname=$1`,[config.target.schema])).rows;
  const rls=(await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relrowsecurity`,[config.target.schema])).rows;
  for(const table of tables){
   stage=`planejamento ${table.table}`;
   const issues=[...table.issues];let model;
   try{model=buildTable(table,config.source.schema,config.target.schema);}catch(e){issues.push(e.message);}
   if(table.source.some(c=>['datetime2','time'].includes(c.type)&&c.scale>6&&table.target.some(d=>d.column_name.toLowerCase()===c.column_name.toLowerCase())))issues.push('TEMPORAL_PRECISION_ABOVE_POSTGRES');
   if(table.source.some(c=>{
    const d=table.target.find(x=>x.column_name.toLowerCase()===c.column_name.toLowerCase());
    return ['datetime','datetime2','time'].includes(c.type)&&d?.datetime_precision!=null&&c.scale>d.datetime_precision;
   }))issues.push('TEMPORAL_PRECISION_REDUCED');
   if(triggers.some(t=>t.table_name===table.target[0]?.table_name))issues.push('ACTIVE_TRIGGER_REQUIRES_STRATEGY');
   if(rules.some(t=>t.tablename===table.target[0]?.table_name))issues.push('ACTIVE_RULE_REQUIRES_STRATEGY');
   if(rls.some(t=>t.relname===table.target[0]?.table_name))issues.push('RLS_REQUIRES_STRATEGY');
   const item={table:table.table,issues,warnings:[],ignoredSourceColumns:table.ignoredSourceColumns,destinationOnlyColumns:table.destinationOnlyColumns,counts:{source:null,target:null,equal:false},structure:table};
   if(!options.execute&&table.source.length)item.counts.source=(await pool.request().query(`SELECT CONVERT(varchar(30),COUNT_BIG(*)) AS n FROM ${qs(config.source.schema)}.${qs(table.source[0].table_name)}`)).recordset[0].n;
   if(!options.execute&&table.target.length)item.counts.target=(await client.query(`SELECT count(*)::text AS n FROM ${qp(config.target.schema)}.${qp(table.target[0].table_name)}`)).rows[0].n;
   if(options.execute){
    const planned=approvedPlan.tables.find(t=>t.table===table.table);
    if(approvedPlan.countPolicy!==report.countPolicy)throw new Error('REGENERATE_PLAN_FOR_COUNT_POLICY');
    item.counts={...planned.counts};
   }
   item.counts.equal=item.counts.source!==null&&item.counts.source===item.counts.target;
   item.counts.difference=item.counts.source!==null&&item.counts.target!==null?(BigInt(item.counts.target)-BigInt(item.counts.source)).toString():null;
   item.skip=options.command==='import'&&item.counts.equal;
   if(item.skip){item.skipReason='equal-counts-in-plan';item.structureIssuesNotApplied=[...item.issues];item.issues=[];}
   const missing=sourceFks.filter(f=>f.table_name.toLowerCase()===table.table&&!targetFks.some(g=>g.table_name.toLowerCase()===table.table&&g.column_name.toLowerCase()===f.column_name.toLowerCase()&&g.referenced_table.toLowerCase()===f.referenced_table.toLowerCase()&&g.referenced_column.toLowerCase()===f.referenced_column.toLowerCase()));
   if(missing.length)item.warnings.push(`Referências da origem ausentes no destino: ${missing.length} pares; verificar XML/FKs físicas antes da segunda importação`);
   report.tables.push(item);
   if(options.command!=='diagnose'&&item.issues.length)console.log(`${table.table}: ${item.issues.join('; ')}`);
  }
  try{report.order=options.flow==='core'?coreOrder(report.tables):dependencyOrder(report.tables.filter(t=>!t.skip).map(t=>t.table),targetFks,config.target.schema);}catch(e){report.order=[];report.blockers=[e.message];}
  // Bind approval to endpoint, schema, selection, column types and physical FK topology.
  report.fingerprint=hash({config,...(options.flow==='core'?{flow:'core',explicitTableOrder:coreTables}:{}),columnPolicy:report.columnPolicy,countPolicy:report.countPolicy,skipped:report.tables.filter(t=>t.skip).map(t=>t.table),tables:tables.map(t=>({table:t.table,source:t.source,target:t.target})),targetFks});
  await client.query('ROLLBACK');pgTx=false;
  if(options.command==='diagnose'){
   console.log(diagnosticLines(report).join('\n'));
   report.status=report.tables.some(t=>!t.counts.equal||t.issues.length)||report.blockers?.length?'differences':'equal';
   if(report.status==='differences')process.exitCode=2;
  }else if(!options.execute){
   report.status=report.tables.some(t=>t.issues.length)||report.blockers?.length?'blocked':'ready';
   console.log(`Plano: ${report.tables.filter(t=>!t.skip).length} tabela(s) para importar; ${report.tables.filter(t=>t.skip).length} ignorada(s) por totais iguais.`);
   if(report.status==='blocked')process.exitCode=2;
  }
  else{
   const plan=approvedPlan;
   if(plan.command!=='import'||plan.execute||plan.status!=='ready'||plan.fingerprint!==report.fingerprint)throw new Error('PLAN_NOT_READY_OR_ENVIRONMENT_CHANGED');
   if(report.tables.some(t=>t.issues.length)||report.blockers?.length)throw new Error('PREFLIGHT_BLOCKED');
   if(!(await client.query('SELECT pg_try_advisory_lock(179094,2) AS acquired')).rows[0].acquired)throw new Error('ANOTHER_IMPORT_IS_RUNNING');
   const checkpointDir=`checkpoints/${report.fingerprint}`;await mkdir(checkpointDir,{recursive:true});
   const backupDir=`backups/${report.runId}`;await mkdir(backupDir,{recursive:true});report.backupDirectory=backupDir;
   for(const item of report.tables)item.migration=item.skip?{status:'skipped-equal-counts',contentValidation:'not-performed'}:{status:'pending'};
   console.log(`${report.tables.filter(t=>t.skip).length} tabela(s) ignorada(s) conforme os totais do plano.`);
   for(const name of report.order){
    const item=report.tables.find(t=>t.table===name),model=buildTable(item.structure,config.source.schema,config.target.schema);
    stage=`carga ${name}`;
    console.log(`[${report.order.indexOf(name)+1}/${report.order.length}] ${name}: iniciando`);
    await migrateTable(pool,client,config,model,item,checkpointDir,backupDir,options.restart,report.fingerprint,options.bulk?options.bulkBatchSize:null);
    console.log(`${name}: ${item.migration.status}; ${item.migration.validated} linhas validadas`);
   }report.status=report.tables.some(t=>!t.counts.equal)?'validated-with-count-differences':report.tables.some(t=>t.skip)?'completed-with-count-skips':'validated';
   if(report.status==='validated-with-count-differences')process.exitCode=2;
   report.sequenceAdjustment='not-executed';
  }
 }catch(error){report.status='failed';report.failure=safeError(error,stage);if(/^[A-Z][A-Z_]+$/.test(error.message))report.reason=error.message;console.error(report.reason||report.failure);process.exitCode=1;}
 finally{
  if(pgTx)await client.query('ROLLBACK').catch(()=>{});
  if(client)await client.end().catch(()=>{});if(pool)await pool.close().catch(()=>{});
  report.finishedAt=new Date().toISOString();await mkdir('reports',{recursive:true});
  const file=`reports/${report.flow||'brh'}-${report.command||'error'}-${report.runId}.json`;
  await writeFile(file,JSON.stringify(report,null,2));
  const csv='tabela;origem;destino;diferenca;totais_iguais;pendencias\n'+report.tables.map(t=>[t.table,t.counts.source,t.counts.target,t.counts.difference,t.counts.equal,t.issues.length].map(x=>'"'+String(x??'').replaceAll('"','""')+'"').join(';')).join('\n');
  await writeFile(file.replace('.json','.csv'),csv);console.log(`Relatório: ${file}; status: ${report.status}`);
 }
}

async function migrateTable(pool,client,config,model,item,dir,backupDir,restart,fingerprint,bulkBatchSize=null){
 const tx=new sql.Transaction(pool);let begun=false,pgBegun=false;
 const checkpoint=`${dir}/${item.table}.json`,backup=`${backupDir}/${item.table}.jsonl`;
 const m=item.migration={status:'running',changed:'0',validated:'0',batches:0};
 const read=async cursor=>{
  const size=bulkBatchSize?Math.min(bulkBatchSize,Math.floor(60000/model.pk.length)):Math.min(config.batch,Math.floor(60000/model.columns.length));
  const r=new sql.Request(tx).input('batch',sql.Int,size).input('initial',sql.Bit,cursor===null);
  model.pk.forEach((_,i)=>r.input('k'+i,sql.VarChar(100),cursor?.[i]??null));return (await r.query(model.readSql)).recordset;
 };
 const key=row=>model.pk.map(c=>row['c'+c.index]);
 const stored=async rows=>new Map((await client.query(model.batchLookup(rows.length),rows.flatMap(key))).rows.map(row=>[JSON.stringify(key(row)),row]));
 const scanHash=async()=>{let cursor=null,total=0n;const digest=createHash('sha256');for(;;){const rows=await read(cursor);if(!rows.length)break;for(const row of rows){digest.update(canonical(row,model.columns)+'\n');total++;}cursor=key(rows.at(-1));}return {hash:digest.digest('hex'),count:total.toString()};};
 try{
  await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);begun=true;
  const source=await scanHash();m.source=source;
  let saved;
  try{saved=JSON.parse(await readFile(checkpoint,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(saved&&!restart&&(saved.fingerprint!==fingerprint||saved.source.hash!==source.hash))throw new Error('SOURCE_CHANGED_RESTART_REQUIRED');
  let cursor=!restart&&saved?.status==='running'?saved.cursor:null;
  const save=async status=>{await writeFile(checkpoint+'.tmp',JSON.stringify({version:1,fingerprint,source,cursor,status,backupDirectory:backupDir},null,2));await rename(checkpoint+'.tmp',checkpoint);};
  await save('running');
  for(;;){
   const rows=await read(cursor);if(!rows.length)break;
   await client.query('BEGIN');pgBegun=true;
   await client.query(`LOCK TABLE ${model.targetTable} IN SHARE ROW EXCLUSIVE MODE`);
   const previous=await stored(rows);
   // Persist exact preimages before the database change; replay logs may contain duplicates.
   await appendFile(backup,rows.map(row=>JSON.stringify({pk:key(row),previous:previous.get(JSON.stringify(key(row)))||null})).join('\n')+'\n',{flush:true});
   let result;
   if(bulkBatchSize)result=await bulkUpsert(client,model,rows);
   else{
    const params=rows.flatMap(row=>model.columns.map((c,i)=>['binary','varbinary','image'].includes(c.source.type)&&row['c'+i]!==null?Buffer.from(row['c'+i],'hex'):row['c'+i]));
    result=await client.query(model.batchUpsert(rows.length),params);
   }
   m.changed=(BigInt(m.changed)+BigInt(result.rowCount)).toString();
   const actual=await stored(rows);
   for(const row of rows){const value=actual.get(JSON.stringify(key(row)));if(!value||canonical(value,model.columns)!==canonical(row,model.columns))throw new Error('BATCH_CONTENT_MISMATCH');}
   await client.query('COMMIT');pgBegun=false;cursor=key(rows.at(-1));m.batches++;await save('running');
  }
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');pgBegun=true;
  const sh=createHash('sha256'),th=createHash('sha256');cursor=null;let count=0n;
  for(;;){const rows=await read(cursor);if(!rows.length)break;const values=await stored(rows);for(const row of rows){
   const actual=values.get(JSON.stringify(key(row)));if(!actual||canonical(actual,model.columns)!==canonical(row,model.columns))throw new Error('FINAL_CONTENT_MISMATCH');
   sh.update(canonical(row,model.columns)+'\n');th.update(canonical(actual,model.columns)+'\n');count++;
  }cursor=key(rows.at(-1));}
  m.validated=count.toString();m.sourceHash=sh.digest('hex');m.targetHash=th.digest('hex');
  m.targetCount=(await client.query(`SELECT count(*)::text AS n FROM ${model.targetTable}`)).rows[0].n;m.countsEqual=m.targetCount===source.count;
  item.counts={source:source.count,target:m.targetCount,equal:m.countsEqual,difference:(BigInt(m.targetCount)-BigInt(source.count)).toString()};
  if(m.validated!==source.count||m.sourceHash!==source.hash||m.sourceHash!==m.targetHash)throw new Error('FINAL_HASH_OR_COUNT_MISMATCH');
  await client.query('ROLLBACK');pgBegun=false;await save('complete');m.status=m.countsEqual?'validated':'validated-with-extra-target-rows';
 }catch(e){m.status='failed';m.failure=/^[A-Z][A-Z_]+$/.test(e.message)?e.message:safeError(e,'migração da tabela');throw e;}
 finally{if(pgBegun)await client.query('ROLLBACK').catch(()=>{});if(begun)await tx.rollback();}
}
