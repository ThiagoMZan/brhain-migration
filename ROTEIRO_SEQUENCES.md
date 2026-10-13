# Alinhamento de todas as sequences

Este fluxo usa somente PostgreSQL e inventaria todos os schemas de usuário do banco
configurado no .env, incluindo sequences fora de BRH_/APH_/CORE. Não consulta SQL Server.

## 1. Planejar — somente leitura

```powershell
npm.cmd run sequences:planejar -- --env .env
```

Gera `reports/sequences-ID.json`. Descobre vínculos de identity/serial, dependências
de defaults com nextval e o gerador da plataforma `<tabela_em_minúsculas>_sq` quando
há PK inteira de uma única coluna. Calcula o próximo valor além do máximo usado;
para incremento negativo, abaixo do mínimo. Preserva o incremento e sequences já
adiantadas. Tabelas vazias preservam a posição atual. Não chama nextval, evitando
consumir IDs no diagnóstico. Compartilhadas usam os extremos de todas as colunas
identificadas. Usa bigint textual para não perder precisão.

O relatório inclui 100% das sequences encontradas e a cobertura dos vínculos.
Uma sequence sem vínculo confirmado, com PK ambígua, default não direto, ciclo ou
limite esgotado fica bloqueada. A aplicação exige plano ready e nenhuma pendência;
O limite do tipo da coluna também é respeitado. Leitura sujeita a RLS não pode
ocultar registros ao calcular os extremos: o comando falha se não tiver visão completa.
não pula sequences silenciosamente. Planos não reconhecem referências dinâmicas
arbitrárias em código/funções: adicione explicitamente consumidores não catalogados.

Para sequences sem vínculo, use um arquivo JSON local:

```json
[
  {
    "sequenceSchema": "public",
    "sequence": "nome_sequence",
    "tableSchema": "public",
    "table": "nome_tabela",
    "column": "id"
  }
]
```

```powershell
npm.cmd run sequences:planejar -- --env .env --map sequences-map.json
```

Vários itens para a mesma sequence acrescentam os consumidores compartilhados.
Mapeamentos explícitos não removem vínculos nativos conhecidos nem autorizam
defaults aritméticos/cíclicos; esses casos precisam de estratégia específica.

## 2. Aplicar, quando autorizado

Pare a plataforma e outros consumidores de IDs e feche suas conexões antes do ajuste.
Reabra as conexões depois, para descartar valores de sequences previamente reservados
em cache. O parâmetro `--maintenance` declara que essa condição foi atendida.

```powershell
npm.cmd run sequences:ajustar -- --env .env --plan reports/sequences-ID.json --maintenance
```

Se usou --map no plano, passe o mesmo arquivo na aplicação.
Confere inventário/ambiente, trava as tabelas e sequences, recalcula os extremos no
momento da aplicação e usa ALTER SEQUENCE RESTART WITH, em uma única transação.
Sequences adiantadas não são rebobinadas. Não altera incrementos, limites, cache,
ownership, defaults ou IDs já gravados. O ALTER INCREMENT BY com o valor existente
serve apenas para obter o lock da sequence antes de ler seu estado.
Se qualquer ajuste falhar, todos os ajustes da transação são revertidos; o relatório
fica failed/rolledBack. Requer usuário proprietário das sequences ou privilégios
equivalentes, além de SELECT/lock nas tabelas.

## 3. Conferir e testar a plataforma

```powershell
npm.cmd run sequences:planejar -- --env .env
```

O novo relatório deve indicar zero sequences a ajustar. Depois teste uma inserção
pela plataforma e confirme o ID gerado. Esse teste não é executado por este comando.
