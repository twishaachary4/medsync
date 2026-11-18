/* MedSync local shim.
   Gives the page the same window.claude.use('db') and use('sample') API that claude.ai provides,
   backed by server.js. On claude.ai this file does nothing. */
(function () {
  if (window.claude && window.claude.use) return;

  // Same origin when opened from http://localhost:3000, otherwise call the server directly.
  const API = location.port === '3000' ? '' : 'http://localhost:3000';

  const post = async (path, body) => {
    let r;
    try {
      r = await fetch(API + '/api' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
    } catch (e) {
      const err = new Error('Cannot reach the MedSync server. Run "npm start" first.');
      err.code = 'upstream_error';
      throw err;
    }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(j.error || 'Request failed');
      err.code = j.code || 'upstream_error';
      throw err;
    }
    return j;
  };

  const genId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const meta = { fromCache: false, hasPendingWrites: false };
  const snap = (id, data) => ({ id, exists: data !== undefined, data: () => data, metadata: meta });
  const qSnap = docs => ({ docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: meta });

  // Live updates: poll the server every 2 seconds and deliver only when the result changes.
  const poll = (fetchFn, toSnap, next, error) => {
    let last = null, alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const j = await fetchFn();
        const key = JSON.stringify(j);
        if (key !== last) { last = key; next(toSnap(j)); }
      } catch (e) {
        if (error) error({ code: e.code || 'unavailable', message: e.message });
      }
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(timer); };
  };

  const docRef = path => {
    const id = path.split('/').pop();
    return {
      id, path,
      get: async () => { const j = await post('/doc/get', { path }); return snap(id, j.exists ? j.data : undefined); },
      set: data => post('/doc/set', { path, data }).then(() => {}),
      update: data => post('/doc/update', { path, data }).then(() => {}),
      delete: () => post('/doc/delete', { path }).then(() => {}),
      onSnapshot: (next, error) =>
        poll(() => post('/doc/get', { path }), j => snap(id, j.exists ? j.data : undefined), next, error)
    };
  };

  const query = (coll, wheres) => ({
    where: (f, op, v) => query(coll, [...wheres, [f, op, v]]),
    orderBy: () => query(coll, wheres),
    limit: () => query(coll, wheres),
    get: async () => qSnap((await post('/query', { collection: coll, where: wheres })).docs.map(r => snap(r.id, r.data))),
    onSnapshot: (next, error) =>
      poll(() => post('/query', { collection: coll, where: wheres }),
           j => qSnap(j.docs.map(r => snap(r.id, r.data))), next, error)
  });

  const collection = path => ({
    ...query(path, []),
    path,
    doc: id => docRef(path + '/' + (id || genId())),
    add: async data => { const ref = docRef(path + '/' + genId()); await ref.set(data); return ref; }
  });

  const db = { doc: docRef, collection };

  const readBlob = b => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });

  const sample = async (input, opts = {}) => {
    const prompt = typeof input === 'string'
      ? input
      : input.filter(t => t.role === 'user').map(t => t.content).join('\n\n');
    const images = await Promise.all((opts.images || []).map(readBlob));
    const j = await post('/summarize', { prompt, images });
    if (opts.onText) opts.onText({ text: j.text, delta: j.text });
    return { text: j.text, truncated: false };
  };

  window.claude = {
    use: async name => (name === 'db' ? db : name === 'sample' ? sample : null)
  };
})();
