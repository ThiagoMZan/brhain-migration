# Roteiro de migração BRH_ e APH_

Para a lista específica CORE/AUTH e sua ordem definida, use
[ROTEIRO_CORE.md](ROTEIRO_CORE.md) e os comandos `core:*`.

Na pasta desta ferramenta, execute os passos abaixo. Cada ambiente usa um arquivo
local com todos os campos do `.env.example`, como `.env.dev` ou `.env.hml`. Eles
estão ignorados pelo Git. Configure bancos, endpoints, schemas, usuários e senhas.

Preparação única:

```powershell
npm.cmd ci --ignore-scripts
Copy-Item .env.example .env.hml
# Preencher a configuração no arquivo local.
```

## 1. Diagnóstico de totais — somente leitura

```powershell
npm.cmd run brh:diagnostico -- --env .env.hml
```

Descobre as tabelas BRH_ e APH_ dos dois lados, compara totais exatos e estrutura e gera
JSON + CSV em `reports/`. Contagens usam texto/bigint e podem demorar em tabelas grandes.
No terminal mostra somente tabelas com totais divergentes ou problemas impeditivos.
Quando tudo estiver resolvido, mostra “Nenhuma pendência encontrada”. Os relatórios
JSON/CSV continuam completos, incluindo as tabelas sem pendências.
Código 0: totais e estrutura compatíveis; 2: divergências; 1: erro de execução.
Totais iguais não provam igualdade de conteúdo. Os dois bancos não possuem snapshots
simultâneos: mantenha as aplicações sem alterações durante a avaliação.

## 2. Plano de importação — somente leitura

```powershell
npm.cmd run brh:importar -- --env .env.hml
```

Sem `--execute`, não grava nos bancos. Descobre todas as tabelas de dados BRH_ e APH_,
compara os totais dos dois lados e marca as tabelas com totais iguais para pular.
Essa é uma decisão baseada somente na contagem: não compara conteúdo dessas tabelas.
Na execução, a seleção ignorada segue o plano, sem recontagem nem UPSERT ou validação
de conteúdo. Gere um novo plano para atualizar essa decisão após mudanças nos bancos.
compara colunas/tipos/PKs, verifica triggers, regras e RLS, ordena dependências pelas
FKs físicas do destino e gera um plano JSON para as tabelas com totais diferentes.
`status: ready` permite execução. `blocked` exige resolver a estrutura e gerar
outro plano. Regra de colunas: importa apenas a interseção entre origem e destino.
Colunas da origem ausentes no destino são ignoradas na leitura, escrita e validação,
e registradas em `ignoredSourceColumns` no JSON; não são pendências. Colunas exclusivas
do destino ficam fora do UPSERT: mantêm valores em registros existentes e usam default
ou NULL em novas inserções. Uma coluna obrigatória sem origem/default ou PK ausente
continua bloqueando o plano. Tipos incompatíveis nas colunas importadas também bloqueiam.

Os prefixos BRH_ e APH_ são literais. Os comandos continuam com os nomes `brh:*`,
agora abrangendo os dois grupos. Gere um novo plano para incluir APH_; executar um
plano antigo mantém apenas a seleção gravada nele.
Tabelas auxiliares `*_sq` são registradas como exclusões:
no PostgreSQL, seus geradores são sequences, não linhas a copiar. CORE_APPLICATION,
CORE_MODULE, CORE_DATATRACE, CORE_ACCESSLOG e metadados não entram nessa seleção.

No inventário anterior, restrito a BRH_, havia 284 tabelas de dados, 284 auxiliares e 11 tabelas
com colunas ausentes no destino. Essas colunas são ignoradas conforme a regra definida;
gere um novo plano para aplicar essa política. Referências da origem ausentes no destino aparecem como
avisos: confirme a procedência do XML e as FKs físicas na segunda importação.
Esta ferramenta não importa XML, cria FKs nem altera índices.

O diagnóstico completo de 02/10/2026 contou 2.712.955 linhas na origem e 98 no destino.
As 98 são BRH_BANCO, com totais iguais. Os 14 testes passaram, incluindo integração
somente leitura das projeções e keyset do fluxo genérico contra BRH_BANCO. A carga
em massa do novo fluxo não foi executada nem validada em ambiente real.

## 3. Executar o plano aprovado — UPSERT pela PK

Substitua abaixo pelo arquivo do plano **ready** gerado na etapa 2:

```powershell
npm.cmd run brh:importar -- --env .env.hml --execute --plan reports/brh-import-ID.json
```

Executar esse comando é a ação explícita de carga. O ambiente, seleção e estrutura
precisam corresponder ao plano; a seleção vem do plano. IDs são preservados.
Conflitos atualizam todas as colunas não PK, inclusive auditoria, com valores da
origem. Linhas idênticas não recebem UPDATE. Linhas exclusivas do destino são
preservadas e geram divergência de totais (saída 2).

