import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nextSequenceValue} from '../src/sequence-model.js';
const seq={increment:'1',min:'1',max:'9223372036854775807',cycle:false,last:'1',isCalled:false};
test('gerador novo usa max+1 e não consome nextval',()=>assert.equal(nextSequenceValue(seq,['98']),'99'));
test('não retrocede sequence avançada ou sequence de tabela vazia',()=>{
 assert.equal(nextSequenceValue({...seq,last:'200',isCalled:true},['98']),'201');
 assert.equal(nextSequenceValue(seq,[null]),'1');
});
test('bigint, incremento maior e sequence compartilhada',()=>{
 assert.equal(nextSequenceValue(seq,['9007199254740993']),'9007199254740994');
 assert.equal(nextSequenceValue({...seq,increment:'5'},['12','23']),'26');
});
test('sequence descendente mantém direção e não retrocede',()=>{
 const s={...seq,increment:'-2',min:'-100',max:'-1',last:'-1'};
 assert.equal(nextSequenceValue(s,['-6','-10']),'-11');
});
test('ciclo ou limite esgotado são pendências, sem reiniciar a menor valor',()=>{
 assert.throws(()=>nextSequenceValue({...seq,cycle:true},[]),/CYCLIC/);
 assert.throws(()=>nextSequenceValue({...seq,max:'10'},['10']),/EXHAUSTED/);
});
test('sequence bigint não pode gerar ID fora do limite da coluna integer',()=>{
 assert.throws(()=>nextSequenceValue({...seq,consumers:[{type:'integer'}]},['2147483647']),/CONSUMER_INTEGER_RANGE/);
});
