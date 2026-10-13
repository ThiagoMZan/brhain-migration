import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Writable} from 'node:stream';
import {copyField,copyRow,bulkUpsert} from '../src/bulk.js';
import {buildTable} from '../src/workflow-model.js';
const columns=[{source:{type:'bigint'}},{source:{type:'varchar'}},{source:{type:'numeric'}},{source:{type:'varbinary'}}];
test('COPY preserva bigint, decimal, NULL, binário e separadores',()=>{
 assert.equal(copyField(null,'varchar'),'\\N');assert.equal(copyField('\\N','varchar'),'\\\\N');
 assert.equal(copyField('a\tb\nc\r\\','varchar'),'a\\tb\\nc\\r\\\\');
 assert.equal(copyRow({c0:'9007199254740993',c1:null,c2:'12345678901234567890.123400',c3:'00ff'},columns),'9007199254740993\t\\N\t12345678901234567890.123400\t\\\\x00ff\n');
 assert.throws(()=>copyField(undefined,'varchar'),/UNDEFINED/);assert.throws(()=>copyField('a\0b','varchar'),/NUL/);
});
test('pipeline termina COPY antes de executar merge e não faz merge após falha',async()=>{
 const model={columns,createStage:'create',copyStage:'copy',mergeStage:'merge'},calls=[];let copied='';
 const client={query(query){
  if(typeof query==='string'){calls.push(query);return Promise.resolve({rowCount:1});}
  calls.push('copy');return new Writable({write(chunk,encoding,callback){copied+=chunk.toString();callback();}});
 }};
 await bulkUpsert(client,model,[{c0:'1',c1:'nome',c2:'1.20',c3:null}]);
 assert.deepEqual(calls,['create','copy','merge']);assert.ok(copied.includes('nome'));
 const failed=[];const broken={query(query){if(typeof query==='string'){failed.push(query);return Promise.resolve();}return new Writable({write(c,e,done){done(new Error('COPY_FAILED'));}});}};
 await assert.rejects(()=>bulkUpsert(broken,model,[{c0:'1',c1:null,c2:null,c3:null}]),/COPY_FAILED/);assert.deepEqual(failed,['create']);
});
test('staging temporário sem defaults e merge pela PK, sem limpar destino',()=>{
 const table={source:[{table_name:'BRH_T',column_name:'ID',type:'bigint',pk_order:1},{table_name:'BRH_T',column_name:'NAME',type:'varchar'}],
  target:[{table_name:'brh_t',column_name:'id',type:'int8',pk_order:1,identity:true},{table_name:'brh_t',column_name:'name',type:'varchar'}]};
 const m=buildTable(table,'dbo','public');assert.match(m.createStage,/CREATE TEMP TABLE.*ON COMMIT DROP.*WITH NO DATA/);
 assert.match(m.mergeStage,/OVERRIDING SYSTEM VALUE SELECT.*WHERE true ON CONFLICT \("id"\) DO UPDATE/);
 assert.match(m.mergeStage,/IS DISTINCT FROM/);assert.ok(!m.mergeStage.includes('TRUNCATE'));
});
