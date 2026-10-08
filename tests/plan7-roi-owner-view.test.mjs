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
    reportId: overrides.status && overrides.status !== 'OFFLINE' ? 'roi-report-1' : null,
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
  assert.equal(nodes.filter(x=>x.tagName==='DT').length,10);
  assert.equal(nodes.filter(x=>x.tagName==='DD').length,10);
  assert.ok(nodes.some(x=>x.textContent === 'Джерело показників: звіт roi-report-1'));
  assert.ok(nodes.some(x=>x.textContent === 'Час роботи, мілісекунд'));
  assert.ok(nodes.some(x=>x.textContent === 'Оцінена економія, нижня межа, секунд'));
  assert.equal(nodes.find(x=>x.tagName==='CAPTION').textContent,'Дорадчі можливості за робочим процесом');
  assert.equal(nodes.filter(x=>x.tagName==='TH'&&x.attributes.scope==='col').length,3);
  assert.equal(nodes.filter(x=>x.tagName==='TH'&&x.attributes.scope==='row').length,1);
  assert.ok(nodes.some(x=>x.textContent==='-600'));
  assert.ok(nodes.some(x=>x.textContent.includes('Запуску немає.')));
});

test('markup-like workflow identifiers fail closed before accessible DOM mutation',()=>{
  const root=container();
  renderRoiOwnerViewV1(root,base());
  const previous=root.children[0];
  assert.throws(()=>renderRoiOwnerViewV1(root,base({
    status:'EVIDENCE_BACKED',statusText:'Докази', observedRunCount:2, verifiedOutcomeCount:2,
    opportunities:[{workflowClassId:'<script>alert(1)</script>',
      verifiedManualOccurrenceCount:2,policyOrExecutionAuthorized:false}],
  })),/Untrusted ROI opportunity/u);
  assert.equal(root.children[0],previous);
  const nodes=walk(root);
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
    { ...regular, runtimeMs: -1 },
    { ...regular, runtimeMs: '500' },
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
  assert.ok(nodes.some(x => x.textContent === '120'), 'upper estimated bound is announced');
  assert.ok(nodes.some(x => x.textContent === '0'), 'lower estimated bound is announced');
  assert.equal(nodes.filter(x => x.tagName === 'TH' && x.attributes.scope === 'row').length, 1);
  assert.equal(nodes.find(x => x.attributes.role === 'status').attributes['aria-live'], 'polite');
});

test('ROI prevents duplicated workflow identities and cross-row run overcount before DOM mutation', () => {
  const root = container();
  renderRoiOwnerViewV1(root, base());
  const previous = root.children[0];
  const row = (workflowClassId, manual = 2, supporting = 2) => ({
    workflowClassId, verifiedManualOccurrenceCount: manual,
    supportingRunCount: supporting, policyOrExecutionAuthorized: false,
  });
  const variants = [
    [row('workflow.alpha'), row('workflow.alpha', 1, 1)],
    [row('workflow.alpha'), row('workflow.beta')],
    [row('workflow.alpha', 1, 2), row('workflow.beta', 1, 2)],
    [row('workflow.alpha', 2, 1)],
  ];
  for (const opportunities of variants) {
    assert.throws(() => renderRoiOwnerViewV1(root, base({
      status: 'EVIDENCE_BACKED', observedRunCount: 3, verifiedOutcomeCount: 2,
      opportunities,
    })), /duplicates workflow|double-counts canonical runs|exceed observed evidence/u);
    assert.equal(root.children[0], previous,
      'forged aggregates must not replace the previous accessible owner view');
  }
  renderRoiOwnerViewV1(root, base({
    status: 'EVIDENCE_BACKED', observedRunCount: 3, verifiedOutcomeCount: 2,
    opportunities: [row('workflow.alpha', 1, 1), row('workflow.beta', 2, 2)],
  }));
  const rendered = walk(root);
  assert.equal(rendered.filter(node => node.tagName === 'TH'
    && node.attributes.scope === 'row').length, 2);
  assert.equal(rendered.some(node => node.attributes.role === 'status'), true);
});


