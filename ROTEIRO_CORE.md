# Fluxo CORE

Usa o mesmo .env e as regras do fluxo BRH/APH. A lista é explícita, nesta ordem:

1. CORE_USER
2. CORE_USERGROUP
3. CORE_USERGROUP_USERS
4. AUTH_SAMLTRUSTEDIDP
5. AUTH_USRCREDENTIAL
6. AUTH_USRCREDHIST
7. CORE_APPCONFIG
8. CORE_LIBSINCLUDE
9. CORE_MAILING
10. CORE_FILE

Nenhuma outra tabela CORE/AUTH é incluída. A ordem não é reordenada por FKs;
constraints existentes permanecem ativas e erros interrompem a execução.

```powershell
# Somente leitura: pendências de totais/estrutura.
npm.cmd run core:diagnostico -- --env .env

# Somente leitura: plano das dez tabelas na ordem acima.
npm.cmd run core:importar -- --env .env

# Após revisar o plano ready e autorizar a carga, usar seu arquivo:
npm.cmd run core:importar -- --env .env --execute --plan reports/core-import-ID.json --bulk

# Conferir totais após a carga.
npm.cmd run core:diagnostico -- --env .env
```

O plano pula tabelas com totais iguais, sem comparar conteúdo. As demais são
carregadas com UPSERT pela PK, preservando IDs e auditoria. Somente as colunas
presentes no destino são importadas; campos ausentes são registrados como ignorados.
CORE_FILE.ID_FILE é preservado. Anexos externos Oracle/S3 não fazem parte deste fluxo.

Bulk: COPY para staging temporário e UPSERT, padrão de 5.000 linhas por lote.
Sem --bulk, usa INSERT parametrizado por lote. O terminal mostra início/fim de cada
tabela. Backup, validação de conteúdo para tabelas carregadas e checkpoints seguem
[ROTEIRO.md](ROTEIRO.md). Planos e checkpoints CORE são separados dos de BRH.
Para retomar, repetir o mesmo comando/plano sem --restart. Sem ajuste automático
de sequences/identities e sem novas inserções pela plataforma durante a carga.
Após a carga, siga [ROTEIRO_SEQUENCES.md](ROTEIRO_SEQUENCES.md) para alinhar os geradores.
