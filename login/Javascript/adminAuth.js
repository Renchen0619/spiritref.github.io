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
	return session;
}

export async function getAccessToken() {
	return (await getSession())?.access_token || '';
}

export async function logoutAndGo(loginPage = './') {
	const sb = await getSupabase();
	await sb.auth.signOut();
	location.replace(loginPage);
}

export async function onAuthChange(cb) {
	const sb = await getSupabase();
	sb.auth.onAuthStateChange(cb);
}
