/** Real in-memory agent loop with an offline, scripted adapter. No persistence or network provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { correlateContinueInbox } from '../../host/continue-inbox.js';
import { correlateContinueInspection } from '../../host/continue-evidence.js';
import { correlateContinueChain } from '../../host/continue-chain.js';
import { taskIdentityFromInspection } from '../../host/task-identity.js';
import { inspectContinueFailure } from '../../host/continue-failure.js';
import { MODULE_ROOT } from './resolver.mjs';
const names = ['cordis','dsh-agent','dsh-session','dsh-llm','dsh-tools','dsh-system-prompt','dsh-session-projection','dsh-agent-loop'];
const available = names.every(n => existsSync(MODULE_ROOT + '/@deepseek-ai/' + n + '/lib/index.js'));

test('real agent events: offline simulated network failure and continuation', { skip: available ? false : 'required DSH host packages not installed', timeout: 10000 }, async () => {
  register(new URL('./resolver.mjs', import.meta.url).href, pathToFileURL(process.cwd() + '/').href);
  const { Context } = await import('@deepseek-ai/cordis');
  const llm = await import('@deepseek-ai/dsh-llm');
  const modules = await Promise.all(names.slice(1).map(n => import('@deepseek-ai/' + n)));
  const root = new Context();
  let handle;
  try {
    for (const mod of modules) await root.plugin(mod.default);
    let calls = 0;
    class OfflineAdapter extends llm.LlmAdapter {
      async *stream() { calls++; throw new llm.LlmError('synthetic network failure', 'TRANSPORT'); }
    }
    root.llm.registerAdapter(['offline-fixture'], new OfflineAdapter());
    handle = await root.agents.create({ sessionId: 'quota-offline-fixture', meta: { cwd: process.cwd() }, agentOptions: { provider: 'offline-fixture', model: 'fixture' } });
    const agent = handle.agent, session = agent.session;
    const waitEnds = async n => { for (let k=0;k<200;k++) { const events=session.snapshotEvents(); if (events.filter(e=>e.type==='turn/end').length >= n) return events; await new Promise(r=>setTimeout(r,10)); } throw Error('timed out waiting for turn/end'); };
    const message = (id, rpcId, text) => ({ id, role:'user', source:{ kind:'user', rpcId }, content:[{ type:'text', text }] });
    agent.followup(message('root-fixture','root-rpc','synthetic task'));
    const first = await waitEnds(1);
    const firstEnd = first.find(e=>e.type==='turn/end');
    assert.equal(firstEnd.data.reason.kind,'error');
    const inspection = events => ({ meta: session.header, inheritedEventCount: session.inheritedEventCount, events });
    const identity = taskIdentityFromInspection(session.id, inspection(first));
    const failed = inspectContinueFailure(session.id, inspection(first));
    assert.equal(failed.eligible, true);
    assert.equal(failed.failureClass, 'transient');
    assert.equal(failed.code, 'TRANSPORT');
    agent.followup(message('continue-fixture','continue-rpc','继续'));
    const all = await waitEnds(2);
    const ends=all.filter(e=>e.type==='turn/end');
    assert.equal(ends[1].data.reason.kind,'error');
    assert.equal(calls,2);
    const observed = correlateContinueInbox({sessionId:session.id, requestId:'continue-rpc', afterSeq:firstEnd.seq, snapshotSeq:all.at(-1).seq, inspection:inspection(all)});
    assert.equal(observed.status,'observed');
    assert.equal(observed.messageId,'continue-fixture');
    assert.equal(observed.initialPayloadMatches,true);
    const result = correlateContinueInspection({sessionId:session.id, rootMessageId:'root-fixture', generation:identity.generation, originalEndSeq:firstEnd.seq, failureTurn:firstEnd.data.turn, requestId:'continue-rpc', inspection:inspection(all)});
    assert.deepEqual(result, { status: 'failed', messageId: 'continue-fixture', turn: 2, endKind: 'error' });
    const chain = correlateContinueChain({ sessionId:session.id, rootMessageId:'root-fixture', generation:identity.generation, originalEndSeq:firstEnd.seq, failureTurn:firstEnd.data.turn, attempts:[{requestId:'continue-rpc',messageId:'continue-fixture',turn:ends[1].data.turn,endSeq:ends[1].seq}], inspection:inspection(all) });
    assert.equal(chain.verified, true);
    assert.equal(chain.latestFailureTurn, 2);
    assert.equal(chain.authorizationRequired, true);
  } finally { if (handle) await handle.dispose(); await root.fiber.dispose(); }
});

test('real agent: original failed turn can continue successfully with offline adapter', { skip: available ? false : 'required DSH host packages not installed', timeout:10000 }, async () => {
  register(new URL('./resolver.mjs', import.meta.url).href, pathToFileURL(process.cwd() + '/').href);
  const { Context } = await import('@deepseek-ai/cordis');
  const llm = await import('@deepseek-ai/dsh-llm');
  const modules = await Promise.all(names.slice(1).map(n => import('@deepseek-ai/' + n)));
  const root = new Context(); let handle;
  try {
    for (const mod of modules) await root.plugin(mod.default);
    let calls = 0;
    class OfflineAdapter extends llm.LlmAdapter {
      async *stream() {
        calls++;
        if (calls === 1) throw new llm.LlmError('synthetic network failure', 'TRANSPORT');
        yield { type:'block-start', index:0, blockType:'text' };
        yield { type:'text-delta', index:0, text:'fixture recovered' };
        yield { type:'block-end', index:0, block:{type:'text',text:'fixture recovered'} };
        yield { type:'finish', reason:{kind:'stop'} };
      }
    }
    root.llm.registerAdapter(['offline-success-fixture'], new OfflineAdapter());
    handle = await root.agents.create({ sessionId:'quota-offline-success-fixture', meta:{cwd:process.cwd()}, agentOptions:{provider:'offline-success-fixture',model:'fixture'} });
    const agent=handle.agent, session=agent.session;
    const ends=async n=>{for(let k=0;k<200;k++){const events=session.snapshotEvents();if(events.filter(e=>e.type==='turn/end').length>=n)return events;await new Promise(r=>setTimeout(r,10));}throw Error('timeout');};
    agent.followup({id:'root-success',role:'user',source:{kind:'user',rpcId:'root'},content:[{type:'text',text:'synthetic task'}]});
    const first=await ends(1); const firstEnd=first.find(e=>e.type==='turn/end');
    assert.equal(firstEnd.data.reason.kind,'error');
    const inspection=events=>({meta:session.header,inheritedEventCount:session.inheritedEventCount,events});
    const identity=taskIdentityFromInspection(session.id,inspection(first));
    agent.followup({id:'continue-success',role:'user',source:{kind:'user',rpcId:'continuation'},content:[{type:'text',text:'继续'}]});
    const all=await ends(2); const last=all.filter(e=>e.type==='turn/end').at(-1);
    assert.equal(last.data.reason.kind,'completed'); assert.equal(calls,2);
    const result=correlateContinueInspection({sessionId:session.id,rootMessageId:'root-success',generation:identity.generation,originalEndSeq:firstEnd.seq,failureTurn:firstEnd.data.turn,requestId:'continuation',inspection:inspection(all)});
    assert.deepEqual(result,{status:'completed',messageId:'continue-success',turn:2,endKind:'completed'});
    assert.ok(all.some(e=>e.type==='assistant/message'));
  } finally {if(handle)await handle.dispose();await root.fiber.dispose();}
});
