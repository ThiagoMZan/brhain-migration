import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canonical,columns,sourceProjection} from '../src/pilot.js';
test('comparação mantém bigint exato e timestamps sem perda de microssegundos',()=>{
 const row=Object.fromEntries(columns.map(c=>[c,null]));
 row.id_brh_banco='9007199254740993';row.dt_created='2026-10-01 15:45:00.003';
 assert.equal(canonical(row),canonical({...row,dt_created:row.dt_created+'000'}));
 assert.notEqual(canonical(row),canonical({...row,id_brh_banco:'9007199254740992'}));
 assert.notEqual(canonical(row),canonical({...row,dt_created:row.dt_created+'001'}));
 assert.match(sourceProjection,/CONVERT\(varchar\(20\)/);
});
