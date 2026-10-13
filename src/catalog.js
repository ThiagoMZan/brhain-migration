export const sourceColumns = `SELECT t.name AS table_name,c.name AS column_name,c.column_id AS ordinal,
 ty.name AS type,c.max_length,c.precision,c.scale,c.is_nullable AS nullable,c.is_identity AS [identity],
 c.is_computed AS computed,dc.definition AS default_expression,
 CASE WHEN ix.is_primary_key=1 THEN ic.key_ordinal ELSE NULL END AS pk_order
 FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
 JOIN sys.columns c ON c.object_id=t.object_id JOIN sys.types ty ON ty.user_type_id=c.user_type_id
 LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id
 LEFT JOIN sys.indexes ix ON ix.object_id=t.object_id AND ix.is_primary_key=1
 LEFT JOIN sys.index_columns ic ON ic.object_id=c.object_id AND ic.index_id=ix.index_id AND ic.column_id=c.column_id
 WHERE s.name=@schema ORDER BY t.name,c.column_id`;
export const targetColumns = `SELECT c.table_name,c.column_name,c.ordinal_position AS ordinal,c.udt_name AS type,
 c.character_maximum_length AS max_length,c.numeric_precision AS precision,c.numeric_scale AS scale,c.datetime_precision,
 (c.is_nullable='YES') AS nullable,(c.is_identity='YES') AS identity,
 (c.is_generated<>'NEVER') AS computed,c.column_default AS default_expression,
 k.ordinal_position AS pk_order,pg_get_serial_sequence(format('%I.%I',c.table_schema,c.table_name),c.column_name) AS owned_sequence
 FROM information_schema.columns c
 JOIN information_schema.tables t USING(table_catalog,table_schema,table_name)
 LEFT JOIN (SELECT k.* FROM information_schema.key_column_usage k JOIN information_schema.table_constraints tc
 USING(constraint_catalog,constraint_schema,constraint_name,table_catalog,table_schema,table_name)
 WHERE tc.constraint_type='PRIMARY KEY') k USING(table_catalog,table_schema,table_name,column_name)
 WHERE c.table_schema=$1 AND t.table_type='BASE TABLE' ORDER BY c.table_name,c.ordinal_position`;
export const sourceFks = `SELECT t.name AS table_name,f.name,rt.name AS referenced_table,
 c.name AS column_name,rc.name AS referenced_column,fc.constraint_column_id AS ordinal,
 f.is_disabled,f.is_not_trusted FROM sys.foreign_keys f
 JOIN sys.foreign_key_columns fc ON fc.constraint_object_id=f.object_id
 JOIN sys.tables t ON t.object_id=f.parent_object_id JOIN sys.schemas s ON s.schema_id=t.schema_id
 JOIN sys.tables rt ON rt.object_id=f.referenced_object_id
 JOIN sys.columns c ON c.object_id=t.object_id AND c.column_id=fc.parent_column_id
 JOIN sys.columns rc ON rc.object_id=rt.object_id AND rc.column_id=fc.referenced_column_id
 WHERE s.name=@schema ORDER BY t.name,f.name,fc.constraint_column_id`;
export const targetFks = `SELECT t.relname AS table_name,f.conname AS name,rt.relname AS referenced_table,rs.nspname AS referenced_schema,
 c.attname AS column_name,rc.attname AS referenced_column,p.ordinality::int AS ordinal,f.convalidated AS validated
 FROM pg_constraint f JOIN pg_class t ON t.oid=f.conrelid JOIN pg_namespace s ON s.oid=t.relnamespace
 JOIN pg_class rt ON rt.oid=f.confrelid
 JOIN pg_namespace rs ON rs.oid=rt.relnamespace
 CROSS JOIN LATERAL unnest(f.conkey,f.confkey) WITH ORDINALITY p(cid,rid,ordinality)
 JOIN pg_attribute c ON c.attrelid=t.oid AND c.attnum=p.cid
 JOIN pg_attribute rc ON rc.attrelid=rt.oid AND rc.attnum=p.rid
 WHERE f.contype='f' AND s.nspname=$1 ORDER BY t.relname,f.conname,p.ordinality`;
export const targetSequences = `SELECT sequencename,start_value::text,min_value::text,max_value::text,
 increment_by::text,cycle FROM pg_sequences WHERE schemaname=$1 ORDER BY sequencename`;
