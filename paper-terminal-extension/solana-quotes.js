// Read-only launch quotes: no signing, wallet access or transaction submission.
// Aggregators can lag new mints. Resolve a Pump curve/mint from chain state,
// then read mint + virtual reserves together at processed commitment.
(() => {
  const A=globalThis.SolanaAccounts;
  const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const TOKEN2022='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  const endpoints=['https://solana-rpc.publicnode.com','https://api.mainnet.solana.com'];
  const cooldown=new Map(),identities=new Map(),slots=new Map(),pending=new Map();
  let sequence=0;
  async function rpcAt(endpoint,method,params){
    const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',signal:AbortSignal.timeout(2200),body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params})});
    if(!response.ok)throw new Error(`RPC ${response.status}`);
    const data=await response.json();if(data.error || !Object.hasOwn(data,'result'))throw new Error(data.error?.message || 'RPC unavailable');
    return data.result;
  }
  async function withRpc(run, race = false){
    const ordered=[...endpoints].sort((a,b)=>(cooldown.get(a)||0)-(cooldown.get(b)||0));let failure;
    if(race)return Promise.any(ordered.map(async endpoint=>{
      try { const result=await run((method,params)=>rpcAt(endpoint,method,params));cooldown.delete(endpoint);return result; }
      catch(error){cooldown.set(endpoint,Date.now()+15000);throw error;}
    }));
    for(const endpoint of ordered){try{const result=await run((method,params)=>rpcAt(endpoint,method,params));cooldown.delete(endpoint);return result;}catch(error){failure=error;cooldown.set(endpoint,Date.now()+15000);}}
    throw failure || new Error('Launch quote unavailable.');
  }
  const bytes=account=>account?.data?.[1]==='base64'?A.bytesFromBase64(account.data[0]):null;
  function mintFacts(account){
    const data=bytes(account);
    const valid=account?.owner===TOKEN?data?.length===82:account?.owner===TOKEN2022&&(data?.length===82 || (data?.length>165&&data[165]===1));
    if(!valid || data[45]!==1)return null;
    const facts=A.decodeMint(data);if(!facts || facts.decimals>30 || !(facts.supply>0))return null;
    return {decimals:facts.decimals,supply:facts.supply/10**facts.decimals};
  }
  async function curveData(account){
    const data=bytes(account);
    if(account?.owner!==A.PUMP_PROGRAM || !data || data.length<49 || data[48]!==0)return null;
    const expected=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('account:BondingCurve'))).slice(0,8);
    if(!expected.every((v,i)=>data[i]===v))return null;
    // Classic SOL curves: optional creator + mayhem/cashback flags, followed
    // by zero/default quote-mint padding. Do not price an unknown/USDC quote
    // extension as SOL. Appended nonzero data requires its own decoder.
    if(data.length>83 && data.slice(83).some(value=>value!==0))return null;
    const virtualToken=A.readU64(data,8),virtualQuote=A.readU64(data,16);
    return virtualToken>0&&virtualQuote>0?{virtualToken,virtualQuote}:null;
  }
  async function resolve(address,hint,rpc){
    const known=identities.get(address);if(known && Date.now()-known.at<60000)return known;
    const config={encoding:'base64',commitment:'processed'};
    const initial=await rpc('getAccountInfo',[address,config]);
    let mint,curve;
    if(mintFacts(initial?.value)){mint=address;curve=await A.derivePumpCurve(mint);}
    else if(initial?.value?.owner===A.PUMP_PROGRAM){
      curve=address;
      if(A.b58decode(hint) && await A.derivePumpCurve(hint)===curve)mint=hint;
      if(!mint){
        // Curve addresses do not encode their mint. Read owned token accounts
        // and verify the PDA, so a pool id is never sent as a mint supply key.
        for(const programId of [TOKEN,TOKEN2022]){
          const owned=await rpc('getTokenAccountsByOwner',[curve,{programId},{encoding:'jsonParsed',commitment:'processed'}]);
          const candidates=[...new Set((owned?.value||[]).slice(0,32).map(item=>item.account?.data?.parsed?.info?.mint).filter(Boolean))];
          for(const candidate of candidates)if(await A.derivePumpCurve(candidate)===curve){mint=candidate;break;}
          if(mint)break;
        }
      }
    }
    if(!mint || !curve)throw new Error('No supported launch curve for this token.');
    const result={mint,curve,at:Date.now()};identities.set(address,result);identities.set(mint,result);identities.set(curve,result);
    if(identities.size>600)identities.delete(identities.keys().next().value);
    return result;
  }
  async function quote(address,hint,solPrice){
    if(!A.b58decode(address) || !(solPrice>0))throw new Error('Valid mint and SOL price required.');
    const key=`${address}:${solPrice}`;if(pending.has(key))return pending.get(key);
    const request=withRpc(async rpc=>{
      const {mint,curve}=await resolve(address,hint,rpc);
      const data=await rpc('getMultipleAccounts',[[mint,curve],{encoding:'base64',commitment:'processed'}]);
      const slot=Number(data?.context?.slot),held=slots.get(mint),facts=mintFacts(data?.value?.[0]),reserves=await curveData(data?.value?.[1]);
      if(!facts || !reserves || !(slot>0) || slot<(held?.slot||0) || (slot===held?.slot && Date.now()-held.at>5000))throw new Error('Fresh launch reserves unavailable.');
      if(slot!==held?.slot)slots.set(mint,{slot,at:Date.now()});
      const native=(reserves.virtualQuote/1e9)/(reserves.virtualToken/10**facts.decimals),price=native*solPrice;
      if(!(price>0) || !Number.isFinite(price))throw new Error('Invalid launch price.');
      return {chainId:'solana',baseToken:{address:mint},pairAddress:curve,priceUsd:String(price),priceNative:String(native),marketCap:price*facts.supply,fdv:price*facts.supply,supply:facts.supply,source:'onchain',slot,observedAt:Date.now()};
    });
    pending.set(key,request);try{return await request;}finally{pending.delete(key);}
  }
  async function supply(mint){
    if(!A.b58decode(mint))throw new Error('Invalid mint.');
    return withRpc(async rpc=>{
      const data=await rpc('getTokenSupply',[mint,{commitment:'processed'}]),value=data?.value;
      if(!/^\d{1,60}$/.test(value?.amount||'') || !Number.isInteger(value.decimals) || value.decimals<0 || value.decimals>30)throw new Error('Mint supply unavailable.');
      const supply=Number(value.amount)/10**value.decimals;if(!(supply>0)||!Number.isFinite(supply))throw new Error('Empty mint supply.');
      return {ok:true,mint,supply,observedAt:Date.now()};
    },true);
  }
  globalThis.SolanaQuotes={quote,supply};
})();
