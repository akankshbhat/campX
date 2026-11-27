'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const MAX_IMAGE_SIZE = 3 * 1024 * 1024;
const MAX_BODY_SIZE = 13 * 1024 * 1024;
const CATEGORIES = new Set(['Books', 'Electronics', 'Lab & gear', 'Clothing', 'Sports', 'Events', 'Other']);
const TYPES = new Set(['free', 'rent', 'sale']);
const CONDITIONS = new Set(['new', 'like_new', 'good', 'fair']);
const EMAIL_DOMAIN = 'bmsce.ac.in';
const DOMAIN_ERROR = 'Access restricted. Please use your official BMSCE email address to register.';
const DOMAIN_LOGIN_ERROR = 'Access restricted. Please use your official BMSCE email address to log in.';

// Only exact bmsce.ac.in addresses pass: no sub-domains (bmsce.ac.in.example.com) and no look-alikes (notbmsce.ac.in).
function isCollegeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  const match = /^([^\s@]+)@([^\s@]+)$/.exec(email);
  return Boolean(match) && match[1].length <= 64 && match[2] === EMAIL_DOMAIN && email.length <= 254;
}

function loadEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

function makeId() {
  return crypto.randomUUID();
}

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function passwordMatches(password, stored) {
  const [salt, digest] = String(stored).split(':');
  if (!salt || !digest) return false;
  const actual = Buffer.from(passwordHash(password, salt).split(':')[1], 'hex');
  const expected = Buffer.from(digest, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function makeToken(userId, secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 7 * 86400 })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signature = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

function tokenUser(token, secret, db) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const unsigned = `${parts[0]}.${parts[1]}`;
    const expected = crypto.createHmac('sha256', secret).update(unsigned).digest();
    const actual = Buffer.from(parts[2], 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.sub || payload.exp <= Date.now() / 1000) return null;
    return db.prepare('SELECT id, email, name, student_id AS studentId, college, email_verified AS emailVerified FROM users WHERE id = ?').get(payload.sub) || null;
  } catch {
    return null;
  }
}

