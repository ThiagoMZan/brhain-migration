import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compare} from '../src/compare.js';
const col={table_name:'T',column_name:'ID',type:'bigint',pk_order:1,nullable:false};
test('IDs bigint e diferenças de caixa',()=>assert.equal(compare([col],[{...col,table_name:'t',type:'int8'}])[0].status,'structurally-compatible'));
test('redução de precisão bloqueia compatibilidade',()=>{
 const a={...col,type:'decimal',precision:38,scale:10};
 assert.match(compare([a],[{...a,type:'numeric',precision:18,scale:4}])[0].issues.join(),/Precisão reduzida/);
});
test('Y/N não implica boolean',()=>assert.match(compare([{...col,type:'char',max_length:1}],[{...col,type:'bool'}])[0].issues.join(),/Tipo requer decisão/));
test('seleção inexistente falha',()=>assert.throws(()=>compare([col],[],['unknown']),/TABLE_NOT_FOUND/));
test('PK composta considera ordem',()=>{
 const a=[col,{...col,column_name:'OTHER',pk_order:2}];
 const b=a.map(c=>({...c,type:'int8',pk_order:3-c.pk_order}));
 assert.ok(compare(a,b)[0].issues.includes('PK divergente'));
});
