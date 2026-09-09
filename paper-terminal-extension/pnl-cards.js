// Local media library and canvas exports. Uploaded originals stay in IndexedDB;
// large GIFs/videos never go into the shared account/settings storage object.
(() => {
  const PRESETS=[
    {id:'dunes',name:'Dunes',theme:'light',author:'Royce Fonseca',page:'https://unsplash.com/photos/soft-white-sand-dunes-under-a-pale-blue-sky-PhiT_BhJmvM'},
    {id:'highlands',name:'Highlands',author:'JOHN TOWNER',page:'https://unsplash.com/photos/aerial-photo-of-brown-moutains-JgOeRuGD_Y4'},
    {id:'forest',name:'Nightfall',author:'Karsten Würth',page:'https://unsplash.com/photos/flowing-river-between-tall-trees-7BjhtdogU3A'},
    {id:'mist',name:'Afterglow',author:'Alessio Soggetti',page:'https://unsplash.com/photos/view-of-mountain-PdGBci-4jR8'},
    {id:'saturn',name:'Orbit',author:'NASA',page:'https://unsplash.com/photos/saturn-and-its-rings-2W-QWAC0mzI'},
    {id:'obsidian',name:'Obsidian',author:'Alexander Grey',page:'https://unsplash.com/photos/purple-bubbles-on-liquid-om4O_x_qWD8'},
  ].map(p=>({...p,url:`assets/backgrounds/${p.id}.jpg`,type:'image/jpeg'}));
  const PREFS='paperTerminalCardPrefs';
  const BRAND_LOGO=(()=>{
    if(typeof globalThis.Image!=='function')return null;
    const image=new Image();
    image.src=globalThis.chrome?.runtime?.getURL?.('assets/scanpnl-icon-128.png') || 'assets/scanpnl-icon-128.png';
    return image;
  })();
  let dbPromise;
  let prefsQueue=Promise.resolve();
  function database(){return dbPromise ||= new Promise((resolve,reject)=>{const req=indexedDB.open('trade-terminal-media',1);req.onupgradeneeded=()=>req.result.createObjectStore('backgrounds',{keyPath:'id'});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
  async function store(mode,operation){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('backgrounds',mode);let result;const request=operation(tx.objectStore('backgrounds'));request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Media could not be saved.'));});}
  async function list(){return store('readonly',s=>s.getAll());}
  async function save(file){
    if(!/^(?:image\/(?:jpeg|png|webp|gif|avif)|video\/(?:mp4|webm|quicktime))$/.test(file.type))throw new Error('Choose a JPG, PNG, WebP, AVIF, GIF, MP4 or WebM file.');
    if(!file.size || file.size>100*1024*1024)throw new Error('Choose a file smaller than 100 MB.');
    const url=URL.createObjectURL(file);
    try{const media=await loadMedia({url,type:file.type,blob:file});media.pause?.();media.close?.();}finally{URL.revokeObjectURL(url);}
    const asset={id:crypto.randomUUID(),name:file.name.slice(0,100),type:file.type,blob:file,createdAt:Date.now()};
    await store('readwrite',s=>s.put(asset));return asset;
  }
  async function remove(id){return store('readwrite',s=>s.delete(id));}
  function preferences(patch){const task=async()=>{const old=(await chrome.storage.local.get(PREFS))[PREFS]||{};if(patch){const next={...old,...patch};await chrome.storage.local.set({[PREFS]:next});return next;}return old;};const result=prefsQueue.then(task,task);prefsQueue=result.catch(()=>{});return result;}
  // Canvas draws only the first frame of an HTMLImageElement GIF. Decode one
  // composited VideoFrame at a time so preview and WebM export retain motion.
  async function loadGif(asset){
    if(!globalThis.ImageDecoder || !await ImageDecoder.isTypeSupported('image/gif'))throw new Error('Animated GIFs need a newer Chrome browser. You can also use MP4 or WebM.');
    const data=await (asset.blob || await (await fetch(asset.url)).blob()).arrayBuffer();
    const decoder=new ImageDecoder({data,type:'image/gif',preferAnimation:true});
    try{
      await decoder.tracks.ready;
      const count=decoder.tracks.selectedTrack?.frameCount||1,canvas=document.createElement('canvas');
      let index=0,timer=0,running=false,closed=false,duration=100,epoch=0;
      const show=image=>{canvas.width=image.displayWidth;canvas.height=image.displayHeight;canvas.getContext('2d').drawImage(image,0,0);duration=Math.max(20,(image.duration||100000)/1000);image.close();};
      show((await decoder.decode({frameIndex:0,completeFramesOnly:true})).image);
      const next=async generation=>{try{const decoded=await decoder.decode({frameIndex:(index+1)%count,completeFramesOnly:true});if(closed||!running||generation!==epoch){decoded.image.close();return;}index=(index+1)%count;show(decoded.image);timer=setTimeout(()=>next(generation),duration);}catch{canvas.pause();}};
      canvas.play=async()=>{if(running||closed||count<2)return;running=true;const generation=++epoch;timer=setTimeout(()=>next(generation),duration);};
      canvas.pause=()=>{running=false;epoch++;clearTimeout(timer);};
      canvas.close=()=>{canvas.pause();closed=true;decoder.close();};
      return canvas;
    }catch(error){decoder.close();throw error;}
  }
  function loadMedia(asset){if(asset.type==='image/gif')return loadGif(asset);return new Promise((resolve,reject)=>{
    const video=asset.type?.startsWith('video/'),media=video?document.createElement('video'):new Image();
    const timeout=setTimeout(()=>{media.pause?.();reject(new Error('This file cannot be decoded. Try another image or an MP4/WebM video.'));},15000);
    const ready=()=>{clearTimeout(timeout);resolve(media);};
    const failed=()=>{clearTimeout(timeout);reject(new Error('This image or video format is not supported by this browser.'));};
    if(video){media.muted=true;media.loop=true;media.playsInline=true;media.preload='auto';media.onloadeddata=ready;media.onerror=failed;}else{media.onload=ready;media.onerror=failed;}
    media.src=asset.url;
  });}
  function amount(value,unit,solPrice,signed=false){const v=unit==='SOL'?value/solPrice:value;const number=Math.abs(v).toLocaleString(undefined,{maximumFractionDigits:unit==='SOL'?4:2});return `${v<0?'−':signed&&v>0?'+':''}${unit==='USD'?'$':''}${number}${unit==='SOL'?' SOL':''}`;}
  let fontPromise,loadedFont;
  async function fontStore(mode,operation){
    const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('trade-terminal-fonts',1);req.onupgradeneeded=()=>req.result.createObjectStore('fonts');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
    try{return await new Promise((resolve,reject)=>{const tx=db.transaction('fonts',mode),request=operation(tx.objectStore('fonts'));let result;request.onsuccess=()=>result=request.result;tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});}finally{db.close();}
  }
  async function activateFont(source){
    const face=await new FontFace('TerminalUnivers',source).load();
    document.fonts.add(face);if(loadedFont)document.fonts.delete(loadedFont);loadedFont=face;
    return {family:'TerminalUnivers',label:'Univers'};
  }
  async function loadFont(){return fontPromise ||= (async()=>{
    if(!globalThis.FontFace || !document.fonts)return {family:'Arial',label:'Univers unavailable'};
    try{const saved=await fontStore('readonly',s=>s.get('univers'));if(saved)return await activateFont(await saved.blob.arrayBuffer());}catch{}
    try{return await activateFont('local("Univers"), local("Univers LT Std"), local("Univers LT Std 55 Roman"), local("UniversLTStd")');}catch{return {family:'Arial',label:'Univers · upload font'};}
  })();}
  async function saveFont(file){
    if(!file?.size || file.size>10*1024*1024 || !/\.(?:otf|ttf|woff2?)$/i.test(file.name))throw new Error('Choose your Univers OTF, TTF, WOFF or WOFF2 font (up to 10 MB).');
    const data=await file.arrayBuffer(),head=new Uint8Array(data,0,Math.min(4,data.byteLength));
    const signature=String.fromCharCode(...head);
    if(!['OTTO','wOFF','wOF2'].includes(signature) && !(head[0]===0&&head[1]===1&&head[2]===0&&head[3]===0))throw new Error('This file is not a supported font.');
    // Decode before saving so a broken upload cannot replace a working font.
    const face=await new FontFace('TerminalUnivers',data).load();
    await fontStore('readwrite',s=>s.put({blob:file,name:file.name},'univers'));
    document.fonts.add(face);if(loadedFont)document.fonts.delete(loadedFont);loadedFont=face;
    const result={family:'TerminalUnivers',label:'Univers · saved'};fontPromise=Promise.resolve(result);return result;
  }
  function solMark(ctx,x,y,size,mono){
    ctx.save();const gradient=ctx.createLinearGradient(x,y+size,x+size,y);gradient.addColorStop(0,'#9945ff');gradient.addColorStop(1,'#19fb9b');ctx.fillStyle=mono||gradient;
    const polygon=points=>{ctx.beginPath();points.forEach(([a,b],i)=>i?ctx.lineTo(x+a*size,y+b*size):ctx.moveTo(x+a*size,y+b*size));ctx.closePath();ctx.fill();};
    polygon([[.18,0],[1,0],[.82,.22],[0,.22]]);polygon([[0,.34],[.82,.34],[1,.56],[.18,.56]]);polygon([[.18,.68],[1,.68],[.82,.9],[0,.9]]);ctx.restore();
  }
  function paint(canvas,media,card,{unit='SOL',solPrice=1,handle='',name='',fontFamily='Arial',theme='dark'}={}){
    const light=theme==='light',ink=light?'#1b2429':'#efeff3',muted=light?'#46545c':'#aaaab1';
    const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height,family=`"${fontFamily}", "Univers", Arial, sans-serif`;ctx.save();ctx.clearRect(0,0,w,h);ctx.fillStyle='#060608';ctx.fillRect(0,0,w,h);
    const mw=media?.videoWidth||media?.naturalWidth||media?.width,mh=media?.videoHeight||media?.naturalHeight||media?.height;
    if(mw&&mh){const scale=Math.max(w/mw,h/mh);ctx.filter=light?'none':'saturate(.3) brightness(.58)';ctx.drawImage(media,(w-mw*scale)/2,(h-mh*scale)/2,mw*scale,mh*scale);ctx.filter='none';}
    const fade=ctx.createLinearGradient(0,0,w,h*.2);fade.addColorStop(0,light?'rgba(247,248,246,.92)':'rgba(3,3,5,.96)');fade.addColorStop(.55,light?'rgba(247,248,246,.55)':'rgba(3,3,5,.77)');fade.addColorStop(1,light?'rgba(247,248,246,0)':'rgba(3,3,5,.1)');ctx.fillStyle=fade;ctx.fillRect(0,0,w,h);
    const bottom=ctx.createLinearGradient(0,h*.6,0,h);bottom.addColorStop(0,'transparent');bottom.addColorStop(1,light?'rgba(247,248,246,.55)':'rgba(3,3,5,.94)');ctx.fillStyle=bottom;ctx.fillRect(0,0,w,h);
    if(BRAND_LOGO?.complete && (BRAND_LOGO.naturalWidth || BRAND_LOGO.width))ctx.drawImage(BRAND_LOGO,w-132,48,68,68);
    const color=card.pnl<0?'#f74778':card.pnl>0?'#29dcad':'#c5c7cd';
    ctx.fillStyle=color;ctx.fillRect(64,63,34,4);ctx.fillStyle=muted;ctx.font=`500 19px ${family}`;if(card.kind)ctx.fillText(String(card.kind).toUpperCase(),112,72);
    ctx.fillStyle=ink;let titleSize=54;ctx.font=`500 ${titleSize}px ${family}`;while(ctx.measureText(card.title).width>w-128&&titleSize>28)ctx.font=`500 ${--titleSize}px ${family}`;ctx.fillText(card.title,64,149);
    const result=amount(card.pnl,unit,solPrice,true).replace(/ SOL$/,'');let resultSize=80,logoWidth=unit==='SOL'?75:0;ctx.font=`600 ${resultSize}px ${family}`;
    while(ctx.measureText(result).width+logoWidth>w-182&&resultSize>32)ctx.font=`600 ${--resultSize}px ${family}`;
    const badgeWidth=Math.min(w-128,Math.max(370,ctx.measureText(result).width+logoWidth+52));ctx.fillStyle=color;ctx.fillRect(64,193,badgeWidth,122);
    if(unit==='SOL')solMark(ctx,89,231,48,'#09090c');ctx.fillStyle='#09090c';ctx.fillText(result,89+logoWidth,283);
    ctx.font=`500 25px ${family}`;ctx.fillStyle=light?(card.pnl<0?'#ae1748':'#087459'):color;ctx.fillText(card.percent==null?'':`${card.percent>0?'+':''}${card.percent.toFixed(2)}%`,67,361);
    let y=426;const right=Math.min(w-64,640);ctx.font=`400 29px ${family}`;
    if(card.scope==='period' && Number.isFinite(card.buys)&&Number.isFinite(card.sells)){
      ctx.fillStyle=muted;ctx.fillText('Transactions',67,y);
      const sell=String(card.sells),buy=String(card.buys),slash=' / ';ctx.textAlign='right';ctx.fillStyle='#f74778';ctx.fillText(sell,right,y);const soldWidth=ctx.measureText(sell).width;ctx.fillStyle='#73737d';ctx.fillText(slash,right-soldWidth,y);ctx.fillStyle='#29dcad';ctx.fillText(buy,right-soldWidth-ctx.measureText(slash).width,y);ctx.textAlign='left';y+=58;
    }
    for(const [label,value] of (card.rows||[]).slice(0,3)){
      ctx.fillStyle=muted;ctx.fillText(label,67,y);const text=amount(value,unit,solPrice).replace(/ SOL$/,'');ctx.fillStyle=ink;ctx.textAlign='right';ctx.fillText(text,right,y);
      if(unit==='SOL')solMark(ctx,right-ctx.measureText(text).width-43,y-25,28);ctx.textAlign='left';y+=58;
    }
    ctx.fillStyle=light?'#1b242925':'#ffffff1a';ctx.fillRect(64,h-119,Math.min(576,w-128),1);
    const user=String(handle||name).trim().replace(/^@+/,'').slice(0,40);ctx.fillStyle=ink;ctx.font=`500 28px ${family}`;if(user)ctx.fillText('@'+user,64,h-65);
    ctx.restore();
  }
  function png(canvas){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Image export failed.')),'image/png'));}
  function download(blob,filename){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
  async function record(canvas,draw,signal,onProgress){
    const type=['video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'].find(type=>globalThis.MediaRecorder?.isTypeSupported(type));
    if(!type||!canvas.captureStream)throw new Error('Video export is unavailable in this browser. Choose Image to save a PNG.');
    if(signal?.aborted)throw new Error('Video export cancelled.');
    const stream=canvas.captureStream(30);let recorder;
    try{recorder=new MediaRecorder(stream,{mimeType:type,videoBitsPerSecond:6000000});}catch(error){stream.getTracks().forEach(track=>track.stop());throw error;}
    return new Promise((resolve,reject)=>{
      const chunks=[];let timer,frame,start=performance.now(),finished=false;
      const cleanup=()=>{clearTimeout(timer);cancelAnimationFrame(frame);stream.getTracks().forEach(track=>track.stop());signal?.removeEventListener('abort',abort);};
      const fail=message=>{if(finished)return;finished=true;try{if(recorder.state!=='inactive')recorder.stop();}finally{cleanup();reject(new Error(message));}};
      const abort=()=>fail('Video export cancelled.');
      recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
      recorder.onerror=()=>fail('Video export failed. Try Image instead.');
      recorder.onstop=()=>{if(finished)return;finished=true;cleanup();resolve(new Blob(chunks,{type:'video/webm'}));};
      const tick=()=>{if(finished)return;try{draw();onProgress?.(Math.min(100,(performance.now()-start)/80));frame=requestAnimationFrame(tick);}catch{fail('Video export failed. Try Image instead.');}};
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
      try{recorder.start(250);tick();if(!finished)timer=setTimeout(()=>recorder.stop(),8000);}catch{fail('Video export failed. Try Image instead.');}
    });
  }
  globalThis.PnlCards={PRESETS,list,save,remove,preferences,loadMedia,loadFont,saveFont,amount,paint,png,download,record};
})();
