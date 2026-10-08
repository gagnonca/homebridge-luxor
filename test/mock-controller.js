// A fake Luxor controller for tests and local runs.  Behaves like a ZDC (or ZD) and can be told
// to misbehave the way real controllers do: drop connections, stall, or answer slowly.
const http = require('node:http');

function createMockController({ type = 'ZDC', verbose = false } = {}) {
  const state = {
    name: type === 'ZD' ? 'luxor-mock' : 'lxzdc-mock',
    groups: [
      { Name: 'Front Yard', Grp: 1, Inten: 0, Colr: 250 },
      { Name: 'Driveway', Grp: 2, Inten: 50, Colr: 0 },
    ],
    themes: [
      { Name: 'Evening', ThemeIndex: 0, OnOff: 0 },
      { Name: 'Party', ThemeIndex: 1, OnOff: 0 },
    ],
    colors: [{ C: 250, Hue: 120, Sat: 80 }],
  };
  const faults = { drop: 0, hang: 0, delayMs: 0, dropMethod: '' };
  const log = [];
  let active = 0;
  let maxActive = 0;

  const handlers = {
    ControllerName: () => ({ Status: 0, Controller: state.name }),
    GroupListGet: () => type === 'ZD'
      ? { Status: 0, GroupList: state.groups.map(g => ({ Name: g.Name, GroupNumber: g.Grp, Intensity: g.Inten })) }
      : { Status: 0, GroupList: state.groups },
    ThemeListGet: () => ({ Status: 0, Restricted: 0, ThemeList: state.themes }),
    ColorListGet: () => ({ Status: 0, ListSize: state.colors.length, ColorList: state.colors }),
    IlluminateGroup: (b) => {
      const g = state.groups.find(g => g.Grp === b.GroupNumber);
      if (!g) return { Status: 242 };
      g.Inten = b.Intensity;
      return { Status: 0 };
    },
    IlluminateTheme: (b) => {
      const t = state.themes.find(t => t.ThemeIndex === b.ThemeIndex);
      if (!t) return { Status: 251 };
      t.OnOff = b.OnOff;
      if (b.OnOff === 1) state.groups.forEach(g => { g.Inten = 75; });
      return { Status: 0 };
    },
    IlluminateAll: () => { state.groups.forEach(g => { g.Inten = 100; }); return { Status: 0 }; },
    ExtinguishAll: () => { state.groups.forEach(g => { g.Inten = 0; }); return { Status: 0 }; },
    ColorListSet: (b) => {
      const c = state.colors.find(c => c.C === b.C);
      if (c) Object.assign(c, { Hue: b.Hue, Sat: b.Sat });
      else state.colors.push({ C: b.C, Hue: b.Hue, Sat: b.Sat });
      return { Status: 0 };
    },
    GroupListEdit: (b) => {
      const g = state.groups.find(g => g.Grp === b.GroupNumber);
      if (g && b.Color !== undefined) g.Colr = b.Color;
      return { Status: 0 };
    },
  };

  const server = http.createServer((req, res) => {
    active++;
    maxActive = Math.max(maxActive, active);
    res.on('close', () => { active--; });
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      if (req.url.startsWith('/_fault')) {
        // test hook: /_fault?drop=2&hang=1&delayMs=500
        for (const [k, v] of new URL(req.url, 'http://x').searchParams) faults[k] = k === 'dropMethod' ? v : Number(v);
        res.end(JSON.stringify(faults));
        return;
      }
      const method = req.url.replace(/^\//, '').replace(/\.json$/, '');
      const body = raw ? JSON.parse(raw) : {};
      log.push({ method, body, connection: req.headers.connection });
      if (verbose) console.log(new Date().toISOString(), method, raw, faults.drop ? '(dropping)' : faults.hang ? '(hanging)' : '');
      if (faults.drop > 0) { faults.drop--; req.socket.destroy(); return; }
      if (faults.dropMethod === method) { req.socket.destroy(); return; }
      if (faults.hang > 0) { faults.hang--; return; } // never answer
      const handler = handlers[method];
      const reply = handler ? handler(body) : { Status: 1 };
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      }, faults.delayMs);
    });
  });

  return {
    state, faults, log,
    get maxActive() { return maxActive; },
    listen: (port = 0) => new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(`127.0.0.1:${server.address().port}`))),
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

module.exports = { createMockController };

if (require.main === module) {
  const mock = createMockController({ type: process.argv[3] || 'ZDC', verbose: true });
  mock.listen(Number(process.argv[2] || 8080)).then(addr => console.log(`mock Luxor controller on ${addr}`));
}