Keyset por PK inteira, inclusive composta; somente PKs de tipos inteiros suportadas.
Lotes configurados por MIGRATION_BATCH_SIZE (padrão 100, máximo 1000), parâmetros e
transações por lote. O terminal mostra uma mensagem antes de começar cada tabela
e outra após processar e validar, com o total de linhas. Sem atualizações periódicas.
Essa saída aparece em novas execuções; o processo já aberto mantém o código anterior.
Sem OFFSET ou tabela inteira em memória. Bigint e decimais via
texto, datas sem Date JavaScript e binários via hex/Buffer. Tipos não implementados
bloqueiam o plano. Não converte Y/N automaticamente. datetime2 acima de seis casas
decimais bloqueia o plano e exige decisão de precisão.

Antes de cada alteração, registra a imagem anterior em
`backups/<execução>/<tabela>.jsonl`. Esses arquivos contêm dados de negócio e devem
ser protegidos como os bancos; estão ignorados pelo Git. Ainda não há restauração
automática dessas imagens. Checkpoints são separados por ambiente/estrutura.
Falha entre COMMIT e checkpoint repete o lote com UPSERT; lotes confirmados permanecem
se uma etapa posterior falhar. Não há rollback global nem limpeza de tabelas.

Origem: transação SERIALIZABLE de leitura por tabela, podendo bloquear gravações.
Destino: trava de escrita por lote. Mantenha a plataforma sem gravações durante o
fluxo; locks por lote não impedem alterações entre lotes. FKs para tabelas externas
ao grupo, incluindo CORE, são verificadas pelo PostgreSQL e podem exigir carga
prévia autorizada. Ciclos físicos bloqueiam o plano. Constraints nunca são desligadas.

Valida todas as linhas de origem por PK, todas as colunas importadas, hashes SHA-256 ordenados
e totais. O hash inicial detecta mudanças na origem entre retomadas. Falhas retornam
código 1 e são registradas no relatório por tabela. Totais extras do destino são
reportados sem excluir linhas.

## 4. Retomar, se necessário

### Alternativa bulk para tabelas grandes

```powershell
npm.cmd run brh:importar -- --env .env.hml --execute --plan reports/brh-import-ID.json --bulk
```

Usa `COPY FROM STDIN` em uma tabela temporária por lote e depois `INSERT SELECT
ON CONFLICT` pela PK. Padrão: 5.000 linhas por lote; ajuste com
`--bulk-batch-size 5000` (máximo 10.000, limitado também pelo número de colunas da PK).
Mantém backup anterior, validação, constraints, auditoria e checkpoint após COMMIT.
A tabela temporária, sem defaults/identities, desaparece ao terminar a transação.
Não limpa a tabela real nem avança seus geradores de IDs automaticamente.
O modo bulk usa o mesmo plano e checkpoint do modo comum; não exige `--restart`.
Ainda lê a origem para hash/retomada e valida os dados carregados. O ganho esperado
vem do transporte COPY e de menos transações, backups e checkpoints por lote;
não foi medido em carga real. Testes de pipeline/serialização não substituem um piloto
bulk autorizado no ambiente. O processo já aberto mantém o modo anterior.

Execute novamente o comando da etapa 3. Tabelas incompletas retomam pelo checkpoint;
tabelas completas incluídas na carga são relidas e conferidas. Tabelas marcadas para
pular por totais iguais não são processadas, mesmo com `--restart`.
Origem alterada nas tabelas incluídas exige revisão e reinício:

```powershell
npm.cmd run brh:importar -- --env .env.hml --execute --plan reports/brh-import-ID.json --restart
```

`--restart` relê desde a primeira PK, sem apagar registros. Se a estrutura mudou,
gere e aprove um novo plano antes de executar.

## 5. Diagnóstico após a carga

```powershell
npm.cmd run brh:diagnostico -- --env .env.hml
```

O ajuste de sequences/identities e o teste de inserção pela plataforma continuam
separados. Use [ROTEIRO_SEQUENCES.md](ROTEIRO_SEQUENCES.md) para planejar e aplicar
os ajustes autorizados. Importar IDs explícitos não avança
automaticamente `<tabela>_sq`. Não realizar novas inserções pela plataforma até
ajustar e validar o gerador real com autorização explícita.

## Seleção pequena no mesmo fluxo

```powershell
npm.cmd run brh:diagnostico -- --env .env --tables BRH_BANCO
npm.cmd run brh:importar -- --env .env --tables BRH_BANCO
# Depois: etapa 3 com o plano ready da seleção.
```

O piloto antigo `npm.cmd run pilot` permanece restrito aos bancos locais originais.
Para outros ambientes use os comandos `brh:*` deste roteiro.
