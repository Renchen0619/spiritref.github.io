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
let postPage = 1;
let svcPage = 1;
let svcCat = '專業服務';
let noticePage = 1;
const ADMIN_PAGE = 10;
// 暫存制：異動先記帳，按儲存才一次寫入
let pendingOps = [];
let pendingLogs = [];

function markDirty() {
	updateSaveBar();
}

function updateSaveBar() {
	const n = pendingOps.length;
	$('savebar').style.display = n ? 'block' : 'none';
	$('dirtyCount').innerText = n ? `未儲存變更 ${n} 筆` : '';
}

function stage(file, op) {
	pendingOps.push({ file, ...op });
	markDirty();
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');

function setStatus(msg, color = '#d4af37') {
	const el = $('status');
	el.innerText = msg || '';
	el.style.display = msg ? 'block' : 'none';
	el.style.borderColor = color;
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
	let net = {};
	try { net = await netInfo(); } catch (e) {}
	const res = await fetch(atob(authUrl), { method: 'POST', body: JSON.stringify({ action: 'getGithubToken', user, ip: net.ip || '', ua: navigator.userAgent || '' }) });
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
// github modify json
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

// 通用文字檔寫入（sitemap.xml 等非 JSON 檔案）
// generic file writer
async function ghWriteFile(pat, repo, path, content, message) {
	const api = `https://api.github.com/repos/${GITHUB_USER}/${repo}/contents/${path}`;
	const h = ghHeaders(pat);
	let sha = null;
	const g = await fetch(api, { headers: h });
	if (g.ok) sha = (await g.json()).sha;
	else if (g.status !== 404) throw new Error(`讀取 ${path} 失敗: HTTP ${g.status}`);
	const body = { message, content: toB64(content) };
	if (sha) body.sha = sha;
	const p = await fetch(api, { method: 'PUT', headers: h, body: JSON.stringify(body) });
	if (!p.ok) throw new Error(`寫入 ${path} 失敗: HTTP ${p.status} ${(await p.text()).slice(0, 100)}`);
	return true;
}

// 產生 sitemap.xml 內容（與 Tool/generate-sitemap.ps1 邏輯一致）
function buildSitemapXml(posts, services) {
	const base = 'https://spiritref.github.io';
	const today = new Date().toISOString().slice(0, 10);
	const entries = [];
	const staticPages = [
		{ loc: `${base}/services/`, changefreq: 'weekly', priority: '1.0' },
		{ loc: `${base}/services/faq/`, changefreq: 'weekly', priority: '0.8' },
		{ loc: `${base}/services/notices/`, changefreq: 'daily', priority: '0.8' },
		{ loc: `${base}/services/consult.html`, changefreq: 'monthly', priority: '0.5' },
		{ loc: `${base}/ghoststory/`, changefreq: 'daily', priority: '0.9' },
		{ loc: `${base}/`, changefreq: 'weekly', priority: '0.8' }
	];
	for (const s of staticPages) entries.push({ ...s, lastmod: today });
	// 文章頁
	if (Array.isArray(posts)) {
		for (const post of posts) {
			const pid = post && post['PostID'] != null ? String(post['PostID']) : '0';
			const raw = post ? (function(){const ks=Object.keys(post);for(const k of ks){if(typeof post[k]==='string' && /^\d{4}\/\d{2}\/\d{2}/.test(post[k])) return post[k];}return null;})() : null;
			let ts = '0000';
			let lastmod = today;
			if (raw) {
				const d = (typeof raw === 'number')
					? new Date((raw - 25569) * 86400 * 1000)
					: new Date(raw);
				if (!isNaN(d.getTime())) {
					const pad = (n) => String(n).padStart(2, '0');
					ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
					lastmod = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
				}
			}
			const combined = `${pid}_${ts}`;
			entries.push({ loc: `${base}/ghoststory/article/?id=${combined}`, lastmod, changefreq: 'monthly', priority: '0.6' });
		}
	}
	// FAQ 個別頁面
	if (Array.isArray(services)) {
		for (const svc of services) {
			const cat = svc ? (function(){const ks=Object.keys(svc);return ks.length? (svc[ks[0]] || '') : '';}()) : '';
			if (String(cat).indexOf('\u5f59') === -1) continue;
			const title = (function(){const ks=Object.keys(svc);return ks.length>1 ? (svc[ks[1]] || '') : '';}()) || '';
			if (!title) continue;
			const faqId = svc['ID'] || title;
			entries.push({ loc: `${base}/services/faq/detail.html?id=${encodeURIComponent(faqId)}`, lastmod: today, changefreq: 'monthly', priority: '0.7' });
		}
	}
	let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
	for (const e of entries) {
		xml += '  <url>\n';
		xml += `    <loc>${e.loc}</loc>\n`;
		xml += `    <lastmod>${e.lastmod}</lastmod>\n`;
		xml += `    <changefreq>${e.changefreq}</changefreq>\n`;
		xml += `    <priority>${e.priority}</priority>\n`;
		xml += '  </url>\n';
	}
	xml += '</urlset>\n';
	return xml;
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

// 暫存記帳的操作套用到新抓的陣列（儲存時一次結算）
function matchItem(p, m) {
	if (!m) return false;
	if (m.PostID !== undefined) return String(p['PostID']) === String(m.PostID);
	if (m.ID !== undefined) return p['ID'] === m.ID;
	if (m.keyTitle !== undefined) return p['\u6a19\u984c'] === m.keyTitle;
	return false;
}

function generateSvcId(cat, arr) {
	const prefix = (cat.charCodeAt(0) === 0x8D85) ? 'FAQ' : (cat.charCodeAt(0) === 0x8996) ? 'V' : 'S';
	let max = 0;
	for (const it of (arr || [])) {
		const id = it && it['ID'];
		if (typeof id === 'string' && id.indexOf(prefix + '_') === 0) {
			const n = parseInt(id.slice(prefix.length + 1), 10);
			if (!isNaN(n) && n > max) max = n;
		}
	}
	return prefix + '_' + String(max + 1).padStart(3, '0');
}

function applyOps(arr, ops) {
	let out = [...arr];
	for (const o of ops) {
		if (o.type === 'append') {
			const maxId = out.reduce((m, p) => Math.max(m, Number(p.PostID) || 0), 0);
			const e = { ...o.entry };
			if (e.PostID === undefined && out.some(p => p.PostID !== undefined)) e.PostID = maxId + 1;
			out.push(e);
		} else if (o.type === 'update') {
			out = out.map(p => matchItem(p, o.match) ? { ...p, ...o.fields } : p);
		} else if (o.type === 'delete') {
			out = out.filter(p => !matchItem(p, o.match));
		} else if (o.type === 'move') {
			const from = out.findIndex(p => matchItem(p, o.match));
			const to = from + o.dir;
			if (from >= 0 && to >= 0 && to < out.length) {
				const [m] = out.splice(from, 1);
				out.splice(to, 0, m);
			}
		} else if (o.type === 'pin') {
			out = out.map(p => matchItem(p, o.match) ? { ...p, '置頂': o.to } : p);
		}
	}
	return out;
}

// 儲存：各檔一次寫入＋版本戳＋操作紀錄一次結算
// save all
async function saveAll() {
	if (!pendingOps.length && !pendingLogs.length) return;
	setStatus('⏳ 儲存中...', 'blue');
	try {
		const pat = await ensurePat();
		const files = [...new Set(pendingOps.map(o => o.file))];
		let savedPosts = null;
		let savedServices = null;
		for (const file of files) {
			const path = file === 'posts' ? jsonPostsPath : jsonSvcPath;
			const next = await ghModifyJson(pat, JSON_REPO, path,
				(arr) => applyOps(arr, pendingOps.filter(o => o.file === file)),
				`Admin save ${file} (${pendingOps.filter(o => o.file === file).length} ops)`);
			await bumpVersion(pat, file, next.length);
			if (file === 'posts') {
				savedPosts = next;
				try {
					allPosts = next;
					allNotices = next.filter(i => String(i['標題'] || '').includes('公告'));
					sortPinned(allNotices);
					renderPosts();
					renderNoticesAdmin();
				} catch (e) {}
			} else {
				savedServices = next;
				try {
					const cat = svcCat;
					allSvc = next.filter(i => String(i['分類'] || '') === cat);
					renderSvcRows();
				} catch (e) {}
			}
		}
		// 自動更新 sitemap.xml（文章或服務有變更時）
		if (savedPosts || savedServices) {
			try {
				const postsForSitemap = savedPosts || allPosts;
				const servicesForSitemap = savedServices || null;
				const sitemapXml = buildSitemapXml(postsForSitemap, servicesForSitemap);
				await ghWriteFile(pat, JSON_REPO, 'sitemap.xml', sitemapXml, 'Admin save sitemap');
			} catch (e) { console.warn('sitemap 更新失敗（不影響本體）:', e); }
		}
		await flushLogs(pat);
		pendingOps = [];
		pendingLogs = [];
		updateSaveBar();
		setStatus('✅ 已儲存，前台約 1~3 分鐘生效', 'green');
	} catch (e) {
		setStatus('❌ 儲存失敗：' + e.message + '（暫存保留，可重試）', 'red');
	}
}

async function flushLogs(pat) {
	if (!pendingLogs.length) return;
	const cutoff = Date.now() - OPLOG_KEEP_MS;
	const api = `https://api.github.com/repos/${GITHUB_USER}/${JSON_REPO}/contents/${OPLOG_PATH}`;
	const h = ghHeaders(pat);
	let sha = null;
	let arr = [];
	try {
		const g = await fetch(api, { headers: h });
		if (g.ok) {
			const j = await g.json();
			sha = j.sha;
			const parsed = JSON.parse(fromB64(j.content));
			if (Array.isArray(parsed)) arr = parsed;
		}
	} catch (e) {}
	arr = [...pendingLogs.slice().reverse(), ...arr].filter(e => e && (Date.now() - new Date(e.t).getTime()) < cutoff).slice(0, 500);
	const body = { message: `oplog: ${pendingLogs.length} entries`, content: toB64(JSON.stringify(arr, null, 1)) };
	if (sha) body.sha = sha;
	await fetch(api, { method: 'PUT', headers: h, body: JSON.stringify(body) });
}

async function discardAll() {
	pendingOps = [];
	pendingLogs = [];
	updateSaveBar();
	setStatus('⏳ 已捨棄暫存，重新載入...', 'blue');
	try {
		await loadPosts();
		await loadNotices();
		await loadSvc();
	} catch (e) {}
	setStatus('✅ 已還原', 'green');
	setTimeout(() => setStatus(''), 2000);
}

const OPLOG_PATH = 'Data/admin-oplog.json';
const OPLOG_KEEP_MS = 90 * 24 * 3600 * 1000; // 只保留3個月

function deviceLabel() {
	try {
		const ua = navigator.userAgent;
		let os = '其他裝置';
		if (/Android/i.test(ua)) os = 'Android';
		else if (/iPhone|iPad|iPod/i.test(ua)) os = 'iOS';
		else if (/Windows/i.test(ua)) os = 'Windows';
		else if (/Macintosh/i.test(ua)) os = 'Mac';
		else if (/Linux/i.test(ua)) os = 'Linux';
		let br = '';
		if (/Edg\//i.test(ua)) br = 'Edge';
		else if (/Chrome\//i.test(ua)) br = 'Chrome';
		else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) br = 'Safari';
		else if (/Firefox\//i.test(ua)) br = 'Firefox';
		else if (/LINE\//i.test(ua)) br = 'LINE內建';
		return `${os}${br ? '·' + br : ''} ${window.innerWidth}x${window.innerHeight}`;
	} catch (e) { return '未知裝置'; }
}

// IP＋地區（快取一整個分頁工作階段，失敗就只記裝置）
async function netInfo() {
	try {
		const cached = sessionStorage.getItem('net_info');
		if (cached) return JSON.parse(cached);
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), 4000);
		const r = await fetch('https://ipapi.co/json/', { signal: ctl.signal });
		clearTimeout(timer);
		if (!r.ok) throw new Error('net ' + r.status);
		const j = await r.json();
		const info = {
			ip: j.ip || 'unknown',
			loc: [j.city, j.region, j.country_name].filter(Boolean).join('·') || 'unknown'
		};
		sessionStorage.setItem('net_info', JSON.stringify(info));
		return info;
	} catch (e) {
		return { ip: 'unknown', loc: 'unknown' };
	}
}

function logOp(event, detail) {
	const entry = { t: new Date().toISOString(), admin: session?.user?.email || '?', event, detail: detail || '', dev: deviceLabel(), ip: '', loc: '' };
	try {
		const arr = JSON.parse(localStorage.getItem('admin_oplog') || '[]');
		arr.unshift(entry);
		localStorage.setItem('admin_oplog', JSON.stringify(arr.slice(0, 200)));
	} catch (e) {}
	renderOplog();
	// IP 拿到後補上（本機＋遠端都更新）
	netInfo().then(info => {
		entry.ip = info.ip;
		entry.loc = info.loc;
		try {
			const arr = JSON.parse(localStorage.getItem('admin_oplog') || '[]');
			if (arr[0] && arr[0].t === entry.t) {
				arr[0] = entry;
				localStorage.setItem('admin_oplog', JSON.stringify(arr.slice(0, 200)));
			}
		} catch (e) {}
		renderOplog();
		pendingLogs.push(entry);
		markDirty();
	}).catch(() => {
		pendingLogs.push(entry);
		markDirty();
	});
}

function oplogText(e) {
	if (typeof e === 'string') return e;
	const extra = [e.dev, e.loc, e.ip].filter(Boolean).join(' · ');
	return `${new Date(e.t).toLocaleString()} [${e.admin || '?'}] ${e.event || ''} ${e.detail || ''}${extra ? ' (' + extra + ')' : ''}`;
}

function refreshDevFilter(list) {
	const sel = $('oplogDev');
	if (!sel) return;
	const cur = sel.value;
	const devs = [...new Set(list.map(e => (e && e.dev) || '未知裝置'))];
	sel.innerHTML = '<option value="">全部裝置</option>' + devs.map(d => `<option value="${esc(d).replace(/"/g, '&quot;')}"${d === cur ? ' selected' : ''}>${esc(d)}</option>`).join('');
}

function renderOplog() {
	const devFilter = ($('oplogDev') && $('oplogDev').value) || '';
	const show = (arr) => {
		const list = arr.filter(e => {
			if (e && typeof e === 'object' && e.t && (Date.now() - new Date(e.t).getTime()) >= OPLOG_KEEP_MS) return false;
			if (devFilter && e && typeof e === 'object' && ((e.dev || '未知裝置') !== devFilter)) return false;
			return true;
		});
		refreshDevFilter(arr.filter(e => e && typeof e === 'object'));
		$('oplog').innerText = list.length ? list.map(oplogText).join('\n') : '（空）';
	};
	try {
		const arr = JSON.parse(localStorage.getItem('admin_oplog') || '[]');
		show(Array.isArray(arr) ? arr : []);
	} catch (e) {}
	// 有共用檔就以它為準（多管理員、多裝置同步）
	fetch(`https://api.github.com/repos/${GITHUB_USER}/${JSON_REPO}/contents/${OPLOG_PATH}`)
		.then(r => r.ok ? r.json() : null)
		.then(j => {
			if (!j) return;
			const arr = JSON.parse(fromB64(j.content));
			if (Array.isArray(arr)) show(arr);
		}).catch(() => {});
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
	updateTitleFilter();
	renderPosts();
}

function updateTitleFilter() {
	const sel = $('postTitleFilter');
	if (!sel) return;
	const cur = sel.value;
	const titles = [...new Set(allPosts.map(p => String(p['標題'] || '')).filter(t => t))].sort();
	sel.innerHTML = '<option value="">📌 所有標題</option>' + titles.map(t => `<option value="${esc(t).replace(/"/g, '&quot;')}"${t === cur ? ' selected' : ''}>${esc(t)}</option>`).join('');
}

function getCombinedId(post) {
	const pid = post["PostID"] || "0";
	const d = (typeof post["發佈日期"] === 'number')
		? new Date((post["發佈日期"] - 25569) * 86400 * 1000)
		: new Date(post["發佈日期"]);
	if (isNaN(d.getTime())) return `${pid}_00000000000000`;
	const pad = (n) => String(n).padStart(2, '0');
	return `${pid}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function postDateVal(p) {
	return (typeof p["發佈日期"] === 'number') ? (p["發佈日期"] - 25569) * 86400 * 1000 : new Date(p["發佈日期"]).getTime();
}

function renderPosts() {
	const term = ($('postSearch').value || '').toLowerCase();
	const picked = $('postTitleFilter') ? $('postTitleFilter').value : '';
	const mode = $('postSort') ? $('postSort').value : 'id_desc';
	const list = allPosts.filter(p => {
		const titleOk = !picked || String(p['標題'] || '') === picked;
		const termOk = !term || String(p['標題'] || '').toLowerCase().includes(term) || String(p['貼文內容'] || '').toLowerCase().includes(term);
		return titleOk && termOk;
	});
	// 置頂永遠在前，再按選擇排序（預設 ID 新→舊）
	list.sort((a, b) => {
		const pin = ((b['置頂'] === true) - (a['置頂'] === true));
		if (pin !== 0) return pin;
		if (mode === 'id_asc') return (Number(a['PostID']) || 0) - (Number(b['PostID']) || 0);
		if (mode === 'date_desc') return postDateVal(b) - postDateVal(a);
		if (mode === 'date_asc') return postDateVal(a) - postDateVal(b);
		return (Number(b['PostID']) || 0) - (Number(a['PostID']) || 0);
	});
	const PAGE = 10;
	const maxPage = Math.max(1, Math.ceil(list.length / PAGE));
	if (postPage > maxPage) postPage = maxPage;
	if (postPage < 1) postPage = 1;
	const page = list.slice((postPage - 1) * PAGE, postPage * PAGE);
	$('postCount').innerText = `共 ${list.length} 筆`;
	$('postPageInfo').innerText = `/${maxPage}`;
	const jump = $('postJump');
	if (jump) {
		let opts = '';
		for (let i = 1; i <= maxPage; i++) opts += `<option value="${i}"${i === postPage ? ' selected' : ''}>${i}</option>`;
		jump.innerHTML = opts;
	}
	$('postRows').innerHTML = page.map((p) => {
		const pid = p['PostID'] ?? '';
		const idx = allPosts.indexOf(p);
		const pinned = p['置頂'] === true;
		const artUrl = `../ghoststory/article/?id=${encodeURIComponent(getCombinedId(p))}`;
		return `<tr><td>${pinned ? '📌' : ''}${esc(pid)}</td><td style="white-space:nowrap;">${esc(p['發佈日期'] || '')}</td>
			<td class="title">${esc(p['標題'] || '(無標題)')}</td>
			<td style="white-space:nowrap;">
				<button class="rowbtn" data-act="pin" data-i="${idx}">${pinned ? '取消置頂' : '置頂'}</button>
				<a class="rowbtn" style="text-decoration:none;" href="${artUrl}" target="_blank">👁查看</a>
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
	$('noticeRows').innerHTML = '<tr><td colspan="5">載入中...</td></tr>';
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
	const term = ($('noticeSearch') && $('noticeSearch').value || '').toLowerCase();
	const list = allNotices.filter(i => {
		if (!term) return true;
		const t = String(i['標題'] || '').toLowerCase();
		const c = String(i['貼文內容'] || i['內容'] || '').toLowerCase();
		return t.includes(term) || c.includes(term);
	});
	const maxPage = Math.max(1, Math.ceil(list.length / ADMIN_PAGE));
	if (noticePage > maxPage) noticePage = maxPage;
	if (noticePage < 1) noticePage = 1;
	const page = list.slice((noticePage - 1) * ADMIN_PAGE, noticePage * ADMIN_PAGE);
	$('noticeCount').innerText = `共 ${list.length} 筆`;
	$('noticePageInfo').innerText = `/${maxPage}`;
	const jump = $('noticeJump');
	if (jump) {
		let opts = '';
		for (let i = 1; i <= maxPage; i++) opts += `<option value="${i}"${i === noticePage ? ' selected' : ''}>${i}</option>`;
		jump.innerHTML = opts;
	}
	$('noticeRows').innerHTML = page.map((it) => {
		const idx = allNotices.indexOf(it);
		const pinned = it['置頂'] === true;
		const body = String(it['貼文內容'] || it['內容'] || '');
		const isLong = body.length > 60;
		const short = isLong ? body.substring(0, 60) + '...' : body;
		return `<tr><td style="white-space:nowrap;">
				<button class="rowbtn" data-nact="pin" data-i="${idx}">${pinned ? '取消置頂' : '📌置頂'}</button>
			</td><td>${esc(it['PostID'] ?? '')}</td>
			<td class="title">${esc(it['標題'] || '')}</td>
			<td class="title cell-text" style="max-width:280px;white-space:pre-wrap;" data-i="${idx}">${esc(short)}</td>
			<td style="white-space:nowrap;">
				<button class="rowbtn" data-nact="preview" data-i="${idx}">預覽</button>
				<button class="rowbtn" data-nact="edit" data-i="${idx}">編輯</button>
				<button class="rowbtn" data-nact="del" data-i="${idx}">刪除</button>
			</td></tr>`;
	}).join('') || '<tr><td colspan="5">無資料</td></tr>';
}

async function togglePostPin(idx) {
	const it = allPosts[idx];
	if (!it) return;
	const to = !(it['置頂'] === true);
	it['置頂'] = to;
	renderPosts();
	stage('posts', { type: 'pin', match: { PostID: it['PostID'] }, to });
	logOp(to ? '置頂文章' : '取消置頂', `${it['PostID']}`);
	setStatus('已暫存，按上方儲存才寫入', 'orange');
}

async function togglePin(idx, btn) {
	const it = allNotices[idx];
	const to = !(it['置頂'] === true);
	it['置頂'] = to;
	sortPinned(allNotices);
	renderNoticesAdmin();
	stage('posts', { type: 'pin', match: { PostID: it['PostID'] }, to });
	logOp(to ? '置頂公告' : '取消置頂', `${it['PostID']}`);
	setStatus('已暫存，按右上儲存才寫入', 'orange');
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
	setModalMode(false);
}

function openNoticeCreator() {
	editing = { kind: 'notice', idx: -1 };
	$('modalTitle').innerText = '新增公告';
	const now = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	const nowStr = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	$('modalFields').innerHTML = [['標題', 'text', '【公告】'], ['發佈日期', 'text', nowStr], ['貼文內容', 'textarea', '']].map(([k, t, v]) => {
		return `<label>${k}</label>` + (t === 'textarea'
			? `<textarea data-k="${k}">${esc(v)}</textarea>`
			: `<input data-k="${k}" value="${esc(String(v)).replace(/"/g, '&quot;')}">`);
	}).join('');
	$('previewBox').style.display = 'none';
	$('modal').classList.add('open');
	setModalMode(false);
}

function openSvcCreator() {
	editing = { kind: 'svc', idx: -1 };
	const cat = svcCat;
	$('modalTitle').innerText = `新增${cat}`;
	$('modalFields').innerHTML = `<label>分類（固定為目前頁籤）</label><input value="${esc(cat)}" disabled>`
		+ fieldDefs('svc')
			.filter(([k]) => !(cat === '專業服務' && k === '連結'))
			.map(([k, t]) => {
				const input = t === 'textarea'
					? `<textarea data-k="${k}"></textarea>`
					: `<input data-k="${k}" value="">`;
				const hint = (k === '連結') ? `<div style="font-size:12px;color:#8b7355;margin:2px 0 6px;">多個連結請換行或逗號分隔，一行一個也可以</div>` : '';
				return `<label>${k}</label>` + input + hint;
			}).join('');
	$('previewBox').style.display = 'none';
	$('modal').classList.add('open');
	setModalMode(false);
}

// ---------- 服務內容 ----------
async function loadSvc() {
	$('svcRows').innerHTML = '<tr><td colspan="3">載入中...</td></tr>';
	const cat = svcCat;
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
	renderSvcRows();
}

function renderSvcRows() {
	const term = ($('svcSearch') && $('svcSearch').value || '').toLowerCase();
	const list = allSvc.filter(i => {
		if (!term) return true;
		const t = String(i['標題'] || '').toLowerCase();
		const c = String(i['貼文內容'] || i['內容'] || '').toLowerCase();
		return t.includes(term) || c.includes(term);
	});
	const maxPage = Math.max(1, Math.ceil(list.length / ADMIN_PAGE));
	if (svcPage > maxPage) svcPage = maxPage;
	if (svcPage < 1) svcPage = 1;
	const page = list.slice((svcPage - 1) * ADMIN_PAGE, svcPage * ADMIN_PAGE);
	$('svcCount').innerText = `共 ${list.length} 筆`;
	$('svcPageInfo').innerText = `/${maxPage}`;
	const jump = $('svcJump');
	if (jump) {
		let opts = '';
		for (let i = 1; i <= maxPage; i++) opts += `<option value="${i}"${i === svcPage ? ' selected' : ''}>${i}</option>`;
		jump.innerHTML = opts;
	}
	$('svcRows').innerHTML = page.map((it) => {
		const idx = allSvc.indexOf(it);
		return '<tr><td>' + esc(it['ID'] ?? idx + 1) + '</td>'
		+ '<td class="title">' + esc(it['標題'] || '') + '</td>'
		+ '<td style="white-space:nowrap;">'
		+ '<button class="rowbtn" data-sact="up" data-i="' + idx + '">↑</button>'
		+ '<button class="rowbtn" data-sact="down" data-i="' + idx + '">↓</button>'
		+ '<button class="rowbtn" data-sact="preview" data-i="' + idx + '">預覽</button>'
		+ '<button class="rowbtn" data-sact="edit" data-i="' + idx + '">編輯</button>'
		+ '<button class="rowbtn" data-sact="del" data-i="' + idx + '">刪除</button>'
		+ '</td></tr>';
	}).join('') || '<tr><td colspan="3">無資料</td></tr>';
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
	const hideLink = kind === 'svc' && src['分類'] === '專業服務';
	$('modalTitle').innerText = (kind === 'post' ? '編輯文章' : '編輯內容') + `（${src['PostID'] ?? src['ID'] ?? src['標題']}）`;
	$('modalFields').innerHTML = fieldDefs(kind)
		.filter(([k]) => !(hideLink && k === '連結'))
		.map(([k, t]) => {
			const v = src[k] ?? src['內容'] ?? '';
			const input = t === 'textarea'
				? `<textarea data-k="${k}">${esc(v)}</textarea>`
				: `<input data-k="${k}" value="${esc(String(v)).replace(/"/g, '&quot;')}">`;
			const hint = (k === '連結') ? `<div style="font-size:12px;color:#8b7355;margin:2px 0 6px;">多個連結請換行或逗號分隔，一行一個也可以</div>` : '';
			return `<label>${k}</label>` + input + hint;
		}).join('');
	$('previewBox').style.display = 'none';
	$('modal').classList.add('open');
	setModalMode(false);
}

function setModalMode(preview) {
	$('modalFields').style.display = preview ? 'none' : '';
	$('modalSave').style.display = preview ? 'none' : '';
	$('modalPreview').style.display = preview ? 'none' : '';
}

function previewOnly(kind, idx) {
	if (kind === 'post') openEditor('post', idx);
	else if (kind === 'notice') openNoticeEditor(idx);
	else openEditor('svc', idx);
	$('modalTitle').innerText = '預覽（唯讀）';
	setModalMode(true);
	showPreview();
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
	$('previewBox').innerHTML = `<h3 style="margin:0 0 8px;">${esc(f['標題'] || '')}</h3><div>${esc(f['貼文內容'] || '').replace(/\n/g, '<br>')}</div>${imgs}`;
	$('previewBox').style.display = 'block';
}

async function saveEdit() {
	if (!editing) return;
	const f = collectFields();
	try {
		if (editing.kind === 'post') {
			const pid = allPosts[editing.idx]['PostID'];
			allPosts[editing.idx] = { ...allPosts[editing.idx], ...f };
			renderPosts();
			stage('posts', { type: 'update', match: { PostID: pid }, fields: f });
			logOp('編輯文章', `${pid} ${f['標題'] || ''}`);
			setStatus('已暫存，按上方儲存才寫入', 'orange');
		} else if (editing.kind === 'notice') {
			if (editing.idx === -1) {
				const entry = { "發佈日期": f['發佈日期'] || '', "標題": f['標題'] || '', "貼文內容": f['貼文內容'] || '', "圖片網址": null };
				stage('posts', { type: 'append', entry });
				logOp('新增公告', `${f['標題'] || ''}`);
				allNotices.push(entry);
				sortPinned(allNotices);
				renderNoticesAdmin();
				setStatus('已暫存，按上方儲存才寫入', 'orange');
			} else {
			const pid = allNotices[editing.idx]['PostID'];
			allNotices[editing.idx] = { ...allNotices[editing.idx], ...f };
			sortPinned(allNotices);
			renderNoticesAdmin();
			stage('posts', { type: 'update', match: { PostID: pid }, fields: f });
			logOp('編輯公告', `${pid} ${f['標題'] || ''}`);
			setStatus('已暫存，按上方儲存才寫入', 'orange');
			}
		} else {
			const cat = svcCat;
			if (editing.idx === -1) {
				const entry = { "ID": generateSvcId(cat, allSvc), "\u5206\u985e": cat, "\u6a19\u984c": f["\u6a19\u984c"] || "", "\u8cbc\u6587\u5167\u5bb9": f["\u8cbc\u6587\u5167\u5bb9"] || "", "\u9023\u7d50": f["\u9023\u7d50"] || "" };
				stage('services', { type: 'append', entry });
				logOp('新增服務內容', `${cat} ${f['標題'] || ''}`);
				allSvc.push(entry);
				renderSvcRows();
				setStatus('已暫存，按上方儲存才寫入', 'orange');
			} else {
			const src = allSvc[editing.idx];
			const useId = src['ID'] !== undefined;
			const match = useId ? { ID: src['ID'] } : { keyTitle: src['標題'] };
			allSvc[editing.idx] = { ...allSvc[editing.idx], ...f };
			renderSvcRows();
			stage(cat === '公告' ? 'posts' : 'services', { type: 'update', match, fields: f });
			logOp('編輯服務內容', `${cat} ${f['標題'] || ''}`);
			setStatus('已暫存，按上方儲存才寫入', 'orange');
			}
		}
		$('modal').classList.remove('open');
		editing = null;
	} catch (e) {
		setStatus('❌ 暫存失敗：' + e.message, 'red');
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
		const pid = allNotices[idx]['PostID'];
		allNotices.splice(idx, 1);
		renderNoticesAdmin();
		stage('posts', { type: 'delete', match: { PostID: pid } });
		logOp('刪除公告', `${pid}`);
		setStatus('已暫存，按上方儲存才寫入', 'orange');
	} catch (e) { setStatus('❌ 刪除失敗：' + e.message, 'red'); }
}

async function moveSvc(idx, dir) {
	const it = allSvc[idx];
	const ni = idx + dir;
	if (ni < 0 || ni >= allSvc.length) return;
	const useId = it['ID'] !== undefined;
	const [m] = allSvc.splice(idx, 1);
	allSvc.splice(ni, 0, m);
	renderSvcRows();
	stage('services', { type: 'move', match: useId ? { ID: it['ID'] } : { keyTitle: it['標題'] }, dir });
	logOp('移動服務順序', `${it['標題'] || ''} ${dir < 0 ? '上移' : '下移'}`);
	setStatus('已暫存，按上方儲存才寫入', 'orange');
}

async function delItem(kind, idx, btn) {
	if (btn.dataset.armed) {
		try {
			if (kind === 'post') {
				const pid = allPosts[idx]['PostID'];
				allPosts.splice(idx, 1);
				renderPosts();
				stage('posts', { type: 'delete', match: { PostID: pid } });
				logOp('刪除文章', `${pid}`);
				setStatus('已暫存，按上方儲存才寫入', 'orange');
			} else {
				const cat = svcCat;
				const it = allSvc[idx];
				const useId = it['ID'] !== undefined;
				allSvc.splice(idx, 1);
				renderSvcRows();
				stage(cat === '公告' ? 'posts' : 'services', { type: 'delete', match: useId ? { ID: it['ID'] } : { keyTitle: it['標題'] } });
				logOp('刪除服務內容', `${cat} ${it['標題'] || ''}`);
				setStatus('已暫存，按上方儲存才寫入', 'orange');
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
// rebuild version
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

	let imgLoaded = false;
	document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
		document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('active'));
		b.classList.add('active');
		document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
		$('tab-' + b.dataset.tab).classList.add('active');
		if (b.dataset.cat) {
			svcCat = b.dataset.cat;
			svcPage = 1;
			loadSvc();
		}
		if (b.dataset.tab === 'images' && !imgLoaded) {
			imgLoaded = true;
			loadImages();
		}
	});

	$('postSearch').oninput = () => { postPage = 1; renderPosts(); };
	$('postTitleFilter').onchange = () => { postPage = 1; renderPosts(); };
	$('postSort').onchange = () => { postPage = 1; renderPosts(); };
	$('postJump').onchange = () => { postPage = parseInt($('postJump').value) || 1; renderPosts(); };
	$('postReload').onclick = loadPosts;
	$('postAdd').onclick = () => { location.href = 'inputData.html'; };
	$('postPrev').onclick = () => { postPage--; renderPosts(); };
	$('postNext').onclick = () => { postPage++; renderPosts(); };
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
		if (b.dataset.act === 'pin') togglePostPin(i);
		else if (b.dataset.act === 'edit') openEditor('post', i);
		else if (b.dataset.act === 'preview') previewOnly('post', i);
		else if (b.dataset.act === 'del') delItem('post', i, b);
	};
	$('svcReload').onclick = loadSvc;
	$('svcSearch').oninput = () => { svcPage = 1; renderSvcRows(); };
	$('svcJump').onchange = () => { svcPage = parseInt($('svcJump').value) || 1; renderSvcRows(); };
	$('svcAdd').onclick = openSvcCreator;
	$('svcPrev').onclick = () => { svcPage--; renderSvcRows(); };
	$('svcNext').onclick = () => { svcPage++; renderSvcRows(); };
	$('noticeReload').onclick = loadNotices;
	$('noticeAdd').onclick = openNoticeCreator;
	$('noticePrev').onclick = () => { noticePage--; renderNoticesAdmin(); };
	$('noticeNext').onclick = () => { noticePage++; renderNoticesAdmin(); };
	$('noticeSearch').oninput = () => { noticePage = 1; renderNoticesAdmin(); };
	$('noticeJump').onchange = () => { noticePage = parseInt($('noticeJump').value) || 1; renderNoticesAdmin(); };
	$('noticeRows').onclick = (e) => {
		const cell = e.target.closest('.cell-text');
		if (cell && cell.dataset.expanded !== '1') {
			const it = allNotices[Number(cell.dataset.i)];
			if (it) {
				const body = String(it['貼文內容'] || it['內容'] || '');
				if (body.length > 60) {
					cell.innerText = body + ' （收起）';
					cell.dataset.expanded = '1';
					return;
				}
			}
		} else if (cell) {
			cell.dataset.expanded = '';
			const it = allNotices[Number(cell.dataset.i)];
			const body = String(it['貼文內容'] || it['內容'] || '');
			cell.innerText = body.substring(0, 60) + '...';
			return;
		}
		const b = e.target.closest('button'); if (!b) return;
		const i = Number(b.dataset.i);
		if (b.dataset.nact === 'pin') togglePin(i);
		else if (b.dataset.nact === 'preview') previewOnly('notice', i);
		else if (b.dataset.nact === 'edit') openNoticeEditor(i);
		else if (b.dataset.nact === 'del') delNotice(i, b);
	};
	$('svcRows').onclick = (e) => {
		const b = e.target.closest('button'); if (!b) return;
		const i = Number(b.dataset.i);
		if (b.dataset.sact === 'up') moveSvc(i, -1);
		else if (b.dataset.sact === 'down') moveSvc(i, 1);
		else if (b.dataset.sact === 'edit') openEditor('svc', i);
		else if (b.dataset.sact === 'preview') previewOnly('svc', i);
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
	$('oplogDev').onchange = renderOplog;
	$('syncPostsBtn').onclick = rebuildVersion;
	$('saveAllBtn').onclick = saveAll;
	$('discardBtn').onclick = discardAll;
	window.addEventListener('beforeunload', (e) => {
		if (pendingOps.length || pendingLogs.length) {
			e.preventDefault();
			e.returnValue = '';
		}
	});
	$('clearCacheBtn').onclick = () => {
		['cached_novel_data', 'cache_notices', 'cache_services', 'data_ver'].forEach(k => localStorage.removeItem(k));
		setStatus('✅ 本機快取已清除（前台下次開啟會重抓）', 'green');
		logOp('清除快取', '');
	};

	await loadPosts();
	await loadNotices();
	await loadSvc();
}
