export function nextSequenceValue(sequence, extrema) {
 if(sequence.cycle)throw new Error('CYCLIC_SEQUENCE_REQUIRES_STRATEGY');
 const increment=BigInt(sequence.increment),min=BigInt(sequence.min),max=BigInt(sequence.max);
 let next=BigInt(sequence.last)+(sequence.isCalled?increment:0n);
 const values=extrema.filter(v=>v!==null).map(v=>BigInt(v));
 if(values.length){
  if(increment>0n){const used=values.reduce((a,b)=>a>b?a:b);if(next<=used)next+=((used-next)/increment+1n)*increment;}
  else {const used=values.reduce((a,b)=>a<b?a:b),step=-increment;if(next>=used)next-=((next-used)/step+1n)*step;}
 }
 if(next<min||next>max)throw new Error('SEQUENCE_EXHAUSTED');
 const ranges={smallint:[-32768n,32767n],integer:[-2147483648n,2147483647n],bigint:[-9223372036854775808n,9223372036854775807n]};
 for(const consumer of sequence.consumers||[]){const range=ranges[consumer.type];if(range&&(next<range[0]||next>range[1]))throw new Error('CONSUMER_INTEGER_RANGE_EXHAUSTED');}
 return next.toString();
}
