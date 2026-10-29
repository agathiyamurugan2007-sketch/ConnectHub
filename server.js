require('dotenv').config();
const express = require('express'), session = require('express-session'), helmet = require('helmet');
const rateLimit = require('express-rate-limit'), multer = require('multer'), bcrypt = require('bcryptjs');
const crypto = require('crypto'), fs = require('fs'), path = require('path'), db = require('./database/db');

const prod = process.env.NODE_ENV === 'production';
const UP = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(UP, { recursive: true });
class HttpErr extends Error { constructor(s, m) { super(m); this.status = s; } }
const must = (x, m = 'Not found') => { if (!x) throw new HttpErr(404, m); return x; };
const id = v => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new HttpErr(400, 'Invalid id'); return n; };
const clean = s => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
const auth = (q, r, n) => q.session.userId ? n() : r.status(401).json({ error: 'Please log in first' });
const me = q => q.session.userId;

const app = express();
app.use(helmet({ contentSecurityPolicy: { directives: {
  imgSrc: ["'self'", 'data:', 'blob:'], styleSrc: ["'self'", 'https://fonts.googleapis.com'],
  fontSrc: ['https://fonts.gstatic.com'], scriptSrc: ["'self'"], upgradeInsecureRequests: null } } }));
app.use(express.json({ limit: '10kb' }));
app.use(session({ name: 'ch.sid', secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false, saveUninitialized: true, cookie: { httpOnly: true, sameSite: 'lax', secure: prod, maxAge: 6048e5 } }));
app.use(express.static(path.join(__dirname, 'public')));

// CSRF: client fetches a token, sends it in x-csrf-token on every non-GET request
app.get('/api/csrf', (q, r) => { q.session.csrf ??= crypto.randomBytes(24).toString('hex'); r.json({ csrf: q.session.csrf }); });
app.use('/api', (q, r, n) => (q.method === 'GET' || (q.session.csrf && q.headers['x-csrf-token'] === q.session.csrf)) ? n() : r.status(403).json({ error: 'Invalid CSRF token' }));

// Image upload: size limit + magic-byte check + random filename (client filename/MIME never trusted)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
function saveImg(f) {
  if (!f) return null;
  const b = f.buffer, h = b.subarray(0, 12);
  const ext = h.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'jpg' : h.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])) ? 'png'
    : h.subarray(0, 4).toString() === 'GIF8' ? 'gif' : (h.subarray(0, 4).toString() === 'RIFF' && h.subarray(8, 12).toString() === 'WEBP') ? 'webp' : null;
  if (!ext) throw new HttpErr(400, 'Only JPG, PNG, GIF or WEBP images are allowed');
  const name = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(UP, name), b);
  return '/uploads/' + name;
}

// ---------- Auth ----------
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: process.env.NODE_ENV === 'test' ? 1000 : 30, message: { error: 'Too many attempts, try again later' } });
const USER_SQL = `SELECT id,full_name,username,bio,avatar_path,created_at,
 (SELECT COUNT(*) FROM posts WHERE user_id=u.id) posts,
 (SELECT COUNT(*) FROM follows WHERE following_id=u.id) followers,
 (SELECT COUNT(*) FROM follows WHERE follower_id=u.id) following,
 EXISTS(SELECT 1 FROM follows WHERE follower_id=@me AND following_id=u.id) is_following FROM users u`;
const getUser = (uid, viewer) => db.prepare(USER_SQL + ' WHERE id=@id').get({ id: uid, me: viewer || 0 });

app.post('/api/auth/register', authLimit, (q, r) => {
  const full_name = clean(q.body.full_name), username = clean(q.body.username), email = clean(q.body.email).toLowerCase(), pw = String(q.body.password ?? '');
  if (full_name.length < 2 || full_name.length > 60) throw new HttpErr(400, 'Full name must be 2-60 characters');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new HttpErr(400, 'Username: 3-20 letters, numbers or underscore');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) throw new HttpErr(400, 'Enter a valid email');
  if (pw.length < 8 || pw.length > 72 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new HttpErr(400, 'Password: 8+ characters with a letter and a number');
  if (pw !== q.body.confirm_password) throw new HttpErr(400, 'Passwords do not match');
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) throw new HttpErr(409, 'Username already taken');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpErr(409, 'Email already registered');
  const uid = db.prepare('INSERT INTO users(full_name,username,email,password_hash) VALUES(?,?,?,?)').run(full_name, username, email, bcrypt.hashSync(pw, 10)).lastInsertRowid;
  q.session.userId = uid;
  r.status(201).json({ user: getUser(uid, uid) });
});
app.post('/api/auth/login', authLimit, (q, r) => {
  const ident = clean(q.body.identifier), u = db.prepare('SELECT id,password_hash FROM users WHERE username=? OR email=?').get(ident, ident);
  if (!u || !bcrypt.compareSync(String(q.body.password ?? ''), u.password_hash)) throw new HttpErr(401, 'Invalid username/email or password');
  q.session.userId = u.id;
  r.json({ user: getUser(u.id, u.id) });
});
app.post('/api/auth/logout', (q, r) => { q.session.userId = null; r.json({ ok: true }); });
app.get('/api/auth/me', (q, r) => r.json({ user: me(q) ? getUser(me(q), me(q)) : null }));

