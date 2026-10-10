import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderLaunchList } from '../../src/ui/launch-list.js';
import { buildSimplifiedSessionConfig } from '../../src/ui/simplified-session-config.js';
import { makeScenarioWorkProfile, parseScenarioWorkProfileDocument } from '../../src/ui/scenario-work-profile.js';

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.disabled=false;}
  append(...nodes){for(const node of nodes){node.parentNode=this;this.children.push(node);}}
  addEventListener(name,callback){this.listeners[name]=callback;}
  remove(){this.parentNode.children=this.parentNode.children.filter(value=>value!==this);}
}

test('separate launch lists open and stop their exact IDs, preserving focused buttons during progress refresh',async()=>{
  const document={createElement:tag=>new Element(tag)},simplified=new Element('ul'),scenarios=new Element('ul');
  const opened=[],stopped=[];
  const callbacks={open:async id=>opened.push(id),stop:async id=>stopped.push(id)};
  renderLaunchList(document,simplified,[{id:'simple-A',name:'A',description:'Sent: 2'}],callbacks);
  renderLaunchList(document,scenarios,[{id:'pool:B',name:'B',description:'Sent: 5'}],callbacks);
  const button=scenarios.children[0].children[1];
  renderLaunchList(document,scenarios,[{id:'pool:B',name:'B',description:'Sent: 10'}],callbacks);
  assert.equal(scenarios.children[0].children[1],button);
  await button.listeners.click();await simplified.children[0].children[2].listeners.click();
  assert.deepEqual(opened,['pool:B']);assert.deepEqual(stopped,['simple-A']);
});

test('timing spinbuttons have labels, seconds, bounded integers and form persistence/export wiring',async()=>{
  const html=await readFile(new URL('../../src/ui/options.html',import.meta.url),'utf8');
  for(const id of ['simplified-tab-ready','simplified-post-send','scenario-work-tab-ready','scenario-work-post-send','tab-ready-delay','post-send-delay']) {
    assert.match(html,new RegExp(`<label for="${id}">`));
    assert.match(html,new RegExp(`<input id="${id}" type="number" min="0" max="60" step="1"`));
  }
  const fields={mode:'shared-shared',url:'https://chatgpt.com/',prompt:'Hi',cycles:'1',interval:'1',delay:'2',busy:'2',retry:'5',tabReady:'3',postSend:'9'};
  const simple=buildSimplifiedSessionConfig(fields,null,()=> 'id');assert.equal(simple.tabReadyDelaySeconds,3);assert.equal(simple.postSendDelaySeconds,9);
  assert.throws(()=>buildSimplifiedSessionConfig({...fields,postSend:'1.5'}));
  assert.throws(()=>buildSimplifiedSessionConfig({...fields,tabReady:'61'}));
  const scenario=parseScenarioWorkProfileDocument(JSON.stringify(makeScenarioWorkProfile({steps:[{prompt:'Hi'}],tabReadyDelaySeconds:4,postSendDelaySeconds:11})));
  assert.equal(scenario.config.tabReadyDelaySeconds,4);assert.equal(scenario.config.postSendDelaySeconds,11);
});
