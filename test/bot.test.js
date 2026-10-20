import { parseAccess } from '../src/config.js';
const access = parseAccess({});
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState, accrue, complete, undo, forecast, localTime, reminderDue, lessons } from '../src/model.js';
import { command } from '../src/commands.js';
import { Store } from '../src/store.js';
import { handleUpdate, tick, drain, stateKey, migrateOwner } from '../src/service.js';
const clock = { day: '2026-10-20', time: '17:00' };

test('weekly arrivals and Tuesday baseline, no duplicate accrual', () => {
  const s = initialState(clock);
  accrue(s, clock);
  assert.equal(s.backlog, 16);
  accrue(s, { ...clock, time: '18:00' });
  accrue(s, { ...clock, time: '20:00' });
  assert.equal(s.backlog, 17);
  accrue(s, { day: '2026-10-27', time: '18:00' });
  assert.equal(s.backlog, 25);
});
test('4/3 is allowed, undo, cannot complete future topics', () => {
  const s = initialState(clock);
  for (let i = 0; i < 4; i++) complete(s, clock);
  assert.equal(s.history[clock.day].done, 4);
  assert.equal(s.backlog, 12);
  undo(s, clock);
  assert.equal(s.backlog, 13);
  for (let i = 0; i < 30; i++) complete(s, clock);
  assert.equal(s.backlog, 0);
  assert.equal(s.history[clock.day].done, 16);
  const tomorrow = { day: '2026-10-21', time: '10:00' };
  undo(s, tomorrow);
  assert.equal(s.backlog, 0);
});
test('forecast starting Tuesday includes today math and 8 new topics/week', () => {
  const s = initialState(clock);
  assert.deepEqual(forecast(s, clock), { day: '2026-10-28', days: 9 });
  for (let i = 0; i < 4; i++) complete(s, clock);
  assert.deepEqual(forecast(s, clock), { day: '2026-10-27', days: 8 });
  accrue(s, { ...clock, time: '19:00' });
  assert.deepEqual(forecast(s, { ...clock, time: '19:00' }), { day: '2026-10-27', days: 8 });
});
test('zero backlog before future lessons still accounts for them', () => {
  const s = initialState(clock);
  s.backlog = 0;
  s.history[clock.day] = { done: 3, added: 0 };
  assert.equal(forecast(s, clock).day, '2026-10-21');
  assert.equal(lessons('2026-10-24').length, 0);
});
test('low goal cannot catch a growing backlog', () => {
  assert.equal(forecast(initialState(clock), clock, 1), null);
});
test('Kyiv local dates including DST boundaries', () => {
  assert.deepEqual(localTime(new Date('2026-10-20T21:30:00Z')), { day: '2026-10-21', time: '00:30' });
  assert.equal(localTime(new Date('2026-10-25T00:30:00Z')).time, '03:30');
  assert.equal(localTime(new Date('2026-10-25T01:30:00Z')).time, '03:30');
});
test('reminder window, dedupe, pause and completed daily goal', () => {
  const s = initialState(clock);
  const noon = { ...clock, time: '12:05' };
  assert.equal(reminderDue(s, noon), '12:00');
  s.sent[clock.day + '/12:00'] = true;
  assert.equal(reminderDue(s, noon), null);
  assert.equal(reminderDue(s, { ...clock, time: '12:15' }), null);
  s.paused = true;
  assert.equal(reminderDue(s, { ...clock, time: '18:00' }), null);
  s.paused = false;
  for (let i = 0; i < 3; i++) complete(s, clock);
  assert.equal(reminderDue(s, { ...clock, time: '18:00' }), null);
});
test('commands validate input and start never resets existing progress', () => {
  let { state } = command(null, '/start', clock);
  command(state, '/done', clock);
  command(state, '/start', clock);
  assert.equal(state.backlog, 15);
  command(state, '/goal -1', clock);
  assert.equal(state.goal, 3);
  command(state, '/goal 4', clock);
  assert.equal(state.goal, 4);
  command(state, '/remind 24:00', clock);
  assert.equal(state.reminders.length, 3);
  command(state, '/remind 21:00 09:00 09:00', clock);
  assert.deepEqual(state.reminders, ['09:00', '21:00']);
  command(state, '/setleft 0', clock);
  assert.equal(state.backlog, 0);
  command(state, '/lesson_time 16:00', clock);
  assert.equal(state.backlog, 1);
  command(state, '/lesson_time 15:00', clock);
  assert.equal(state.backlog, 1);
});
test('first start after lesson time immediately accrues today', () => {
  const { state } = command(null, '/start', { ...clock, time: '20:00' });
  assert.equal(state.backlog, 17);
});
test('unauthorized and group messages cannot alter state or get responses', () => {
  const db = new Store(':memory:');
  try {
    for (const [id, type] of [[8, 'private'], [1252270301, 'group']]) {
      handleUpdate(db, { update_id: id, message: { from: { id }, chat: { id, type }, text: '/start' } }, access, clock);
    }
    assert.equal(db.get(stateKey(1252270301)), null);
    assert.deepEqual(db.get('outbox', []), []);
  } finally { db.close(); }
});
test('duplicate Telegram update is atomic and cannot count twice', async () => {
  const db = new Store(':memory:');
  const owner = 1252270301;
  const update = (id, text) => ({ update_id: id, message: { from: { id: owner }, chat: { id: owner, type: 'private' }, text } });
  try {
    handleUpdate(db, update(1, '/start'), access, clock);
    handleUpdate(db, update(2, '+1'), access, clock);
    handleUpdate(db, update(2, '+1'), access, clock);
    assert.equal(db.get(stateKey(1252270301)).backlog, 15);
    assert.equal(db.get('offset'), 3);
    assert.equal(db.get('outbox').length, 2);
    await assert.rejects(drain(db, async () => { throw new Error('offline'); }));
    assert.equal(db.get('outbox').length, 2);
    let sent = 0;
    await drain(db, async () => { sent++; });
    assert.equal(sent, 2);
    assert.deepEqual(db.get('outbox'), []);
  } finally { db.close(); }
});
test('reminder survives restart in outbox and tick does not enqueue duplicate', () => {
  const db = new Store(':memory:');
  try {
    db.set(stateKey(1252270301), initialState(clock));
    tick(db, access, { ...clock, time: '18:03' });
    tick(db, access, { ...clock, time: '18:04' });
    assert.equal(db.get('outbox').length, 1);
    assert.equal(db.get(stateKey(1252270301)).backlog, 17);
  } finally { db.close(); }
});
test('SQLite persists after reopen and transactions roll back on failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'counter-test-'));
  const path = join(dir, 'state.sqlite');
  let db = new Store(path);
  try {
    db.set(stateKey(1252270301), initialState(clock));
    assert.throws(() => db.transaction(() => { db.set(stateKey(1252270301), {}); throw new Error('rollback'); }));
    assert.equal(db.get(stateKey(1252270301)).backlog, 16);
    db.close();
    db = new Store(path);
    assert.equal(db.get(stateKey(1252270301)).backlog, 16);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('access parser adds owner and validates all IDs', () => {
  assert.deepEqual([...parseAccess({ OWNER_ID: '10', ALLOWED_USER_IDS: '20, 30 20' }).allowedUserIds], [10, 20, 30]);
  assert.deepEqual([...parseAccess({}).allowedUserIds], [1252270301]);
  for (const value of ['abc', '-1', '0', '1.5', '9007199254740993']) {
    assert.throws(() => parseAccess({ ALLOWED_USER_IDS: value }));
  }
});
test('users have separate progress, settings and reminder recipients', () => {
  const db = new Store(':memory:');
  const access = parseAccess({ OWNER_ID: '10', ALLOWED_USER_IDS: '20,30' });
  const update = (id, user, text) => ({ update_id: id, message: { from: { id: user }, chat: { id: user, type: 'private' }, text } });
  try {
    handleUpdate(db, update(1, 10, '/start'), access, clock);
    handleUpdate(db, update(2, 20, '/start'), access, clock);
    handleUpdate(db, update(3, 20, '/goal 5'), access, clock);
    handleUpdate(db, update(4, 20, '+1'), access, clock);
    handleUpdate(db, update(5, 10, '/pause'), access, clock);
    assert.equal(db.get(stateKey(10)).backlog, 16);
    assert.equal(db.get(stateKey(10)).goal, 3);
    assert.equal(db.get(stateKey(20)).backlog, 15);
    assert.equal(db.get(stateKey(20)).goal, 5);
    assert.equal(db.get(stateKey(30)), null);
    db.set('outbox', []);
    tick(db, access, { ...clock, time: '18:01' });
    assert.equal(db.get(stateKey(10)).backlog, 17);
    assert.equal(db.get(stateKey(20)).backlog, 16);
    assert.deepEqual(db.get('outbox').map(m => m.chat_id), [20]);
    handleUpdate(db, update(6, 99, '/start'), access, clock);
    assert.equal(db.get(stateKey(99)), null);
    handleUpdate(db, update(7, 20, '+1'), parseAccess({ OWNER_ID: '10' }), clock);
    assert.equal(db.get(stateKey(20)).backlog, 16);
  } finally { db.close(); }
});
test('legacy migration preserves owner state exactly and runs once', () => {
  const db = new Store(':memory:');
  try {
    const legacy = initialState(clock);
    complete(legacy, clock);
    legacy.paused = true;
    db.set('state', legacy);
    db.set('offset', 123);
    migrateOwner(db, 10);
    assert.deepEqual(db.get(stateKey(10)), legacy);
    assert.equal(db.get('state'), null);
    assert.equal(db.get('offset'), 123);
    migrateOwner(db, 20);
    assert.equal(db.get(stateKey(20)), null);
    db.set('state', initialState(clock));
    migrateOwner(db, 10);
    assert.deepEqual(db.get(stateKey(10)), legacy);
  } finally { db.close(); }
});
test('queued messages to removed users are not sent', async () => {
  const db = new Store(':memory:');
  try {
    db.set('outbox', [{ chat_id: 10, text: 'owner' }, { chat_id: 20, text: 'revoked' }]);
    const sent = [];
    await drain(db, async (method, body) => sent.push(body.chat_id), new Set([10]));
    assert.deepEqual(sent, [10]);
    assert.deepEqual(db.get('outbox'), []);
  } finally { db.close(); }
});
