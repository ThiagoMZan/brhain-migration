import {test} from 'node:test';
import assert from 'node:assert/strict';
import {coreTables,coreSelection,coreOrder} from '../src/flows.js';
test('CORE usa lista exata e ordem instruída, incluindo AUTH',()=>{
 const tables=[...coreTables].reverse().map(table=>({table}));tables.push({table:'core_application'},{table:'core_accesslog'});
 assert.deepEqual(coreSelection(tables).map(t=>t.table),[...coreTables]);
 assert.deepEqual(coreOrder(coreSelection(tables)),[...coreTables]);
 tables.find(t=>t.table==='core_user').skip=true;
 assert.deepEqual(coreOrder(coreSelection(tables)),coreTables.slice(1));
});
test('seleção parcial mantém ordem; tabelas não autorizadas ou ausentes falham',()=>{
 const tables=coreTables.map(table=>({table}));
 assert.deepEqual(coreSelection(tables,['core_file','core_user']).map(t=>t.table),['core_user','core_file']);
 assert.throws(()=>coreSelection(tables,['core_application']),/OUTSIDE_CORE/);
 assert.throws(()=>coreSelection(tables.slice(1)),/NOT_FOUND/);
});
