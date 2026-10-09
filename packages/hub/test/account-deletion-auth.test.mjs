import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {generateKeyPair,exportJWK,SignJWT} from "jose";
import {Hono} from "hono";
import {integration,isolatedPostgres} from "../../db/test/postgres-database.fixture.mjs";
import {verifyAuthToken,signAgentRunToken} from "../src/auth.ts";
import {signMachineDaemonCredential,verifyMachineDaemonCredential} from "../src/connections/machine-daemon/auth.ts";
import {registerAccountDeletionRoutes} from "../src/index-routes-account-deletion.ts";

integration("deletion requires a Human's fresh session and revokes already-issued Human, Agent and Machine tokens",async()=>{
 const f=await isolatedPostgres("account_auth",{shard:true});
 try{
  const user={id:"auth-user",email:"auth-user@example.test",name:"Test user"};
  await f.run(`INSERT INTO control.auth_users(id,name,email,email_verified,created_at,updated_at) VALUES($1,$2,$3,true,now(),now())`,[user.id,user.name,user.email]);
  await f.run(`INSERT INTO control.auth_sessions(id,token,user_id,expires_at,created_at,updated_at) VALUES('fresh-session','test-cookie',$1,now()+interval '1 day',now(),now())`,[user.id]);
  const keys=await generateKeyPair("ES256"),publicKey=JSON.stringify(await exportJWK(keys.publicKey));
  await f.run("INSERT INTO control.auth_jwks(id,public_key,private_key,created_at) VALUES('test-key',$1,'unused',now())",[publicKey]);
  const objects=new Set(["avatars/auth-user/one.png","avatars/other-user/two.png"]);
  const env={AUTH_AUTHORITY:"postgres",RELAY_POSTGRES:{connectionString:f.url.toString()},RELAY_POSTGRES_SHARD_ID:"shard-0",
    BETTER_AUTH_SECRET:"isolated-account-test-signing-secret",HUB_URL:"https://hub.example.test",APP_URL:"https://example.test",
    ATTACHMENT_BUCKET:{list:async({prefix})=>({objects:[...objects].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false}),delete:async keys=>{for(const key of keys){assert.ok(key.startsWith("avatars/auth-user/"));objects.delete(key);}}}};
  const token=await new SignJWT({email:user.email,auth_session_id:"fresh-session"}).setProtectedHeader({alg:"ES256",kid:"test-key"}).setIssuer(env.HUB_URL).setAudience(env.HUB_URL).setSubject(user.id).setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
  const agent=await signAgentRunToken(env,user,{agentId:"test-agent",agentName:"test",runId:"test-run",executionKey:"test-execution",spaceId:"test-space",channelId:"test-channel",machineId:"test-machine",hostId:"test-host",permissions:[]});
  const machine=await signMachineDaemonCredential(env,{ownerUserId:user.id,ownerEmail:user.email,machineId:"test-machine",hostId:"test-host"});
  assert.equal((await verifyAuthToken(token,env)).id,user.id);
  assert.equal((await verifyAuthToken(agent,env)).agentRun.ownerUserId,user.id);
  assert.equal((await verifyMachineDaemonCredential(machine,env)).ownerUserId,user.id);
  const app=new Hono();registerAccountDeletionRoutes(app);
  const work=[];const context={waitUntil:p=>work.push(p)};
  const proof={requestId:randomUUID(),receipt:"c".repeat(64),email:user.email,confirmation:"DELETE",acknowledge:true};
  const send=(path,body,credential=token)=>app.fetch(new Request(env.HUB_URL+path,{method:"POST",headers:{"content-type":"application/json",...(credential?{authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(body)}),env,context);
  assert.equal((await send("/api/account-deletion",proof,agent)).status,401);
  assert.equal((await send("/api/account-deletion",{...proof,acknowledge:false})).status,400);
  assert.equal((await send("/api/account-deletion",{...proof,email:"other@example.test"})).status,400);
  assert.equal((await send("/api/account-deletion",proof)).status,202);
  await Promise.all(work);
  assert.equal((await send("/api/account-deletion/status",proof,"")).status,200);
  assert.deepEqual(await (await send("/api/account-deletion/status",proof,"")).json(),{state:"completed"});
  assert.equal((await send("/api/account-deletion/status",{...proof,receipt:"d".repeat(64)},"")).status,404);
  await assert.rejects(verifyAuthToken(token,env),/Invalid or expired auth token/);
  await assert.rejects(verifyAuthToken(agent,env),/Invalid or expired auth token/);
  await assert.rejects(verifyMachineDaemonCredential(machine,env),/Invalid or expired Machine Daemon/);
  assert.deepEqual([...objects],["avatars/other-user/two.png"]);
  assert.equal((await f.run("SELECT receipt_hash FROM control.account_deletion_requests WHERE user_id=$1",[user.id]))[0].receipt_hash,createHash("sha256").update(proof.receipt).digest("hex"));
 }finally{await f.close();}
});
