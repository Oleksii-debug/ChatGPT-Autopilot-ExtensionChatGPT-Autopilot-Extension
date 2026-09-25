import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {McpStdioBridge} from '../companion/native-host/mcp-stdio-bridge.mjs';

const registry={schemaVersion:1,commands:[{commandId:'approved.node.helper',executable:'node.exe',fixedArgs:['server.mjs'],cwd:null,envKeys:[]}]};
function silentChild(){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin={write(text,cb){JSON.parse(text);cb?.();return true;}};child.kill=()=>child.emit('exit',0);return child;}

test('close surfaces accepted effectful invocation as reconcile-required and rejects its pending call',async()=>{
  const bridge=new McpStdioBridge({registry,spawnImpl:silentChild});
  const call=bridge.request({commandId:'approved.node.helper',method:'tools/call',invocationId:'inv-close-1',params:{},timeoutMs:500});
  await new Promise(resolve=>setImmediate(resolve));
  const result=await bridge.close({commandId:'approved.node.helper'});
  assert.deepEqual(result,{closed:true,requiresReconcile:true,unresolvedEffects:[{invocationId:'inv-close-1',effectMayHaveOccurred:true,safeToRetry:false}]});
  await assert.rejects(call,e=>e.code==='MCP_TRANSPORT_CLOSED'&&e.invocationId==='inv-close-1'&&e.effectMayHaveOccurred===true&&e.safeToRetry===false);
  assert.equal(bridge.sessions.size,0);
});

test('close of pending read-only request is safe-retry and does not invent unresolved external effect',async()=>{
  const bridge=new McpStdioBridge({registry,spawnImpl:silentChild});
  const read=bridge.request({commandId:'approved.node.helper',method:'tools/list',params:{},timeoutMs:500});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(await bridge.close({commandId:'approved.node.helper'}),{closed:true,requiresReconcile:false,unresolvedEffects:[]});
  await assert.rejects(read,e=>e.code==='MCP_TRANSPORT_CLOSED'&&e.effectMayHaveOccurred===false&&e.safeToRetry===true);
});

test('closed session is removed and a later request reconnects with a fresh child',async()=>{
  let spawned=0;
  const bridge=new McpStdioBridge({registry,spawnImpl:()=>{spawned++;const child=silentChild();child.stdin.write=(text,cb)=>{const req=JSON.parse(text);cb?.();queueMicrotask(()=>child.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{tools:[]}})+'\n'));return true;};return child;}});
  assert.deepEqual(await bridge.request({commandId:'approved.node.helper',method:'tools/list',params:{},timeoutMs:500}),{tools:[]});
  await bridge.close({commandId:'approved.node.helper'});
  assert.deepEqual(await bridge.request({commandId:'approved.node.helper',method:'tools/list',params:{},timeoutMs:500}),{tools:[]});
  assert.equal(spawned,2);
});
