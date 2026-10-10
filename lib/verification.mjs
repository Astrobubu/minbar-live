// Enforce the browser capture contract before transmitting a clip to the API.
export function validateVerificationWav(base64,samples){
 const invalid=()=>{throw Object.assign(new Error('Expected mono PCM16 WAV at 24000 Hz matching the sample span.'),{status:400});};
 if(typeof base64!=='string'||!base64.length||base64.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))invalid();
 const bytes=Buffer.from(base64,'base64');
 if(bytes.length<44||bytes.length>1200000||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'||bytes.readUInt32LE(4)!==bytes.length-8)invalid();
 let offset=12,format=false,data=false;
 while(offset<bytes.length){
  if(offset+8>bytes.length)invalid();const type=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4),start=offset+8;
  if(start+length>bytes.length)invalid();
  if(type==='fmt '){if(format||length<16||bytes.readUInt16LE(start)!==1||bytes.readUInt16LE(start+2)!==1||bytes.readUInt32LE(start+4)!==24000||bytes.readUInt32LE(start+8)!==48000||bytes.readUInt16LE(start+12)!==2||bytes.readUInt16LE(start+14)!==16)invalid();format=true;}
  if(type==='data'){if(data||length!==samples*2)invalid();data=true;}
  offset=start+length+(length%2);
 }
 if(offset!==bytes.length||!format||!data)invalid();return bytes;
}
