export function safeError(error, stage) {
 const candidates=[error, error?.originalError, error?.originalError?.info, error?.cause];
 const codes=candidates.flatMap(e=>[e?.code,e?.number]).filter(v=>
  (typeof v==='string' && /^[A-Z0-9_]{2,40}$/.test(v)) || (typeof v==='number' && Number.isInteger(v)));
 const hints={ELOGIN:'SQL Server recusou o login; confira usuário, senha e acesso ao banco.',
  '28P01':'PostgreSQL recusou a senha; confira PGUSER e PGPASSWORD.',
  '3D000':'Banco PostgreSQL não encontrado; confira PGDATABASE e maiúsculas/minúsculas.',
  ECONNREFUSED:'Conexão recusada; confira container, endereço e porta publicada.',
  ETIMEOUT:'Tempo esgotado; confira conectividade e disponibilidade do banco.',
  '42501':'Permissão insuficiente para consultar os metadados.',
  '42702':'Consulta com coluna ambígua; corrigir a consulta de catálogo.',
  '42703':'Coluna inexistente na consulta de catálogo.',
  '42P01':'Relação inexistente na consulta de catálogo.'};
 return `Etapa: ${stage}. Código: ${[...new Set(codes)].join(', ')||'UNCLASSIFIED'}. ${codes.map(c=>hints[c]).find(Boolean)||'Verificar conexão/configuração ou consulta nesta etapa.'}`;
}
