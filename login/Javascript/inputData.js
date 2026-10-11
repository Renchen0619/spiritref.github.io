import { getSession } from './adminAuth.js';

async function requireSession() {
	const session = await getSession();
	if (!session) {
		location.replace('login.html');
		return null;
	}
	return session;
}

// --- 1. 配置設定（資料庫 = GitHub 靜態 JSON，不再經 GAS） ---
const GITHUB_USER = "SpiritRef";
const GITHUB_REPO = "ghoststory"; // 圖片庫
const GITHUB_PATH = "pic";
const JSON_REPO = "spiritref.github.io"; // 資料庫
const JSON_PATH = "Data/postFB.json";
const VERSION_PATH = "Data/postFB.version.json";

// 管理密碼 = 原本邏輯：送 GAS 換 GitHub token（圖片上傳＋JSON 共用）
let authUrl = "";
let finalToken = "";

async function getToken(status) {
	if (finalToken) return finalToken;
	const name = document.getElementById('token').value.trim();
	if (!name) { alert("請輸入管理密碼！"); return ''; }
	if (!authUrl) {
		try {
			const cfg = await (await import('/Javascript/global.js')).getIni('/settings/global.ini');
			authUrl = cfg.updateGithub_URL || '';
		} catch (e) {}
	}
	if (!authUrl) throw new Error('INI 缺少 updateGithub_URL');
	if (status) { status.innerText = "⏳ 正在驗證身分..."; status.style.color = "orange"; }
	const response = await fetch(atob(authUrl), {
		method: "POST",
		body: JSON.stringify({ action: "getGithubToken", user: name })
	});
	const result = await response.json();
	if (!result.success) throw new Error('驗證失敗：' + (result.message || ''));
	finalToken = result.githubToken;
	return finalToken;
}

function ghHeaders(pat) {
	return {
		"Authorization": `token ${pat}`,
		"Accept": "application/vnd.github.v3+json",
		"Content-Type": "application/json"
	};
}

function toBase64Utf8(str) {
	const bytes = new TextEncoder().encode(str);
	let bin = "";
	const CH = 0x8000;
	for (let i = 0; i < bytes.length; i += CH) {
		bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
	}
	return btoa(bin);
}

function fromBase64Utf8(b64) {
	const bin = atob(b64.replace(/\s/g, ''));
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

async function ghRead(pat, repo, path) {
	const r = await fetch(`https://api.github.com/repos/${GITHUB_USER}/${repo}/contents/${path}`, { headers: ghHeaders(pat) });
	if (r.status === 404) return { sha: null, data: null };
	if (!r.ok) throw new Error(`讀取 ${path} 失敗: HTTP ${r.status}`);
	const j = await r.json();
	return { sha: j.sha, data: JSON.parse(fromBase64Utf8(j.content)) };
}

async function ghWrite(pat, repo, path, obj, message, sha) {
	const body = { message, content: toBase64Utf8(typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1)) };
	if (sha) body.sha = sha;
	const r = await fetch(`https://api.github.com/repos/${GITHUB_USER}/${repo}/contents/${path}`, {
		method: "PUT", headers: ghHeaders(pat), body: JSON.stringify(body)
	});
	if (r.status === 409) return 'conflict';
	if (!r.ok) {
		const msg = await r.text();
		throw new Error(`GitHub 寫入失敗: HTTP ${r.status} ${msg.slice(0, 120)}`);
	}
	return 'ok';
}

