import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../../src/ui/options.js',import.meta.url),'utf8');
const actionSource = source.slice(source.indexOf('async function simplifiedAction(command)'), source.indexOf('async function importSimplifiedProfile'));
function harness(updateFails=false) {
  const calls=[], nodes=new Map();
  const ui={simplifiedSelectedId:'session',simplifiedSelected:{id:'session',version:3},simplifiedDirty:true};
  const context={ui,clone:structuredClone,$:id=>{if(!nodes.has(id))nodes.set(id,{textContent:''});return nodes.get(id);},
    renderSimplifiedActions(){},loadSessions:async()=>{},showSimplifiedSession(){ui.simplifiedDirty=false;},
    simplifiedFields:()=>({tabs:'open-close'}),buildSimplifiedSessionConfig:(fields,session)=>({...fields,id:session.id}),
    core:async(command,payload)=>{
      calls.push({command,payload});
      if(command==='UPDATE_SESSION' && updateFails)throw Error('configuration cannot be changed during unresolved Send');
      return {session:{id:'session',version:4,runState:command==='GET_SESSION'?'PAUSED':'RUNNING'}};
    }};
  vm.createContext(context);vm.runInContext(actionSource,context);
  return {ui,calls,nodes,action:context.simplifiedAction};
}
test('Start saves the selected open-close mode before dispatching an external execution command',async()=>{
  const h=harness();await h.action('START_SESSION');
  assert.equal(h.calls[0].command,'UPDATE_SESSION');assert.equal(h.calls[0].payload.config.tabs,'open-close');
  assert.equal(h.calls[0].payload.expectedVersion,3);assert.equal(h.calls[1].command,'START_SESSION');
});
test('an edit rejected by Core prevents Resume and preserves the unsaved mode',async()=>{
  const h=harness(true);await h.action('RESUME_SESSION');
  assert.ok(!h.calls.some(call=>call.command==='RESUME_SESSION'));assert.equal(h.ui.simplifiedDirty,true);
  assert.match(h.nodes.get('simplified-command-result').textContent,/configuration cannot be changed/);
});
