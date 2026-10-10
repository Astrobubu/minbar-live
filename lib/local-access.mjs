import {randomBytes,createHash} from 'node:crypto';
export function createLocalAccess({enabled=false,port=4310}={}){
 const grants=new Map(),hash=value=>createHash('sha256').update(value).digest('hex');
 const available=req=>enabled&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
 const sameOrigin=req=>{try{const origin=new URL(req.headers.origin);return available(req)&&origin.protocol==='http:'&&['localhost','127.0.0.1'].includes(origin.hostname)&&origin.port===String(port)&&origin.host===req.headers.host&&origin.origin===req.headers.origin;}catch{return false;}};
 const authorize=req=>{if(!sameOrigin(req))return false;const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('minbar_local_operator='));return cookie&&(grants.get(hash(cookie.slice('minbar_local_operator='.length)))||0)>Date.now();};
 function bootstrap(req,res){if(!sameOrigin(req))throw Object.assign(new Error('Local operator access requires enabled local development and a same-origin loopback request.'),{status:403});for(const[key,expiry]of grants)if(expiry<Date.now())grants.delete(key);if(grants.size>=100)throw Object.assign(new Error('Local access limit reached.'),{status:429});const token=randomBytes(32).toString('base64url');grants.set(hash(token),Date.now()+8*3600000);res.setHeader('Set-Cookie',`minbar_local_operator=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);return{granted:true};}
 return{available,authorize,bootstrap};
}
