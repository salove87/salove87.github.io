const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const html = fs.readFileSync('leave-form-nano.html', 'utf8');
const legacyHtml = fs.readFileSync('leave_form2027.html', 'utf8');
function segment(start, end, input=html) {
  const a = input.indexOf(start), b = input.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('Missing source segment: ' + start);
  return input.slice(a, b);
}
const source = [
  segment('    const EMP_ID_ALIASES = {', '    function makeLocalDriver(){'),
  segment('    function makeFirestoreDriver(){', '    let driver = null;'),
  'let driver = makeFirestoreDriver();',
  'let legacyDriver = (() => {' + segment('    function makeFirestoreDriver(){', '    let driver = null;', legacyHtml) + ' return makeFirestoreDriver(); })();',
  segment('    async function saveLeaveEditWithAudit(', '    function openEditLeaveDateModal('),
  'globalThis.app = { requireNoOverlappingLeave, overlapPeriod, driver, legacyDriver, saveLeaveEditWithAudit };'
].join('\n');

function makeHarness(initial = {}) {
  const docs = new Map();
  const versions = new Map();
  for (const [key, value] of Object.entries(initial)) { docs.set(key, structuredClone(value)); versions.set(key, 1); }
  let counter = 0, failure = false, barrier = null, serverReads = 0, retries = 0;
  const collection = (_, name) => ({ name });
  function doc(first, second, third) {
    if (first?.name && second === undefined) return { path: `${first.name}/auto-${++counter}`, id: `auto-${counter}` };
    return { path: `${second}/${third}`, id: third };
  }
  const snapshot = (ref) => {
    const value = docs.get(ref.path);
    return { id: ref.id, exists: () => value !== undefined, data: () => structuredClone(value) };
  };
  const q = (col, condition) => ({ col, condition });
  const where = (field, _op, value) => ({field, value});
  async function getDocsFromServer(query) {
    if (failure) throw new Error('unavailable');
    serverReads++;
    const values = [...docs.entries()].filter(([key, value]) => key.startsWith(query.col.name + '/') && value[query.condition.field] === query.condition.value)
      .map(([key, value]) => ({ id: key.split('/')[1], data: () => structuredClone(value) }));
    if (barrier && !barrier.released) {
      barrier.count++;
      if (barrier.count === 2) { barrier.released = true; barrier.resolve(); }
      await barrier.promise;
    }
    return {docs: values};
  }
  async function runTransaction(_db, work) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const reads = new Map(), writes = [];
      const tx = {
        async get(ref) { reads.set(ref.path, versions.get(ref.path) || 0); return snapshot(ref); },
        set(ref, data, options) { writes.push({kind:'set', ref, data:structuredClone(data), options}); },
        update(ref, data) { writes.push({kind:'update', ref, data:structuredClone(data)}); },
        delete(ref) { writes.push({kind:'delete', ref}); }
      };
      const result = await work(tx);
      if ([...reads].some(([path, version]) => (versions.get(path) || 0) !== version)) { retries++; continue; }
      for (const w of writes) {
        const existing = docs.get(w.ref.path);
        if (w.kind === 'update' && !existing) throw new Error('not-found');
        if (w.kind === 'delete') { docs.delete(w.ref.path); versions.set(w.ref.path, (versions.get(w.ref.path) || 0) + 1); continue; }
        const next = w.kind === 'update' || w.options?.merge ? {...existing, ...w.data} : w.data;
        docs.set(w.ref.path, next);
        versions.set(w.ref.path, (versions.get(w.ref.path) || 0) + 1);
      }
      return result;
    }
    throw new Error('too many retries');
  }
  const context = vm.createContext({
    db:{}, collection, doc, where, query:q, getDocsFromServer,
    getDocFromServer:async ref=>{ if(failure) throw new Error('unavailable'); return snapshot(ref); },
    getDocs:getDocsFromServer, runTransaction, serverTimestamp:()=>'timestamp',
    fmtDateDMY:s=>s.split('-').reverse().join('/'),
    leaveLockedReason:()=>'', leaveISO:s=>s,
    MAX_VACATION_DAYS:6, getLeaveYearRange:()=>({}),
    normalizeHistoryLeaveType:s=>s, leaveDaysWithinRange:r=>parseFloat(String(r.leaveDays))
  });
  vm.runInContext(source, context);
  return {
    ...context.app, docs,
    failServerReads() { failure = true; },
    forceConcurrentReads() { let resolve; const promise = new Promise(r=>resolve=r); barrier = { count:0, released:false, resolve, promise }; },
    stats:()=>({serverReads,retries})
  };
}
const makeLeave = (date='2032-03-17', period='บ่าย', overrides={}) => ({
  empId:'TEST-42', startDate:date, endDate:date, leaveDays:period?'0.5 วัน':'1 วัน',
  halfDayPeriod:period, leaveType:'ลาพักร้อน', ...overrides
});

