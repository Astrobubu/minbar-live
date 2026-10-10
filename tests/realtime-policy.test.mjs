import test from 'node:test';import assert from 'node:assert/strict';import {startTranscription} from '../public/realtime.js';
test('microphone tracks are released when token transport, parsing or secret fails',async()=>{
 const originalFetch=globalThis.fetch;
 try{for(const response of [async()=>{throw new Error('offline');},async()=>({ok:true,json:async()=>{throw new Error('invalid response');}}),async()=>({ok:true,json:async()=>({})}),async()=>({ok:false,json:async()=>({error:'unauthorized'})})]){
  let stopped=0;globalThis.fetch=response;const stream={getTracks:()=>[{stop:()=>stopped++}]};await assert.rejects(startTranscription({sessionId:'test',sourceStream:stream}));assert.ok(stopped>=1);
 }}finally{globalThis.fetch=originalFetch;}
});
