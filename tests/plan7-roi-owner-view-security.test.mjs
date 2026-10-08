import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRoiOwnerViewV1 } from '../src/ui/roi-owner-view.js';

class FakeNode {
  constructor(tag) { this.tagName=tag.toUpperCase();this.id='';this.textContent='';this.attributes={};this.children=[];this.ownerDocument=null; }
  setAttribute(name,value){this.attributes[name]=value;}
  appendChild(node){this.children.push(node);}
  replaceChildren(...nodes){this.children=nodes;}
}
const doc={createElement(tag){return new FakeNode(tag);}};
function container() { const root=new FakeNode('div');root.id='roi-panel';root.ownerDocument=doc;return root; }
function evidence(overrides={}) {
  return {schemaVersion:1,status:'EVIDENCE_BACKED',statusText:'Локальна оцінка',
    deploymentAuthorized:false, recommendationAuthorized:false, telemetryEmitted:false,
    verifiedOutcomeCount:1,observedOwnerAttentionSeconds:10,observedOwnerTimeAvoidedSeconds:0,
    netOwnerTimeLowerSeconds:-10,netOwnerTimeUpperSeconds:0,machineSpendUsdMicros:0,
    opportunities:[],...overrides};
}
function bad(fn) { const root=container(); const old=root.children; assert.throws(()=>fn(root));assert.equal(root.children,old); }

test('adversarial: advisory getters never run and DOM remains unchanged',()=>{
  let sideEffects=0;
  const a=evidence();
  Object.defineProperty(a,'statusText',{enumerable:true,get(){ sideEffects++;return 'FORGED'; }});
  bad(root=>renderRoiOwnerViewV1(root,a));
  assert.equal(sideEffects,0);
});

test('adversarial: nested opportunity getters never run',()=>{
  let sideEffects=0;
  const row={verifiedManualOccurrenceCount:1,policyOrExecutionAuthorized:false};
  Object.defineProperty(row,'workflowClassId',{enumerable:true,get(){sideEffects++;return 'FORGED';}});
  bad(root=>renderRoiOwnerViewV1(root,evidence({opportunities:[row]})));
  assert.equal(sideEffects,0);
});

test('adversarial: sparse/accessor arrays and forged controls fail closed',()=>{
  const rows=new Array(1);
  bad(root=>renderRoiOwnerViewV1(root,evidence({opportunities:rows})));
  const accessorRows=[];
  Object.defineProperty(accessorRows,'0',{get(){throw new Error('SHOULD NOT EXECUTE');},enumerable:true});
  accessorRows.length=1;
  bad(root=>renderRoiOwnerViewV1(root,evidence({opportunities:accessorRows})));
  bad(root=>renderRoiOwnerViewV1(root,evidence({recommendationAuthorized:true})));
  bad(root=>renderRoiOwnerViewV1(root,evidence({telemetryEmitted:true})));
  bad(root=>renderRoiOwnerViewV1(root,evidence({opportunities:[{
    workflowClassId:'w',verifiedManualOccurrenceCount:1,policyOrExecutionAuthorized:false,decisionAuthorized:true,
  }]})));
});

test('adversarial: metrics reject overflow/NaN/coercion and report absent values explicitly',()=>{
  for (const amount of [Number.MAX_SAFE_INTEGER + 1,NaN,Infinity,'0',-1]) {
    bad(root=>renderRoiOwnerViewV1(root,evidence({machineSpendUsdMicros:amount})));
  }
  const root=container();
  renderRoiOwnerViewV1(root,evidence({machineSpendUsdMicros:null}));
  const all=[]; const walk=node=>{all.push(node);node.children.forEach(walk);};walk(root);
  assert.ok(all.some(node=>node.tagName==='DD'&&node.textContent==='Немає підтверджених даних'));
  assert.ok(all.some(node=>node.attributes['aria-live']==='polite'));
});

test('ROI never accepts forged model evaluation or automatic advisory promotion', () => {
  const trustedRow = {
    workflowClassId: 'workflow.safe', verifiedManualOccurrenceCount: 2,
    recurringOwnerAttentionSeconds: 15, supportingRunCount: 2,
    policyOrExecutionAuthorized: false, decisionAuthorized: false,
    advisoryPath: 'EVALUATE_DETERMINISTIC_RECIPE_OR_TOOL',
    shorterModelPath: 'NOT_EVALUATED',
  };
  const accepted = container();
  renderRoiOwnerViewV1(accepted, evidence({ opportunities: [trustedRow] }));
  assert.equal(accepted.children.length, 1);
  for (const changes of [
    { advisoryPath: 'DEPLOY' },
    { shorterModelPath: 'VERIFIED_CHEAPER_MODEL' },
    { decisionAuthorized: 'false' },
    { recurringOwnerAttentionSeconds: -1 },
    { supportingRunCount: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    bad(root => renderRoiOwnerViewV1(root,
      evidence({ opportunities: [{ ...trustedRow, ...changes }] })));
  }
});

test('ROI rejects stringified or nullable approval and telemetry flags', () => {
  for (const changes of [
    { recommendationAuthorized: 'false' },
    { recommendationAuthorized: null },
    { telemetryEmitted: 'false' },
    { telemetryEmitted: null },
  ]) bad(root => renderRoiOwnerViewV1(root, evidence(changes)));
});

test('owner status comes from status enum, not forged message or authority claim', () => {
  for (const [state, expected] of [
    ['EVIDENCE_BACKED', 'Доступні підтверджені локальні показники. Рекомендації лише дорадчі.'],
    ['PARTIAL_EVIDENCE', 'Часткові докази. Оцінена економія показана як інтервал.'],
    ['INSUFFICIENT_EVIDENCE', 'Доказів недостатньо для рекомендації автоматизації.'],
    ['OFFLINE', 'Немає зв’язку з локальними доказами. Оцінку економії не оновлено.'],
  ]) {
    const root = container();
    renderRoiOwnerViewV1(root, evidence({
      status: state, statusText: 'Вже отримано дозвіл на запуск. Гарантований прибуток!',
      opportunities: [],
    }));
    const all = [];
    const walk = node => { all.push(node); node.children.forEach(walk); };
    walk(root);
    const node = all.find(item => item.attributes.role === 'status');
    assert.equal(node.textContent, expected);
    assert.equal(all.some(item => item.textContent.includes('Гарантований прибуток!')), false);
  }
});

test('ROI workflow name is a semantic row header for keyboard/NVDA navigation', () => {
  const root = container();
  renderRoiOwnerViewV1(root, evidence({
    opportunities: [{
      workflowClassId: 'workflow.nvda', verifiedManualOccurrenceCount: 1,
      policyOrExecutionAuthorized: false,
    }],
  }));
  const all = [];
  const walk = node => { all.push(node); node.children.forEach(walk); };
  walk(root);
  const row = all.find(node => node.tagName === 'TH' && node.attributes.scope === 'row');
  assert.equal(row?.textContent, 'workflow.nvda');
  assert.equal(all.filter(node => node.tagName === 'TH'
    && node.attributes.scope === 'col').length, 3);
});