// ---------- Users ----------
app.get('/api/users', auth, (q, r) => {
  const s = clean(q.query.q).replace(/[%_]/g, '');
  let sql = USER_SQL + ' WHERE id<>@me', p = { me: me(q) };
  if (s) { sql += ' AND (full_name LIKE @s OR username LIKE @s)'; p.s = `%${s}%`; }
  if (q.query.suggested) sql += ' AND is_following=0';
  r.json({ users: db.prepare(sql + ' ORDER BY followers DESC, id DESC LIMIT 20').all(p) });
});
app.get('/api/users/:id', auth, (q, r) => r.json({ user: must(getUser(id(q.params.id), me(q)), 'User not found') }));
app.put('/api/users/me', auth, upload.single('avatar'), (q, r) => {
  const name = clean(q.body.full_name), bio = clean(q.body.bio);
  if (name.length < 2 || name.length > 60) throw new HttpErr(400, 'Full name must be 2-60 characters');
  if (bio.length > 200) throw new HttpErr(400, 'Bio max 200 characters');
  const av = saveImg(q.file);
  db.prepare('UPDATE users SET full_name=?,bio=?,avatar_path=COALESCE(?,avatar_path) WHERE id=?').run(name, bio, av, me(q));
  r.json({ user: getUser(me(q), me(q)) });
});
const list = col => (q, r) => {
  const uid = id(q.params.id); must(getUser(uid), 'User not found');
  const other = col === 'follower_id' ? 'following_id' : 'follower_id';
  r.json({ users: db.prepare(`SELECT id,full_name,username,avatar_path FROM users WHERE id IN (SELECT ${col} FROM follows WHERE ${other}=?)`).all(uid) });
};
app.get('/api/users/:id/followers', auth, list('follower_id'));
app.get('/api/users/:id/following', auth, list('following_id'));
app.post('/api/users/:id/follow', auth, (q, r) => {
  const t = id(q.params.id); must(getUser(t), 'User not found');
  if (t === me(q)) throw new HttpErr(400, 'You cannot follow yourself');
  db.prepare('INSERT OR IGNORE INTO follows(follower_id,following_id) VALUES(?,?)').run(me(q), t);
  r.json({ user: getUser(t, me(q)) });
});
app.delete('/api/users/:id/follow', auth, (q, r) => {
  const t = id(q.params.id); must(getUser(t), 'User not found');
  db.prepare('DELETE FROM follows WHERE follower_id=? AND following_id=?').run(me(q), t);
  r.json({ user: getUser(t, me(q)) });
});

// ---------- Posts ----------
const POST_SQL = `SELECT p.id,p.user_id,p.content,p.image_path,p.created_at,p.updated_at,u.username,u.full_name,u.avatar_path,
 (SELECT COUNT(*) FROM likes WHERE post_id=p.id) like_count,(SELECT COUNT(*) FROM comments WHERE post_id=p.id) comment_count,
 EXISTS(SELECT 1 FROM likes WHERE post_id=p.id AND user_id=@me) liked FROM posts p JOIN users u ON u.id=p.user_id`;
