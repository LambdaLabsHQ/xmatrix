import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {resolveTestPostgresTools} from '../../../scripts/test-postgres-tools.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url)),tools=resolveTestPostgresTools();
const directory=mkdtempSync(join(tmpdir(),'xmatrix-dtfx-')),started=[];
function run(cmd,args,env={}) {return execFileSync(tools[cmd]??cmd,args,{cwd:root,env:{...process.env,...env},stdio:'inherit',timeout:300000});}
const urls={};
try {
  for(const [side,port,shard] of [['source','25541','shard-0'],['target','25542','shard-1']]) {
    const data=directory+'/'+side,admin='dt_cross_'+side,runtime=admin+'_runtime',socket=directory;
    run('initdb',['-D',data,'-U',admin,'-A','trust','--no-locale','-E','UTF8']);
    writeFileSync(data+'/postgresql.auto.conf',"max_prepared_transactions = 256\n");
    run('pg_ctl',['-D',data,'-l',directory+'/'+side+'.log','-o',`-k ${socket} -p ${port} -h ''`,'-w','start']);started.push(data);
    run('createdb',['-h',socket,'-p',port,'-U',admin,admin]);
    run('psql',['-h',socket,'-p',port,'-U',admin,'-d',admin,'-v','ON_ERROR_STOP=1','-c',`CREATE ROLE ${runtime} LOGIN`]);
    const url=new URL(`postgresql://${admin}@localhost/${admin}`);url.searchParams.set('host',socket);url.searchParams.set('port',port);
    run('node',['packages/db/scripts/migrate.mjs','apply','--allow-contract'],{DATABASE_URL:url.toString(),POSTGRES_RUNTIME_ROLE:runtime});
    run('psql',['-h',socket,'-p',port,'-U',admin,'-d',admin,'-v','ON_ERROR_STOP=1','-c',`INSERT INTO control.postgres_shards(shard_id,state,capacity_class,created_at,updated_at) VALUES('${shard}','active','test',now(),now()); INSERT INTO control.postgres_local_identity(singleton,shard_id,created_at) VALUES(true,'${shard}',now());`]);
    const rt=new URL(url);rt.username=runtime;
    urls[side]={url:url.toString(),runtimeUrl:rt.toString(),role:runtime,data,shard,admin};
  }
  writeFileSync(directory+'/servers.json',JSON.stringify(urls));
  const env={XMATRIX_REQUIRE_POSTGRES_TEST:'true',XMATRIX_TEST_POSTGRES_URL:urls.source.url,XMATRIX_DINGTALK_CROSSDB_SERVERS:directory+'/servers.json'};
  run('node',['--test','--test-reporter=tap','packages/db/test/dingtalk-crossdb-postgres.test.mjs'],env);
  run('node',['--import','./packages/hub/node_modules/tsx/dist/loader.mjs','--import','./packages/hub/test/support/platform-preload.mjs','--test','--test-reporter=tap','packages/hub/test/connector-dingtalk-crossdb.test.mjs'],env);
} finally {for(const data of started.reverse())run('pg_ctl',['-D',data,'-m','fast','-w','stop']);process.stdout.write('TWO_PHYSICAL_CLUSTERS='+directory+'\n');}
