import test from 'node:test';
import assert from 'node:assert/strict';
import { createColdObserver } from '../../host/cold-observer.js';

function fixture() {
  const secret = 'SECRET-token-body';
  const agent = { id:'s', status:'idle', inbox:{ nextTurn:[{content:secret}], nextStep:[] } };
  let current = agent;
  const registry = { get: id => id === 's' ? current : undefined };
  const inspection = { meta:{ id:'s', version:4, isSeeded:false, cwd:'private-path' }, inheritedEventCount:0, events:[
    {seq:0,type:'turn/start',data:{turn:1}},
    {seq:1,type:'user/message',data:{id:'root',role:'user',source:{kind:'user'},content:secret}},
    {seq:2,type:'request/header',data:{header:{config:{provider:'p',model:'m',token:secret}}}},
    {seq:3,type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'TRANSPORT',status:503,message:secret}}}},
  ] };
  let during = () => {};
  const controller = { inspect: async (id, signal) => { assert.equal(id,'s'); await during(signal); return inspection; }, resolveAgent: () => { throw Error('side effect'); }, prompt: () => { throw Error('side effect'); } };
  const observer = createColdObserver({resolveInspection:()=>controller, resolveAgents:()=>registry});
  return { agent, registry, inspection, controller, observer, secret, replace: a=>{current=a;}, during: f=>{during=f;} };
}

test('idle/running live states, queue counts and sanitized failure facts', async () => {
  const f=fixture();
  for (const status of ['idle','running']) {
    f.agent.status=status;
    const r=await f.observer.observe('s');
    assert.equal(r.ok,true); assert.equal(r.reason,'observation_only');
    assert.deepEqual(r.agent,{state:status,queue:{nextTurn:1,nextStep:0}});
    assert.deepEqual(r.goal,{state:'unavailable'});
    assert.deepEqual(r.failure,{eligible:true,failureClass:'transient',code:'TRANSPORT',status:503,turn:1});
    assert.ok(!JSON.stringify(r).includes(f.secret)); assert.ok(!JSON.stringify(r).includes('private-path'));
  }
});
test('missing and unknown are distinct from idle', async () => {
  const f=fixture(); f.replace(undefined);
  assert.deepEqual((await f.observer.observe('s')).agent,{state:'missing',queue:null});
  f.replace({...f.agent,status:'unexpected'});
  assert.deepEqual((await f.observer.observe('s')).agent,{state:'unknown',queue:null});
});
test('replacement, status, queue and service changes fail closed', async () => {
  for (const mutate of [f=>f.replace({...f.agent}),f=>{f.agent.status='running';},f=>{f.agent.inbox.nextTurn.push({});},f=>{f.registry.get=()=>undefined;}]) {
    const f=fixture(); f.during(()=>mutate(f));
    assert.deepEqual(await f.observer.observe('s'),{ok:false,reason:'observation_changed'});
  }
  const f=fixture(); let ctrl=f.controller; f.during(()=>{ctrl={inspect:ctrl.inspect};});
  assert.deepEqual(await createColdObserver({resolveInspection:()=>ctrl,resolveAgents:()=>f.registry}).observe('s'),{ok:false,reason:'observation_changed'});
});
test('goal view is minimal, absent and throwing services are distinguished', async () => {
  const f=fixture(); let goal={phase:'active',activation:'armed',objective:f.secret};
  const service={get:()=>goal};
  const o=createColdObserver({resolveInspection:()=>f.controller,resolveAgents:()=>f.registry,resolveGoals:()=>service});
  assert.deepEqual((await o.observe('s')).goal,{state:'present',phase:'active',activation:'armed'});
  goal=undefined; assert.deepEqual((await o.observe('s')).goal,{state:'none'});
  service.get=()=>{throw Error(f.secret);}; assert.deepEqual(await o.observe('s'),{ok:false,reason:'observation_failed'});
});
test('aborts, getters, rejected inspection and mismatched target fail closed', async () => {
  let f=fixture(); const abort=new AbortController(); f.during(()=>abort.abort());
  assert.deepEqual(await f.observer.observe('s',abort.signal),{ok:false,reason:'cancelled'});
  f=fixture(); Object.defineProperty(f.controller,'inspect',{get(){throw Error(f.secret);}});
  assert.deepEqual(await f.observer.observe('s'),{ok:false,reason:'observation_failed'});
  f=fixture(); f.during(()=>{throw Error(f.secret);}); assert.deepEqual(await f.observer.observe('s'),{ok:false,reason:'observation_failed'});
  f=fixture(); f.inspection.meta.id='other'; assert.deepEqual((await f.observer.observe('s')).failure,{eligible:false,reason:'identity_unverified'});
});
test('no mutations, activations, inbox operations or extra session inspections', async () => {
  const f=fixture(); const before=JSON.stringify(f.inspection); const inbox=JSON.stringify(f.agent.inbox);
  for (const k of ['clear','append','prepend','remove','replace','splice']) f.agent.inbox[k]=()=>{throw Error('mutation');};
  const r=await f.observer.observe('s'); assert.equal(r.ok,true);
  assert.equal(JSON.stringify(f.inspection),before); assert.equal(JSON.stringify(f.agent.inbox),inbox);
});