function updateTime() {
	const now = new Date();
	const pad = (n) => n.toString().padStart(2, '0');
	const dateInput = document.getElementById('date');
	if (dateInput) {
		dateInput.value = `${now.getFullYear()}/${pad(now.getMonth()+1)}/${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
	}
}

async function initApp() {
	try {
		updateTime();
	} catch (e) {}
}

// --- 核心功能：多檔案上傳（直傳 ghoststory/pic） ---
window.uploadToGithub = async function() {
	const session = await requireSession();
	if (!session) return;
	const status = document.getElementById('status');
	let pat = '';
	try {
		pat = await getToken(status);
	} catch (e) {
		status.innerText = "❌ " + e.message;
		status.style.color = "red";
		return;
	}
	if (!pat) return;

	const fileInput = document.getElementById('fileInput');
	const status = document.getElementById('status');
	const picInput = document.getElementById('pic');

	if (fileInput.files.length === 0) { alert("請先選擇檔案！"); return; }

	status.innerText = `⏳ 準備上傳 ${fileInput.files.length} 個檔案...`;
	status.style.color = "blue";

	let uploadedPaths = [];
	const now = new Date();
	const pad = (n) => n.toString().padStart(2, '0');
	const dateBase = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
					 pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());

	for (let i = 0; i < fileInput.files.length; i++) {
		const file = fileInput.files[i];
		const fileExt = file.name.split('.').pop().toLowerCase();
		const fileName = `${dateBase}${i}.${fileExt}`;
		const filePath = `${GITHUB_PATH}/${fileName}`;

		status.innerText = `⏳ 正在上傳 (${i + 1}/${fileInput.files.length}): ${fileName}`;

		try {
			const base64 = await new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.readAsDataURL(file);
				reader.onload = () => {
					const raw = reader.result.split(',')[1];
					resolve(raw.replace(/\s/g, ''));
				};
				reader.onerror = (e) => reject(e);
			});

			const apiUrl = `https://api.github.com/repos/${GITHUB_USER}/${GITHUB_REPO}/contents/${filePath}`;
			const res = await fetch(apiUrl, {
				method: "PUT",
				headers: ghHeaders(pat),
				body: JSON.stringify({
					message: `Upload: ${fileName}`,
					content: base64
				})
			});

			if (res.ok) {
				uploadedPaths.push(filePath);
			} else {
				const contentType = res.headers.get("content-type");
				let errorDetails = `HTTP ${res.status}`;
				if (contentType && contentType.includes("application/json")) {
					const errJson = await res.json();
					errorDetails = errJson.message || errorDetails;
				} else {
					errorDetails = await res.text();
				}
				throw new Error(errorDetails);
			}
		} catch (e) {
			console.error("詳細上傳失敗資訊:", e);
			status.innerText = `❌ 部分失敗: ${e.message}`;
			status.style.color = "red";
			return;
		}
	}

	picInput.value = uploadedPaths.join('|');
	status.innerText = `✅ 成功上傳 ${uploadedPaths.length} 個檔案！`;
	status.style.color = "green";
}

// --- 發文：直接附加到 GitHub JSON（讀-改-寫，衝突自動重試一次） ---
window.sendData = async function() {
	const session = await requireSession();
	if (!session) return;
	const status = document.getElementById('status');
	let pat = '';
	try {
		pat = await getToken(status);
	} catch (e) {
		status.innerText = "❌ " + e.message;
		status.style.color = "red";
		return;
	}
	if (!pat) return;

	const status = document.getElementById('status');
	const title = document.getElementById('title').value.trim();
	const content = document.getElementById('content').value;
	const dateVal = document.getElementById('date').value;
	const picVal = document.getElementById('pic').value.trim();
	if (!title && !content.trim()) { alert("標題和內容不能全空！"); return; }

	status.innerText = "🚀 正在寫入 GitHub...";
	status.style.color = "blue";

	try {
		for (let attempt = 0; attempt < 2; attempt++) {
			const { sha, data } = await ghRead(pat, JSON_REPO, JSON_PATH);
			const arr = Array.isArray(data) ? data : [];
			// 防重複送出：最後一筆完全相同就視為已發佈
			const last = arr[arr.length - 1];
			if (last && last["標題"] === title && (last["貼文內容"] || "") === content) {
				status.innerText = "⚠️ 偵測到相同內容已發佈，不重複寫入。";
				status.style.color = "orange";
				return;
			}
			const maxId = arr.reduce((m, p) => Math.max(m, Number(p.PostID) || 0), 0);
			arr.push({
				PostID: maxId + 1,
				"發佈日期": dateVal,
				"標題": title,
				"貼文內容": content,
				"圖片網址": picVal || null
			});
			const result = await ghWrite(pat, JSON_REPO, JSON_PATH, arr, `Post: ${title}`, sha);
			if (result === 'ok') break;
			if (attempt === 1) throw new Error("連續衝突，請稍後再試");
			// 409：有人同時寫入，重抓一次再試
		}

		// 更新版本戳（保留 services 段）
		try {
			const v = await ghRead(pat, JSON_REPO, VERSION_PATH);
			const ver = (v.data && typeof v.data === 'object') ? v.data : {};
			ver.posts = { updatedAt: new Date().toISOString(), count: undefined };
			// count 以剛寫入的為準
			const cur = await ghRead(pat, JSON_REPO, JSON_PATH);
			ver.posts.count = Array.isArray(cur.data) ? cur.data.length : 0;
			await ghWrite(pat, JSON_REPO, VERSION_PATH, ver, `Sync version (post)`, v.sha);
		} catch (ve) { console.warn("版本戳寫入失敗（不影響本文）:", ve); }

		status.innerText = "✅ 已發佈！前台約 1~3 分鐘生效。";
		status.style.color = "green";

		document.getElementById('title').value = "";
		document.getElementById('content').value = "";
		document.getElementById('pic').value = "";
		document.getElementById('fileInput').value = "";
		updateTime();
	} catch (e) {
		status.innerText = "❌ 發佈失敗：" + e.message;
		console.error(e);
	}
}

initApp();
