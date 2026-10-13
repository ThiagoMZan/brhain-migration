import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadEnvFile} from 'node:process';
import sql from 'mssql';
import {configuration,connections} from '../src/connections.js';
import {sourceColumns,targetColumns} from '../src/catalog.js';
import {compare} from '../src/compare.js';
import {buildTable,canonical} from '../src/workflow-model.js';
test('integração somente leitura: keyset e projeções em BRH_BANCO',{skip:process.env.RUN_READONLY_INTEGRATION!=='1'},async()=>{
 loadEnvFile('.env');const config=configuration();const {pool,client}=connections(config);let begun=false;
 try{
  await pool.connect();await client.connect();await client.query('BEGIN READ ONLY');begun=true;
  const a=(await pool.request().input('schema',sql.NVarChar,config.source.schema).query(sourceColumns)).recordset;
  const b=(await client.query(targetColumns,[config.target.schema])).rows;
  const table=compare(a,b,['BRH_BANCO'])[0];assert.deepEqual(table.issues,[]);
  const model=buildTable(table,config.source.schema,config.target.schema);let cursor=null,validated=0;
  const key=row=>model.pk.map(c=>row['c'+c.index]);
  for(;;){
   const request=pool.request().input('batch',sql.Int,17).input('initial',sql.Bit,cursor===null);
   model.pk.forEach((_,i)=>request.input('k'+i,sql.VarChar(100),cursor?.[i]??null));
   const rows=(await request.query(model.readSql)).recordset;if(!rows.length)break;
   const stored=(await client.query(model.batchLookup(rows.length),rows.flatMap(key))).rows;
   const values=new Map(stored.map(row=>[JSON.stringify(key(row)),row]));
   for(const row of rows){const actual=values.get(JSON.stringify(key(row)));assert.ok(actual);assert.equal(canonical(row,model.columns),canonical(actual,model.columns));validated++;}
   cursor=key(rows.at(-1));
  }
  assert.ok(validated>0);
  const expected=(await pool.request().query(`SELECT COUNT_BIG(*) AS n FROM ${model.sourceTable}`)).recordset[0].n;
  assert.equal(BigInt(validated),BigInt(expected));
 }finally{if(begun)await client.query('ROLLBACK');await client.end();await pool.close();}
});
