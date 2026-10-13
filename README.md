# Migração SQL Server → PostgreSQL

Ferramenta separada da plataforma, em `C:\Users\thiag\www\brhain-migration`.
Node.js observado: 22.21.0. Nenhum módulo Java foi alterado.

## Sequences de todo o banco

`sequences:planejar` inventaria e calcula ajustes sem gravar.
`sequences:ajustar` aplica um plano ready com `--maintenance`, após autorização.
Veja [ROTEIRO_SEQUENCES.md](ROTEIRO_SEQUENCES.md).

## Fluxo CORE

Comandos `core:diagnostico` e `core:importar`, usando a lista e a ordem explícitas
de dez tabelas em [ROTEIRO_CORE.md](ROTEIRO_CORE.md). Reaproveita as regras de
contagens, colunas do destino, UPSERT e bulk; não inclui outras tabelas CORE/AUTH.

## Fluxo reutilizável para BRH_ e APH_

Consulte [ROTEIRO.md](ROTEIRO.md) para comandos por ambiente, UPSERT, diagnóstico
de totais, planos e retomada. Comandos novos: `brh:diagnostico` e `brh:importar`.
Esses comandos selecionam os dois prefixos. Gere um novo plano para incluir APH_.
Sem `--execute`, importar apenas gera plano. Ajuste de sequences continua separado.

## Piloto autorizado: BRH_BANCO

`npm.cmd run pilot` gera um plano somente leitura.
`npm.cmd run pilot -- --execute` executa exclusivamente o UPSERT de BRH_BANCO
pela PK ID_BRH_BANCO. Não aceita outras tabelas nem ambientes diferentes dos
bancos BRHDEVAMIL_YXUYVT → DEV_AMIL. Atualiza todas as colunas não PK, incluindo
auditoria, somente quando os valores divergem; preserva linhas exclusivas do destino.

O primeiro piloto exige destino vazio ou checkpoint desta configuração. Sobrescrita
de dados preexistentes sem checkpoint exige implementação de backup das imagens
anteriores. Lotes de 25, keyset bigint textual, parâmetros e transação por lote;
checkpoint local atômico após commit. Falha entre commit e checkpoint repete o lote
com UPSERT idempotente. Origem mantida em transação SERIALIZABLE de leitura durante
a execução, podendo bloquear alterações concorrentes no SQL Server. Não utilizar
a tabela pela plataforma durante a carga e validação.

Validação compara todas as oito colunas por PK e hashes SHA-256 ordenados. Datas
datetime são projetadas como texto SQL estilo 121; no destino, microssegundos são
comparados sem conversão para Date. IDs bigint permanecem strings. A validação final
verifica todas as linhas de origem, inclusive as anteriores ao checkpoint; mudanças
na origem entre execuções podem causar falha, exigindo revisão e reinício completo.
Com checkpoint completo, uma nova execução relê e compara toda a origem.
`npm.cmd run pilot -- --execute --restart` reinicia a leitura pela primeira PK,
mantendo o UPSERT e sem apagar registros. Use após revisão de uma falha de retomada.
`node --env-file-if-exists=.env src/verify-upsert.js` testa atualização por conflito
e repetição sem alteração em uma transação que é integralmente revertida.

Sequence brh_banco_sq é apenas consultada. Seu ajuste e a nova inserção pela
plataforma exigem autorização explícita separada. Relatórios e checkpoints locais
não entram no Git. A CLI diagnose permanece exclusivamente de leitura.

## Etapa atual: diagnóstico

```powershell
npm.cmd install
Copy-Item .env.example .env
# Preencher as senhas localmente no .env, sem enviá-las pelo chat.
npm.cmd run diagnose -- --help
npm.cmd run diagnose
npm.cmd run diagnose -- --tables CORE_FILE --counts
npm.cmd test
```

O comando diagnose consulta catálogos, compara tabelas/colunas/PKs, tipos, comprimentos,
precisão, nulabilidade, referências físicas e geradores de IDs. `--counts` executa
contagens exatas somente nas tabelas selecionadas e pode ser demorado.
Relatórios JSON locais contêm estrutura e nomes, sem senhas ou conteúdo das linhas.
Falhas encerram o comando com código diferente de zero; relatórios parciais não são
apresentados como sucesso. O comando diagnose não possui DML/DDL.
PostgreSQL usa transação READ ONLY; SQL Server executa somente SELECTs fixos.
Para proteção adicional no SQL Server, configure um usuário com permissões de leitura
e visibilidade de metadados. A ferramenta não cria usuários nem concede permissões.

`structurally-compatible` é uma avaliação preliminar, não autorização de carga.
Comparações são insensíveis à caixa; schemas configurados devem conter nomes únicos
sem diferenças apenas de caixa. Tipos especiais, collation, timezone, índices,
triggers, defaults, regras e semântica de FKs compostas exigem revisão.
Contagens de bancos em atividade não constituem snapshot consistente nem validação
de conteúdo. Valores de linhas não são lidos nesta etapa.

## Drivers e precisão

`mssql` usa Tedious (JavaScript puro); `msnodesqlv8` exige dependências nativas/ODBC.
Destino: `pg`. Não usar o parser padrão de decimal do Tedious para a carga:
decimal/numeric, money, bigint e datas serão projetados para representações textuais
exatas no SQL de origem; binários serão buffers. Nenhuma conversão universal de Y/N.
Datas exigem política por tipo, sem passagem automática por Date JavaScript.

## Próximas etapas, após diagnóstico e autorização

1. Receber o XML exportado e confirmar ambiente/estrutura contra o backup de
   01/10/2026, 15:45–15:48 (Brasília). Preservar a normalização determinística de índices
   na segunda importação; verificar as FKs físicas, inclusive compostas, além de
   `createForeignKeys=true`. O diagnóstico não importa XML.
2. Selecionar explicitamente uma tabela pequena e definir política para dados já
   presentes, conversões e dependências. OBJETOBD, CAMPOBD e metadados relacionados
   exigem inventário e decisão específica. CORE_APPLICATION/CORE_MODULE já carregadas
   não devem ser sobrescritas. CORE_DATATRACE/CORE_ACCESSLOG fora do piloto.
3. Implementar módulos `reader`, `writer`, `checkpoint`, `validate` e `sequences`:
   paginação keyset por PK (inclusive composta), parâmetros, projeções exatas,
   transações por lote, checkpoint consistente com commit e retomada que trate
   falha entre commit e checkpoint sem upsert automático. Limitar memória por lote.
4. Com autorização explícita, carregar o piloto preservando IDs/auditoria e
   CORE_FILE.ID_FILE quando aplicável; validar contagens e conteúdo por chave com
   hashes canônicos e relatório de falhas. Não incluir anexos Oracle/S3.
5. Identificar gerador real: identity, sequence ligada ao default ou `<tabela>_sq`
   (confirmado em PostgresNextKeyImpl.java). Planejar ajuste levando em conta máximo
   existente, incremento, sequência compartilhada e concorrência. Executar somente
   após autorização; testar nova inserção pela plataforma com ID sem colisão.

Não há truncate, limpeza, desativação de constraints nem ajuste de sequences
implementados. Os novos comandos `brh:*` implementam o UPSERT das tabelas BRH_ e APH_; o teste de inserção
pela plataforma permanece pendente.