function initDatabase(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      student_id TEXT NOT NULL,
      college TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      verification_token_hash TEXT,
      verification_expires TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS listings (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('free', 'rent', 'sale')),
      price INTEGER NOT NULL DEFAULT 0,
      deposit INTEGER NOT NULL DEFAULT 0,
      condition TEXT NOT NULL,
      pickup_location TEXT NOT NULL DEFAULT '',
      images TEXT NOT NULL DEFAULT '[]',
      max_rental_days INTEGER NOT NULL DEFAULT 30,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      listing_id TEXT NOT NULL REFERENCES listings(id),
      owner_id TEXT NOT NULL REFERENCES users(id),
      requester_id TEXT NOT NULL REFERENCES users(id),
      type TEXT NOT NULL CHECK(type IN ('free', 'rent', 'sale')),
      status TEXT NOT NULL DEFAULT 'pending',
      start_date TEXT,
      end_date TEXT,
      fee INTEGER NOT NULL DEFAULT 0,
      deposit INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT NOT NULL,
      owner_handover INTEGER NOT NULL DEFAULT 0,
      requester_handover INTEGER NOT NULL DEFAULT 0,
      owner_return INTEGER NOT NULL DEFAULT 0,
      requester_return INTEGER NOT NULL DEFAULT 0,
      damage_notes TEXT,
      dispute_reason TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(requester_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS listings_active_created ON listings(active, created_at);
    CREATE INDEX IF NOT EXISTS listings_owner ON listings(owner_id);
    CREATE INDEX IF NOT EXISTS requests_owner_status ON requests(owner_id, status);
    CREATE INDEX IF NOT EXISTS requests_requester_status ON requests(requester_id, status);
    CREATE INDEX IF NOT EXISTS requests_listing_dates ON requests(listing_id, status, start_date, end_date);
  `);
  // Email verification was removed: existing accounts are marked verified so they keep working.
  db.exec('UPDATE users SET email_verified = 1, verification_token_hash = NULL, verification_expires = NULL WHERE email_verified = 0');
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readBody(req, limit = MAX_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(fail(413, 'Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  let value;
  try {
    value = JSON.parse((await readBody(req)).toString('utf8'));
  } catch (error) {
    if (error.status) throw error;
    throw fail(400, 'Request body must be valid JSON.');
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw fail(400, 'Request body must be a JSON object.');
  return value;
}

function parseMultipart(buffer, boundary) {
  const fields = Object.create(null);
  const files = [];
  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = buffer.indexOf(delimiter);
  while (cursor !== -1) {
    cursor += delimiter.length;
    if (buffer.subarray(cursor, cursor + 2).toString() === '--') break;
    if (buffer.subarray(cursor, cursor + 2).toString() === '\r\n') cursor += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd === -1) throw fail(400, 'Malformed multipart request.');
    const headers = buffer.subarray(cursor, headerEnd).toString('utf8');
    const next = buffer.indexOf(delimiter, headerEnd + 4);
    if (next === -1) throw fail(400, 'Malformed multipart request.');
    let dataEnd = next;
    if (buffer.subarray(dataEnd - 2, dataEnd).toString() === '\r\n') dataEnd -= 2;
    const disposition = /content-disposition:\s*form-data;([^]*)/i.exec(headers);
    const name = disposition && /(?:^|;)\s*name="([^"]*)"/i.exec(disposition[1]);
    const fileName = disposition && /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition[1]);
    if (!name) throw fail(400, 'Malformed multipart field.');
    const data = buffer.subarray(headerEnd + 4, dataEnd);
    if (fileName && fileName[1]) {
      const type = /content-type:\s*([^\r\n]+)/i.exec(headers);
      files.push({ field: name[1], originalName: path.basename(fileName[1]), type: type ? type[1].trim().toLowerCase() : '', data: Buffer.from(data) });
    } else {
      fields[name[1]] = data.toString('utf8');
    }
    cursor = next;
  }
  return { fields, files };
}

function imageExtension(file) {
  const b = file.data;
  if (file.type === 'image/jpeg' && b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (file.type === 'image/png' && b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (file.type === 'image/webp' && b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return null;
}

function userView(row) {
  return { id: row.id, email: row.email, name: row.name, studentId: row.studentId, college: row.college, emailVerified: Boolean(row.emailVerified) };
}

function listingView(row) {
  return {
    _id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    type: row.type,
    price: row.price,
    deposit: row.deposit,
    condition: row.condition,
    pickupLocation: row.pickup_location,
    images: JSON.parse(row.images),
    maxRentalDays: row.max_rental_days,
    createdAt: row.created_at,
    owner: { _id: row.owner_id, name: row.owner_name }
  };
}

function requestView(row) {
  return {
    _id: row.id,
    type: row.type,
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
    fee: row.fee,
    deposit: row.deposit,
    message: row.message,
    ownerHandover: Boolean(row.owner_handover),
    requesterHandover: Boolean(row.requester_handover),
    ownerReturn: Boolean(row.owner_return),
    requesterReturn: Boolean(row.requester_return),
    isOverdue: Boolean(row.end_date && row.end_date < new Date().toISOString().slice(0, 10) && row.status === 'handed_over'),
    owner: { id: row.owner_id, name: row.owner_name },
    requester: { id: row.requester_id, name: row.requester_name },
    listing: { _id: row.listing_id, title: row.title, images: JSON.parse(row.images || '[]') }
  };
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function createServer(options = {}) {
  loadEnv();
  const dataDir = options.dataDir || path.join(ROOT, 'data');
  const uploadDir = options.uploadDir || path.join(ROOT, 'uploads');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(uploadDir, { recursive: true });
  const db = options.db || new DatabaseSync(options.dbPath || path.join(dataDir, 'campx.sqlite'));
  initDatabase(db);
  const secret = options.jwtSecret || process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
  const clientOrigin = options.clientOrigin || process.env.CLIENT_ORIGIN || '';
  const log = options.log || console.log;

  function auth(req) {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    const user = match && tokenUser(match[1], secret, db);
    if (!user) throw fail(401, 'Please log in to continue.');
    return user;
  }

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && clientOrigin && origin === clientOrigin) {
      res.setHeader('Access-Control-Allow-Origin', clientOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /api/health') {
        json(res, 200, { status: 'ok', database: 'connected' });
        return;
      }

      if (route === 'POST /api/auth/register') {
        const body = await readJson(req);
        const name = String(body.name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const studentId = String(body.studentId || '').trim();
        const college = String(body.college || '').trim();
        const password = String(body.password || '');
        if (!isCollegeEmail(email)) throw fail(403, DOMAIN_ERROR);
        if (name.length < 2 || name.length > 60 ||
            studentId.length < 1 || studentId.length > 30 || college.length < 2 || college.length > 80 || password.length < 8 || password.length > 200) {
          throw fail(400, 'Enter a valid name, college email, student ID, college, and password (8–200 characters).');
        }
        const id = makeId();
        try {
          db.prepare('INSERT INTO users (id, email, name, student_id, college, password_hash, email_verified, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
            .run(id, email, name, studentId, college, passwordHash(password), new Date().toISOString());
        } catch (error) {
          if (String(error.message).includes('UNIQUE constraint failed')) throw fail(409, 'An account with this email already exists.');
          throw error;
        }
        json(res, 201, { message: 'Your account is ready. Log in to continue.' });
        return;
      }

      if (route === 'POST /api/auth/login') {
        const body = await readJson(req);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (!isCollegeEmail(email)) throw fail(403, DOMAIN_LOGIN_ERROR);
        const row = db.prepare(`SELECT id, email, name, student_id AS studentId, college, email_verified AS emailVerified, password_hash
          FROM users WHERE email = ?`).get(email);
        if (!row || !passwordMatches(password, row.password_hash)) throw fail(401, 'Email or password is incorrect.');
        json(res, 200, { user: userView(row), token: makeToken(row.id, secret) });
        return;
      }

      if (route === 'GET /api/auth/me') {
        json(res, 200, userView(auth(req)));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/listings') {
        auth(req);
        const page = Math.max(1, Math.min(10000, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1));
        const limit = Math.max(1, Math.min(50, Number.parseInt(url.searchParams.get('limit') || '12', 10) || 12));
        const sort = url.searchParams.get('sort');
        const order = sort === 'low' ? 'price ASC, created_at DESC' : sort === 'high' ? 'price DESC, created_at DESC' : 'created_at DESC';
        const conditions = ['l.active = 1'];
        const args = [];
        const type = url.searchParams.get('type');
        const category = url.searchParams.get('category');
        const query = (url.searchParams.get('q') || '').trim().slice(0, 100);
        if (TYPES.has(type)) { conditions.push('l.type = ?'); args.push(type); }
        if (CATEGORIES.has(category)) { conditions.push('l.category = ?'); args.push(category); }
        if (query) { conditions.push('(l.title LIKE ? OR l.description LIKE ?)'); args.push(`%${query}%`, `%${query}%`); }
        const where = conditions.join(' AND ');
        const total = db.prepare(`SELECT COUNT(*) AS count FROM listings l WHERE ${where}`).get(...args).count;
        const rows = db.prepare(`SELECT l.*, u.name AS owner_name FROM listings l JOIN users u ON u.id = l.owner_id
          WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
        json(res, 200, { items: rows.map(listingView), total });
        return;
      }

      const availability = /^\/api\/listings\/([0-9a-f-]+)\/availability$/i.exec(url.pathname);
      if (req.method === 'GET' && availability) {
        auth(req);
        const rows = db.prepare(`SELECT start_date, end_date FROM requests WHERE listing_id = ? AND status IN ('accepted', 'handed_over')
          ORDER BY start_date`).all(availability[1]);
        json(res, 200, { booked: rows.map((row) => ({ startDate: row.start_date, endDate: row.end_date })) });
        return;
      }

      if (route === 'POST /api/listings') {
        const user = auth(req);
        const contentType = req.headers['content-type'] || '';
        const boundary = /multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
        if (!boundary) throw fail(415, 'Listings must be submitted as multipart form data.');
        const parsed = parseMultipart(await readBody(req), boundary[1] || boundary[2]);
        const f = parsed.fields;
        const title = String(f.title || '').trim();
        const type = f.type;
        const category = f.category;
        const condition = f.condition;
        const price = Number(f.price);
        const deposit = Number(f.deposit || 0);
        if (title.length < 3 || title.length > 80 || !TYPES.has(type) || !CATEGORIES.has(category) || !CONDITIONS.has(condition) ||
            !Number.isSafeInteger(price) || price < 0 || !Number.isSafeInteger(deposit) || deposit < 0 ||
            (type !== 'free' && price <= 0) || (type === 'free' && price !== 0) || (type !== 'rent' && deposit !== 0)) {
          throw fail(400, 'Check the item name, category, type, condition, price, and deposit.');
        }
        if (parsed.files.some((file) => file.field !== 'images') || parsed.files.length > 4) throw fail(400, 'Choose up to 4 item photos.');
        const saved = [];
        try {
          for (const file of parsed.files) {
            if (file.data.length > MAX_IMAGE_SIZE || !imageExtension(file)) throw fail(400, 'Each photo must be a valid JPG, PNG, or WebP under 3 MB.');
            const name = `${makeId()}${imageExtension(file)}`;
            fs.writeFileSync(path.join(uploadDir, name), file.data, { flag: 'wx' });
            saved.push(`/uploads/${name}`);
          }
          const id = makeId();
          db.prepare(`INSERT INTO listings (id, owner_id, title, description, category, type, price, deposit, condition, pickup_location, images, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            id, user.id, title, String(f.description || '').trim().slice(0, 1000), category, type, price, deposit, condition,
            String(f.pickupLocation || '').trim().slice(0, 80), JSON.stringify(saved), new Date().toISOString()
          );
          json(res, 201, { _id: id });
        } catch (error) {
          for (const image of saved) fs.rmSync(path.join(uploadDir, path.basename(image)), { force: true });
          throw error;
        }
        return;
      }

      const listingDelete = /^\/api\/listings\/([0-9a-f-]+)$/i.exec(url.pathname);
      if (req.method === 'DELETE' && listingDelete) {
        const user = auth(req);
        const row = db.prepare('SELECT owner_id, images FROM listings WHERE id = ? AND active = 1').get(listingDelete[1]);
        if (!row) throw fail(404, 'Listing not found.');
        if (row.owner_id !== user.id) throw fail(403, 'Only the listing owner can remove it.');
        const pending = db.prepare("SELECT COUNT(*) AS count FROM requests WHERE listing_id = ? AND status IN ('accepted', 'handed_over')").get(listingDelete[1]).count;
        if (pending) throw fail(409, 'This listing has an active request and cannot be removed yet.');
        db.prepare('UPDATE listings SET active = 0 WHERE id = ?').run(listingDelete[1]);
        json(res, 200, { message: 'Listing removed.' });
        return;
      }

      if (route === 'POST /api/requests') {
        const user = auth(req);
        const body = await readJson(req);
        const listing = db.prepare('SELECT * FROM listings WHERE id = ? AND active = 1').get(String(body.listingId || ''));
        if (!listing) throw fail(404, 'This listing is no longer available.');
        if (listing.owner_id === user.id) throw fail(400, 'You cannot request your own listing.');
        const idempotencyKey = String(body.idempotencyKey || '');
        if (!/^[\w-]{8,100}$/.test(idempotencyKey)) throw fail(400, 'Please retry sending your request.');
        const message = String(body.message || '').trim();
        if (message.length > 500) throw fail(400, 'Your message must be 500 characters or less.');
        let startDate = null, endDate = null, fee = listing.price, deposit = 0;
        if (listing.type !== 'sale') {
          startDate = listing.type === 'rent' ? body.startDate : new Date().toISOString().slice(0, 10);
          endDate = body.endDate;
          if (!validDate(startDate) || !validDate(endDate) || endDate <= startDate) throw fail(400, 'Choose valid pickup and return dates.');
          const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000);
          if (days > listing.max_rental_days) throw fail(400, `The maximum borrowing period is ${listing.max_rental_days} days.`);
          if (startDate < new Date().toISOString().slice(0, 10)) throw fail(400, 'The pickup date cannot be in the past.');
          fee = listing.type === 'rent' ? days * listing.price : 0;
          deposit = listing.type === 'rent' ? listing.deposit : 0;
        }
        const duplicate = db.prepare('SELECT id FROM requests WHERE requester_id = ? AND idempotency_key = ?').get(user.id, idempotencyKey);
        if (duplicate) {
          json(res, 200, { _id: duplicate.id });
          return;
        }
        const id = makeId();
        db.prepare(`INSERT INTO requests (id, listing_id, owner_id, requester_id, type, start_date, end_date, fee, deposit, message, idempotency_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, listing.id, listing.owner_id, user.id, listing.type, startDate, endDate, fee, deposit, message, idempotencyKey, new Date().toISOString()
        );
        json(res, 201, { _id: id });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/requests') {
        const user = auth(req);
        const role = url.searchParams.get('role');
        if (role !== 'requester' && role !== 'owner') throw fail(400, 'Choose requester or owner.');
        const column = role === 'owner' ? 'owner_id' : 'requester_id';
        const rows = db.prepare(`SELECT r.*, l.title, l.images, owner.name AS owner_name, requester.name AS requester_name
          FROM requests r JOIN listings l ON l.id = r.listing_id
          JOIN users owner ON owner.id = r.owner_id JOIN users requester ON requester.id = r.requester_id
          WHERE r.${column} = ? ORDER BY r.created_at DESC LIMIT 50`).all(user.id);
        json(res, 200, rows.map(requestView));
        return;
      }

      const requestAction = /^\/api\/requests\/([0-9a-f-]+)\/(accept|reject|cancel|handover|return|dispute)$/i.exec(url.pathname);
      if (requestAction && ['PATCH', 'POST'].includes(req.method)) {
        const user = auth(req);
        const [, id, action] = requestAction;
        const request = db.prepare('SELECT * FROM requests WHERE id = ?').get(id);
        if (!request) throw fail(404, 'Request not found.');
        if (request.owner_id !== user.id && request.requester_id !== user.id) throw fail(403, 'You are not part of this request.');
        const body = ['dispute', 'reject'].includes(action) || (action === 'return' && req.headers['content-type'] === 'application/json')
          ? await readJson(req)
          : {};
        const owner = request.owner_id === user.id;
        const update = (sql, ...args) => db.prepare(sql).run(...args, id);

        if (action === 'accept' || action === 'reject') {
          if (!owner || request.status !== 'pending') throw fail(409, 'Only the owner can respond to a pending request.');
          if (action === 'accept') {
            if (request.type === 'sale') {
              const acceptedSale = db.prepare("SELECT id FROM requests WHERE listing_id = ? AND id != ? AND status IN ('accepted', 'handed_over')")
                .get(request.listing_id, id);
              if (acceptedSale) throw fail(409, 'Another purchase request is already in progress for this listing.');
            } else if (request.start_date) {
              const conflict = db.prepare(`SELECT id FROM requests WHERE listing_id = ? AND id != ? AND status IN ('accepted', 'handed_over')
                AND start_date <= ? AND end_date >= ?`).get(request.listing_id, id, request.end_date, request.start_date);
              if (conflict) throw fail(409, 'Those dates are no longer available.');
            }
            update("UPDATE requests SET status = 'accepted' WHERE id = ?");
          } else {
            update("UPDATE requests SET status = 'rejected' WHERE id = ?");
          }
        } else if (action === 'cancel') {
          if (request.status === 'pending' && request.requester_id === user.id) {
            update("UPDATE requests SET status = 'cancelled' WHERE id = ?");
          } else if (request.status === 'accepted' && !request.owner_handover && !request.requester_handover) {
            update("UPDATE requests SET status = 'cancelled' WHERE id = ?");
          } else {
            throw fail(409, 'This request can no longer be cancelled.');
          }
        } else if (action === 'handover') {
          if (request.status !== 'accepted') throw fail(409, 'This request is not awaiting a handover.');
          update(`UPDATE requests SET ${owner ? 'owner_handover' : 'requester_handover'} = 1,
            status = CASE WHEN ${owner ? 'requester_handover' : 'owner_handover'} = 1 THEN 'handed_over' ELSE status END WHERE id = ?`);
        } else if (action === 'return') {
          if (body.damaged === true) {
            if (!owner || request.status !== 'handed_over') throw fail(409, 'Only the owner can report damage during an active exchange.');
            const notes = String(body.notes || '').trim().slice(0, 1000);
            update("UPDATE requests SET status = 'disputed', damage_notes = ? WHERE id = ?", notes);
          } else {
            if (request.status !== 'handed_over') throw fail(409, 'This request is not awaiting a return.');
            update(`UPDATE requests SET ${owner ? 'owner_return' : 'requester_return'} = 1,
              status = CASE WHEN ${owner ? 'requester_return' : 'owner_return'} = 1 THEN 'completed' ELSE status END WHERE id = ?`);
            if (request.type === 'sale' && request.status !== 'completed') {
              const updated = db.prepare('SELECT status FROM requests WHERE id = ?').get(id);
              if (updated.status === 'completed') db.prepare('UPDATE listings SET active = 0 WHERE id = ?').run(request.listing_id);
            }
          }
        } else if (action === 'dispute') {
          const reason = String(body.reason || '').trim();
          if (reason.length < 10 || reason.length > 1000 || !['pending', 'accepted', 'handed_over'].includes(request.status)) {
            throw fail(400, 'Enter a dispute reason of 10–1000 characters for an active request.');
          }
          update("UPDATE requests SET status = 'disputed', dispute_reason = ? WHERE id = ?", reason);
        }
        json(res, 200, { message: 'Request updated.' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/') {
        serveFile(res, path.join(ROOT, 'index.html'));
        return;
      }
      if (req.method === 'GET' && ['/index.html', '/style.css', '/script.js'].includes(url.pathname)) {
        serveFile(res, path.join(ROOT, url.pathname.slice(1)));
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/uploads/')) {
        const name = path.basename(url.pathname);
        if (name !== url.pathname.slice('/uploads/'.length)) throw fail(404, 'File not found.');
        serveFile(res, path.join(uploadDir, name));
        return;
      }
      throw fail(404, 'Not found.');
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const status = error.status || 500;
      if (status === 500) log(error);
      json(res, status, { error: status === 500 ? 'The server could not complete this request.' : error.message });
    }
  });

  return { server, db };
}

function serveFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    json(res, 404, { error: 'File not found.' });
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

if (require.main === module) {
  const { server } = createServer();
  const port = Number(process.env.PORT || 5000);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => {
    console.log(`CampX is running at http://localhost:${port}`);
    console.log(`SQLite database: ${path.join(ROOT, 'data', 'campx.sqlite')}`);
    if (!process.env.JWT_SECRET) console.warn('JWT_SECRET is unset; login tokens will expire when the server restarts.');
  });
}

module.exports = { createServer, passwordHash, isCollegeEmail };
