import {webcrypto,createHash} from 'node:crypto';import fs from 'node:fs';import vm from 'node:vm';
const dir=new URL('../paper-terminal-extension/',import.meta.url),c={crypto:webcrypto,atob};vm.createContext(c);vm.runInContext(fs.readFileSync(new URL('solana-accounts.js',dir),'utf8'),c);
export const MINT='2JpbTe1whNrJqMAMtxBbfbmtNMEzEsFvQM35xoSAcGgg';
export const CURVE=await c.SolanaAccounts.derivePumpCurve(MINT);
export const TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',PUMP=c.SolanaAccounts.PUMP_PROGRAM;
export function fixtureAccounts({quote=30000000000n,complete=false,owner=PUMP,extension=false}={}){
 const mint=Buffer.alloc(82);mint.writeBigUInt64LE(1000000000000000n,36);mint[44]=6;mint[45]=1;
 const curve=Buffer.alloc(extension?115:83);createHash('sha256').update('account:BondingCurve').digest().copy(curve,0,0,8);curve.writeBigUInt64LE(1000000000000000n,8);curve.writeBigUInt64LE(quote,16);curve.writeBigUInt64LE(1n,24);curve.writeBigUInt64LE(1n,32);curve.writeBigUInt64LE(1000000000000000n,40);curve[48]=complete?1:0;if(extension)curve[84]=4;
 return {mint:{owner:TOKEN,data:[mint.toString('base64'),'base64']},curve:{owner,data:[curve.toString('base64'),'base64']}};
}
