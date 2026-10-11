/**
 * 讀取並解析 INI 檔案
 * @param {string} filePath - INI 檔案的路徑
 * @returns {Promise<Object>} - 回傳解析後的物件
 */
export async function getIni(filePath) {
	try {
		// 加入時間戳避免瀏覽器快取舊的設定
		const response = await fetch(filePath + '?t=' + Date.now());
		if (!response.ok) throw new Error(`找不到檔案: ${filePath}`);
		
		const text = await response.text();
		const config = {};
		const lines = text.split(/\r?\n/);

		lines.forEach(line => {
			line = line.trim();
			if (!line || line.startsWith(';') || line.startsWith('#')) return;
			const index = line.indexOf('=');
			if (index !== -1) {
				const key = line.substring(0, index).trim();
				const value = line.substring(index + 1).trim();
				config[key] = value;
			}
		});
		return config;
	} catch (e) {
		console.error("INI Error:", e);
		return null;
	}
}
export function initMenu(menuData) {
    const menuContent = document.getElementById('menuContent');
    if (!menuContent) return;
    const items = menuData.split('|');
    menuContent.innerHTML = ''; 
    items.forEach(item => {
        const parts = item.split(',');
        if (parts.length >= 3) {
            const [text, link, icon] = parts;
            const a = document.createElement('a');
            a.href = link;
            a.className = 'menu-item';
            a.innerHTML = `<span class="icon">${icon}</span> <span class="text">${text}</span>`;
            menuContent.appendChild(a);
        }
    });
}
window.toggleMenu = function() {
    const menu = document.getElementById('menuContainer');
    if (menu) menu.classList.toggle('show-menu');
};
/**
 * 自動偵測 Header 高度並同步到 CSS 變數
 * 解決固定導覽列遮擋錨點標題的問題
 */
export function syncHeaderHeight() {
    const header = document.querySelector('header');
    if (header) {
        const height = header.offsetHeight;
        // 將高度動態寫入根元素的 CSS 變數 --header-h
        document.documentElement.style.setProperty('--header-h', height + 'px');
    }
}

// 初始化監聽器：確保在全站生效
export function initGlobalHeader() {
    // 1. 頁面完全載入後計算一次
    window.addEventListener('load', syncHeaderHeight);
    // 2. 視窗縮放時重新計算 (處理手機/電腦版切換)
    window.addEventListener('resize', syncHeaderHeight);
    // 3. 如果 Logo 是圖片，圖片載入完畢後再算一次最精準
    document.querySelector('.logo img')?.addEventListener('load', syncHeaderHeight);
    
    // 執行第一次計算
    syncHeaderHeight();
}

/**
 * 讀取遠端版本戳（每次後台同步 JSON 時更新，僅數百 bytes）
 * 格式：{ posts: { updatedAt, count }, services: { updatedAt, count } }
 * 回傳正規化字串，抓不到回 null
 */
export async function getRemoteVersion() {
    try {
        const r = await fetch(`/Data/postFB.version.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!r.ok) return null;
        return JSON.stringify(await r.json());
    } catch (e) { return null; }
}
