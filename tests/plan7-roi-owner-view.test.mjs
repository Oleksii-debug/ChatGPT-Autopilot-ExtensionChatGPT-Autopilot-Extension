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
    observedRunCount:0,verifiedOutcomeCount:0,
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
    observedRunCount:2,verifiedOutcomeCount:2,observedOwnerAttentionSeconds:600,
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
    status:'EVIDENCE_BACKED',statusText:'Докази', observedRunCount:2, verifiedOutcomeCount:2,
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

test('owner ROI view rejects contradictory provenance populations and inverted savings without DOM mutation', () => {
  const root = container();
  renderRoiOwnerViewV1(root, base());
  const existing = root.children[0];
  const regular = {
    status: 'PARTIAL_EVIDENCE', observedRunCount: 2, verifiedOutcomeCount: 1,
    opportunities: [{
      workflowClassId: 'workflow.test', verifiedManualOccurrenceCount: 2,
      supportingRunCount: 2, policyOrExecutionAuthorized: false,
    }],
  };
  const wrong = [
    { ...regular, opportunities: [{ ...regular.opportunities[0], verifiedManualOccurrenceCount: 3 }] },
    { ...regular, opportunities: [{ ...regular.opportunities[0], supportingRunCount: 3 }] },
    { ...regular, netOwnerTimeLowerSeconds: 20, netOwnerTimeUpperSeconds: 10 },
    { ...regular, estimatedOwnerTimeAvoidedSeconds: { lower: 500, upper: 300 } },
    { ...regular, estimatedOwnerTimeAvoidedSeconds: { lower: '0', upper: 300 } },
    { ...regular, noComparableModelEvidence: false },
  ];
  let getterCalls = 0;
  const hostileInterval = { lower: 0 };
  Object.defineProperty(hostileInterval, 'upper', {
    enumerable: true, get() { getterCalls += 1; return 4; },
  });
  wrong.push({ ...regular, estimatedOwnerTimeAvoidedSeconds: hostileInterval });
  for (const candidate of wrong) {
    assert.throws(() => renderRoiOwnerViewV1(root, base(candidate)));
    assert.equal(root.children[0], existing, 'invalid evidence must not change semantic owner view');
  }
  assert.equal(getterCalls, 0, 'hostile nested metrics must not execute accessors');
});

test('valid bounded ROI intervals and evidence populations preserve semantic status', () => {
  const root = container();
  renderRoiOwnerViewV1(root, base({
    status: 'PARTIAL_EVIDENCE', observedRunCount: 3, verifiedOutcomeCount: 2,
    observedOwnerAttentionSeconds: 60,
    estimatedOwnerTimeAvoidedSeconds: { lower: 0, upper: 120 },
    netOwnerTimeLowerSeconds: -60, netOwnerTimeUpperSeconds: 60,
    noComparableModelEvidence: true,
    opportunities: [{ workflowClassId: 'workflow.valid',
      verifiedManualOccurrenceCount: 2, supportingRunCount: 3,
      policyOrExecutionAuthorized: false }],
  }));
  const nodes = walk(root);
  assert.equal(nodes.filter(x => x.tagName === 'TH' && x.attributes.scope === 'row').length, 1);
  assert.equal(nodes.find(x => x.attributes.role === 'status').attributes['aria-live'], 'polite');
});
