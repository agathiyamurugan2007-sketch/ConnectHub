let csrf, me, feedPage = 1;
const $ = s => document.querySelector(s), app = $('#app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = d => new Date(d.replace(' ', 'T') + 'Z').toLocaleString();
const av = (u, big) => u.avatar_path ? `<img class="av ${big ? 'big' : ''}" src="${esc(u.avatar_path)}" alt="">` : `<span class="av ${big ? 'big' : ''}">${esc(u.full_name[0].toUpperCase())}</span>`;
function toast(m, ok) { const t = $('#toast'); t.textContent = m; t.className = ok ? 'good' : 'err'; t.style.display = 'block'; clearTimeout(t.t); t.t = setTimeout(() => t.style.display = 'none', 3000); }
async function api(u, method = 'GET', body) {
  const o = { method, headers: {} };
  if (method !== 'GET') o.headers['x-csrf-token'] = csrf;
  if (body instanceof FormData) o.body = body; else if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  const r = await fetch('/api' + u, o), d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

function nav() {
  const h = location.hash || '#/';
  const a = (href, t) => `<a href="${href}" class="${h === href ? 'active' : ''}">${t}</a>`;
  $('#links').innerHTML = me ? a('#/', 'Home') + a('#/explore', 'Explore') + a('#/', 'Create Post') + `<a href="#/" title="Demo only" onclick="event.preventDefault();toast('Notifications are a demo feature (not implemented)',true)">🔔 Notifications (demo)</a>`
    + a('#/profile/' + me.id, 'Profile') + '<button id="logout">Logout</button>' : a('#/login', 'Login') + a('#/register', 'Register');
  $('#logout')?.addEventListener('click', guard(async () => { await api('/auth/logout', 'POST'); me = null; location.hash = '#/login'; route(); }));
}
$('#menu').onclick = () => $('#links').classList.toggle('open');

function postHtml(p) {
  const own = p.user_id === me.id;
  return `<article class="card post" data-id="${p.id}"><div class="row">${av(p)}<div class="grow"><a href="#/profile/${p.user_id}"><b>${esc(p.full_name)}</b></a> <span class="muted">@${esc(p.username)} · ${when(p.created_at)}${p.updated_at !== p.created_at ? ' (edited)' : ''}</span></div></div>
  ${p.content ? `<p>${esc(p.content)}</p>` : ''}${p.image_path ? `<img class="post-img" src="${esc(p.image_path)}" alt="Post image">` : ''}
  <div class="acts"><button data-act="like" class="${p.liked ? 'liked' : ''}">${p.liked ? '♥' : '♡'} ${p.like_count}</button><button data-act="comments">💬 ${p.comment_count}</button>
  <a href="#/profile/${p.user_id}" style="padding:6px 10px">View Profile</a>${own ? '<button data-act="edit">Edit</button><button data-act="del">Delete</button>' : ''}</div><div class="comments" hidden></div></article>`;
}
const userRow = u => `<div class="row" style="margin-bottom:10px">${av(u)}<div class="grow"><a href="#/profile/${u.id}"><b>${esc(u.full_name)}</b></a><div class="muted">@${esc(u.username)}</div></div>${followBtn(u)}</div>`;
const followBtn = u => `<button class="btn ${u.is_following ? 'alt' : ''}" data-act="follow" data-uid="${u.id}" data-on="${u.is_following}">${u.is_following ? 'Unfollow' : 'Follow'}</button>`;

async function loadPosts(url, box, more, reset) {
  if (reset) { feedPage = 1; box.innerHTML = ''; }
  const d = await api(`${url}${url.includes('?') ? '&' : '?'}page=${feedPage}&limit=5`);
  box.insertAdjacentHTML('beforeend', d.posts.map(postHtml).join(''));
  if (!box.children.length) box.innerHTML = '<div class="card empty">No posts yet. Be the first to share something!</div>';
  more.hidden = !d.has_more; more.onclick = guard(() => { feedPage++; return loadPosts(url, box, more); });
}
async function suggested(el) { const d = await api('/users?suggested=1'); el.innerHTML = '<h3>Suggested users</h3><br>' + (d.users.slice(0, 5).map(userRow).join('') || '<div class="muted">No suggestions right now.</div>'); }

async function feedView() {
  app.innerHTML = `<div class="wrap"><section><form class="card" id="pf"><textarea name="content" rows="3" maxlength="1000" placeholder="What's on your mind?"></textarea>
  <img id="prev" class="post-img" hidden alt="Preview"><div class="row"><input type="file" name="image" accept="image/png,image/jpeg,image/gif,image/webp" aria-label="Image"><button class="btn">Publish</button></div></form>
  <div id="posts"><div class="empty">Loading…</div></div><button class="btn alt" id="more" hidden style="width:100%">Load more</button></section><aside><div class="card" id="sug">Loading…</div></aside></div>`;
  const f = $('#pf'), img = f.image;
  img.onchange = () => { const p = $('#prev'); p.hidden = !img.files[0]; if (img.files[0]) p.src = URL.createObjectURL(img.files[0]); };
  f.onsubmit = guard(async e => { e.preventDefault(); await api('/posts', 'POST', new FormData(f)); f.reset(); $('#prev').hidden = true; toast('Posted!', true); await loadPosts('/posts', $('#posts'), $('#more'), true); });
  suggested($('#sug')).catch(() => { });
  await loadPosts('/posts', $('#posts'), $('#more'), true);
}
async function exploreView() {
  app.innerHTML = `<div class="wrap" style="grid-template-columns:1fr"><div class="card"><input id="q" placeholder="Search by name or username" aria-label="Search users"><div id="res"></div></div></div>`;
  const run = guard(async () => { const d = await api('/users?q=' + encodeURIComponent($('#q').value)); $('#res').innerHTML = d.users.map(userRow).join('') || '<div class="empty">No users found.</div>'; });
  let t; $('#q').oninput = () => { clearTimeout(t); t = setTimeout(run, 250); }; run();
}
async function profileView(uid) {
  const { user: u } = await api('/users/' + uid), mine = u.id === me.id;
  app.innerHTML = `<div class="wrap"><section><div class="card"><div class="row">${av(u, true)}<div class="grow"><h2>${esc(u.full_name)}</h2><div class="muted">@${esc(u.username)}</div><p>${esc(u.bio) || '<span class="muted">No bio yet.</span>'}</p>
  <b>${u.posts}</b> posts · <b>${u.followers}</b> followers · <b>${u.following}</b> following</div>${mine ? '<button class="btn alt" id="edit">Edit Profile</button>' : followBtn(u)}</div><form id="ef" hidden style="margin-top:14px">
  <input name="full_name" value="${esc(u.full_name)}" maxlength="60" required><textarea name="bio" maxlength="200" rows="2" placeholder="Bio">${esc(u.bio)}</textarea><input type="file" name="avatar" accept="image/*" aria-label="Avatar"><button class="btn">Save</button></form></div>
  <div id="posts"></div><button class="btn alt" id="more" hidden style="width:100%">Load more</button></section><aside></aside></div>`;
  $('#edit')?.addEventListener('click', () => $('#ef').hidden = !$('#ef').hidden);
  $('#ef').onsubmit = guard(async e => { e.preventDefault(); await api('/users/me', 'PUT', new FormData(e.target)); me = (await api('/auth/me')).user; toast('Profile updated', true); profileView(uid); });
  await loadPosts(`/users/${uid}/posts`, $('#posts'), $('#more'), true);
}
function authView(reg) {
  const fld = (n, l, t = 'text') => `<label>${l}<input name="${n}" type="${t}" required></label>`;
  app.innerHTML = `<form class="card auth" id="af"><h2>${reg ? 'Create account' : 'Welcome back'}</h2><br>${reg ? fld('full_name', 'Full name') + fld('username', 'Username') + fld('email', 'Email', 'email') : fld('identifier', 'Username or email')}
  ${fld('password', 'Password', 'password')}${reg ? fld('confirm_password', 'Confirm password', 'password') : ''}<button class="btn" style="width:100%">${reg ? 'Register' : 'Login'}</button>
  <p class="muted">${reg ? 'Have an account? <a href="#/login">Login</a>' : 'New? <a href="#/register">Register</a>'}</p></form>`;
  $('#af').onsubmit = guard(async e => {
    e.preventDefault(); const b = Object.fromEntries(new FormData(e.target));
    if (reg && b.password !== b.confirm_password) throw new Error('Passwords do not match');
    me = (await api(reg ? '/auth/register' : '/auth/login', 'POST', b)).user; location.hash = '#/'; route();
  });
}

// Event delegation for post/follow actions
document.addEventListener('click', guard(async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const act = b.dataset.act, card = b.closest('.post'), pid = card?.dataset.id;
  const refresh = p => card.outerHTML = postHtml(p);
  if (act === 'follow') { const r = await api(`/users/${b.dataset.uid}/follow`, b.dataset.on === 'true' ? 'DELETE' : 'POST'); toast(r.user.is_following ? 'Followed' : 'Unfollowed', true); route(); }
  else if (act === 'like') refresh((await api(`/posts/${pid}/like`, b.classList.contains('liked') ? 'DELETE' : 'POST')).post);
  else if (act === 'del') { if (confirm('Delete this post?')) { await api('/posts/' + pid, 'DELETE'); card.remove(); toast('Post deleted', true); } }
  else if (act === 'edit') { const t = prompt('Edit post', card.querySelector('p')?.textContent || ''); if (t !== null) refresh((await api('/posts/' + pid, 'PUT', { content: t })).post); }
  else if (act === 'comments') { const c = card.querySelector('.comments'); c.hidden = !c.hidden; if (!c.hidden) await loadComments(card, pid); }
  else if (act === 'delc') { if (confirm('Delete this comment?')) { await api('/comments/' + b.dataset.cid, 'DELETE'); await loadComments(card, pid, true); } }
}));
async function loadComments(card, pid, updateCount) {
  const c = card.querySelector('.comments'), { comments } = await api(`/posts/${pid}/comments`);
  c.innerHTML = (comments.map(x => `<div class="row">${av(x)}<div class="grow"><b>${esc(x.full_name)}</b> <span class="muted">${when(x.created_at)}</span><div>${esc(x.content)}</div></div>${x.user_id === me.id || +card.querySelector('[data-act=del]') ? `<button data-act="delc" data-cid="${x.id}" class="btn alt">✕</button>` : ''}</div>`).join('') || '<div class="muted">No comments yet.</div>')
    + '<form class="cf row"><input maxlength="300" placeholder="Write a comment…" required aria-label="Comment"><button class="btn">Send</button></form>';
  card.querySelector('[data-act=comments]').textContent = '💬 ' + comments.length;
  c.querySelector('.cf').onsubmit = guard(async e => { e.preventDefault(); await api(`/posts/${pid}/comments`, 'POST', { content: e.target.querySelector('input').value }); await loadComments(card, pid); });
}

async function route() {
  nav(); const h = (location.hash || '#/').slice(1), [, seg, arg] = h.split('/');
  try {
    if (!me && seg !== 'register') return authView(false);
    if (me && (seg === 'login' || seg === 'register')) { location.hash = '#/'; return; }
    if (seg === 'register') return authView(true);
    app.innerHTML = '<div class="empty">Loading…</div>';
    if (seg === 'explore') await exploreView(); else if (seg === 'profile') await profileView(arg); else await feedView();
  } catch (e) { app.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', route);
(async () => { csrf = (await api('/csrf')).csrf; me = (await api('/auth/me')).user; route(); })();
