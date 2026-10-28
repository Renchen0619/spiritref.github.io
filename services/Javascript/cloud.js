// 祥雲圖片背景（共用）：直接用 PNG，頁面有 #cloud-container 才作用
// 想加不同造型：把圖丟進 /pic/，檔名加進 IMAGES 陣列即可
// 展示頁可用 data-count 加量：<div id="cloud-container" data-count="16">
(function () {
    const IMAGES = ['/pic/cloud.png'];

    const rand = (a, b) => a + Math.random() * (b - a);

    // 分道制：天空切橫道，同道同速＋前後等距，雲永遠不重疊
    function lanePlan(total) {
        const W = window.innerWidth, H = window.innerHeight;
        const lanes = H < 520 ? 2 : 3;
        const perLane = Math.max(2, Math.ceil(total / lanes));
        const list = [];
        for (let l = 0; l < lanes; l++) {
            const duration = rand(45, 110);
            for (let j = 0; j < perLane && list.length < total; j++) {
                list.push({
                    lane: l, lanes,
                    duration,
                    slot: (j + rand(0.15, 0.85)) / perLane // 在整條飛行路徑上等距錯開
                });
            }
        }
        return list;
    }

    function makeCloud(plan) {
        const item = document.createElement('div');
        item.className = 'cloud-item';

        const W = window.innerWidth, H = window.innerHeight;
        const laneH = H / plan.lanes;
        const baseW = Math.min(rand(220, 380), W * 0.55);
        const cloudH = baseW * 0.45;
        item.style.width = baseW + 'px';
        // 垂直：道內置中＋小抖動，不超出本道
        const top = plan.lane * laneH + Math.max(0, (laneH - cloudH) / 2) + rand(-14, 14);
        item.style.top = Math.max(0, top) + 'px';
        item.style.left = '0';
        item.style.opacity = rand(0.85, 1).toFixed(2);

        // 同道同速，用負延遲把雲鋪在路徑各段，間距永久保持
        item.style.setProperty('--duration', plan.duration.toFixed(1) + 's');
        item.style.animationDelay = (-plan.slot * plan.duration).toFixed(1) + 's';

        const bob = document.createElement('div');
        bob.className = 'cloud-bob';
        const bobDur = rand(6, 11);
        bob.style.setProperty('--bob-duration', bobDur.toFixed(1) + 's');
        bob.style.animationDelay = (Math.random() * -bobDur).toFixed(1) + 's';

        const img = document.createElement('img');
        img.src = IMAGES[Math.floor(Math.random() * IMAGES.length)];
        img.alt = '';
        img.draggable = false;
        if (Math.random() > 0.5) img.style.transform = 'scaleX(-1)';
        bob.appendChild(img);

        item.appendChild(bob);
        return item;
    }

    function init() {
        const container = document.getElementById('cloud-container');
        if (!container) return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        let count = Number(container.dataset.count) || 14;
        if (window.innerWidth < 640) count = Math.min(count, 6); // 小螢幕減量
        lanePlan(count).forEach(plan => container.appendChild(makeCloud(plan)));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
