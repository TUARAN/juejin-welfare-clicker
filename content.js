(function () {
  "use strict";

  const STORAGE_KEYS = {
    count: "jwl_count",
    gapMs: "jwl_gap_ms",
    afterConfirmMs: "jwl_after_confirm_ms",
    primarySel: "jwl_primary_sel",
    confirmSel: "jwl_confirm_sel",
  };

  const DEFAULTS = {
    count: 10,
    gapMs: 800,
    afterConfirmMs: 400,
    primarySel: "",
    confirmSel: "",
  };

  let running = false;
  let stopRequested = false;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return (
      r.width > 0 &&
      r.height > 0 &&
      st.visibility !== "hidden" &&
      st.display !== "none" &&
      st.opacity !== "0"
    );
  }

  function findBySelectorOrNull(sel) {
    if (!sel || !sel.trim()) return null;
    try {
      return document.querySelector(sel.trim());
    } catch {
      return null;
    }
  }

  function btnText(b) {
    return (b.innerText || "").replace(/\s+/g, " ").trim();
  }

  function findConfirmButton(customSel) {
    const fromCustom = findBySelectorOrNull(customSel);
    if (fromCustom && visible(fromCustom)) return fromCustom;

    const buttons = [...document.querySelectorAll("button, [role='button'], .btn, a")];
    const candidates = buttons.filter((b) => {
      if (!visible(b) || b.disabled) return false;
      const t = btnText(b);
      if (/我再想想|取消|关闭|算了/.test(t)) return false;
      if (/确定兑换/.test(t)) return true;
      if (/^(确定|确认|我知道了)$/.test(t)) return true;
      return false;
    });

    const primary =
      candidates.find((b) => /确定兑换/.test(btnText(b))) || candidates[0];
    return primary || null;
  }

  function findRedeemButton(customSel) {
    const fromCustom = findBySelectorOrNull(customSel);
    if (fromCustom && visible(fromCustom) && !fromCustom.disabled) return fromCustom;

    const scoped = [...document.querySelectorAll("*")].filter((el) => {
      const t = el.innerText || "";
      return t.includes("补签卡") && el.querySelector && el.querySelector("button");
    });
    scoped.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length);
    for (const scope of scoped) {
      const btns = [...scope.querySelectorAll("button")].filter(
        (b) =>
          visible(b) &&
          !b.disabled &&
          /兑换|立即兑换/.test((b.innerText || "").trim())
      );
      if (btns.length) return btns[0];
    }

    const fallback = [...document.querySelectorAll("button")].filter(
      (b) =>
        visible(b) &&
        !b.disabled &&
        /兑换|立即兑换/.test((b.innerText || "").trim())
    );
    return fallback[0] || null;
  }

  async function waitForConfirmClick(customConfirmSel, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const btn = findConfirmButton(customConfirmSel);
      if (btn) {
        btn.click();
        return true;
      }
      await sleep(80);
    }
    return false;
  }

  async function loadSettings() {
    const base =
      typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync
        ? chrome.storage.sync
        : null;
    if (!base) return { ...DEFAULTS };
    const raw = await new Promise((resolve) => {
      base.get(Object.values(STORAGE_KEYS), (obj) => resolve(obj || {}));
    });
    return {
      count: Number(raw[STORAGE_KEYS.count]) || DEFAULTS.count,
      gapMs: Number(raw[STORAGE_KEYS.gapMs]) || DEFAULTS.gapMs,
      afterConfirmMs: Number(raw[STORAGE_KEYS.afterConfirmMs]) || DEFAULTS.afterConfirmMs,
      primarySel: String(raw[STORAGE_KEYS.primarySel] || ""),
      confirmSel: String(raw[STORAGE_KEYS.confirmSel] || ""),
    };
  }

  function savePartial(patch) {
    const base =
      typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync
        ? chrome.storage.sync
        : null;
    if (!base) return;
    const payload = {};
    if (patch.count != null) payload[STORAGE_KEYS.count] = patch.count;
    if (patch.gapMs != null) payload[STORAGE_KEYS.gapMs] = patch.gapMs;
    if (patch.afterConfirmMs != null)
      payload[STORAGE_KEYS.afterConfirmMs] = patch.afterConfirmMs;
    if (patch.primarySel != null) payload[STORAGE_KEYS.primarySel] = patch.primarySel;
    if (patch.confirmSel != null) payload[STORAGE_KEYS.confirmSel] = patch.confirmSel;
    base.set(payload);
  }

  function ensureUi() {
    if (document.getElementById("jwl-root")) return;

    const root = document.createElement("div");
    root.id = "jwl-root";
    root.innerHTML = `
      <div id="jwl-panel">
        <h3>补签卡兑换</h3>
        <label>目标次数（总点击兑换次数）</label>
        <input id="jwl-count" type="number" min="1" step="1" />
        <label>点「确定」后间隔（毫秒，再发起下一次兑换）</label>
        <input id="jwl-gap" type="number" min="0" step="50" />
        <label>点「确定」后额外停顿（毫秒，给页面刷新状态）</label>
        <input id="jwl-after" type="number" min="0" step="50" />
        <label>兑换按钮 CSS 选择器（可选，留空则自动找「补签卡」附近的兑换）</label>
        <input id="jwl-primary" type="text" spellcheck="false" placeholder="例：.goods-item button.btn-main" />
        <label>确认弹窗按钮选择器（可选）</label>
        <input id="jwl-confirm" type="text" spellcheck="false" placeholder="例：.byte-modal button.byte-btn-primary" />
        <div class="jwl-row">
          <button type="button" class="jwl-primary" id="jwl-start">开始</button>
          <button type="button" class="jwl-danger" id="jwl-stop" disabled>停止</button>
        </div>
        <div class="jwl-row">
          <button type="button" class="jwl-secondary" id="jwl-hide">收起</button>
        </div>
        <div id="jwl-log"></div>
      </div>
      <button type="button" id="jwl-toggle" title="展开补签兑换面板">签</button>
    `;
    document.documentElement.appendChild(root);

    const logEl = () => root.querySelector("#jwl-log");
    function log(line) {
      const el = logEl();
      const ts = new Date().toLocaleTimeString();
      el.textContent = `[${ts}] ${line}\n` + el.textContent;
      const max = 4000;
      if (el.textContent.length > max) {
        el.textContent = el.textContent.slice(0, max);
      }
    }

    const els = {
      count: root.querySelector("#jwl-count"),
      gap: root.querySelector("#jwl-gap"),
      after: root.querySelector("#jwl-after"),
      primary: root.querySelector("#jwl-primary"),
      confirm: root.querySelector("#jwl-confirm"),
      start: root.querySelector("#jwl-start"),
      stop: root.querySelector("#jwl-stop"),
      hide: root.querySelector("#jwl-hide"),
      toggle: root.querySelector("#jwl-toggle"),
    };

    loadSettings().then((s) => {
      els.count.value = String(s.count);
      els.gap.value = String(s.gapMs);
      els.after.value = String(s.afterConfirmMs);
      els.primary.value = s.primarySel;
      els.confirm.value = s.confirmSel;
    });

    function bindInputs() {
      savePartial({
        count: Number(els.count.value),
        gapMs: Number(els.gap.value),
        afterConfirmMs: Number(els.after.value),
        primarySel: els.primary.value,
        confirmSel: els.confirm.value,
      });
    }
    ["count", "gap", "after", "primary", "confirm"].forEach((k) => {
      els[k].addEventListener("change", bindInputs);
    });

    async function runBatch() {
      const total = Math.max(1, Math.floor(Number(els.count.value) || 1));
      const gapMs = Math.max(0, Number(els.gap.value) || 0);
      const afterConfirmMs = Math.max(0, Number(els.after.value) || 0);
      const primarySel = els.primary.value.trim();
      const confirmSel = els.confirm.value.trim();

      savePartial({
        count: total,
        gapMs,
        afterConfirmMs,
        primarySel,
        confirmSel,
      });

      stopRequested = false;
      running = true;
      els.start.disabled = true;
      els.stop.disabled = false;
      log(`开始：共 ${total} 次；确定后停顿 ${afterConfirmMs + gapMs} ms`);

      for (let i = 1; i <= total; i++) {
        if (stopRequested) {
          log(`已停止于第 ${i - 1}/${total} 次之前`);
          break;
        }

        const redeem = findRedeemButton(primarySel);
        if (!redeem) {
          log(`第 ${i}/${total} 次：未找到兑换按钮（可填写自定义选择器或确认已在「补签卡」列表）`);
          break;
        }

        redeem.click();
        const ok = await waitForConfirmClick(confirmSel, 12000);
        if (!ok) {
          log(`第 ${i}/${total} 次：12s 内未出现「确定兑换」等确认按钮（可调确认按钮选择器）`);
          break;
        }

        await sleep(afterConfirmMs + gapMs);

        log(`完成 ${i}/${total}`);
      }

      running = false;
      els.start.disabled = false;
      els.stop.disabled = true;
      log("本轮结束");
    }

    els.start.addEventListener("click", () => {
      if (running) return;
      runBatch().catch((e) => {
        log(`异常：${e && e.message ? e.message : String(e)}`);
        running = false;
        els.start.disabled = false;
        els.stop.disabled = true;
      });
    });

    els.stop.addEventListener("click", () => {
      stopRequested = true;
      log("收到停止指令，将在当前次完成后停下…");
    });

    els.hide.addEventListener("click", () => {
      root.classList.add("jwl-collapsed");
    });
    els.toggle.addEventListener("click", () => {
      root.classList.remove("jwl-collapsed");
    });
  }

  ensureUi();
})();
