import { getIni } from '/Javascript/global.js?v=20261011';

// 資料庫 = GitHub 靜態 JSON（不再經 GAS）
// 文章 -> spiritref.github.io/Data/postFB.json
// 服務 -> INI JsonService 指向的檔案

const GITHUB_USER = 'SpiritRef';
const GHOST_REPO = 'ghoststory';
const JSON_REPO = 'spiritref.github.io';
const VERSION_PATH = 'Data/postFB.version.json';

let session = null;
let jsonPostsPath = 'Data/postFB.json';
let jsonSvcPath = '';
let allPosts = [];
let allSvc = [];
let allNotices = [];
let editing = null; // {kind:'post'|'svc'|'notice'}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

function setStatus(msg, color = '#4a2e1b') {
	const el = $('status');
	el.innerText = msg;
	el.style.color = color;
}

// 管理密碼 = 原本邏輯：送 GAS 換 GitHub token（圖片＋JSON＋刪除共用）
let authUrl = '';
let finalToken = '';

async function getToken() {
	if (finalToken) return finalToken;
	const name = $('adminPwd').value.trim();
	if (name) sessionStorage.setItem('admin_pwd', name);
	const user = name || sessionStorage.getItem('admin_pwd') || '';
	if (!user) throw new Error('請先輸入管理密碼');
	if (!authUrl) throw new Error('INI 缺少 updateGithub_URL');
	const res = await fetch(atob(authUrl), { method: 'POST', body: JSON.stringify({ action: 'getGithubToken', user }) });
	const j = await res.json();
	if (!j.success) throw new Error('身分驗證失敗：' + (j.message || ''));
	finalToken = j.githubToken;
	return finalToken;
}

function ghHeaders(pat) {
	return {
		Authorization: `token ${pat}`,
		Accept: 'application/vnd.github.v3+json',
		'Content-Type': 'application/json'
	};
}

function toB64(s) {
	const b = new TextEncoder().encode(s);
	let o = '';
	for (let i = 0; i < b.length; i += 0x8000) o += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
	return btoa(o);
}

