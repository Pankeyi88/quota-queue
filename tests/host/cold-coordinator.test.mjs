import test from 'node:test';
import assert from 'node:assert/strict';
import { createColdCoordinator } from '../../host/cold-coordinator.js';

const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise,resolve}; };
function fixture(code='QUOTA', status=429) {
 const inspection = {meta:{id:'s',version:4,isSeeded:false,cwd:'E:/work'},inheritedEventCount:0,events:[
  {seq:0,type:'turn/start',data:{turn:1}},
  {seq:1,type:'user/message',data:{id:'root',role:'user',source:{kind:'user'}}},
  {seq:2,type:'request/header',data:{header:{config:{provider:'p',model:'m'}}}},
  {seq:3,type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code,status}}}},
 ]};
 let saved=null, active=false; const sends=[], phases=[], waits=[], quarantines=[];
 const ports={
  withLease:async (_,fn)=>{ if(active) throw Error('busy'); active=true; try{return await fn();}finally{active=false;} },
  readInspection:async()=>({inspection:structuredClone(inspection),snapshotSeq:inspection.events.length-1}),
  check:async ({identity,phase})=>{ phases.push(phase); return {identity,revision:'v1',authorized:true,failureBound:true,stopped:true,exclusive:true,configStable:true,queueClear:true,notCancelled:true,ready:true}; },
  waitReady:async ({failureClass})=>{waits.push(failureClass);},
  quarantine:async event=>{quarantines.push(event); return true;},
  load:async()=>structuredClone(saved), save:async s=>{saved=structuredClone(s);},
  resolveController:()=>({prompt:async input=>{assert.equal(saved.entries[0].fenced,true); sends.push(input); return {accepted:true};}}),
 };
 return {ports,inspection,sends,phases,waits,quarantines,get saved(){return saved;}};
}
const run = (f, opts={}) => createColdCoordinator(f.ports,opts).run({sessionId:'s',workspaceId:'w',requestId:'r'});

test('quota and network use distinct readiness with fence persisted before original-session prompt',async()=>{
 for(const [code,status,category] of [['QUOTA',429,'quota'],['TIMEOUT',504,'transient'],[null,429,'rate_limit']]){
  const f=fixture(code,status); assert.deepEqual(await run(f),{kind:'accepted'}); assert.deepEqual(f.waits,[category]);
  assert.deepEqual(f.phases,['initial','before_fence','after_fence']);
  assert.equal(f.sends.length,1); assert.equal(f.sends[0].sessionId,'s'); assert.equal(f.sends[0].requestId,'r');
  assert.equal(f.sends[0].mode,'queue'); assert.deepEqual(f.sends[0].content,[{type:'text',text:'继续'}]);
 }
});

test('missing attestations, changed revision or binding fail closed',async()=>{
 for(const field of ['authorized','failureBound','stopped','exclusive','configStable','queueClear','notCancelled','ready','revision','identity']){
  const f=fixture(), original=f.ports.check; f.ports.check=async x=>{const a=await original(x); if(x.phase==='before_fence') delete a[field]; return a;};
  assert.equal((await run(f)).kind,'closed',field); assert.equal(f.sends.length,0);
 }
 const f=fixture(), original=f.ports.check; f.ports.check=async x=>({...await original(x),revision:x.phase==='initial'?'a':'b'});
 assert.equal((await run(f)).kind,'closed'); assert.equal(f.sends.length,0);
});

test('failed recheck after durable claim remains fenced, including later restart',async()=>{
 const f=fixture(), original=f.ports.check; f.ports.check=async x=>({...await original(x),stopped:x.phase!=='after_fence'});
 assert.equal((await run(f)).kind,'unknown'); assert.equal(f.saved.entries[0].fenced,true); assert.equal(f.sends.length,0);
 f.ports.check=original; assert.equal((await run(f)).kind,'closed'); assert.equal(f.sends.length,0);
});

test('user input and config changes during readiness are detected',async()=>{
 for(const change of [f=>{f.inspection.events.push({seq:4,type:'user/message',data:{id:'new',role:'user',source:{kind:'user'}}});},
  f=>{f.inspection.events[2].data.header.config.model='changed';}]){
  const f=fixture(); f.ports.waitReady=async()=>change(f); assert.equal((await run(f)).kind,'closed'); assert.equal(f.sends.length,0);
 }
});

test('manual stop and competing inbox are rejected',async()=>{
 const f=fixture('ABORTED',undefined); assert.equal((await run(f)).kind,'closed');
 const g=fixture(); g.inspection.events.push({seq:4,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,inserted:[{id:'q',role:'user',source:{kind:'user'},content:[{type:'text',text:'new'}]}]}});
 assert.equal((await run(g)).kind,'closed'); assert.equal(g.sends.length,0);
});

test('cancel during pending durable save revokes before send',async()=>{
 const f=fixture(), entered=deferred(), release=deferred(), save=f.ports.save;
 f.ports.save=async s=>{entered.resolve(); await release.promise; await save(s);};
 const c=createColdCoordinator(f.ports), p=c.run({sessionId:'s',workspaceId:'w',requestId:'r'});
 await entered.promise; await c.cancel(); assert.equal((await p).kind,'cancelled'); release.resolve();
 await new Promise(r=>setImmediate(r)); assert.equal(f.sends.length,0); assert.equal(f.saved.entries[0].fenced,true);
});

