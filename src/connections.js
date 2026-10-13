import sql from 'mssql';
import pg from 'pg';
export function configuration(e=process.env){
 const required=['MSSQL_HOST','MSSQL_PORT','MSSQL_DATABASE','MSSQL_USER','MSSQL_PASSWORD','PGHOST','PGPORT','PGDATABASE','PGUSER','PGPASSWORD'];
 if(required.some(k=>!e[k]))throw new Error('MISSING_ENV_CONFIGURATION');
 const batch=Number(e.MIGRATION_BATCH_SIZE||100);
 if(!Number.isInteger(batch)||batch<1||batch>1000)throw new Error('INVALID_BATCH_SIZE');
 if([e.MSSQL_PORT,e.PGPORT].some(v=>!Number.isInteger(Number(v))||Number(v)<1||Number(v)>65535))throw new Error('INVALID_PORT');
 return {batch,source:{host:e.MSSQL_HOST,port:Number(e.MSSQL_PORT),database:e.MSSQL_DATABASE,user:e.MSSQL_USER,schema:e.MSSQL_SCHEMA||'dbo'},
  target:{host:e.PGHOST,port:Number(e.PGPORT),database:e.PGDATABASE,user:e.PGUSER,schema:e.PGSCHEMA||'public'}};
}
export function connections(config){
 const e=process.env;
 return {pool:new sql.ConnectionPool({server:config.source.host,port:config.source.port,database:config.source.database,user:config.source.user,password:e.MSSQL_PASSWORD,
  connectionTimeout:15000,requestTimeout:60000,pool:{max:1,min:0},options:{encrypt:e.MSSQL_ENCRYPT!=='false',trustServerCertificate:e.MSSQL_TRUST_CERTIFICATE==='true'}}),
 client:new pg.Client({host:config.target.host,port:config.target.port,database:config.target.database,user:config.target.user,password:e.PGPASSWORD,connectionTimeoutMillis:15000,statement_timeout:60000})};
}