const getPost = (pid, viewer) => db.prepare(POST_SQL + ' WHERE p.id=@id').get({ id: pid, me: viewer });
const page = q => { const l = Math.min(Math.max(parseInt(q.query.limit) || 10, 1), 50), p = Math.max(parseInt(q.query.page) || 1, 1); return { limit: l + 1, offset: (p - 1) * l, l }; };
const paged = (rows, l) => ({ posts: rows.slice(0, l), has_more: rows.length > l });
app.get('/api/posts', auth, (q, r) => { const g = page(q); const rows = db.prepare(POST_SQL + ' ORDER BY p.created_at DESC,p.id DESC LIMIT @limit OFFSET @offset').all({ me: me(q), limit: g.limit, offset: g.offset }); r.json(paged(rows, g.l)); });
app.get('/api/users/:id/posts', auth, (q, r) => { const g = page(q); const rows = db.prepare(POST_SQL + ' WHERE p.user_id=@uid ORDER BY p.created_at DESC,p.id DESC LIMIT @limit OFFSET @offset').all({ me: me(q), uid: id(q.params.id), limit: g.limit, offset: g.offset }); r.json(paged(rows, g.l)); });
app.post('/api/posts', auth, upload.single('image'), (q, r) => {
  const content = clean(q.body.content);
  if (content.length > 1000) throw new HttpErr(400, 'Post max 1000 characters');
  if (!content && !q.file) throw new HttpErr(400, 'Write something or attach an image');
  const img = saveImg(q.file);
  const pid = db.prepare('INSERT INTO posts(user_id,content,image_path) VALUES(?,?,?)').run(me(q), content, img).lastInsertRowid;
  r.status(201).json({ post: getPost(pid, me(q)) });
});
app.get('/api/posts/:id', auth, (q, r) => r.json({ post: must(getPost(id(q.params.id), me(q)), 'Post not found') }));
app.put('/api/posts/:id', auth, (q, r) => {
  const p = must(db.prepare('SELECT * FROM posts WHERE id=?').get(id(q.params.id)), 'Post not found');
  if (p.user_id !== me(q)) throw new HttpErr(403, 'You can only edit your own posts');
  const content = clean(q.body.content);
  if (content.length > 1000 || (!content && !p.image_path)) throw new HttpErr(400, 'Invalid post content');
  db.prepare("UPDATE posts SET content=?,updated_at=datetime('now') WHERE id=?").run(content, p.id);
  r.json({ post: getPost(p.id, me(q)) });
});
app.delete('/api/posts/:id', auth, (q, r) => {
  const p = must(db.prepare('SELECT * FROM posts WHERE id=?').get(id(q.params.id)), 'Post not found');
  if (p.user_id !== me(q)) throw new HttpErr(403, 'You can only delete your own posts');
  db.prepare('DELETE FROM posts WHERE id=?').run(p.id);
  if (p.image_path) fs.unlink(path.join(UP, path.basename(p.image_path)), () => {});
  r.json({ ok: true });
});

// ---------- Likes ----------
const likeRoute = add => (q, r) => {
  const pid = id(q.params.id); must(db.prepare('SELECT 1 FROM posts WHERE id=?').get(pid), 'Post not found');
  add ? db.prepare('INSERT OR IGNORE INTO likes(post_id,user_id) VALUES(?,?)').run(pid, me(q)) : db.prepare('DELETE FROM likes WHERE post_id=? AND user_id=?').run(pid, me(q));
  r.json({ post: getPost(pid, me(q)) });
};
app.post('/api/posts/:id/like', auth, likeRoute(true));
app.delete('/api/posts/:id/like', auth, likeRoute(false));

// ---------- Comments ----------
app.get('/api/posts/:id/comments', auth, (q, r) => {
  const pid = id(q.params.id); must(db.prepare('SELECT 1 FROM posts WHERE id=?').get(pid), 'Post not found');
  r.json({ comments: db.prepare('SELECT c.id,c.user_id,c.content,c.created_at,u.username,u.full_name,u.avatar_path FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=? ORDER BY c.id').all(pid) });
});
app.post('/api/posts/:id/comments', auth, (q, r) => {
  const pid = id(q.params.id); must(db.prepare('SELECT 1 FROM posts WHERE id=?').get(pid), 'Post not found');
  const c = clean(q.body.content);
  if (!c || c.length > 300) throw new HttpErr(400, 'Comment must be 1-300 characters');
  db.prepare('INSERT INTO comments(post_id,user_id,content) VALUES(?,?,?)').run(pid, me(q), c);
  r.status(201).json({ post: getPost(pid, me(q)) });
});
app.delete('/api/comments/:id', auth, (q, r) => {
  const c = must(db.prepare('SELECT c.*,p.user_id post_owner FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.id=?').get(id(q.params.id)), 'Comment not found');
  if (c.user_id !== me(q) && c.post_owner !== me(q)) throw new HttpErr(403, 'Not allowed to delete this comment');
  db.prepare('DELETE FROM comments WHERE id=?').run(c.id);
  r.json({ post: getPost(c.post_id, me(q)) });
});

// ---------- Errors ----------
app.use('/api', (q, r) => r.status(404).json({ error: 'Endpoint not found' }));
app.use((e, q, r, n) => {
  const s = e.status || (e.code === 'LIMIT_FILE_SIZE' ? 400 : 500);
  if (s === 500) console.error(e);
  r.status(s).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'Image must be 2 MB or smaller' : s === 500 ? 'Server error' : e.message });
});

module.exports = app;
if (require.main === module) {
  const start = port => app.listen(port, () => console.log(`ConnectHub running at http://localhost:${port}`)).on('error', e => e.code === 'EADDRINUSE' ? start(port + 1) : (() => { throw e; })());
  start(Number(process.env.PORT) || 3000);
}
