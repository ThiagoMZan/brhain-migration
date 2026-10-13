import {createHash} from 'node:crypto';
export const qs=s=>'['+s.replaceAll(']',']]')+']';
export const qp=s=>'"'+s.replaceAll('"','""')+'"';
export const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const tablePrefixes=['BRH_','APH_'];
export const matchesTablePrefix=name=>tablePrefixes.some(prefix=>name.toUpperCase().startsWith(prefix));
export const isBusinessTable=name=>matchesTablePrefix(name)&&!name.toLowerCase().endsWith('_sq');
const textTypes=['varchar','nvarchar','char','nchar','text','ntext'];
const exactTypes=['bigint','int','smallint','tinyint','numeric','decimal','money','smallmoney'];
const dates=['datetime','smalldatetime','datetime2','date','time'];
export function projection(column,side,index){
 const c=side==='source'?`b.${qs(column.source.column_name)}`:`b.${qp(column.target.column_name)}`;
 const type=column.source.type,alias=side==='source'?qs('c'+index):qp('c'+index);
 let expression=c;
 if(exactTypes.includes(type))expression=side==='source'?`CONVERT(varchar(100),${c}${type.includes('money')?',2':''})`:`${c}::text`;
 else if(dates.includes(type))expression=side==='source'?`CONVERT(varchar(40),${c},${type==='datetime'||type==='smalldatetime'?121:126})`:
  type==='date'?`to_char(${c},'YYYY-MM-DD')`:type==='time'?`to_char(${c},'HH24:MI:SS.US')`:`to_char(${c},'YYYY-MM-DD"T"HH24:MI:SS.US')`;
 else if(['binary','varbinary','image'].includes(type))expression=side==='source'?`CONVERT(varchar(max),${c},2)`:`encode(${c},'hex')`;
 else if(type==='uniqueidentifier')expression=side==='source'?`CONVERT(varchar(36),${c})`:`${c}::text`;
 else if(!textTypes.includes(type)&&type!=='bit')throw new Error('UNSUPPORTED_TYPE');
 return `${expression} AS ${alias}`;
}
export function normalize(value,type){
 if(value===null)return null;
 if(exactTypes.includes(type)){
  const s=String(value);return s.includes('.')?s.replace(/0+$/,'').replace(/\.$/,''):s;
 }
 if(dates.includes(type))return String(value).replace(' ','T').replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
 if(['binary','varbinary','image','uniqueidentifier'].includes(type))return String(value).toLowerCase();
 return value;
}
export const canonical=(row,columns)=>JSON.stringify(columns.map((c,i)=>normalize(row['c'+i],c.source.type)));
export function buildTable(table,sourceSchema,targetSchema){
 if(new Set(table.source.map(c=>c.table_name)).size!==1||new Set(table.target.map(c=>c.table_name)).size!==1||
  new Set(table.source.map(c=>c.column_name.toLowerCase())).size!==table.source.length||
  new Set(table.target.map(c=>c.column_name.toLowerCase())).size!==table.target.length)throw new Error('AMBIGUOUS_IDENTIFIERS');
 const columns=table.source.map(source=>({source,target:table.target.find(c=>c.column_name.toLowerCase()===source.column_name.toLowerCase())})).filter(c=>c.target);
 if(table.source.some(c=>c.pk_order&&!columns.some(m=>m.source===c)))throw new Error('MISSING_PK_COLUMN');
 const sourcePk=table.source.filter(c=>c.pk_order).sort((a,b)=>a.pk_order-b.pk_order).map(c=>c.column_name.toLowerCase());
 const targetPk=table.target.filter(c=>c.pk_order).sort((a,b)=>a.pk_order-b.pk_order).map(c=>c.column_name.toLowerCase());
 if(JSON.stringify(sourcePk)!==JSON.stringify(targetPk))throw new Error('PK_MISMATCH');
 const pk=columns.map((c,i)=>({...c,index:i})).filter(c=>c.source.pk_order).sort((a,b)=>a.source.pk_order-b.source.pk_order);
 if(!pk.length||pk.some(c=>!['bigint','int','smallint','tinyint'].includes(c.source.type)))throw new Error('UNSUPPORTED_PK');
 if(columns.some(c=>c.source.computed||c.target.computed))throw new Error('GENERATED_COLUMN_REQUIRES_STRATEGY');
 const sourceTable=qs(sourceSchema)+'.'+qs(table.source[0].table_name),targetTable=qp(targetSchema)+'.'+qp(table.target[0].table_name);
 const selectSource=columns.map((c,i)=>projection(c,'source',i)).join(','),selectTarget=columns.map((c,i)=>projection(c,'target',i)).join(',');
 const keyset=pk.map((c,i)=>'('+pk.slice(0,i).map((p,j)=>`b.${qs(p.source.column_name)}=CONVERT(${p.source.type},@k${j})`).concat(`b.${qs(c.source.column_name)}>CONVERT(${c.source.type},@k${i})`).join(' AND ')+')').join(' OR ');
 const order=pk.map(c=>'b.'+qs(c.source.column_name)).join(',');
 const lookup=pk.map((c,i)=>`b.${qp(c.target.column_name)}=$${i+1}`).join(' AND ');
 const nonPk=columns.filter(c=>!c.source.pk_order),names=columns.map(c=>qp(c.target.column_name));
 const action=nonPk.length?`DO UPDATE SET ${nonPk.map(c=>`${qp(c.target.column_name)}=EXCLUDED.${qp(c.target.column_name)}`).join(',')}
 WHERE ROW(${nonPk.map(c=>'d.'+qp(c.target.column_name)).join(',')}) IS DISTINCT FROM ROW(${nonPk.map(c=>'EXCLUDED.'+qp(c.target.column_name)).join(',')})`:'DO NOTHING';
 const batchUpsert=count=>`INSERT INTO ${targetTable} AS d (${names.join(',')}) ${columns.some(c=>c.target.identity)?'OVERRIDING SYSTEM VALUE ':''}VALUES ${Array.from({length:count},(_,r)=>'('+columns.map((_,i)=>'$'+(r*columns.length+i+1)).join(',')+')').join(',')} ON CONFLICT (${pk.map(c=>qp(c.target.column_name)).join(',')}) ${action}`;
 const batchLookup=count=>`SELECT ${selectTarget} FROM ${targetTable} AS b WHERE (${pk.map(c=>'b.'+qp(c.target.column_name)).join(',')}) IN (${Array.from({length:count},(_,r)=>'('+pk.map((c,i)=>'$'+(r*pk.length+i+1)+'::'+qp(c.target.type)).join(',')+')').join(',')})`;
 const stage='pg_temp."migration_bulk_stage"';
 const createStage=`CREATE TEMP TABLE "migration_bulk_stage" ON COMMIT DROP AS SELECT ${names.join(',')} FROM ${targetTable} WITH NO DATA`;
 const copyStage=`COPY ${stage} (${names.join(',')}) FROM STDIN WITH (FORMAT text)`;
 const mergeStage=`INSERT INTO ${targetTable} AS d (${names.join(',')}) ${columns.some(c=>c.target.identity)?'OVERRIDING SYSTEM VALUE ':''}SELECT ${names.join(',')} FROM ${stage} WHERE true ON CONFLICT (${pk.map(c=>qp(c.target.column_name)).join(',')}) ${action}`;
 return {columns,pk,sourceTable,targetTable,upsert:batchUpsert(1),batchUpsert,batchLookup,lookup,selectTarget,createStage,copyStage,mergeStage,
  readSql:`SELECT TOP (@batch) ${selectSource} FROM ${sourceTable} AS b WHERE @initial=1 OR (${keyset}) ORDER BY ${order}`};
}
export function diagnosticLines(report){
 const pending=report.tables.filter(t=>!t.counts.equal||t.issues.length);
 const lines=pending.map(t=>`${t.table}: origem=${t.counts.source??'ausente'}, destino=${t.counts.target??'ausente'}${t.issues.length?'; '+t.issues.join('; '):''}`);
 if(report.blockers?.length)lines.push(...report.blockers.map(b=>`Pendência do fluxo: ${b}`));
 if(!lines.length)return ['Nenhuma pendência encontrada.'];
 lines.push(`${pending.length} tabela(s) pendente(s) de ${report.tables.length} verificadas.`);return lines;
}
export function dependencyOrder(tables,fks,schema){
 const pending=new Set(tables),out=[];
 while(pending.size){
  const available=[...pending].filter(name=>!fks.some(f=>f.table_name.toLowerCase()===name && f.referenced_table.toLowerCase()!==name &&
   (!f.referenced_schema||f.referenced_schema===schema) && pending.has(f.referenced_table.toLowerCase()))).sort();
  if(!available.length)throw new Error('FK_CYCLE_REQUIRES_STRATEGY');
  for(const name of available){pending.delete(name);out.push(name);}
 }return out;
}
