const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createMockController } = require('./mock-controller');
const { LuxorClient, LuxorError } = require('../dist/LuxorClient');
const { LuxorController, ControllerType } = require('../dist/LuxorController');

const log = { info() {}, warn() {}, error() {}, debug() {}, success() {}, log() {} };
let mock, ip;

beforeEach(async () => { mock = createMockController(); ip = await mock.listen(); });
afterEach(() => mock.close());

const client = (opts = {}) => new LuxorClient({ ip, timeout: 500, retries: 2, log, ...opts });

test('retries a dropped connection', async () => {
  mock.faults.drop = 2;
  const res = await client().request('ControllerName');
  assert.equal(res.Controller, 'lxzdc-mock');
  assert.equal(mock.log.length, 3);
});

test('retries a request the controller never answers', async () => {
  mock.faults.hang = 1;
  const res = await client({ timeout: 200 }).request('ThemeListGet');
  assert.equal(res.ThemeList.length, 2);
});

test('gives up after the configured retries', async () => {
  mock.faults.drop = 10;
  await assert.rejects(client({ retries: 1 }).request('ControllerName'));
  assert.equal(mock.log.length, 2);
});

test('does not retry an error status from the controller', async () => {
  await assert.rejects(client().request('IlluminateGroup', { GroupNumber: 99, Intensity: 10 }),
    err => err instanceof LuxorError && err.status === 242);
  assert.equal(mock.log.length, 1);
});

test('sends one request at a time on fresh connections', async () => {
  mock.faults.delayMs = 30;
  const c = client();
  await Promise.all([1, 2, 3, 4, 5].map(i => c.request('IlluminateGroup', { GroupNumber: 1, Intensity: i * 10 })));
  assert.equal(mock.maxActive, 1);
  assert.deepEqual(mock.log.map(l => l.body.Intensity), [10, 20, 30, 40, 50]);
  assert.ok(mock.log.every(l => l.connection === 'close'));
});

test('a failed request does not block the queue', async () => {
  mock.faults.drop = 10;
  const c = client({ retries: 0 });
  await assert.rejects(c.request('ControllerName'));
  mock.faults.drop = 0;
  assert.equal((await c.request('ControllerName')).Controller, 'lxzdc-mock');
});

for (const type of ['ZD', 'ZDC']) {
  test(`normalizes ${type} group lists`, async () => {
    await mock.close();
    mock = createMockController({ type });
    ip = await mock.listen();
    const ctl = new LuxorController('x', type === 'ZD' ? ControllerType.ZD : ControllerType.ZDC, client(), log, { pollInterval: 30000, hideGroups: false });
    await ctl.refresh();
    assert.deepEqual(ctl.groups.get(2), { number: 2, name: 'Driveway', intensity: 50, color: 0, type: 'ZD' });
    assert.equal(ctl.groups.get(1).type, type === 'ZD' ? 'ZD' : 'ZDC');
    assert.equal(ctl.themes.size, 2);
    assert.equal(ctl.isResponsive(), true);
  });
}

test('hideGroups refresh completes (used to deadlock the request queue)', async () => {
  const ctl = new LuxorController('x', ControllerType.ZDC, client(), log, { pollInterval: 30000, hideGroups: true });
  await ctl.refresh();
  assert.equal(ctl.groups.size, 0);
  assert.equal(ctl.themes.size, 2);
  assert.ok(!mock.log.some(l => l.method === 'GroupListGet'));
});
