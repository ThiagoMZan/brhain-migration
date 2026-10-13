import {test} from 'node:test';
import assert from 'node:assert/strict';
import {safeError} from '../src/errors.js';
test('mensagens e campos sensíveis não são exibidos',()=>{
 const output=safeError({message:'secret-password',code:'28P01',password:'secret-password'},'conexão PostgreSQL');
 assert.ok(!output.includes('secret-password'));assert.match(output,/28P01/);
});
test('códigos arbitrários são descartados e códigos internos são preservados',()=>{
 const output=safeError({code:'password=value',originalError:{info:{number:18456}}},'conexão SQL Server');
 assert.ok(!output.includes('password=value'));assert.match(output,/18456/);
});
