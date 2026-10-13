import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {from as copyFrom} from 'pg-copy-streams';

export function copyField(value,type){
 if(value===null)return '\\N';
 if(value===undefined)throw new Error('COPY_UNDEFINED_VALUE');
 let text=['binary','varbinary','image'].includes(type)?'\\x'+value:String(value);
 if(text.includes('\0'))throw new Error('COPY_NUL_CHARACTER');
 return text.replaceAll('\\','\\\\').replaceAll('\t','\\t').replaceAll('\n','\\n').replaceAll('\r','\\r');
}
export function copyRow(row,columns){return columns.map((c,i)=>copyField(row['c'+i],c.source.type)).join('\t')+'\n';}
export async function bulkUpsert(client,model,rows){
 // Caller owns the batch transaction. The temporary table disappears on commit/rollback.
 await client.query(model.createStage);
 await pipeline(Readable.from(rows.map(row=>copyRow(row,model.columns))),client.query(copyFrom(model.copyStage)));
 return client.query(model.mergeStage);
}
