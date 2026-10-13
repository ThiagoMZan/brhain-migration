import {test} from 'node:test';
import assert from 'node:assert/strict';
import {matchesTablePrefix,isBusinessTable,buildTable,canonical,dependencyOrder,projection,qs,qp,diagnosticLines} from '../src/workflow-model.js';
import {compare} from '../src/compare.js';
const col=(name,type,pk=null)=>({source:{column_name:name,type,pk_order:pk},target:{column_name:name.toLowerCase(),type,pk_order:pk}});
test('prefixo literal e geradores excluídos',()=>{
 assert.ok(isBusinessTable('BRH_BANCO'));assert.ok(!isBusinessTable('BRHX_BANCO'));assert.ok(!isBusinessTable('BRH_BANCO_sq'));assert.ok(!isBusinessTable('CORE_FILE'));
 assert.ok(isBusinessTable('APH_ENTIDADE'));assert.ok(isBusinessTable('aph_entidade'));
 assert.ok(matchesTablePrefix('APH_ENTIDADE_sq'));assert.ok(!isBusinessTable('APH_ENTIDADE_sq'));
 assert.ok(!isBusinessTable('APHX_ENTIDADE'));assert.ok(!isBusinessTable('XAPH_ENTIDADE'));
});
test('identificadores escapados',()=>{assert.equal(qs('a]b'),'[a]]b]');assert.equal(qp('a"b'),'"a""b"');});
test('keyset numérico qualificado não ordena alias textual; PK composta',()=>{
 const c=[col('ID','bigint',1),col('SUB','int',2),col('VALUE','numeric')];
 const table={source:c.map(x=>({...x.source,table_name:'BRH_T'})),target:c.map(x=>({...x.target,table_name:'brh_t'}))};
 const model=buildTable(table,'dbo','public');
 assert.match(model.readSql,/ORDER BY b\.\[ID\],b\.\[SUB\]/);
 assert.match(model.readSql,/b\.\[ID\]=CONVERT\(bigint,@k0\) AND b\.\[SUB\]>CONVERT\(int,@k1\)/);
 assert.match(model.upsert,/ON CONFLICT \("id","sub"\)/);
 assert.ok(!model.upsert.includes('"id"=EXCLUDED'));assert.match(model.upsert,/IS DISTINCT FROM/);
 assert.match(model.batchUpsert(2),/VALUES \(\$1,\$2,\$3\),\(\$4,\$5,\$6\)/);
 assert.match(model.batchLookup(2),/\(\$1::"bigint",\$2::"int"\),\(\$3::"bigint",\$4::"int"\)/);
});
test('precisão decimal, bigint, timestamp e binários',()=>{
 const c=[col('A','bigint'),col('B','numeric'),col('C','datetime'),col('D','varbinary')];
 const a={c0:'9007199254740993',c1:'12345678901234567890.1200',c2:'2026-10-01 15:45:00.003',c3:'ABFF'};
 assert.equal(canonical(a,c),canonical({...a,c1:'12345678901234567890.12',c2:'2026-10-01T15:45:00.003000',c3:'abff'},c));
 assert.notEqual(canonical(a,c),canonical({...a,c0:'9007199254740992'},c));
 assert.notEqual(canonical(a,c),canonical({...a,c2:'2026-10-01T15:45:00.003001'},c));
 assert.match(projection(col('M','money'),'source',0),/,2\)/);
});
test('FKs ordenadas e ciclos bloqueados, relações externas respeitadas pelo banco',()=>{
 const f=[{table_name:'brh_child',referenced_table:'brh_parent',referenced_schema:'public'}];
 assert.deepEqual(dependencyOrder(['brh_child','brh_parent'],f,'public'),['brh_parent','brh_child']);
 assert.throws(()=>dependencyOrder(['brh_child','brh_parent'],[...f,{table_name:'brh_parent',referenced_table:'brh_child'}],'public'),/FK_CYCLE/);
});
test('colunas ausentes no destino ficam fora da leitura, UPSERT e validação',()=>{
 const c=[col('ID','bigint',1),col('LEGACY','datetime2'),col('VALUE','varchar')];
 const source=c.map(x=>({...x.source,table_name:'BRH_T'}));
 const target=[{...c[0].target,table_name:'brh_t',type:'int8'},{...c[2].target,table_name:'brh_t',type:'varchar'}];
 const table=compare(source,target,[],{destinationColumnsOnly:true})[0];
 assert.deepEqual(table.issues,[]);assert.deepEqual(table.ignoredSourceColumns,['LEGACY']);
 const model=buildTable(table,'dbo','public');assert.equal(model.columns.length,2);
 assert.ok(!model.readSql.includes('LEGACY'));assert.ok(!model.upsert.includes('legacy'));
 assert.equal(canonical({c0:'1',c1:'nome'},model.columns),'["1","nome"]');
});
test('colunas exclusivas do destino usam default ou preservam valor existente',()=>{
 const a=[{table_name:'BRH_T',column_name:'ID',type:'bigint',pk_order:1}];
 const b=[{...a[0],table_name:'brh_t',column_name:'id',type:'int8'},
  {table_name:'brh_t',column_name:'extra',type:'varchar',nullable:false,default_expression:"'x'"}];
 const t=compare(a,b,[],{destinationColumnsOnly:true})[0];assert.deepEqual(t.issues,[]);
 assert.ok(!buildTable(t,'dbo','public').upsert.includes('extra'));
 b[1].default_expression=null;
 assert.match(compare(a,b,[],{destinationColumnsOnly:true})[0].issues.join(),/Coluna obrigatória/);
});
test('PK ausente não pode ser ignorada',()=>{
 const t={source:[{table_name:'BRH_T',column_name:'ID',type:'bigint',pk_order:1}],target:[{table_name:'brh_t',column_name:'other',type:'int8',pk_order:1}]};
 assert.throws(()=>buildTable(t,'dbo','public'),/MISSING_PK_COLUMN/);
 assert.ok(compare(t.source,t.target,[],{destinationColumnsOnly:true})[0].issues.includes('PK divergente'));
});
test('diagnóstico mostra apenas pendentes e mensagem quando todos estão iguais',()=>{
 const good={table:'brh_ok',issues:[],counts:{source:'98',target:'98',equal:true}};
 const bad={table:'brh_pending',issues:[],counts:{source:'10',target:'0',equal:false}};
 const lines=diagnosticLines({tables:[good,bad]});assert.ok(!lines.join().includes('brh_ok'));assert.match(lines[0],/brh_pending/);
 assert.deepEqual(diagnosticLines({tables:[good]}),['Nenhuma pendência encontrada.']);
 assert.match(diagnosticLines({tables:[good],blockers:['FK_CYCLE']}).join(),/FK_CYCLE/);
});
