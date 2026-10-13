import { getIni } from '/Javascript/global.js?v=20261011';

// 集中管理：優先讀 /settings/global.ini 的 SUPABASE_URL / SUPABASE_ANON_KEY，
// INI 失效時才用下方備援值（換專案只改 INI 即可，不用動程式）。
const FALLBACK_URL = 'https://ocqycgcatxdbpffpxdva.supabase.co';
const FALLBACK_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9jcXljZ2NhdHhkYnBmZnB4ZHZhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE0NjcxODksImV4cCI6MjEwNzA0MzE4OX0.ZmE5XI1LZdnZ3LagFDhcqaLqh-u3T8dtIFyBTHYzDOw';

let client = null;

export async function getSupabase() {
	if (client) return client;
	const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
	let url = FALLBACK_URL;
	let key = FALLBACK_ANON;
	try {
		const cfg = await getIni('/settings/global.ini');
		if (cfg?.SUPABASE_URL) url = cfg.SUPABASE_URL;
		if (cfg?.SUPABASE_ANON_KEY) key = cfg.SUPABASE_ANON_KEY;
	} catch (e) { console.warn('登入設定改用備援值:', e); }
	client = createClient(url, key);
	return client;
}

export async function getSession() {
	const sb = await getSupabase();
	const { data } = await sb.auth.getSession();
	return data.session;
}

// 無 session 時踢回登入頁（帶 next，登入後回到原頁），回傳 session
export async function requireAdmin(loginPage = './') {
	const session = await getSession();
	if (!session) {
		const next = location.pathname.split('/').pop() || 'admin.html';
		location.replace(`${loginPage}?next=${encodeURIComponent(next)}`);
		return null;
	}
	startIdleLogout(loginPage);
	return session;
}

// 閒置自動登出（預設 30 分鐘；測試可用 ?idle=秒 覆寫，5~7200）
function idleMs() {
	try {
		const q = Number(new URLSearchParams(location.search).get('idle'));
		if (q >= 5 && q <= 7200) return q * 1000;
	} catch (e) {}
	return 30 * 60 * 1000;
}
let idleTimer = null;
export function startIdleLogout(loginPage = './') {
	const reset = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(async () => {
			try {
				sessionStorage.setItem('idle_logout', '1');
				const sb = await getSupabase();
				await sb.auth.signOut();
			} catch (e) {}
			location.replace(loginPage + '?timeout=1');
		}, idleMs());
	};
	['click', 'keydown', 'scroll', 'touchstart'].forEach(ev => window.addEventListener(ev, reset, { passive: true }));
	reset();
}

export async function getAccessToken() {
	return (await getSession())?.access_token || '';
}

export async function logoutAndGo(loginPage = './') {
	try {
		sessionStorage.removeItem('admin_pwd');
		sessionStorage.removeItem('net_info');
		const sb = await getSupabase();
		await sb.auth.signOut();
	} catch (e) {}
	location.replace(loginPage);
}

export async function onAuthChange(cb) {
	const sb = await getSupabase();
	sb.auth.onAuthStateChange(cb);
}
