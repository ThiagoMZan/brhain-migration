const key = x => x.toLowerCase();
const mapping = {bigint:['int8'],int:['int4','int8'],smallint:['int2','int4','int8'],tinyint:['int2','int4','int8'],
 bit:['bool'],decimal:['numeric'],numeric:['numeric'],money:['numeric'],smallmoney:['numeric'],
 float:['float8'],real:['float4','float8'],varchar:['varchar','text'],nvarchar:['varchar','text'],
 char:['bpchar','varchar','text'],nchar:['bpchar','varchar','text'],text:['text'],ntext:['text'],
 binary:['bytea'],varbinary:['bytea'],image:['bytea'],uniqueidentifier:['uuid'],date:['date'],
 datetime:['timestamp'],datetime2:['timestamp'],smalldatetime:['timestamp'],datetimeoffset:['timestamptz'],time:['time'],xml:['xml','text']};
export function compare(source, target, selected=[], {destinationColumnsOnly=false}={}) {
 const names=[...new Set([...source,...target].map(c=>key(c.table_name)))];
 for(const name of selected) if(!names.includes(key(name))) throw new Error('TABLE_NOT_FOUND');
 return names.filter(n=>!selected.length || selected.some(s=>key(s)===n)).map(name=>{
  const a=source.filter(c=>key(c.table_name)===name),b=target.filter(c=>key(c.table_name)===name),issues=[];
  if(!a.length) issues.push('Tabela ausente na origem');
  if(!b.length) issues.push('Tabela ausente no destino');
  const pk=cols=>cols.filter(c=>c.pk_order).sort((x,y)=>x.pk_order-y.pk_order).map(c=>key(c.column_name));
  if(!pk(a).length) issues.push('Origem sem PK: paginação por chave precisa de estratégia');
  if(JSON.stringify(pk(a))!==JSON.stringify(pk(b))) issues.push('PK divergente');
  for(const c of a){
   const d=b.find(x=>key(x.column_name)===key(c.column_name));
   if(!d){if(!destinationColumnsOnly)issues.push(`Coluna ausente no destino: ${c.column_name}`);continue;}
   if(!mapping[c.type]?.includes(d.type)) issues.push(`Tipo requer decisão: ${c.column_name} (${c.type} → ${d.type})`);
   if(c.nullable && !d.nullable) issues.push(`Destino não aceita NULL: ${c.column_name}`);
   const length=c.type.startsWith('n') ? c.max_length/2 : c.max_length;
   if(d.max_length!=null && (c.max_length===-1 || length>d.max_length)) issues.push(`Comprimento reduzido: ${c.column_name}`);
   if(['decimal','numeric','money','smallmoney'].includes(c.type) && d.type==='numeric' && d.precision!=null){
    const precision=c.type==='money'?19:c.type==='smallmoney'?10:c.precision,scale=c.type.includes('money')?4:c.scale;
    if(d.scale<scale || d.precision-d.scale<precision-scale) issues.push(`Precisão reduzida: ${c.column_name}`);
   }
   if(d.computed) issues.push(`Coluna gerada exige projeção: ${c.column_name}`);
  }
  for(const d of b) if(!a.some(c=>key(c.column_name)===key(d.column_name))) {
   if(!destinationColumnsOnly)issues.push(`Coluna exclusiva no destino: ${d.column_name}`);
   else if(!d.nullable && d.default_expression==null && !d.identity && !d.computed)issues.push(`Coluna obrigatória no destino sem origem/default: ${d.column_name}`);
  }
  const protectedTable=/^(CORE_APPLICATION|CORE_MODULE|CORE_DATATRACE|CORE_ACCESSLOG|OBJETOBD|CAMPOBD)$/i.test(name);
  return {table:name,protectedTable,status:issues.length?'review':'structurally-compatible',issues,source:a,target:b,
   ignoredSourceColumns:destinationColumnsOnly?a.filter(c=>!b.some(d=>key(c.column_name)===key(d.column_name))).map(c=>c.column_name):[],
   destinationOnlyColumns:destinationColumnsOnly?b.filter(c=>!a.some(s=>key(c.column_name)===key(s.column_name))).map(c=>c.column_name):[],
   warning:'Compatibilidade estrutural não autoriza carga; XML, conteúdo, FKs e gerador de IDs precisam de validação.'};
 });
}
