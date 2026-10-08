import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRoiOwnerViewV1 } from '../src/ui/roi-owner-view.js';

class FakeNode {
  constructor(tag) {
    this.tagName=tag.toUpperCase();this.id='';this.textContent='';this.attributes={};
    this.children=[];this.ownerDocument=null;
  }
  setAttribute(name,value){this.attributes[name]=value;}
  appendChild(node){this.children.push(node);}
  replaceChildren(...nodes){this.children=nodes;}
}
const doc={createElement(tag){return new FakeNode(tag);}};
function container(){const node=new FakeNode('div');node.id='roi-panel';node.ownerDocument=doc;return node;}
function base(overrides={}){
  return {
    schemaVersion:1,status:'OFFLINE',statusText:'Офлайн: немає нових даних',
    opportunities:[],deploymentAuthorized:false,
    ...overrides,
  };
}
function walk(node){return [node,...node.children.flatMap(walk)];}

test('offline status has heading, landmark and polite live region, with no invented metrics',()=>{
  const root=container();
  renderRoiOwnerViewV1(root,base());
  const nodes=walk(root);
  assert.equal(nodes.find(x=>x.tagName==='SECTION').attributes['aria-labelledby'],'roi-panel-heading');
  assert.equal(nodes.find(x=>x.tagName==='H2').textContent,'Економія часу та можливості автоматизації');
  const status=nodes.find(x=>x.attributes.role==='status');
  assert.equal(status.attributes['aria-live'],'polite');
  assert.equal(status.attributes['aria-atomic'],'true');
  assert.equal(nodes.some(x=>x.tagName==='TABLE'),false);
});

test('accessible view exposes text-only trusted metrics and semantic table header scopes',()=>{
  const root=container();
  const item={
    workflowClassId:'workflow.invoice-review',
    verifiedManualOccurrenceCount:2,
    policyOrExecutionAuthorized:false,
  };
  renderRoiOwnerViewV1(root,base({
    status:'PARTIAL_EVIDENCE',statusText:'Часткові докази',
    verifiedOutcomeCount:2,observedOwnerAttentionSeconds:600,
    observedOwnerTimeAvoidedSeconds:0,netOwnerTimeLowerSeconds:-600,
    netOwnerTimeUpperSeconds:-600,machineSpendUsdMicros:100000,
    opportunities:[item],
  }));
  const nodes=walk(root);
  assert.equal(nodes.filter(x=>x.tagName==='DT').length,6);
  assert.equal(nodes.filter(x=>x.tagName==='DD').length,6);
  assert.equal(nodes.find(x=>x.tagName==='CAPTION').textContent,'Дорадчі можливості за робочим процесом');
  assert.equal(nodes.filter(x=>x.tagName==='TH'&&x.attributes.scope==='col').length,3);
  assert.equal(nodes.filter(x=>x.tagName==='TH'&&x.attributes.scope==='row').length,1);
  assert.ok(nodes.some(x=>x.textContent==='-600'));
  assert.ok(nodes.some(x=>x.textContent.includes('Запуску немає.')));
});

test('does not emit HTML injection or create unauthorized controls',()=>{
  const root=container();
  renderRoiOwnerViewV1(root,base({
    status:'EVIDENCE_BACKED',statusText:'Докази',
    opportunities:[{workflowClassId:'<script>alert(1)</script>',
      verifiedManualOccurrenceCount:2,policyOrExecutionAuthorized:false}],
  }));
  const nodes=walk(root);
  assert.ok(nodes.some(x=>x.textContent==='<script>alert(1)</script>'));
  assert.equal(nodes.some(x=>x.tagName==='SCRIPT'),false);
  assert.equal(nodes.some(x=>['BUTTON','INPUT','A'].includes(x.tagName)),false);
});

test('rejects a second authority or missing semantic container identity',()=>{
  assert.throws(()=>renderRoiOwnerViewV1(container(),base({deploymentAuthorized:true})),/invalid or attempts to grant/);
  const root=container();root.id='';
  assert.throws(()=>renderRoiOwnerViewV1(root,base()),/stable, named/);
  assert.throws(()=>renderRoiOwnerViewV1(container(),base({
    status:'EVIDENCE_BACKED',opportunities:[{workflowClassId:'w',verifiedManualOccurrenceCount:2,policyOrExecutionAuthorized:true}],
  })),/Untrusted ROI opportunity/);
});