test('one lease excludes concurrent coordinator instances',async()=>{
 const f=fixture(), entered=deferred(), release=deferred(); f.ports.waitReady=async()=>{entered.resolve(); await release.promise;};
 const one=run(f), two=()=>run(f); await entered.promise; assert.equal((await two()).kind,'closed'); release.resolve();
 assert.equal((await one).kind,'accepted'); assert.equal(f.sends.length,1);
});

test('timeout aborts wait and prevents a late send; lease remains until work ends',async()=>{
 const f=fixture(), entered=deferred(), release=deferred(); f.ports.waitReady=async()=>{entered.resolve(); await release.promise;};
 const p=run(f,{timeoutMs:20}); await entered.promise; assert.equal((await p).kind,'cancelled');
 assert.equal((await run(f)).kind,'closed'); release.resolve(); await new Promise(r=>setImmediate(r)); assert.equal(f.sends.length,0);
});

test('unknown transport result remains fenced and is never retried',async()=>{
 const f=fixture(); f.ports.resolveController=()=>({prompt:async x=>{f.sends.push(x); throw Error('ambiguous');}});
 assert.equal((await run(f)).kind,'unknown'); assert.equal(f.saved.entries[0].fenced,true);
 assert.equal((await run(f)).kind,'closed'); assert.equal(f.sends.length,1);
});

test('lost claim acknowledgement quarantines and retains a durable fence',async()=>{
 const f=fixture(), save=f.ports.save; f.ports.save=async s=>{await save(s); throw Error('lost ack');};
 assert.equal((await run(f)).kind,'closed'); assert.equal(f.sends.length,0);
 assert.equal(f.saved.entries[0].fenced,true); assert.equal(f.quarantines[0].reason,'storage_unknown');
});

test('post-send status save failure is unknown and quarantined',async()=>{
 const f=fixture(), save=f.ports.save; let calls=0;
 f.ports.save=async s=>{if(++calls===2) throw Error('status write failed'); await save(s);};
 assert.equal((await run(f)).kind,'unknown'); assert.equal(f.sends.length,1);
 assert.equal(f.saved.entries[0].fenced,true); assert.equal(f.quarantines[0].reason,'delivery_unknown');
});

test('cancellation before run, while waiting, and after completion quarantines',async()=>{
 {const f=fixture(), c=createColdCoordinator(f.ports); await c.cancel();
 assert.equal((await c.run({sessionId:'s',workspaceId:'w',requestId:'r'})).kind,'cancelled');
 assert.equal(f.quarantines.length,1); assert.equal(f.sends.length,0);}
 {const f=fixture(), entered=deferred(), release=deferred(); f.ports.waitReady=async()=>{entered.resolve(); await release.promise;};
 const c=createColdCoordinator(f.ports), p=c.run({sessionId:'s',workspaceId:'w',requestId:'r'}); await entered.promise;
 await c.cancel(); assert.equal((await p).kind,'cancelled'); assert.equal(f.quarantines[0].sessionId,'s'); release.resolve();}
 {const f=fixture(), c=createColdCoordinator(f.ports); assert.equal((await c.run({sessionId:'s',workspaceId:'w',requestId:'r'})).kind,'accepted');
 await c.cancel(); assert.equal(f.quarantines[0].reason,'cancelled');}
});

test('quarantine failure is explicit and host must block future execution',async()=>{
 const f=fixture(); f.ports.quarantine=async()=>{throw Error('private');};
 f.ports.resolveController=()=>({prompt:async()=>{throw Error('ambiguous');}});
 await assert.rejects(run(f),/cold_coordinator_quarantine_failed/); assert.equal(f.saved.entries[0].fenced,true);
 const g=fixture(); g.ports.quarantine=async()=>false;
 const c=createColdCoordinator(g.ports); await c.cancel();
 await assert.rejects(c.run({sessionId:'s',workspaceId:'w',requestId:'r'}),/cold_coordinator_quarantine_failed/);
});

test('quarantine timeout fails explicitly within the bound',async()=>{
 const f=fixture(); f.ports.quarantine=()=>new Promise(()=>{}); f.ports.resolveController=()=>({prompt:async()=>{throw Error();}});
 await assert.rejects(run(f,{timeoutMs:20}),/cold_coordinator_quarantine_failed/);
});

test('synchronous wait that overruns deadline never sends',async()=>{
 const f=fixture(); f.ports.waitReady=()=>{const until=performance.now()+40; while(performance.now()<until) {}};
 assert.equal((await run(f,{timeoutMs:5})).kind,'cancelled'); assert.equal(f.sends.length,0); assert.equal(f.quarantines.length,1);
});

test('unknown prompt is quarantined before lease release and later admission stays isolated',async()=>{
 const f=fixture(), late=deferred(), start=deferred(); let isolated=false, admitted=false, released=false;
 f.ports.quarantine=async event=>{f.quarantines.push(event); isolated=true; return true;};
 const lease=f.ports.withLease; f.ports.withLease=async (x,fn)=>{try{return await lease(x,fn);}finally{released=true; assert.equal(isolated,true);}};
 f.ports.resolveController=()=>({prompt:async()=>{start.resolve(); await late.promise; admitted=true; assert.equal(isolated,true); return {accepted:true};}});
 const result=run(f,{timeoutMs:20}); await start.promise; assert.equal((await result).kind,'unknown');
 await new Promise(r=>setTimeout(r,5)); assert.equal(released,true); assert.equal(isolated,true);
 late.resolve(); await new Promise(r=>setImmediate(r)); assert.equal(admitted,true); assert.equal(isolated,true);
});