test('blocks same employee, date and afternoon even when leave type or approver differ', () => {
  const h=makeHarness();
  assert.throws(()=>h.requireNoOverlappingLeave(makeLeave('2032-03-17','บ่าย',{leaveType:'ลากิจ'}), [{id:'x', ...makeLeave()}]), /ซ้ำกัน/);
});
test('allows separate morning and afternoon but rejects full day or overlapping ranges', () => {
  const h=makeHarness();
  assert.doesNotThrow(()=>h.requireNoOverlappingLeave(makeLeave('2032-03-17','เช้า'),[{id:'x',...makeLeave()}]));
  assert.throws(()=>h.requireNoOverlappingLeave(makeLeave('2032-03-17',''),[{id:'x',...makeLeave()}]), /ซ้ำกัน/);
  assert.throws(()=>h.requireNoOverlappingLeave(makeLeave('2032-03-16','',{endDate:'2032-03-18',leaveDays:'3 วัน'}),[{id:'x',...makeLeave()}]), /17\/03\/2032/);
  assert.doesNotThrow(()=>h.requireNoOverlappingLeave(makeLeave('2032-03-18',''),[{id:'x',...makeLeave()}]));
});
test('cancelled records do not block; unknown old half day and invalid dates are handled conservatively', () => {
  const h=makeHarness();
  assert.doesNotThrow(()=>h.requireNoOverlappingLeave(makeLeave(),[{id:'x',...makeLeave(undefined,undefined,{leaveStatus:'cancelled'})}]));
  assert.throws(()=>h.requireNoOverlappingLeave(makeLeave('2032-03-17','เช้า'),[{id:'x',...makeLeave('2032-03-17','',{leaveDays:'0.5 วัน'})}]), /ซ้ำกัน/);
  assert.throws(()=>h.requireNoOverlappingLeave(makeLeave(),[{id:'x',...makeLeave('not-a-date')}]), /ข้อมูลวันที่ลาเดิมไม่ครบ/);
  assert.throws(()=>h.requireNoOverlappingLeave(makeLeave('2032-02-30'),[]), /วันที่ลาไม่ถูกต้อง/);
  assert.doesNotThrow(()=>h.requireNoOverlappingLeave(makeLeave(),[{id:'x',...makeLeave()}],'x'));
});
test('checks legacy employee ID aliases against the server', async () => {
  const match=html.match(/const EMP_ID_ALIASES\s*=\s*\{\s*'([^']+)'\s*:\s*'([^']+)'/);
  assert.ok(match);
  const [,legacyId,canonicalId]=match;
  const h=makeHarness({'leave_requests/old':makeLeave(undefined,undefined,{empId:legacyId})});
  await assert.rejects(h.driver.create(makeLeave(undefined,undefined,{empId:canonicalId})), /ซ้ำกัน/);
  assert.equal(h.docs.has(`leave_overlap_guards/${canonicalId}`),false);
});
test('simultaneous identical submissions commit exactly once and the loser is retried', async () => {
  const h=makeHarness(); h.forceConcurrentReads();
  const results=await Promise.allSettled([h.driver.create(makeLeave()),h.driver.create(makeLeave())]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected' && /ซ้ำกัน/.test(r.reason.message)).length,1);
  assert.equal([...h.docs.keys()].filter(k=>k.startsWith('leave_requests/')).length,1);
  assert.ok(h.stats().serverReads>=3);
});
test('opposite half days commit successfully; cancellation permits replacement but prevents conflicting restore', async () => {
  const h=makeHarness();
  const afternoon=await h.driver.create(makeLeave());
  const morning=await h.driver.create(makeLeave('2032-03-17','เช้า'));
  await h.driver.update(afternoon.id,{leaveStatus:'cancelled'},'TEST-42');
  const replacement=await h.driver.create(makeLeave());
  await assert.rejects(h.driver.update(afternoon.id,{leaveStatus:'active'},'TEST-42'),/ซ้ำกัน/);
  assert.equal(h.docs.get(`leave_requests/${afternoon.id}`).leaveStatus,'cancelled');
  assert.ok(h.docs.has(`leave_requests/${morning.id}`));
  assert.ok(h.docs.has(`leave_requests/${replacement.id}`));
});
test('editing checks the new period and keeps an audit entry', async () => {
  const h=makeHarness();
  const first=await h.driver.create(makeLeave());
  const second=await h.driver.create(makeLeave('2032-03-18','บ่าย'));
  const row={id:second.id,...h.docs.get(`leave_requests/${second.id}`)};
  await assert.rejects(h.saveLeaveEditWithAudit(row,{startDate:'2032-03-17',endDate:'2032-03-17',leaveDays:0.5,halfDayPeriod:'บ่าย'}),/ซ้ำกัน/);
  await h.saveLeaveEditWithAudit(row,{startDate:'2032-03-17',endDate:'2032-03-17',leaveDays:0.5,halfDayPeriod:'เช้า'});
  const edited=h.docs.get(`leave_requests/${second.id}`);
  assert.equal(edited.halfDayPeriod,'เช้า');
  assert.equal(edited.editHistory.length,1);
  assert.equal(edited.editHistory[0].before.startDate,'2032-03-18');
  assert.ok(h.docs.has(`leave_requests/${first.id}`));
});
test('simultaneous edit and submission cannot occupy the same half day', async () => {
  const h=makeHarness();
  const existing=await h.driver.create(makeLeave('2032-03-18','บ่าย'));
  const row={id:existing.id,...h.docs.get(`leave_requests/${existing.id}`)};
  h.forceConcurrentReads();
  const results=await Promise.allSettled([
    h.saveLeaveEditWithAudit(row,{startDate:'2032-03-17',endDate:'2032-03-17',leaveDays:0.5,halfDayPeriod:'บ่าย'}),
    h.driver.create(makeLeave())
  ]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected' && /ซ้ำกัน/.test(r.reason.message)).length,1);
});
test('current and legacy forms coordinate concurrent submissions', async () => {
  const h=makeHarness(); h.forceConcurrentReads();
  const results=await Promise.allSettled([h.driver.create(makeLeave()), h.legacyDriver.create(makeLeave())]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.filter(r=>r.status==='rejected' && /ซ้ำกัน/.test(r.reason.message)).length,1);
});
test('legacy form checks edits and serializes deletion', async () => {
  const h=makeHarness();
  const first=await h.driver.create(makeLeave());
  const second=await h.legacyDriver.create(makeLeave('2032-03-18','บ่าย'));
  await assert.rejects(h.legacyDriver.update(second.id,{startDate:'2032-03-17',endDate:'2032-03-17'},'TEST-42'),/ซ้ำกัน/);
  await h.legacyDriver.remove(first.id,'TEST-42');
  const replacement=await h.driver.create(makeLeave());
  assert.ok(h.docs.has(`leave_requests/${replacement.id}`));
  assert.equal(h.docs.has(`leave_requests/${first.id}`),false);
});
test('vacation quota remains enforced after the server history check', async () => {
  const h=makeHarness({'leave_requests/old':makeLeave('2032-01-01','',{endDate:'2032-01-06',leaveDays:'6 วัน'})});
  await assert.rejects(h.driver.create(makeLeave()),/เกินโควตา/);
  assert.equal([...h.docs.keys()].filter(k=>k.startsWith('leave_requests/')).length,1);
});
test('server read failure does not create a leave or a guard', async () => {
  const h=makeHarness(); h.failServerReads();
  await assert.rejects(h.driver.create(makeLeave()),/unavailable/);
  assert.equal(h.docs.size,0);
});
