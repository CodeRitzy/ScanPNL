import fs from 'node:fs';import vm from 'node:vm';import {webcrypto} from 'node:crypto';
const dir=new URL('../paper-terminal-extension/',import.meta.url);
export function loadWorker(context,suffix=''){
  Object.assign(context,{crypto:webcrypto,atob,TextEncoder,URL,URLSearchParams,setTimeout,clearTimeout});
  context.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(new URL(file,dir),'utf8'),context));
  vm.createContext(context);vm.runInContext(fs.readFileSync(new URL('background.js',dir),'utf8')+suffix,context);
}
