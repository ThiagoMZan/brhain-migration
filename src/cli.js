import { mkdir, writeFile } from 'node:fs/promises';
import sql from 'mssql';
import pg from 'pg';
import * as catalog from './catalog.js';
import { compare } from './compare.js';
import { safeError } from './errors.js';

const args=process.argv.slice(2);
if(args.includes('--help')) {
 console.log('Diagnóstico somente leitura: npm.cmd run diagnose -- [--tables TABELA1,TABELA2] [--counts]\nSem --tables: catálogo completo. --counts exige seleção explícita.');
 process.exit(0);
}
let pool,client,transaction=false,stage='configuração';
try {
 let selected=[],counts=false;
 for(let i=0;i<args.length;i++) {
  if(args[i]==='--tables' && args[i+1]) selected=args[++i].split(',').map(x=>x.trim()).filter(Boolean);
  else if(args[i]==='--counts') counts=true;
  else throw new Error('INVALID_ARGUMENT');
 }
 if(counts && !selected.length) throw new Error('COUNTS_REQUIRE_TABLES');
 for(const variable of ['MSSQL_PASSWORD','PGPASSWORD']) if(!process.env[variable]) throw new Error('MISSING_LOCAL_CREDENTIALS');
 const env=process.env,sourceSchema=env.MSSQL_SCHEMA||'dbo',targetSchema=env.PGSCHEMA||'public';
 pool=new sql.ConnectionPool({server:env.MSSQL_HOST||'127.0.0.1',port:Number(env.MSSQL_PORT||1433),
  database:env.MSSQL_DATABASE||'BRHDEVAMIL_YXUYVT',user:env.MSSQL_USER||'sa',password:env.MSSQL_PASSWORD,
  connectionTimeout:15000,requestTimeout:60000,pool:{max:1,min:0},
  options:{encrypt:env.MSSQL_ENCRYPT!=='false',trustServerCertificate:env.MSSQL_TRUST_CERTIFICATE==='true',appName:'brhain-readonly-diagnostic'}});
 client=new pg.Client({host:env.PGHOST||'127.0.0.1',port:Number(env.PGPORT||5432),database:env.PGDATABASE||'DEV_AMIL',
  user:env.PGUSER||'USER_AD_DEV_AMIL',password:env.PGPASSWORD,connectionTimeoutMillis:15000,statement_timeout:60000});
 stage='conexão SQL Server';await pool.connect();
 stage='conexão PostgreSQL';await client.connect();
 stage='transação PostgreSQL somente leitura';
 await client.query('BEGIN READ ONLY');transaction=true;
 const sourceQuery=async (text,label)=>{stage=`catálogo SQL Server: ${label}`;return (await pool.request().input('schema',sql.NVarChar,sourceSchema).query(text)).recordset;};
 const targetQuery=async (text,label)=>{stage=`catálogo PostgreSQL: ${label}`;return (await client.query(text,[targetSchema])).rows;};
 // Only fixed catalog SQL and quoted SELECT COUNT identifiers are reachable in this executable.
 const source=await sourceQuery(catalog.sourceColumns,'colunas'),target=await targetQuery(catalog.targetColumns,'colunas');
 stage='comparação de estrutura';
 const tables=compare(source,target,selected);
 const sourceFks=await sourceQuery(catalog.sourceFks,'FKs'),targetFks=await targetQuery(catalog.targetFks,'FKs');
 const sequences=await targetQuery(catalog.targetSequences,'sequences');
 stage='informações SQL Server';
 const sourceInfo=(await pool.request().query(`SELECT DB_NAME() AS database_name,CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version,
 compatibility_level,collation_name FROM sys.databases WHERE name=DB_NAME()`)).recordset;
 stage='informações PostgreSQL';
 const targetInfo=(await client.query('SELECT current_database() AS database_name,version() AS version')).rows;
 for(const table of tables){
  table.sourceFks=sourceFks.filter(f=>f.table_name.toLowerCase()===table.table);
  table.targetFks=targetFks.filter(f=>f.table_name.toLowerCase()===table.table);
  const signature=f=>[f.column_name,f.referenced_table,f.referenced_column].map(x=>x.toLowerCase()).join('|');
  table.missingFkPairs=table.sourceFks.filter(f=>!table.targetFks.some(g=>signature(f)===signature(g)));
  if(table.missingFkPairs.length) table.issues.push('Referências físicas ausentes no destino; conferir agrupamento das FKs compostas');
  if(table.targetFks.some(f=>!f.validated)) table.issues.push('FK física presente, mas não validada');
  table.conventionalSequence=sequences.find(s=>s.sequencename===table.table+'_sq')||null;
  if(table.issues.length) table.status='review';
  if(counts && table.source.length && table.target.length){
   stage='contagens das tabelas selecionadas';
   const qs=x=>'['+x.replaceAll(']',']]')+']',qp=x=>'"'+x.replaceAll('"','""')+'"';
   table.counts={source:(await pool.request().query(`SELECT CONVERT(varchar(30),COUNT_BIG(*)) AS count FROM ${qs(sourceSchema)}.${qs(table.source[0].table_name)}`)).recordset[0].count,
    target:(await client.query(`SELECT count(*)::text AS count FROM ${qp(targetSchema)}.${qp(table.target[0].table_name)}`)).rows[0].count};
   table.counts.equal=table.counts.source===table.counts.target;
  }
 }
 stage='encerramento da transação';await client.query('ROLLBACK');transaction=false;
 const report={mode:'diagnostic-readonly',createdAt:new Date().toISOString(),sourceInfo,targetInfo,sourceSchema,targetSchema,
  xmlVerification:{status:'pending',reason:'XML não fornecido; origem e estrutura ainda não confirmadas'},
  contentValidation:'not-performed',tables};
 stage='gravação do relatório local';await mkdir('reports',{recursive:true});
 const path=`reports/diagnostic-${Date.now()}.json`;
 await writeFile(path,JSON.stringify(report,null,2),{flag:'wx'});
 console.log(`Relatório: ${path}. Tabelas: ${tables.length}; revisão: ${tables.filter(t=>t.status==='review').length}. Nenhuma carga executada.`);
} catch(error) {
 // Do not print driver messages, connection objects or stacks: they can contain credentials.
 const allowed=['INVALID_ARGUMENT','COUNTS_REQUIRE_TABLES','MISSING_LOCAL_CREDENTIALS','TABLE_NOT_FOUND'];
 console.error(`Diagnóstico falhou: ${allowed.includes(error.message)?error.message:'CONNECTION_OR_QUERY_FAILED'}. Nenhuma falha foi ignorada.`);
 console.error(safeError(error,stage));
 process.exitCode=1;
} finally {
 if(transaction) await client.query('ROLLBACK').catch(()=>{});
 if(client) await client.end().catch(()=>{});
 if(pool) await pool.close().catch(()=>{});
}
