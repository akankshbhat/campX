'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer, isCollegeEmail } = require('./server');

const DOMAIN_ERROR = 'Access restricted. Please use your official BMSCE email address to register.';
const DOMAIN_LOGIN_ERROR = 'Access restricted. Please use your official BMSCE email address to log in.';

async function startServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'campx-test-'));
  const logs = [];
  const { server, db } = createServer({
    dataDir: path.join(root, 'data'),
    uploadDir: path.join(root, 'uploads'),
    jwtSecret: 'test-secret',
    log: (message) => logs.push(String(message))
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, db, logs };
}

function caller(server) {
  const base = `http://127.0.0.1:${server.address().port}`;
  return async function call(route, { method = 'GET', token, body, headers = {} } = {}) {
    const requestHeaders = { ...headers };
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    if (body && !(body instanceof FormData)) requestHeaders['Content-Type'] = 'application/json';
    const response = await fetch(base + route, {
      method,
      headers: requestHeaders,
      body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
      redirect: 'manual'
    });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
    return { response, data };
  };
}

test('only exact bmsce.ac.in addresses pass validation, case-insensitively', () => {
  assert.equal(isCollegeEmail('student@bmsce.ac.in'), true);
  assert.equal(isCollegeEmail('Student@BMSCE.ac.in'), true);
  assert.equal(isCollegeEmail('  student@Bmsce.AC.in  '), true);
  assert.equal(isCollegeEmail('student@notbmsce.ac.in'), false);
  assert.equal(isCollegeEmail('student@bmsce.ac.in.example.com'), false);
  assert.equal(isCollegeEmail('student@bmsce.ac.in.evil.io'), false);
  assert.equal(isCollegeEmail('student@gmail.com'), false);
  assert.equal(isCollegeEmail('student@bmsce.ac'), false);
  assert.equal(isCollegeEmail('student@@bmsce.ac.in'), false);
  assert.equal(isCollegeEmail(''), false);
});

test('database-backed account, listing, and exchange flow', async (t) => {
  const { server } = await startServer(t);
  const call = caller(server);

  async function register(email, name) {
    const result = await call('/api/auth/register', {
      method: 'POST',
      body: { email, name, studentId: 'S123', college: 'BMS College of Engineering', password: 'secure-password' }
    });
    assert.equal(result.response.status, 201, JSON.stringify(result.data));
    assert.match(result.data.message, /log in/i);
    const login = await call('/api/auth/login', { method: 'POST', body: { email, password: 'secure-password' } });
    assert.equal(login.response.status, 200);
    assert.equal(login.data.user.emailVerified, true);
    return login.data;
  }

  const health = await call('/api/health');
  assert.deepEqual(health.data, { status: 'ok', database: 'connected' });

  const owner = await register('owner@bmsce.ac.in', 'Owner Student');
  const listingForm = new FormData();
  for (const [key, value] of Object.entries({
    title: 'Graphing calculator',
    description: 'Works well',
    category: 'Electronics',
    type: 'free',
    price: '0',
    deposit: '0',
    condition: 'good',
    pickupLocation: 'Library'
  })) listingForm.append(key, value);
  const published = await call('/api/listings', { method: 'POST', token: owner.token, body: listingForm });
  assert.equal(published.response.status, 201);

  const requester = await register('requester@bmsce.ac.in', 'Requester Student');
  const browse = await call('/api/listings', { token: requester.token });
  assert.equal(browse.data.total, 1);
  assert.equal(browse.data.items[0].owner.name, 'Owner Student');
  const sent = await call('/api/requests', {
    method: 'POST',
    token: requester.token,
    body: {
      listingId: published.data._id,
      message: 'May I borrow this?',
      idempotencyKey: 'one-test-request-001',
      endDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)
    }
  });
  assert.equal(sent.response.status, 201, JSON.stringify(sent.data));

  const accepted = await call(`/api/requests/${sent.data._id}/accept`, { method: 'PATCH', token: owner.token });
  assert.equal(accepted.response.status, 200);
  await call(`/api/requests/${sent.data._id}/handover`, { method: 'POST', token: owner.token });
  await call(`/api/requests/${sent.data._id}/handover`, { method: 'POST', token: requester.token });
  await call(`/api/requests/${sent.data._id}/return`, { method: 'POST', token: owner.token });
  await call(`/api/requests/${sent.data._id}/return`, { method: 'POST', token: requester.token });
  const requests = await call('/api/requests?role=requester', { token: requester.token });
  assert.equal(requests.data[0].status, 'completed');
});

test('registration and login reject every non-BMSCE domain', async (t) => {
  const { server } = await startServer(t);
  const call = caller(server);
  const body = { name: 'Outside Student', studentId: 'S9', college: 'BMS College of Engineering', password: 'secure-password' };

  for (const email of [
    'student@gmail.com',
    'student@outlook.com',
    'student@yahoo.co.in',
    'student@notbmsce.ac.in',
    'student@bmsce.ac.in.example.com',
    'student@bmsce.ac.in.evil.io'
  ]) {
    const result = await call('/api/auth/register', { method: 'POST', body: { ...body, email } });
    assert.equal(result.response.status, 403, email);
    assert.equal(result.data.error, DOMAIN_ERROR, email);
  }

  const valid = await call('/api/auth/register', { method: 'POST', body: { ...body, email: 'STUDENT@BMSCE.AC.IN' } });
  assert.equal(valid.response.status, 201, JSON.stringify(valid.data));

  const badLogin = await call('/api/auth/login', { method: 'POST', body: { email: 'student@gmail.com', password: 'secure-password' } });
  assert.equal(badLogin.response.status, 403);
  assert.equal(badLogin.data.error, DOMAIN_LOGIN_ERROR);

  const lookalikeLogin = await call('/api/auth/login', { method: 'POST', body: { email: 'student@notbmsce.ac.in', password: 'secure-password' } });
  assert.equal(lookalikeLogin.response.status, 403);
  assert.equal(lookalikeLogin.data.error, DOMAIN_LOGIN_ERROR);

  const okLogin = await call('/api/auth/login', { method: 'POST', body: { email: 'student@bmsce.ac.in', password: 'secure-password' } });
  assert.equal(okLogin.response.status, 200);
  assert.equal(okLogin.data.user.email, 'student@bmsce.ac.in');
  assert.equal(okLogin.data.user.emailVerified, true);
});

test('no verification endpoints remain and unverified existing accounts still work', async (t) => {
  const { server, db } = await startServer(t);
  const call = caller(server);

  const registered = await call('/api/auth/register', {
    method: 'POST',
    body: { email: 'legacy@bmsce.ac.in', name: 'Legacy Student', studentId: 'S5', college: 'BMS College of Engineering', password: 'secure-password' }
  });
  assert.equal(registered.response.status, 201);

  assert.equal((await call('/api/auth/verify?token=anything')).response.status, 404);
  const login = await call('/api/auth/login', { method: 'POST', body: { email: 'legacy@bmsce.ac.in', password: 'secure-password' } });
  assert.equal(login.response.status, 200);
  assert.equal((await call('/api/auth/resend-verification', { method: 'POST', token: login.data.token })).response.status, 404);

  // An older row that predates the change is flagged verified during init and can still use the app.
  db.prepare('UPDATE users SET email_verified = 0 WHERE email = ?').run('legacy@bmsce.ac.in');
  const listing = await call('/api/listings', { token: login.data.token });
  assert.equal(listing.response.status, 200);

  const restored = db.prepare('SELECT email_verified AS v FROM users WHERE email = ?').get('legacy@bmsce.ac.in');
  assert.equal(Number(restored.v), 0);
});
