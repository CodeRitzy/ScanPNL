import fs from 'node:fs';
import assert from 'node:assert/strict';

const extension=new URL('../paper-terminal-extension/',import.meta.url);
const read=name=>fs.readFileSync(new URL(name,extension),'utf8');
const manifest=JSON.parse(read('manifest.json'));
let count=0;
const test=(name,run)=>{run();count++;console.log(`PASS ${name}`);};

test('public release is branded ScanPNL 1.0.0',()=>{
  assert.equal(manifest.name,'ScanPNL');
  assert.equal(manifest.short_name,'ScanPNL');
  assert.equal(manifest.version,'1.0.0');
  assert.equal(manifest.action.default_title,'ScanPNL');
});
test('popup banner uses the ScanPNL name and logo',()=>{
  const popup=read('popup.js');
  assert.match(popup,/<strong>ScanPNL<\/strong>/);
  assert.match(popup,/scanpnl-icon-128\.png/);
});
test('P&L card draws the logo without a ScanPNL wordmark',()=>{
  const cards=read('pnl-cards.js');
  assert.match(cards,/drawImage\(BRAND_LOGO/);
  assert.doesNotMatch(cards,/fillText\([^\n]*scanPNL/i);
});
test('Chrome icon sizes are present',()=>{
  for(const size of [16,32,48,128])assert.ok(fs.existsSync(new URL(`assets/scanpnl-icon-${size}.png`,extension)));
});

console.log(`${count} branding tests passed`);
