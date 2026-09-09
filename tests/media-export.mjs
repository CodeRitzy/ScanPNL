// Production export lifecycle with controlled codecs, timers and capture tracks.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../paper-terminal-extension/pnl-cards.js',import.meta.url),'utf8');
let count=0;async function test(name,run){await run();count++;console.log('PASS '+name);}
function fixture(mode='ok'){
 const timers=new Map(),frames=new Map(),drawn=[];let seq=0,stopped=0,decoderClosed=0,frameClosed=0;
 class Recorder{static isTypeSupported(){return mode!=='unsupported';}constructor(){this.state='inactive';if(mode==='constructor')throw Error('codec');}start(){if(mode==='start')throw Error('codec');this.state='recording';}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['frame'])});this.onstop?.();}}
 class Decoder{static async isTypeSupported(){return true;}constructor(){this.tracks={ready:Promise.resolve(),selectedTrack:{frameCount:3}};}async decode({frameIndex}){return {image:{displayWidth:12,displayHeight:8,duration:50000,index:frameIndex,close(){frameClosed++;}}};}close(){decoderClosed++;}}
 const ctx={Blob,AbortController,console,MediaRecorder:Recorder,ImageDecoder:Decoder,performance:{now:()=>0},setTimeout(fn){const id=++seq;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),requestAnimationFrame(fn){const id=++seq;frames.set(id,fn);return id;},cancelAnimationFrame:id=>frames.delete(id),document:{createElement(){return {getContext:()=>({drawImage:image=>drawn.push(image.index)})};}}};
 vm.createContext(ctx);vm.runInContext(source,ctx);
 return {api:ctx.PnlCards,timers,frames,drawn,canvas:{captureStream(){return {getTracks:()=>[{stop(){stopped++;}}]};}},stopped:()=>stopped,decoderClosed:()=>decoderClosed,frameClosed:()=>frameClosed,async timer(){const [id,fn]=timers.entries().next().value;timers.delete(id);await fn();}};
}
await test('completed WebM includes data and releases capture resources',async()=>{const f=fixture(),p=f.api.record(f.canvas,()=>{});await f.timer();const blob=await p;assert.equal(blob.type,'video/webm');assert.ok(blob.size);assert.equal(f.stopped(),1);assert.equal(f.frames.size,0);});
await test('closing a card aborts recording without leaving capture active',async()=>{const f=fixture(),a=new AbortController(),p=f.api.record(f.canvas,()=>{},a.signal);a.abort();await assert.rejects(p,/cancelled/);assert.equal(f.stopped(),1);assert.equal(f.frames.size+f.timers.size,0);});
await test('already aborted export never starts a capture',async()=>{const f=fixture(),a=new AbortController();a.abort();await assert.rejects(f.api.record(f.canvas,()=>{},a.signal),/cancelled/);assert.equal(f.stopped(),0);});
await test('codec initialization and drawing failures release capture resources',async()=>{for(const mode of ['constructor','start','draw']){const f=fixture(mode);await assert.rejects(f.api.record(f.canvas,()=>{if(mode==='draw')throw Error('draw');}));assert.equal(f.stopped(),1);assert.equal(f.frames.size+f.timers.size,0);}});
await test('unsupported video codecs give an image export fallback',async()=>{const f=fixture('unsupported');await assert.rejects(f.api.record(f.canvas,()=>{}),/Choose Image/);assert.equal(f.stopped(),0);});
await test('GIF playback decodes subsequent frames and loops',async()=>{const f=fixture(),media=await f.api.loadMedia({type:'image/gif',blob:new Blob(['gif'])});assert.deepEqual(f.drawn,[0]);await media.play();await f.timer();await f.timer();await f.timer();assert.deepEqual(f.drawn,[0,1,2,0]);assert.equal(f.frameClosed(),4);media.close();assert.equal(f.timers.size,0);assert.equal(f.decoderClosed(),1);});
console.log(`${count} media export tests passed`);
