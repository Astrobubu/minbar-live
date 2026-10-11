import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
const temp=await mkdtemp(path.join(os.tmpdir(),'minbar-test-'));const port=4397;const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:String(port),MINBAR_DATA_DIR:temp,OPENAI_API_KEY:'',APP_ACCESS_TOKEN:'test-host-key'},stdio:'pipe'});await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error('Server exit '+code)));});
const base=`http://127.0.0.1:${port}`;let owned;
async function request(p,options={}){const r=await fetch(base+p,options);return{status:r.status,data:await r.json()};}
test.after(async()=>{child.kill();await new Promise(resolve=>child.once('exit',resolve));await rm(temp,{recursive:true,force:true});});
test('private session stays absent from discovery and rejects unauthenticated read',async()=>{const r=await request('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Private',kind:'personal',sourceLanguage:'en',language:'ar'})});assert.equal(r.status,201);owned=r.data;assert.equal(owned.session.visibility,'private');assert.equal(owned.session.sourceLanguage,'en');assert.equal((await request('/api/sessions/'+owned.session.id)).status,401);const list=await request('/api/sessions');assert.equal(list.data.sessions.length,0);});
test('owner token never appears in session detail',async()=>{const r=await request('/api/sessions/'+owned.session.id,{headers:{Authorization:`Bearer ${owned.ownerToken}`}});assert.equal(r.status,200);assert.equal(r.data.ownerHash,undefined);assert.equal(r.data.ownerToken,undefined);});
test('paid paths require host key even with valid owner',async()=>{const r=await request(`/api/sessions/${owned.session.id}/realtime`,{method:'POST',headers:{Authorization:`Bearer ${owned.ownerToken}`,'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,401);});
test('demo creates actual durable ordered segments with explicit provenance',async()=>{const r=await request(`/api/sessions/${owned.session.id}/start-demo`,{method:'POST',headers:{Authorization:`Bearer ${owned.ownerToken}`}});assert.equal(r.status,200);await new Promise(resolve=>setTimeout(resolve,3500));const detail=await request(`/api/sessions/${owned.session.id}`,{headers:{Authorization:`Bearer ${owned.ownerToken}`}});assert.equal(detail.data.isDemo,true);assert.equal(detail.data.segments.length,3);assert.equal(detail.data.segments[1].previousItemId,'demo-0');assert.deepEqual(detail.data.segments[1].citations,[]);});
test('private QR cannot leak owner access',async()=>assert.equal((await request(`/api/sessions/${owned.session.id}/qr`,{headers:{Authorization:`Bearer ${owned.ownerToken}`}})).status,403));
test('static traversal cannot expose environment',async()=>assert.notEqual((await fetch(base+'/%2e%2e%2f.env')).status,200));
test('recording archival requires explicit consent and owner authorization',async()=>{const p=`/api/sessions/${owned.session.id}/recordings`;const options={method:'POST',headers:{Authorization:`Bearer ${owned.ownerToken}`,'Content-Type':'audio/wav'},body:Buffer.from('audio')};assert.equal((await request(p,options)).status,403);assert.equal((await request(p,{...options,headers:{'Content-Type':'audio/wav','X-Recording-Consent':'true'}})).status,401);const saved=await request(p,{...options,headers:{...options.headers,'X-Recording-Consent':'true'}});assert.equal(saved.status,201);assert.equal((await request(p+'/'+saved.data.recording.id)).status,401);assert.equal((await request(p+'/'+saved.data.recording.id,{method:'DELETE',headers:{Authorization:`Bearer ${owned.ownerToken}`}})).status,200);});

test('verification preflight rejects invalid capture and pending sources before any OpenAI call',async()=>{const created=await request('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'personal'})});const {session,ownerToken}=created.data;const headers={Authorization:`Bearer ${ownerToken}`,'X-Host-Key':'test-host-key','Content-Type':'application/json'};const payload={audioWavBase64:'AAAA',itemIds:['missing'],windowStartSample:0,windowEndSample:240};const invalid=await request(`/api/sessions/${session.id}/verify`,{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(invalid.status,400);assert.match(invalid.data.error,/captureId/);const pending=await request(`/api/sessions/${session.id}/verify`,{method:'POST',headers,body:JSON.stringify({...payload,captureId:'capture-test'})});assert.equal(pending.status,409);assert.match(pending.data.error,/pending/);});

test('stable public profiles exclude private rooms and enforce account ownership',async()=>{const register=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'profile@example.com',password:'long profile password'})});assert.equal(register.status,200);const cookie=register.headers.get('set-cookie').split(';')[0];const headers={Cookie:cookie,'Content-Type':'application/json'};const created=await request('/api/profiles',{method:'POST',headers,body:JSON.stringify({name:'Speaker',type:'speaker',bio:'About'})});assert.equal(created.status,201);const id=created.data.profile.id;assert.equal(created.data.profile.userId,undefined);assert.equal((await request('/api/me/profiles',{headers})).data.profiles[0].id,id);for(const visibility of ['public','private']){assert.equal((await request('/api/sessions',{method:'POST',headers,body:JSON.stringify({profileId:id,kind:'venue',visibility})})).status,201);}const publicProfile=await request('/api/profiles/'+id);assert.equal(publicProfile.data.sessions.length,1);assert.equal(publicProfile.data.sessions[0].visibility,'public');assert.equal(publicProfile.data.profile.userId,undefined);assert.equal((await request('/api/profiles/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Forged'})})).status,403);assert.equal((await request('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profileId:id})})).status,403);assert.equal((await request('/api/profiles/'+id,{method:'PATCH',headers,body:JSON.stringify({name:'Updated'})})).status,200);assert.equal((await request('/api/profiles/'+id)).data.profile.name,'Updated');});

test('browser realtime module dependency is served with JavaScript MIME',async()=>{const r=await fetch(base+'/commit-policy.mjs');assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/^text\/javascript/);assert.match(await r.text(),/export.*shouldCommit/);});

const hostHeaders=token=>({Authorization:`Bearer ${token}`,'X-Host-Key':'test-host-key','Content-Type':'application/json'});
const newRoom=async(body={})=>(await request('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Live status',visibility:'public',sourceLanguage:'ar',targetLanguages:['en'],...body})})).data;

test('room is marked live (and the status event published) when the owner posts the first segment without realtime start',async()=>{
 const {session,ownerToken}=await newRoom();assert.equal(session.status,'ready');
 const controller=new AbortController();const stream=await fetch(`${base}/api/sessions/${session.id}/events`,{signal:controller.signal});let seen='';const reader=stream.body.getReader();
 const statusEvent=(async()=>{const decoder=new TextDecoder();for(;;){const {value,done}=await reader.read();if(done)return '';seen+=decoder.decode(value);const m=seen.match(/event: status\ndata: (.*)\n/);if(m)return JSON.parse(m[1]);}})();
 const r=await request(`/api/sessions/${session.id}/segments`,{method:'POST',headers:hostHeaders(ownerToken),body:JSON.stringify({text:'السلام عليكم',itemId:'item-live-1'})});
 assert.equal(r.status,200);
 const event=await Promise.race([statusEvent,new Promise(resolve=>setTimeout(()=>resolve(null),4000))]);controller.abort();
 assert.deepEqual(event,{status:'live'});
 const detail=await request(`/api/sessions/${session.id}`);assert.equal(detail.data.status,'live');assert.ok(Date.parse(detail.data.liveStartedAt)>0);
});

test('a draft from the owner also marks a ready room live; viewers without the owner token cannot',async()=>{
 const {session,ownerToken}=await newRoom();
 const stranger=await request(`/api/sessions/${session.id}/partials`,{method:'POST',headers:{'Content-Type':'application/json','X-Host-Key':'test-host-key'},body:JSON.stringify({itemId:'x',text:'draft'})});
 assert.equal(stranger.status,401);assert.equal((await request(`/api/sessions/${session.id}`)).data.status,'ready');
 const r=await request(`/api/sessions/${session.id}/partials`,{method:'POST',headers:hostHeaders(ownerToken),body:JSON.stringify({itemId:'x',text:'draft'})});
 assert.equal(r.status,200);assert.equal((await request(`/api/sessions/${session.id}`)).data.status,'live');
});

test('an ended room never goes back to live from late segments or drafts',async()=>{
 const {session,ownerToken}=await newRoom();
 assert.equal((await request(`/api/sessions/${session.id}`,{method:'PATCH',headers:hostHeaders(ownerToken),body:JSON.stringify({status:'ended'})})).status,200);
 assert.equal((await request(`/api/sessions/${session.id}/segments`,{method:'POST',headers:hostHeaders(ownerToken),body:JSON.stringify({text:'late',itemId:'late-1'})})).status,409);
 assert.equal((await request(`/api/sessions/${session.id}/partials`,{method:'POST',headers:hostHeaders(ownerToken),body:JSON.stringify({itemId:'late',text:'late'})})).status,409);
 assert.equal((await request(`/api/sessions/${session.id}`)).data.status,'ended');
});

test('public base URL follows HOST/PORT when PUBLIC_BASE_URL is unset, and the QR route accepts it',async()=>{
 const config=await request('/api/config');assert.equal(config.data.publicBaseUrl,`http://localhost:${port}`);
 const {session}=await newRoom();const link=`${config.data.publicBaseUrl}/listen.html?room=${session.id}`;
 const qr=await fetch(`${base}/api/sessions/${session.id}/qr?url=${encodeURIComponent(link)}`);assert.equal(qr.status,200);assert.match(qr.headers.get('content-type'),/svg/);
 const foreign=await fetch(`${base}/api/sessions/${session.id}/qr?url=${encodeURIComponent(`http://evil.example/listen.html?room=${session.id}`)}`);assert.equal(foreign.status,400);
});
