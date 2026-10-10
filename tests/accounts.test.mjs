import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,writeFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHmac} from 'node:crypto';import {createAccounts} from '../lib/accounts.mjs';import {verifyStripeSignature,applyBillingEvent,billingConfigured} from '../lib/billing.mjs';
test('scrypt account passwords and opaque cookies enforce identity',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'minbar-account-'));try{const a=await createAccounts(dir);const user=await a.register('test@example.com','a long private password');assert.notEqual(user.passwordHash,'a long private password');await assert.rejects(a.login(user.email,'wrong'));assert.equal((await a.login(user.email,'a long private password')).id,user.id);assert.equal(a.safe(user).passwordHash,undefined);let cookie;await a.issue(user,{setHeader:(_,value)=>cookie=value},true);assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.equal(a.current({headers:{cookie:cookie.split(';')[0]}}).id,user.id);assert.equal(a.current({headers:{cookie:'minbar_session=forged'}}),null);}finally{await rm(dir,{recursive:true,force:true});}});
test('Stripe signatures reject forged/stale webhook bytes',()=>{const body=Buffer.from('{"id":"evt_test"}'),secret='test-secret',now=1770000000,signature=createHmac('sha256',secret).update(now+'.').update(body).digest('hex');assert.equal(verifyStripeSignature(body,`t=${now},v1=${signature}`,secret,now),true);assert.equal(verifyStripeSignature(Buffer.from('{}'),`t=${now},v1=${signature}`,secret,now),false);assert.equal(verifyStripeSignature(body,`t=${now},v1=${signature}`,secret,now+301),false);});
test('billing webhook is idempotent and entitlement bound to authenticated user metadata and configured price',async()=>{process.env.STRIPE_PRICE_ID='price_test';const user={id:'user-1'};const accounts={state:{users:{'user-1':user},billingEvents:{}},save:async()=>{}};const event={id:'evt_1',created:100,type:'customer.subscription.updated',data:{object:{id:'sub_1',metadata:{userId:'user-1'},status:'active',customer:'cus_1',items:{data:[{price:{id:'price_test'}}]}}}};await applyBillingEvent(accounts,event);assert.equal(user.subscription.active,true);assert.equal((await applyBillingEvent(accounts,event)).duplicate,true);const cancelled=structuredClone(event);cancelled.id='evt_2';cancelled.created=101;cancelled.data.object.status='canceled';await applyBillingEvent(accounts,cancelled);assert.equal(user.subscription.active,false);});

test('billing ignores stale and checkout downgrade events',async()=>{
 process.env.STRIPE_PRICE_ID='price_test';const user={id:'u'};const accounts={state:{users:{u:user},billingEvents:{}},save:async()=>{}};
 const event=(id,created,status,sub='sub_new')=>({id,created,type:'customer.subscription.updated',data:{object:{id:sub,customer:'cus',metadata:{userId:'u'},status,items:{data:[{price:{id:'price_test'}}]}}}});
 await applyBillingEvent(accounts,event('active',200,'active'));
 await applyBillingEvent(accounts,event('old-cancel',199,'canceled'));
 assert.equal(user.subscription.active,true);
 await applyBillingEvent(accounts,{id:'checkout',created:201,type:'checkout.session.completed',data:{object:{mode:'subscription',subscription:'sub_new',customer:'cus',metadata:{userId:'u'}}}});
 assert.equal(user.subscription.active,true);
 await applyBillingEvent(accounts,event('old-identity',198,'active','sub_old'));
 assert.equal(user.subscription.id,'sub_new');
 await applyBillingEvent(accounts,event('new-cancel',202,'canceled'));
 assert.equal(user.subscription.active,false);
 await applyBillingEvent(accounts,event('equal-time-active',202,'active'));assert.equal(user.subscription.active,false);
});
test('Stripe malformed and nonfinite timestamps are rejected even with valid signatures',()=>{
 const body=Buffer.from('{}'),secret='secret';for(const timestamp of ['NaN','Infinity','1e3','-1','1770000000x']){
  const signature=createHmac('sha256',secret).update(timestamp+'.').update(body).digest('hex');assert.equal(verifyStripeSignature(body,`t=${timestamp},v1=${signature}`,secret,1770000000),false);
 }
 assert.equal(verifyStripeSignature(body,'t=1770000000,v1=invalid',secret,1770000000),false);
});
test('concurrent registrations cannot duplicate the same email',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'minbar-race-'));try{const a=await createAccounts(dir);const results=await Promise.allSettled([a.register('same@example.com','a long private password'),a.register('SAME@example.com','a long private password')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(Object.keys(a.state.users).length,1);}finally{await rm(dir,{recursive:true,force:true});}
});

test('existing corrupt account store fails instead of resetting identities',async()=>{const dir=await mkdtemp(path.join(os.tmpdir(),'minbar-corrupt-'));try{await writeFile(path.join(dir,'accounts.json'),'{broken');await assert.rejects(createAccounts(dir),SyntaxError);await writeFile(path.join(dir,'accounts.json'),'{}');await assert.rejects(createAccounts(dir),/Invalid account store/);}finally{await rm(dir,{recursive:true,force:true});}});
