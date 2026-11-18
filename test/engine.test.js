const test=require('node:test');
const assert=require('node:assert/strict');
const {optimize,opportunities}=require('../server');
test('optimizer stays within budget and supplier availability',()=>{
  const p=optimize({budget:90000});
  assert.ok(p.investment<=p.budget);
  assert.ok(p.remaining>=0);
  assert.ok(p.purchases.every(x=>x.recommended<=x.available));
});
test('zero budget yields no purchases and no spend',()=>{
  const p=optimize({budget:0});assert.equal(p.investment,0);assert.equal(p.purchases.length,0);
});
test('budget input validation is explicit',()=>assert.throws(()=>optimize({budget:-1}),/Budget/));
test('scenario changes affect computed opportunity forecast',()=>{
  const a=opportunities({demandShift:0}),b=opportunities({demandShift:.2});
  assert.ok(b[0].forecast>a[0].forecast);
});
test('higher risk tolerance admits at least as many candidate rows',()=>{
  const conservative=optimize({budget:1000000,riskTolerance:0});
  const tolerant=optimize({budget:1000000,riskTolerance:100});
  assert.ok(tolerant.purchases.length>=conservative.purchases.length);
});
