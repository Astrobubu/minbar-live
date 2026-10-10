import {createHmac,timingSafeEqual} from 'node:crypto';
export function verifyStripeSignature(bytes,header,secret,now=Math.floor(Date.now()/1000)){if(!secret||typeof header!=='string')return false;const values=header.split(',').map(x=>x.split('=')),timestamp=values.find(x=>x[0]==='t')?.[1];if(!timestamp||!/^\d+$/.test(timestamp)||!Number.isSafeInteger(Number(timestamp))||!Number.isFinite(now)||Math.abs(now-Number(timestamp))>300)return false;const expected=createHmac('sha256',secret).update(timestamp+'.').update(bytes).digest('hex');return values.filter(x=>x[0]==='v1').some(x=>/^[a-f0-9]{64}$/.test(x[1])&&timingSafeEqual(Buffer.from(x[1]),Buffer.from(expected)));}
export const billingConfigured=Boolean(process.env.STRIPE_SECRET_KEY&&process.env.STRIPE_PRICE_ID&&process.env.STRIPE_WEBHOOK_SECRET&&process.env.PUBLIC_BASE_URL?.startsWith('https://'));
export async function checkout(user){if(!billingConfigured)throw Object.assign(new Error('Subscription billing is not configured. No payment has been created.'),{status:503});const base=process.env.PUBLIC_BASE_URL;const form=new URLSearchParams({mode:'subscription','line_items[0][price]':process.env.STRIPE_PRICE_ID,'line_items[0][quantity]':'1',client_reference_id:user.id,'metadata[userId]':user.id,'subscription_data[metadata][userId]':user.id,customer_email:user.email,success_url:new URL('/?billing=success',base).href,cancel_url:new URL('/?billing=cancelled',base).href});const response=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{Authorization:`Bearer ${process.env.STRIPE_SECRET_KEY}`,'Content-Type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(15000)});const data=await response.json();if(!response.ok)throw Object.assign(new Error('Checkout creation failed.'),{status:502});if(!/^https:\/\/checkout\.stripe\.com\//.test(data.url||''))throw new Error('Unexpected checkout response');return{url:data.url,id:data.id};}
export async function applyBillingEvent(accounts,event){
 if(!event.id||typeof event.id!=='string'||!Number.isSafeInteger(event.created)||event.created<0)throw Object.assign(new Error('Invalid billing event.'),{status:400});
 if(accounts.state.billingEvents[event.id])return{duplicate:true};
 const obj=event.data?.object,userId=obj?.metadata?.userId||obj?.client_reference_id,user=accounts.state.users[userId];
 const relevant=['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].includes(event.type);
 if(user&&obj){
  const identity=relevant?obj.id:obj.subscription;
  const watermark=user.billingUpdatedAt??-1;
  const sameSubscription=user.subscription?.id===identity;
  const stale=event.created<watermark;
  if(!stale&&event.type==='checkout.session.completed'&&obj.mode==='subscription'){
   // Checkout is not proof of payment. It also cannot undo verified subscription state.
   if(!sameSubscription&&!user.subscription?.active){user.stripeCustomer=obj.customer;user.subscription={id:identity,status:'pending-verification',active:false};user.billingUpdatedAt=event.created;}
  }else if(!stale&&relevant){
   // An equal-time event for another subscription cannot replace the current identity.
   const terminalAtSameTime=event.created===watermark&&['canceled','incomplete_expired'].includes(user.subscription?.status)&&['active','trialing'].includes(obj.status);
   if(!terminalAtSameTime&&(event.created>watermark||sameSubscription||!user.subscription)){
    const active=event.type!=='customer.subscription.deleted'&&['active','trialing'].includes(obj.status)&&obj.items?.data?.some(item=>item.price?.id===process.env.STRIPE_PRICE_ID);
    user.stripeCustomer=obj.customer;user.subscription={id:obj.id,status:obj.status,active:Boolean(active),updatedAt:new Date().toISOString()};user.billingUpdatedAt=event.created;
   }
  }
 }
 accounts.state.billingEvents[event.id]=Date.now();await accounts.save();return{received:true};
}
