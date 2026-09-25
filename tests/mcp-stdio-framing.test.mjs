import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {McpStdioBridge} from '../companion/native-host/mcp-stdio-bridge.mjs';

const registry={schemaVersion:1,commands:[{commandId:'approved.node.helper',executable:'node.exe',fixedArgs:['server.mjs'],cwd:null,envKeys:[]}]};
function childWith(writeImpl){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin={write:(text,cb)=>writeImpl(child,text,cb)};child.kill=()=>child.emit('exit',0);return child;}
function request(bridge,extra={}){return bridge.request({commandId:'approved.node.helper',method:'tools/list',params:{},timeoutMs:500,...extra});}

test('bounded framer rejects oversized unterminated stdout before JSON parsing',async()=>{let killed=false;const bridge=new McpStdioBridge({registry,spawnImpl:()=>{const c=childWith((child,text,cb)=>{JSON.parse(text);cb?.();queueMicrotask(()=>child.stdout.write(Buffer.alloc(256001,0x61)));return true;});const kill=c.kill;c.kill=()=>{killed=true;kill();};return c;}});await assert.rejects(()=>request(bridge),e=>e.code==='MCP_TRANSPORT_CLOSED');assert.equal(killed,true);assert.equal(bridge.sessions.size,0);});

test('bounded framer rejects oversized terminated stdout',async()=>{const bridge=new McpStdioBridge({registry,spawnImpl:()=>childWith((child,text,cb)=>{JSON.parse(text);cb?.();queueMicrotask(()=>child.stdout.write(Buffer.concat([Buffer.alloc(256001,0x61),Buffer.from('\n')])));return true;})});await assert.rejects(()=>request(bridge),e=>e.code==='MCP_TRANSPORT_CLOSED');});

test('framer accepts split multibyte UTF-8 and CRLF across chunk boundaries',async()=>{const bridge=new McpStdioBridge({registry,spawnImpl:()=>childWith((child,text,cb)=>{const req=JSON.parse(text);cb?.();const wire=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{label:'€'}})+'\r\n','utf8');const euro=wire.indexOf(Buffer.from('€'));queueMicrotask(()=>{child.stdout.write(wire.subarray(0,euro+1));child.stdout.write(wire.subarray(euro+1,euro+2));child.stdout.write(wire.subarray(euro+2));});return true;})});assert.deepEqual(await request(bridge),{label:'€'});});

test('framer rejects malformed UTF-8 and embedded NUL/control corruption',async()=>{for(const bad of [Buffer.from([0xc3,0x28,0x0a]),Buffer.from('{"jsonrpc":"2.0"}\0\n'),Buffer.from('{"jsonrpc":"2.0"}\u000b\n')]){const bridge=new McpStdioBridge({registry,spawnImpl:()=>childWith((child,text,cb)=>{JSON.parse(text);cb?.();queueMicrotask(()=>child.stdout.write(bad));return true;})});await assert.rejects(()=>request(bridge),e=>e.code==='MCP_TRANSPORT_CLOSED');}});

test('framer handles multiple bounded frames in one chunk',async()=>{const bridge=new McpStdioBridge({registry,spawnImpl:()=>childWith((child,text,cb)=>{const req=JSON.parse(text);cb?.();const notification=JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{progress:1}});const response=JSON.stringify({jsonrpc:'2.0',id:req.id,result:{tools:[]}});queueMicrotask(()=>child.stdout.write(`${notification}\n${response}\n`));return true;})});assert.deepEqual(await request(bridge),{tools:[]});});

test('framing overflow preserves pending effectful invocation as ambiguous and non-retryable',async()=>{const bridge=new McpStdioBridge({registry,spawnImpl:()=>childWith((child,text,cb)=>{JSON.parse(text);cb?.();queueMicrotask(()=>child.stdout.write(Buffer.alloc(256001,0x61)));return true;})});await assert.rejects(async()=>{try{await request(bridge,{method:'tools/call',invocationId:'inv-frame-overflow'});}catch(e){assert.equal(e.code,'MCP_TRANSPORT_CLOSED');assert.equal(e.effectMayHaveOccurred,true);assert.equal(e.safeToRetry,false);assert.equal(e.invocationId,'inv-frame-overflow');throw e;}},/closed/);});
