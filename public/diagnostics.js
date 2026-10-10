import {startTranscription} from './realtime.js';
const $=id=>document.getElementById(id);let recording,context,source,started=0,firstDraft=false;
const log=text=>{$('result').textContent+=`${((performance.now()-started)/1000).toFixed(2)}s ${text}\n`;};
$('keyfile').onchange=async()=>{const file=$('keyfile').files[0];if(file)$('host').value=(await file.text()).trim();$('keyfile').value='';};
$('start').onclick=async()=>{try{
 $('start').disabled=true;started=performance.now();firstDraft=false;$('result').textContent='';
 const language=$('language').value, response=await fetch('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:$('audio').files[0]?'Prerecorded browser verification':'Microphone browser verification',kind:'venue',visibility:'public',sourceLanguage:language,language:language==='ar'?'en':'ar'})});
 const created=await response.json();if(!response.ok)throw Error(created.error);const file=$('audio').files[0];let sourceStream;
 if(file){context=new AudioContext();await context.resume();const buffer=await context.decodeAudioData(await file.arrayBuffer());source=context.createBufferSource();source.buffer=buffer;const destination=context.createMediaStreamDestination();source.connect(destination);sourceStream=destination.stream;}
 $('listener').href=`/?room=${created.session.id}`;$('listener').hidden=false;
 recording=await startTranscription({sessionId:created.session.id,ownerToken:created.ownerToken,hostKey:$('host').value,sourceStream,sourceStart:()=>{if(source){log('Prerecorded audio started');source.onended=()=>void stop();source.start();}},onStatus:message=>{$('status').textContent=message;log(message);},onTranscript:event=>{if(!event.final){if(!firstDraft){firstDraft=true;log('First source draft');}return;}log(`${event.verified?'DOUBLE-CHECKED':'LIVE DRAFT'}: ${event.text}\n${event.segment?.translation||''}`);}});
 $('stop').disabled=false;
 }catch(error){$('status').textContent=error.message;$('start').disabled=false;await context?.close();}};
async function stop(){if(!recording)return;const current=recording;recording=null;$('stop').disabled=true;await current.stop();await context?.close();context=null;source=null;$('start').disabled=false;log('Browser test completed');}
$('stop').onclick=()=>void stop();