function fromB64(b64) {
	const bin = atob(b64.replace(/\s/g, ''));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

async function fetchJson(url) {
	const sep = url.includes('?') ? '&' : '?';
	const r = await fetch(`${url}${sep}t=${Date.now()}`, { cache: 'no-store' });
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return r.json();
}

async function ensurePat() {
	return getToken();
}

// GitHub 讀-改-寫：transform(arr) 回傳新陣列；409 自動重試一次
async function ghModifyJson(pat, repo, path, transform, message) {
	for (let attempt = 0; attempt < 2; attempt++) {
		const api = `https://api.github.com/repos/${GITHUB_USER}/${repo}/contents/${path}`;
		const h = ghHeaders(pat);
		let sha = null;
		let arr = [];
		const g = await fetch(api, { headers: h });
		if (g.ok) {
			const j = await g.json();
			sha = j.sha;
			arr = JSON.parse(fromB64(j.content));
			if (!Array.isArray(arr)) throw new Error(`${path} 內容不是陣列`);
		} else if (g.status !== 404) {
			throw new Error(`讀取 ${path} 失敗: HTTP ${g.status}（token 無效或權限不足？）`);
		}
		const next = transform(arr);
		const body = { message, content: toB64(JSON.stringify(next, null, 1)) };
		if (sha) body.sha = sha;
		const p = await fetch(api, { method: 'PUT', headers: h, body: JSON.stringify(body) });
		if (p.status === 409 && attempt === 0) continue; // 有人同時寫入，重抓再試
		if (!p.ok) throw new Error(`寫入 ${path} 失敗: HTTP ${p.status} ${(await p.text()).slice(0, 100)}`);
		return next;
	}
	throw new Error('連續衝突，請稍後再試');
}

async function bumpVersion(pat, section, count) {
	try {
		const api = `https://api.github.com/repos/${GITHUB_USER}/${JSON_REPO}/contents/${VERSION_PATH}`;
		const h = ghHeaders(pat);
		let sha = null;
		let ver = {};
		const g = await fetch(api, { headers: h });
		if (g.ok) {
			const j = await g.json();
			sha = j.sha;
			const parsed = JSON.parse(fromB64(j.content));
			if (parsed && typeof parsed === 'object') ver = parsed;
		}
		ver[section] = { updatedAt: new Date().toISOString(), count };
		const body = { message: `Sync version (${section})`, content: toB64(JSON.stringify(ver)) };
		if (sha) body.sha = sha;
		await fetch(api, { method: 'PUT', headers: h, body: JSON.stringify(body) });
	} catch (e) { console.warn('版本戳寫入失敗（不影響本體）:', e); }
}

function logOp(event, detail) {
	try {
		const arr = JSON.parse(localStorage.getItem('admin_oplog') || '[]');
		arr.unshift(`${new Date().toLocaleString()} [${session?.user?.email || '?'}] ${event} ${detail || ''}`);
		localStorage.setItem('admin_oplog', JSON.stringify(arr.slice(0, 200)));
		renderOplog();
	} catch (e) {}
}

function renderOplog() {
	try {
		const arr = JSON.parse(localStorage.getItem('admin_oplog') || '[]');
		$('oplog').innerText = arr.length ? arr.join('\n') : '（空）';
	} catch (e) {}
}

// ---------- 文章 ----------
async function loadPosts() {
	$('postRows').innerHTML = '<tr><td colspan="4">載入中...</td></tr>';
	try {
		allPosts = await fetchJson('/' + jsonPostsPath);
	} catch (e) {
		try {
			const cached = localStorage.getItem('cached_novel_data');
			allPosts = cached ? JSON.parse(cached) : [];
		} catch (e2) { allPosts = []; }
		setStatus('⚠️ JSON 讀取失敗，顯示本機快取', 'orange');
	}
	renderPosts();
}

function renderPosts() {
	const term = ($('postSearch').value || '').toLowerCase();
	const list = allPosts.filter(p => !term || String(p['標題'] || '').toLowerCase().includes(term) || String(p['貼文內容'] || '').toLowerCase().includes(term));
	$('postCount').innerText = `共 ${list.length} 筆`;
	$('postRows').innerHTML = list.map((p) => {
		const pid = p['PostID'] ?? '';
		const idx = allPosts.indexOf(p);
		return `<tr><td>${esc(pid)}</td><td style="white-space:nowrap;">${esc(p['發佈日期'] || '')}</td>
			<td class="title">${esc(p['標題'] || '(無標題)')}</td>
			<td style="white-space:nowrap;">
				<button class="rowbtn" data-act="preview" data-i="${idx}">預覽</button>
				<button class="rowbtn" data-act="edit" data-i="${idx}">編輯</button>
				<button class="rowbtn" data-act="del" data-i="${idx}">刪除</button>
			</td></tr>`;
	}).join('') || '<tr><td colspan="4">無資料</td></tr>';
}

// ---------- 公告（獨立頁籤＋置頂） ----------
function sortPinned(arr) {
	arr.sort((a, b) => ((b['置頂'] === true) - (a['置頂'] === true)) || (new Date(b['發佈日期']) - new Date(a['發佈日期'])));
}

async function loadNotices() {
	$('noticeRows').innerHTML = '<tr><td colspan="4">載入中...</td></tr>';
	try {
		const d = await fetchJson('/' + jsonPostsPath);
		allNotices = d.filter(i => String(i['標題'] || '').includes('公告'));
		sortPinned(allNotices);
	} catch (e) {
		allNotices = [];
		setStatus('⚠️ 公告讀取失敗：' + e.message, 'orange');
	}
	renderNoticesAdmin();
}

function renderNoticesAdmin() {
	$('noticeCount').innerText = `共 ${allNotices.length} 筆`;
	$('noticeRows').innerHTML = allNotices.map((it, idx) => {
		const pinned = it['置頂'] === true;
		return `<tr><td style="white-space:nowrap;">
				<button class="rowbtn" data-nact="pin" data-i="${idx}">${pinned ? '📌已置頂' : '置頂'}</button>
			</td><td>${esc(it['PostID'] ?? '')}</td>
			<td class="title">${esc(it['標題'] || '')}</td>
			<td style="white-space:nowrap;">
				<button class="rowbtn" data-nact="edit" data-i="${idx}">編輯</button>
				<button class="rowbtn" data-nact="del" data-i="${idx}">刪除</button>
			</td></tr>`;
	}).join('') || '<tr><td colspan="4">無資料</td></tr>';
}

async function togglePin(idx, btn) {
	const it = allNotices[idx];
	setStatus('⏳ 更新置頂中...', 'blue');
	try {
		const pat = await ensurePat();
		const to = !(it['置頂'] === true);
		const next = await ghModifyJson(pat, JSON_REPO, jsonPostsPath,
			(arr) => arr.map(p => String(p['PostID']) === String(it['PostID']) ? { ...p, '置頂': to } : p),
			`${to ? 'Pin' : 'Unpin'} notice ${it['PostID']} (admin)`);
		await bumpVersion(pat, 'posts', next.length);
		logOp(to ? '置頂公告' : '取消置頂', `${it['PostID']}`);
		setStatus('✅ 已更新', 'green');
		await loadNotices();
	} catch (e) { setStatus('❌ 置頂失敗：' + e.message, 'red'); }
}

function openNoticeEditor(idx) {
	const src = allNotices[idx];
	editing = { kind: 'notice', idx };
	$('modalTitle').innerText = `編輯公告（${src['PostID'] ?? ''}）`;
	$('modalFields').innerHTML = [['標題', 'text'], ['發佈日期', 'text'], ['貼文內容', 'textarea']].map(([k, t]) => {
		const v = src[k] ?? '';
		return `<label>${k}</label>` + (t === 'textarea'
			? `<textarea data-k="${k}">${esc(v)}</textarea>`
			: `<input data-k="${k}" value="${esc(String(v)).replace(/"/g, '&quot;')}">`);
	}).join('');
	$('previewBox').style.display = 'none';
	$('modal').classList.add('open');
}

// ---------- 服務內容 ----------
async function loadSvc() {
	$('svcRows').innerHTML = '<tr><td colspan="3">載入中...</td></tr>';
	const cat = $('svcCat').value;
	try {
		if (cat === '公告') {
			const d = await fetchJson('/' + jsonPostsPath);
			allSvc = d.filter(i => String(i['標題'] || '').includes('公告'));
		} else {
			if (!jsonSvcPath) throw new Error('INI 缺少 JsonService');
			const d = await fetchJson('/' + jsonSvcPath);
			allSvc = d.filter(i => String(i['分類'] || '') === cat);
		}
	} catch (e) {
		allSvc = [];
		setStatus('⚠️ 服務 JSON 讀取失敗：' + e.message, 'orange');
	}
	$('svcCount').innerText = `共 ${allSvc.length} 筆`;
	$('svcRows').innerHTML = allSvc.map((it, idx) => `<tr><td>${esc(it['PostID'] ?? idx + 1)}</td>
		<td class="title">${esc(it['標題'] || '')}</td>
		<td style="white-space:nowrap;">
			<button class="rowbtn" data-sact="preview" data-i="${idx}">預覽</button>
			<button class="rowbtn" data-sact="edit" data-i="${idx}">編輯</button>
			<button class="rowbtn" data-sact="del" data-i="${idx}">刪除</button>
		</td></tr>`).join('') || '<tr><td colspan="3">無資料</td></tr>';
}

// ---------- 編輯 Modal ----------
function fieldDefs(kind) {
	if (kind === 'post') return [
		['標題', 'text'], ['發佈日期', 'text'], ['貼文內容', 'textarea'], ['圖片網址', 'text']
	];
	return [['標題', 'text'], ['貼文內容', 'textarea'], ['連結', 'text']];
}

function openEditor(kind, idx) {
	const src = kind === 'post' ? allPosts[idx] : allSvc[idx];
	editing = { kind, idx };
	$('modalTitle').innerText = (kind === 'post' ? '編輯文章' : '編輯內容') + `（${src['PostID'] ?? src['標題']}）`;
	$('modalFields').innerHTML = fieldDefs(kind).map(([k, t]) => {
		const v = src[k] ?? src['內容'] ?? '';
		return `<label>${k}</label>` + (t === 'textarea'
			? `<textarea data-k="${k}">${esc(v)}</textarea>`
			: `<input data-k="${k}" value="${esc(String(v)).replace(/"/g, '&quot;')}">`);
	}).join('');
	$('previewBox').style.display = 'none';
	$('modal').classList.add('open');
}

function collectFields() {
	const out = {};
	$('modalFields').querySelectorAll('[data-k]').forEach(el => { out[el.dataset.k] = el.value; });
	return out;
}

function showPreview() {
	const f = collectFields();
	const imgs = String(f['圖片網址'] || '').split(/\r?\n|\|/).filter(s => s.trim())
		.map(s => `<img src="${esc(s.trim())}" style="max-width:100%;margin-top:8px;" onerror="this.style.display='none'">`).join('');
	$('previewBox').innerHTML = `<h3 style="margin:0 0 8px;">${esc(f['標題'] || '')}</h3><div>${esc(f['貼文內容'] || '')}</div>${imgs}`;
	$('previewBox').style.display = 'block';
}

async function saveEdit() {
	if (!editing) return;
	const f = collectFields();
	setStatus('⏳ 儲存中...', 'blue');
	try {
		const pat = await ensurePat();
		if (editing.kind === 'post') {
			const pid = allPosts[editing.idx]['PostID'];
			const next = await ghModifyJson(pat, JSON_REPO, jsonPostsPath, (arr) =>
				arr.map(p => String(p['PostID']) === String(pid) ? { ...p, ...f } : p),
				`Edit post ${pid} (admin)`);
			await bumpVersion(pat, 'posts', next.length);
			logOp('編輯文章', `${pid} ${f['標題'] || ''}`);
			setStatus('✅ 已儲存，前台約 1~3 分鐘生效', 'green');
			await loadPosts();
		} else if (editing.kind === 'notice') {
			const pid = allNotices[editing.idx]['PostID'];
			const next = await ghModifyJson(pat, JSON_REPO, jsonPostsPath, (arr) =>
				arr.map(p => String(p['PostID']) === String(pid) ? { ...p, ...f } : p),
				`Edit notice ${pid} (admin)`);
			await bumpVersion(pat, 'posts', next.length);
			logOp('編輯公告', `${pid} ${f['標題'] || ''}`);
			setStatus('✅ 已儲存，前台約 1~3 分鐘生效', 'green');
			await loadNotices();
		} else {
			const cat = $('svcCat').value;
			const isNovel = cat === '公告';
			const path = isNovel ? jsonPostsPath : jsonSvcPath;
			const src = allSvc[editing.idx];
			const useId = src['PostID'] !== undefined;
			const origTitle = src['標題'];
			const next = await ghModifyJson(pat, JSON_REPO, path, (arr) =>
				arr.map(p => (useId ? String(p['PostID']) === String(src['PostID']) : p['標題'] === origTitle) ? { ...p, ...f } : p),
				`Edit ${cat} (admin)`);
			await bumpVersion(pat, isNovel ? 'posts' : 'services', next.length);
			logOp('編輯服務內容', `${cat} ${f['標題'] || ''}`);
			setStatus('✅ 已儲存，前台約 1~3 分鐘生效', 'green');
			await loadSvc();
		}
		$('modal').classList.remove('open');
		editing = null;
	} catch (e) {
		setStatus('❌ 儲存失敗：' + e.message, 'red');
	}
}

async function delNotice(idx, btn) {
	if (!btn.dataset.armed) {
		btn.dataset.armed = '1';
		btn.classList.add('confirm');
		btn.innerText = '確認刪除？';
		setTimeout(() => { btn.dataset.armed = ''; btn.classList.remove('confirm'); btn.innerText = '刪除'; }, 5000);
		return;
	}
	setStatus('⏳ 刪除中...', 'blue');
	try {
		const pat = await ensurePat();
		const pid = allNotices[idx]['PostID'];
		const next = await ghModifyJson(pat, JSON_REPO, jsonPostsPath,
			(arr) => arr.filter(p => String(p['PostID']) !== String(pid)),
			`Delete notice ${pid} (admin)`);
		await bumpVersion(pat, 'posts', next.length);
		logOp('刪除公告', `${pid}`);
		setStatus('✅ 已刪除，前台約 1~3 分鐘生效', 'green');
		await loadNotices();
	} catch (e) { setStatus('❌ 刪除失敗：' + e.message, 'red'); }
}

async function delItem(kind, idx, btn) {
	if (btn.dataset.armed) {
		setStatus('⏳ 刪除中...', 'blue');
		try {
			const pat = await ensurePat();
			if (kind === 'post') {
				const pid = allPosts[idx]['PostID'];
				const next = await ghModifyJson(pat, JSON_REPO, jsonPostsPath,
					(arr) => arr.filter(p => String(p['PostID']) !== String(pid)),
					`Delete post ${pid} (admin)`);
				await bumpVersion(pat, 'posts', next.length);
				logOp('刪除文章', `${pid}`);
				setStatus('✅ 已刪除，前台約 1~3 分鐘生效', 'green');
				await loadPosts();
			} else {
				const cat = $('svcCat').value;
				const isNovel = cat === '公告';
				const path = isNovel ? jsonPostsPath : jsonSvcPath;
				const it = allSvc[idx];
				const useId = it['PostID'] !== undefined;
				const next = await ghModifyJson(pat, JSON_REPO, path,
					(arr) => arr.filter(p => useId ? String(p['PostID']) !== String(it['PostID']) : p['標題'] !== it['標題']),
					`Delete ${cat} (admin)`);
				await bumpVersion(pat, isNovel ? 'posts' : 'services', next.length);
				logOp('刪除服務內容', `${cat} ${it['標題'] || ''}`);
				setStatus('✅ 已刪除，前台約 1~3 分鐘生效', 'green');
				await loadSvc();
			}
		} catch (e) { setStatus('❌ 刪除失敗：' + e.message, 'red'); }
		return;
	}
	btn.dataset.armed = '1';
	btn.classList.add('confirm');
	btn.innerText = '確認刪除？';
	setTimeout(() => { btn.dataset.armed = ''; btn.classList.remove('confirm'); btn.innerText = '刪除'; }, 5000);
}

// ---------- 圖片 ----------
async function loadImages() {
	$('imgGrid').innerText = '載入中...';
	try {
		const pat = finalToken || '';
		const h = pat ? { Authorization: `token ${pat}` } : {};
		const r = await fetch(`https://api.github.com/repos/${GITHUB_USER}/${GHOST_REPO}/contents/pic`, { headers: h });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const files = (await r.json()).filter(f => f.type === 'file');
		$('imgGrid').innerHTML = files.map(f => `<div class="imgcell">
			<img src="${f.download_url}" loading="lazy" onerror="this.style.display='none'">
			<div>${esc(f.name)}</div>
			<div>${(f.size / 1024).toFixed(0)} KB</div>
			<button class="rowbtn" data-copy="pic/${esc(f.name)}">複製路徑</button>
			<button class="rowbtn" data-del="${esc(f.path)}" data-sha="${f.sha}">刪除</button>
		</div>`).join('') || '（空）';
	} catch (e) {
		$('imgGrid').innerText = '讀取失敗：' + e.message;
	}
}

// ---------- 系統狀態 ----------
async function healthCheck() {
	const rows = [];
	const t0 = Date.now();
	try {
		const d = await fetchJson('/' + jsonPostsPath);
		rows.push(['文章 JSON', `<span class="health-ok">正常</span>`, `${Array.isArray(d) ? d.length : '?'} 筆，${Date.now() - t0}ms`]);
	} catch (e) { rows.push(['文章 JSON', `<span class="health-bad">異常</span>`, esc(e.message)]); }
	const t1 = Date.now();
	try {
		const d = await fetchJson('/' + (jsonSvcPath || 'Data/Services.json'));
		rows.push(['服務 JSON', `<span class="health-ok">正常</span>`, `${Array.isArray(d) ? d.length : '?'} 筆，${Date.now() - t1}ms`]);
	} catch (e) { rows.push(['服務 JSON', `<span class="health-bad">異常</span>`, esc(e.message)]); }
	try {
		const pat = finalToken || '';
		const h = pat ? { Authorization: `token ${pat}` } : {};
		const r = await fetch('https://api.github.com/rate_limit', { headers: h });
		const j = await r.json();
		rows.push(['GitHub API', `<span class="health-ok">正常</span>`, `剩餘 ${j.resources.core.remaining}/${j.resources.core.limit}`]);
	} catch (e) { rows.push(['GitHub API', `<span class="health-bad">異常</span>`, esc(e.message)]); }
	try {
		const pat = finalToken || await getToken().catch(() => '');
		if (!pat) throw new Error('尚未取得 token（請先輸入管理密碼並操作一次）');
		const r = await fetch('https://api.github.com/user', { headers: { Authorization: `token ${pat}` } });
		if (!r.ok) throw new Error(`HTTP ${r.status}（token 無效或過期）`);
		const u = await r.json();
		rows.push(['Token 有效性', `<span class="health-ok">有效</span>`, esc(u.login || '')]);
	} catch (e) { rows.push(['Token 有效性', `<span class="health-bad">異常</span>`, esc(e.message)]); }
	$('healthRows').innerHTML = rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('');
}

// 重建版本戳（用現有 JSON 重新計算）
async function rebuildVersion() {
	setStatus('⏳ 重建版本戳...', 'blue');
	try {
		const pat = await ensurePat();
		const posts = await fetchJson('/' + jsonPostsPath).catch(() => []);
		const svcs = jsonSvcPath ? await fetchJson('/' + jsonSvcPath).catch(() => []) : [];
		const api = `https://api.github.com/repos/${GITHUB_USER}/${JSON_REPO}/contents/${VERSION_PATH}`;
		const h = ghHeaders(pat);
		let sha = null;
		const g = await fetch(api, { headers: h });
		if (g.ok) sha = (await g.json()).sha;
		const ver = {
			posts: { updatedAt: new Date().toISOString(), count: Array.isArray(posts) ? posts.length : 0 },
			services: { updatedAt: new Date().toISOString(), count: Array.isArray(svcs) ? svcs.length : 0 }
		};
		const body = { message: 'Rebuild version (admin)', content: toB64(JSON.stringify(ver)) };
		if (sha) body.sha = sha;
		const p = await fetch(api, { method: 'PUT', headers: h, body: JSON.stringify(body) });
		if (!p.ok) throw new Error(`HTTP ${p.status}`);
		logOp('重建版本戳', '');
		setStatus('✅ 版本戳已重建', 'green');
	} catch (e) { setStatus('❌ 重建失敗：' + e.message, 'red'); }
}

// ---------- 初始化 ----------
export async function initAdmin(sess) {
	session = sess;
	const saved = sessionStorage.getItem('admin_pwd');
	if (saved) $('adminPwd').value = saved;

	try {
		const cfg = await getIni('/settings/global.ini');
		if (cfg?.JsonData) jsonPostsPath = cfg.JsonData.replace(/^\//, '');
		if (cfg?.JsonService) jsonSvcPath = cfg.JsonService.replace(/^\//, '');
		if (cfg?.updateGithub_URL) authUrl = cfg.updateGithub_URL;
	} catch (e) { setStatus('⚠️ INI 載入失敗：' + e.message, 'orange'); }
	renderOplog();

	document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
		document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('active'));
		b.classList.add('active');
		document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
		$('tab-' + b.dataset.tab).classList.add('active');
	});

	$('postSearch').oninput = renderPosts;
	$('postReload').onclick = loadPosts;
	$('postBackup').onclick = () => {
		const blob = new Blob([JSON.stringify(allPosts, null, 1)], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'postFB_backup.json';
		a.click();
		logOp('備份JSON', `${allPosts.length} 筆`);
	};
	$('postRows').onclick = (e) => {
		const b = e.target.closest('button'); if (!b) return;
		const i = Number(b.dataset.i);
		if (b.dataset.act === 'edit') openEditor('post', i);
		else if (b.dataset.act === 'preview') { openEditor('post', i); showPreview(); }
		else if (b.dataset.act === 'del') delItem('post', i, b);
	};
	$('svcCat').onchange = loadSvc;
	$('svcReload').onclick = loadSvc;
	$('noticeReload').onclick = loadNotices;
	$('noticeRows').onclick = (e) => {
		const b = e.target.closest('button'); if (!b) return;
		const i = Number(b.dataset.i);
		if (b.dataset.nact === 'pin') togglePin(i);
		else if (b.dataset.nact === 'edit') openNoticeEditor(i);
		else if (b.dataset.nact === 'del') delNotice(i, b);
	};
	$('svcRows').onclick = (e) => {
		const b = e.target.closest('button'); if (!b) return;
		const i = Number(b.dataset.i);
		if (b.dataset.sact === 'edit') openEditor('svc', i);
		else if (b.dataset.sact === 'preview') { openEditor('svc', i); showPreview(); }
		else if (b.dataset.sact === 'del') delItem('svc', i, b);
	};
	$('modalPreview').onclick = showPreview;
	$('modalSave').onclick = saveEdit;
	$('modalClose').onclick = () => { $('modal').classList.remove('open'); editing = null; };
	$('modal').onclick = (e) => { if (e.target.id === 'modal') { $('modal').classList.remove('open'); editing = null; } };

	$('imgReload').onclick = loadImages;
	$('imgGrid').onclick = async (e) => {
		const b = e.target.closest('button'); if (!b) return;
		if (b.dataset.copy) {
			await navigator.clipboard.writeText(b.dataset.copy).catch(() => {});
			setStatus(`✅ 已複製：${b.dataset.copy}`, 'green');
			return;
		}
		if (b.dataset.del) {
			if (!b.dataset.armed) {
				b.dataset.armed = '1'; b.classList.add('confirm'); b.innerText = '確認刪除？';
				setTimeout(() => { b.dataset.armed = ''; b.classList.remove('confirm'); b.innerText = '刪除'; }, 5000);
				return;
			}
			try {
				const token = await ensurePat();
				const r = await fetch(`https://api.github.com/repos/${GITHUB_USER}/${GHOST_REPO}/contents/${b.dataset.del}`, {
					method: 'DELETE', headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
					body: JSON.stringify({ message: `Delete ${b.dataset.del} (admin)`, sha: b.dataset.sha })
				});
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				logOp('刪除圖片', b.dataset.del);
				setStatus('✅ 圖片已刪除', 'green');
				loadImages();
			} catch (err) { setStatus('❌ 刪除失敗：' + err.message, 'red'); }
		}
	};

	$('healthBtn').onclick = healthCheck;
	$('syncPostsBtn').onclick = rebuildVersion;
	$('clearCacheBtn').onclick = () => {
		['cached_novel_data', 'cache_notices', 'cache_services', 'data_ver'].forEach(k => localStorage.removeItem(k));
		setStatus('✅ 本機快取已清除（前台下次開啟會重抓）', 'green');
		logOp('清除快取', '');
	};

	await loadPosts();
	await loadNotices();
	await loadSvc();
}
