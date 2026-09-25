import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionCenterItemStatus,
  ActionCenterOwnerActionKind,
  ActionCenterSeverity,
  ActionCenterSourceKind,
  buildActionCenterProjectionV1,
  normalizeActionCenterItemV1,
} from '../../src/core/action-center-contract.js';

const T0='2026-09-25T00:00:00.000Z';
const T1='2026-09-25T00:01:00.000Z';
const T2='2026-09-25T00:02:00.000Z';

const open=(id,overrides={})=>({
  schemaVersion:1,
  itemId:id,
  status:ActionCenterItemStatus.OPEN,
  severity:ActionCenterSeverity.NORMAL,
  ownerActionKind:ActionCenterOwnerActionKind.REVIEW,
  title:`Review ${id}`,
  materialityReason:'Canonical source owner must be resolved before any consequential action.',
  sourceKind:ActionCenterSourceKind.REVIEW,
  sourceId:`source:${id}`,
  sourceRevisionId:`rev:${id}`,
  sourceEffectId:'',
  evidenceArtifactIds:[],
  createdAt:T0,
  updatedAt:T0,
  closedAt:'',
  supersededByItemId:'',
  ...overrides,
});

test('Action Center projection is advisory and deterministic',()=>{
  const projection=buildActionCenterProjectionV1([
    open('low',{severity:ActionCenterSeverity.LOW,createdAt:T1,updatedAt:T1}),
    open('block',{severity:ActionCenterSeverity.BLOCKING,ownerActionKind:ActionCenterOwnerActionKind.RECONCILE}),
  ]);
  assert.deepEqual(projection.items.map(item=>item.itemId),['block','low']);
  assert.equal(projection.requiresCanonicalSourceResolution,true);
  assert.equal(projection.decisionAuthorized,false);
  assert.equal(projection.summary.blockingOpenCount,1);
});

test('closed historical blocker cannot create live blocking authority',()=>{
  const projection=buildActionCenterProjectionV1([
    open('history',{
      status:ActionCenterItemStatus.RESOLVED,
      severity:ActionCenterSeverity.BLOCKING,
      ownerActionKind:ActionCenterOwnerActionKind.NONE,
      updatedAt:T1,
      closedAt:T2,
    }),
  ]);
  assert.equal(projection.summary.openCount,0);
  assert.equal(projection.summary.blockingOpenCount,0);
});

test('Action Center rejects a successor created after supersession closure',()=>{
  assert.throws(()=>buildActionCenterProjectionV1([
    open('old',{
      status:ActionCenterItemStatus.SUPERSEDED,
      ownerActionKind:ActionCenterOwnerActionKind.NONE,
      updatedAt:T1,
      closedAt:T2,
      supersededByItemId:'future',
    }),
    open('future',{
      createdAt:'2026-09-25T00:03:00.000Z',
      updatedAt:'2026-09-25T00:03:00.000Z',
    }),
  ]),/postdates superseded item closure/);
});

test('Action Center rejects accessor-backed authority before getter execution',()=>{
  let reads=0;
  const raw=open('getter');
  Object.defineProperty(raw,'ownerActionKind',{
    enumerable:true,
    get(){reads+=1;return ActionCenterOwnerActionKind.APPROVE_OR_DENY;},
  });
  assert.throws(()=>normalizeActionCenterItemV1(raw),/enumerable own data properties/);
  assert.equal(reads,0);
});