test('ROI status must reflect canonical report identity and run population before NVDA DOM mutation', () => {
  const root = container();
  renderRoiOwnerViewV1(root, base());
  const previous = root.children[0];
  const forged = [
    base({ status:'PARTIAL_EVIDENCE', observedRunCount:0 }),
    base({ status:'EVIDENCE_BACKED', observedRunCount:0 }),
    base({ status:'EVIDENCE_BACKED', observedRunCount:2, reportId:null }),
    base({ status:'EVIDENCE_BACKED', observedRunCount:2, reportId:' report-1' }),
    base({ status:'EVIDENCE_BACKED', observedRunCount:2, reportId:'report<script>' }),
    base({ status:'INSUFFICIENT_EVIDENCE', reportId:null }),
    base({ status:'OFFLINE', reportId:'prior-report' }),
    base({ status:'OFFLINE', observedRunCount:1 }),
    base({ status:'OFFLINE', verifiedOutcomeCount:1, observedRunCount:1 }),
    base({ status:'OFFLINE', machineSpendUsdMicros:100 }),
    base({ status:'OFFLINE', estimatedOwnerTimeAvoidedSeconds:{ lower:0, upper:10 } }),
  ];
  for (const candidate of forged) {
    assert.throws(() => renderRoiOwnerViewV1(root,candidate),
      /status contradicts|offline evidence|outcome counters/u);
    assert.equal(root.children[0], previous,
      'contradictory or cached ROI status must not replace previous live region');
  }
  renderRoiOwnerViewV1(root, base({
    status:'PARTIAL_EVIDENCE', observedRunCount:1, reportId:'report-1',
  }));
  assert.equal(walk(root).some(n => n.attributes.role === 'status'), true);
  renderRoiOwnerViewV1(root, base({
    status:'INSUFFICIENT_EVIDENCE', reportId:'report-no-results',
  }));
  assert.equal(walk(root).some(n => n.tagName === 'TABLE'), false);
});


test('validated nested ROI interval never re-reads an attacker-controlled Proxy while rendering', () => {
  let rawPropertyReads = 0;
  const interval = new Proxy({ lower: 0, upper: 120 }, {
    get() {
      rawPropertyReads += 1;
      throw new Error('UNTRUSTED_ROI_PROPERTY_GET');
    },
  });
  const root = container();
  renderRoiOwnerViewV1(root, base({
    status: 'PARTIAL_EVIDENCE',
    observedRunCount: 2,
    verifiedOutcomeCount: 1,
    estimatedOwnerTimeAvoidedSeconds: interval,
    opportunities: [],
  }));
  const nodes = walk(root);
  assert.equal(rawPropertyReads, 0,
    'descriptor validation must snapshot nested metrics for later rendering');
  assert.ok(nodes.some(node => node.tagName === 'DD' && node.textContent === '120'),
    'upper bound comes from validated snapshot');
  assert.ok(nodes.some(node => node.tagName === 'DD' && node.textContent === '0'),
    'lower bound comes from validated snapshot');
  assert.equal(nodes.find(node => node.attributes.role === 'status').attributes['aria-live'], 'polite');
});


test('Plan 7 ROI degraded NVDA copy never claims computed verified savings', () => {
  for (const [state, expected] of [
    ['OFFLINE', 'Локальна оцінка недоступна'],
    ['INSUFFICIENT_EVIDENCE', 'Доказів недостатньо для обчислення економії часу'],
  ]) {
    const root = container();
    renderRoiOwnerViewV1(root, base({ status: state }));
    const nodes = walk(root);
    const explanatory = nodes.filter(node => node.tagName === 'P').map(node => node.textContent);
    assert.ok(explanatory.some(value => value.includes(expected)));
    assert.equal(explanatory.some(value => value.includes('Показники обчислено з перевірених записів')), false);
    assert.ok(nodes.some(node => node.attributes.role === 'status'), 'keyboard/NVDA state must remain semantic');
    assert.equal(nodes.some(node => node.tagName === 'TABLE'), false, 'degraded state must not show saved economics');
  }
  const verified = container();
  renderRoiOwnerViewV1(verified, base({ status: 'EVIDENCE_BACKED', observedRunCount: 1 }));
  assert.ok(walk(verified).some(node => node.textContent.includes('Показники обчислено з перевірених записів')));
});
