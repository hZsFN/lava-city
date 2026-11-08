/* =========================================================
 * 无限世界 · SAVE_STATE v3 存档协议核心库
 * ---------------------------------------------------------
 * 整条世界线的关卡都靠这个文件衔接，队伍【不需要修改本文件】。
 *
 * 大厅/外链首尾接力：await WL.ready()；await WL.complete(save, opts) / WL.fail(reason, save, opts)。
 * 官方托管：https://world.dayquay.com/sdk/v1/worldline.js。
 * 以下旧 API 继续兼容；同步读档须在宿主存档就绪后使用。
 *
 * 队伍常用 API：
 *   WL.readSave(levelNo)        读档（宽容：缺字段补默认、多字段忽略、类型自动转换）
 *   WL.consumeAny(items, type)  按类型取用上家道具，取不到返回 null → 触发本关兜底剧情
 *   WL.addItem(save, item)      往背包加道具 { id, name, type }
 *   WL.addClue(save, text)      加线索
 *   WL.setPlayer(save, patch)   改面板 { hp, max_hp, sanity, level, status, curses }
 *   WL.respawn()                恢复进入本关时的存档快照
 *   WL.failLevel(reason)        本关失败：生成遗物、墓碑和满血二代探索者
 *   WL.forcePass()              裁判强制结束本关并走遗物交接
 *   WL.completeLevel(config, save, opts)
 *                               校验出口 → 写档 → 过场 → 跳转；缺交接必填项返回 null
 *                               opts = { exitHook: '结尾一句话', nextUrl: '下一关页面地址' }
 *   WL.renderOpening(save)      前情提要条（自动呼应上家钩子）
 *   WL.renderSaveCard(save, level, world)   五行「通关存档卡」
 *   WL.goTo(url, save)          带存档与旅程进入页面（大厅首跳也使用）
 *   WL.mountDebug(save)         安装存档复制、导入、重置按钮
 *
 * 大厅存档传递通道：postMessage → 大厅校验保存 → 下一关；仅在首尾调用。
 * 独立打开的兼容通道：localStorage（同一台电脑接力）
 *              + URL ?save=存档码&history=旅程码（跳转时自动附加，兼容 file:// 分页存储）
 *
 * 纯静态实现：file:// 双击即可运行，无任何依赖。
 * ========================================================= */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'wuxianliu_save_v3';
  var HISTORY_KEY = 'wuxianliu_history_v3';
  var LEGACY_STORAGE_KEY = 'wuxianliu_save_v2';
  var LEGACY_HISTORY_KEY = 'wuxianliu_history_v2';
  var memoryHistory = null;
  var memoryInitialSave = null;
  var memorySave = null;
  var SCHEMA = 'v3';

  /* 道具类型词表（8 类，消费按类型匹配，不按名称匹配） */
  var ITEM_TYPES = ['key', 'tool', 'light', 'food', 'token', 'info', 'weapon', 'strange'];
  var TYPE_LABELS = {
    key: '钥匙', tool: '工具', light: '照明', food: '食物',
    token: '信物', info: '情报', weapon: '武器', strange: '异物'
  };

  /* 通用道具效果词表（宪章第二章）：有限集合，不开放自由字段。
   * hp/sanity/max_hp/attack 的 value 必须在区间内；cleanse 只接受 true。 */
  var EFFECT_STATS = ['hp', 'sanity', 'max_hp', 'cleanse', 'attack'];
  var EFFECT_TRIGGERS = ['on_enter', 'passive'];
  var EFFECT_RANGE = { hp: [1, 2], sanity: [1, 1], max_hp: [1, 1], attack: [1, 1] };
  var ITEMS_MAX = 3;

  /* ---------------- 基础工具 ---------------- */

  function esc(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toInt(value, fallback, min) {
    var n = parseInt(value, 10);
    if (isNaN(n)) n = fallback;
    if (typeof min === 'number' && n < min) n = min;
    return n;
  }

  function toStr(value, fallback) {
    if (value === undefined || value === null) return fallback || '';
    return String(value);
  }

  function defaultSave(levelNo) {
    return {
      schema: SCHEMA,
      level: typeof levelNo === 'number' ? levelNo : 1,
      player: { hp: 3, max_hp: 3, sanity: 2, level: 1, status: 'normal', curses: [] },
      items: [],
      clues: [],
      exit_hook: '',
      prev_world: '',
      next_world: '',
      tombstone: {}
    };
  }

  /* 效果词条校验：不合规返回 null → 道具降级为纯装饰，不参与结算 */
  function coerceEffect(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var stat = toStr(raw.stat, '').trim().toLowerCase();
    if (EFFECT_STATS.indexOf(stat) === -1) return null;
    var trigger = toStr(raw.trigger, '').trim().toLowerCase();
    if (EFFECT_TRIGGERS.indexOf(trigger) === -1) return null;
    if (stat === 'cleanse') {
      if (raw.value !== true) return null;
      return { stat: stat, value: true, trigger: trigger };
    }
    var range = EFFECT_RANGE[stat], n = raw.value;
    if (typeof n !== 'number' || !Number.isInteger(n)) return null;
    if (!range || n < range[0] || n > range[1]) return null;
    return { stat: stat, value: n, trigger: trigger };
  }

  /* 道具归一化：类型不在词表内 → 归为 strange（异物）；effect 不合规 → 丢弃 */
  function coerceItem(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var type = toStr(raw.type, 'strange').trim().toLowerCase();
    if (ITEM_TYPES.indexOf(type) === -1) type = 'strange';
    var item = {
      id: toStr(raw.id, '').trim().slice(0,64) || 'item_' + Math.random().toString(36).slice(2, 8),
      name: (toStr(raw.name, '未知物品').trim() || '未知物品').slice(0, 32),
      type: type,
      relic: raw.relic === true
    };
    if (raw.desc !== undefined) item.desc = toStr(raw.desc, '').slice(0, 120);
    var effect = coerceEffect(raw.effect);
    if (effect) item.effect = effect;
    if (raw.durability !== undefined) item.durability = Math.max(0, toInt(raw.durability, 1, 0));
    return item;
  }

  function coerceItems(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(coerceItem).filter(Boolean).slice(-ITEMS_MAX);
  }

  function coerceClues(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(function (c) { return toStr(c, '').trim(); }).filter(function (c) { return c; });
  }

  /* ---------------- 存档码（base64，用于 URL 传递与手动导入） ---------------- */

  function toB64(str) {
    if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(str)));
    if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf-8').toString('base64');
    throw new Error('当前环境不支持 base64');
  }
  function fromB64(b64) {
    if (typeof atob === 'function') return decodeURIComponent(escape(atob(b64)));
    if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf-8');
    throw new Error('当前环境不支持 base64');
  }

  function encodeCode(save) {
    return toB64(JSON.stringify(save));
  }

  function decodeCode(code) {
    try {
      return JSON.parse(fromB64(String(code).trim()));
    } catch (e) {
      return null;
    }
  }

  /* ---------------- 旅程记录（供终局结算页回放） ---------------- */

  /* 与存档分开存放：存档卡保持严格五栏，旅程回放数据走独立通道 */
  function readHistory() {
    try {
      var arr = memoryHistory;
      var m = global.location.search.match(/[?&]history=([^&]+)/);
      if (!Array.isArray(arr) && m) arr = decodeCode(decodeURIComponent(m[1]));
      if (!Array.isArray(arr)) {
        var raw = global.localStorage.getItem(HISTORY_KEY) || global.localStorage.getItem(LEGACY_HISTORY_KEY);
        arr = raw ? JSON.parse(raw) : [];
      }
      if (!Array.isArray(arr)) return [];
      return arr.map(function (h) {
        if (!h || typeof h !== 'object') return null;
        return {
          level: toInt(h.level, 0, 0),
          world: toStr(h.world, '？？？'),
          hook: toStr(h.hook, '')
        };
      }).filter(Boolean).slice(-64);
    } catch (e) { return []; }
  }

  /* 每通完一关自动记录一条：第几关 · 什么世界 · 留下了什么结局 */
  function recordPassage(config, save) {
    var list = readHistory();
    list.push({
      level: toInt(config.level, 0, 0),
      world: toStr(config.world, '？？？'),
      hook: toStr(save.exit_hook, '')
    });
    if (list.length > 64) list = list.slice(-64); /* 安全上限 */
    memoryHistory = list;
    try {
      global.localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch (e) { /* ignore */ }
  }

  /* 开始新一局：清空旧数据，生成全场统一开局面板（命3 · 理智2 · 空背包） */
  function startRun(levelNo) {
    resetRun();
    var save = defaultSave(typeof levelNo === 'number' ? levelNo : 1);
    persist(save);
    return save;
  }

  /* 清空本机全部运行数据（存档 + 旅程记录） */
  function resetRun() {
    memoryHistory = [];
    memoryInitialSave = null;
    memorySave = null;
    try {
      global.localStorage.removeItem(STORAGE_KEY);
      global.localStorage.removeItem(HISTORY_KEY);
      global.localStorage.removeItem(LEGACY_STORAGE_KEY);
      global.localStorage.removeItem(LEGACY_HISTORY_KEY);
    } catch (e) { /* ignore */ }
  }

  /* ---------------- 读档（宽容处理核心） ---------------- */

  /* 缺字段补默认值、多字段一律忽略、类型自动转换 */
  function normalize(raw, levelNo) {
    var base = defaultSave(levelNo);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
    var player = raw.player && typeof raw.player === 'object' ? raw.player : {};
    var maxHp = Math.min(10, Math.max(1, toInt(player.max_hp, 3, 1)));
    var hp = Math.min(maxHp, toInt(player.hp, 3, 0));
    var status = toStr(player.status, hp <= 0 ? 'dead' : 'normal');
    if (['normal', 'wounded', 'cursed', 'dead', 'specter'].indexOf(status) === -1) status = 'normal';
    var tomb = raw.tombstone && typeof raw.tombstone === 'object' && !Array.isArray(raw.tombstone) ? raw.tombstone : {};
    return {
      schema: SCHEMA,
      level: typeof levelNo === 'number' ? levelNo : toInt(raw.level, 1, 0),
      world: toStr(raw.world, ''),
      player: {
        hp: hp,
        max_hp: maxHp,
        level: Math.min(10, toInt(player.level, 1, 1)),
        sanity: toInt(player.sanity, 2, 0),
        status: status,
        curses: Array.isArray(player.curses) ? player.curses.map(function (c) { return toStr(c, '').slice(0, 40); }).filter(Boolean).slice(0, 8) : [],
        deaths: toInt(player.deaths, 0, 0)
      },
      items: coerceItems(raw.items),
      /* 已结算的 on_enter 道具 id：防止换关卡或刷新时重复回血 */
      settled: Array.isArray(raw.settled) ? raw.settled.map(function (id) { return toStr(id, '').slice(0, 64); }).filter(Boolean).slice(-8) : [],
      clues: coerceClues(raw.clues).slice(-8),
      exit_hook: toStr(raw.exit_hook, ''),
      prev_world: toStr(raw.prev_world, ''),
      next_world: toStr(raw.next_world, ''),
      tombstone: {
        fallen_level: toInt(tomb.fallen_level, 0, 0),
        cause: toStr(tomb.cause, '').slice(0, 100),
        epitaph: toStr(tomb.epitaph, '').slice(0, 200)
      }
    };
  }

  function persist(save) {
    memorySave = normalize(save, null);
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(save));
    } catch (e) { /* 隐私模式等场景静默忽略，不影响游戏 */ }
  }

  /* 读取优先级：本页已接收/更新的内存存档 → URL ?save=存档码 → localStorage → 默认开局 */
  function readSave(levelNo) {
    var raw = memorySave || (global.__IW_BOOT && global.__IW_BOOT.save);
    if (!raw) try {
      var m = global.location.search.match(/[?&]save=([^&]+)/);
      if (m) {
        raw = decodeCode(decodeURIComponent(m[1]));
        if (raw) persist(normalize(raw, levelNo)); /* 落地本地，刷新不丢 */
      }
    } catch (e) { /* ignore */ }
    if (!raw) {
      try {
        var stored = global.localStorage.getItem(STORAGE_KEY) || global.localStorage.getItem(LEGACY_STORAGE_KEY);
        if (stored) raw = JSON.parse(stored);
      } catch (e) { /* ignore */ }
    }
    var save = applyEntryEffects(normalize(raw, levelNo));
    if (!memoryInitialSave) memoryInitialSave = normalize(save, levelNo);
    memorySave = normalize(save, null);
    return save;
  }

  function freezeSnapshot(value) {
    if (value && typeof value === 'object') {
      Object.keys(value).forEach(function (key) { freezeSnapshot(value[key]); });
      Object.freeze(value);
    }
    return value;
  }
  function getInitialSave() {
    if (memoryInitialSave) return normalize(memoryInitialSave, null);
    return readSave();
  }

  /* 通用道具 on_enter 结算：每件道具只结算一次（settled 标记随存档一路传递）。
   * passive 效果不改数值，由下一关玩法自行读取 save.items[].effect。 */
  function applyEntryEffects(save) {
    var current = normalize(save, null);
    var done = current.settled;
    current.items.forEach(function (it) {
      var fx = it.effect;
      if (!fx || fx.trigger !== 'on_enter' || done.indexOf(it.id) !== -1) return;
      if (fx.stat === 'hp') current.player.hp = Math.min(current.player.max_hp, current.player.hp + fx.value);
      else if (fx.stat === 'sanity') current.player.sanity = Math.max(0, current.player.sanity + fx.value);
      else if (fx.stat === 'max_hp') current.player.max_hp = Math.min(10, current.player.max_hp + fx.value);
      else if (fx.stat === 'cleanse' && current.player.curses.length) {
        current.player.curses.splice(0, 1);
        if (current.player.status === 'cursed') current.player.status = 'normal';
      }
      done.push(it.id);
    });
    current.settled = done.slice(-8);
    return current;
  }

  function respawn() {
    var initial = applyEntryEffects(getInitialSave());
    initial.player.deaths = (initial.player.deaths || 0) + 1;
    memoryInitialSave = normalize(initial, null);
    persist(initial);
    return initial;
  }

  /* 连续阵亡放水档位：0 正常 / 1 连死两次 / 2 连死三次以上；具体放水由选手实现 */
  function assist(save) {
    var n = toInt(save && save.player ? save.player.deaths : 0, 0, 0);
    return n >= 3 ? 2 : n >= 2 ? 1 : 0;
  }

  /* ---------------- 游戏内编辑存档 ---------------- */

  /* 按类型取用上家道具：命中则从背包移除并返回该道具；取不到返回 null，
   * 此时队伍必须走本关兜底剧情（评审「衔接分」硬性要求！） */
  function consumeAny(items, type) {
    if (!Array.isArray(items)) return null;
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].type === type) {
        return items.splice(i, 1)[0];
      }
    }
    return null;
  }

  function addItem(save, item) {
    var rawEffect = item && typeof item === 'object' ? item.effect : null;
    var it = coerceItem(item);
    if (it) {
      if (rawEffect && !it.effect && typeof console !== 'undefined') {
        console.warn('[WL] 道具「' + it.name + '」的 effect 不符合宪章词表，已降级为纯装饰道具。');
      }
      save.items.push(it);
      if (save.items.length > ITEMS_MAX) {
        save.items = save.items.slice(-ITEMS_MAX);
        if (typeof console !== 'undefined') console.warn('[WL] 跨关道具最多 3 件，已丢弃最早的一件。');
      }
    }
    return save;
  }

  function addClue(save, text) {
    var t = toStr(text, '');
    if (t) save.clues.push(t);
    return save;
  }

  function setPlayer(save, patch) {
    if (!patch) return save;
    if (patch.max_hp !== undefined) save.player.max_hp = Math.min(10, Math.max(1, toInt(patch.max_hp, save.player.max_hp || 3, 1)));
    if (patch.hp !== undefined) save.player.hp = Math.min(save.player.max_hp || 3, toInt(patch.hp, save.player.hp, 0));
    if (patch.level !== undefined) save.player.level = Math.min(10, toInt(patch.level, save.player.level || 1, 1));
    if (patch.sanity !== undefined) save.player.sanity = toInt(patch.sanity, save.player.sanity, 0);
    if (patch.status !== undefined) save.player.status = toStr(patch.status, save.player.status);
    if (Array.isArray(patch.curses)) save.player.curses = patch.curses.slice(0, 8);
    return save;
  }

  /* ---------------- 写档 → 过场演出 → 跳转 ---------------- */

  /* 超量保留最近取得的内容，让本关的交接信息优先传给下家。 */
  function softValidate(save) {
    var warnings = [];
    if (save.items.length > 3) {
      save.items = save.items.slice(-3);
      warnings.push('道具超过 3 件，已优先保留最近取得的 3 件');
    }
    if (save.clues.length > 2) {
      save.clues = save.clues.slice(-2);
      warnings.push('线索超过 2 条，已优先保留最近取得的 2 条');
    }
    return warnings;
  }

  /* 读档保持宽容；交接必填项缺失时明确提示，不写入无效出口。 */
  function validateExit(save, config, opts) {
    config = config || {};
    opts = opts || {};
    var errors = [];
    if (!save.items.length) errors.push('请为出口准备至少 1 件道具，并标注道具类型。');
    if (!save.clues.length) errors.push('请为出口准备至少 1 条本关线索。');
    if (!toStr(save.exit_hook, '').trim()) errors.push('请填写指向下一个世界的结尾一句话。');
    if (!toStr(config.world, '').trim()) errors.push('请填写本关世界名。');
    if (!toStr(config.nextWorld, '').trim()) errors.push('请填写下一关世界名。');
    if (!toStr(opts.nextUrl, '').trim()) errors.push('请填写下一关页面地址。');
    return errors;
  }

  function showExitErrors(errors) {
    if (typeof document === 'undefined') return;
    var box = document.getElementById('wl-exit-errors');
    if (!box) {
      box = document.createElement('div');
      box.id = 'wl-exit-errors';
      (document.getElementById('finish-area') || document.body).appendChild(box);
    }
    box.innerHTML = errors.length ? '<div class="wl-warn" role="alert"><strong>交接尚未完成</strong><br>' + errors.map(esc).join('<br>') + '</div>' : '';
  }

  /*
   * config = { level: 本关序号, world: 本关世界名, nextWorld: 下家世界名 }
   * save   = readSave 拿到、游戏过程中已修改的存档对象
   * opts   = { exitHook: '结尾一句话（必须指向下一签世界）', nextUrl: '下家页面地址', passViaUrl: 是否附加存档码（默认 true） }
   */
  function failLevel(reason, fallenSave, configOverride) {
    var config = configOverride || global.CONFIG || {};
    var current = fallenSave ? normalize(fallenSave, toInt(config.level, 1, 1)) : readSave(toInt(config.level, 1, 1));
    var cause = toStr(reason, '力竭倒地').slice(0, 100);
    var items = coerceItems(current.items);
    if (!items.length) {
      items = [{ id: 'relic_survival_knife', name: '前人的求生短刀', type: 'tool', relic: true }];
    } else {
      items = items.map(function (it) {
        it.relic = true;
        it.name = ('前人的' + it.name.replace(/^(前人的)+/, '')).slice(0, 32);
        return it;
      }).slice(0, 3);
    }
    var previous = current.tombstone || {};
    var marker = '[第' + current.level + '关] ' + cause;
    var relicSave = normalize({
      schema: SCHEMA,
      level: current.level + 1,
      world: current.world || config.world,
      player: { hp: 3, max_hp: 3, sanity: 2, level: 1, status: 'normal', curses: [] },
      items: items,
      clues: current.clues.length ? current.clues : ['前人倒在此处，留下了未解的谜题'],
      exit_hook: '【遗物交接】一代探索者在此长眠，新求生者拾起遗物踏入下一世界……',
      prev_world: current.world || config.world,
      next_world: config.nextWorld || current.next_world || '未知世界',
      tombstone: {
        fallen_level: current.level,
        cause: cause,
        epitaph: ((previous.epitaph ? previous.epitaph + ' | ' : '') + marker).slice(0, 200)
      }
    }, current.level + 1);
    persist(relicSave);
    recordPassage(config, relicSave);
    if (global.parent && global.parent !== global) {
      global.parent.postMessage({ type: 'IW_FAIL', reason: cause, fallenSave: current }, '*');
      global.parent.postMessage({ type: 'IW_SAVE', save: relicSave, history: readHistory(), failure: true }, '*');
    }
    if (config.nextUrl) showHandoffOverlay(config, relicSave, [], config.nextUrl, true);
    return relicSave;
  }

  function forcePass() {
    return failLevel('时空裂隙坍缩（演示超时）');
  }

  function completeLevel(config, save, opts) {
    opts = opts || {};
    config = config || {};
    if (global.CONFIG && global.parent && global.parent !== global) { config = global.CONFIG; opts.exitHook = config.exitHook; opts.nextUrl = config.nextUrl; }
    if (config.itemManifest && global.parent && global.parent !== global) {
      save = save || readSave(toInt(config.level, 1, 1));
      var before = memoryInitialSave && memoryInitialSave.items || [];
      var previousIds = before.map(function (item) { return item.id; });
      var acquiredItemIds = opts.acquiredItemIds;
      if (acquiredItemIds === undefined) acquiredItemIds = (save.items || []).filter(function (item) { return previousIds.indexOf(item.id) === -1; }).map(function (item) { return item.id; });
      global.parent.postMessage({ type: 'IW_COMPLETE', save: save, acquiredItemIds: acquiredItemIds }, '*');
      return save;
    }
    var current = normalize(save, toInt(config.level, 1, 1));
    if (current.player.hp <= 0 || current.player.status === 'dead') {
      return failLevel('探索者生命耗尽', save, config);
    }
    var candidate = normalize(save, toInt(config.level, 1, 1) + 1);
    candidate.player.deaths = 0;
    candidate.exit_hook = toStr(opts.exitHook, '').trim();
    candidate.prev_world = toStr(config.world, '').trim();
    candidate.next_world = toStr(config.nextWorld, '').trim();
    var warnings = softValidate(candidate);
    if (Array.isArray(save.items) && save.items.length > 3) warnings.push('道具超过 3 件，已保留最近 3 件');
    if (Array.isArray(save.clues) && save.clues.length > 2) warnings.push('线索超过 2 条，已保留最近 2 条');
    if (warnings.length && typeof console !== 'undefined') console.warn('[WL] ' + warnings.join('；'));
    var errors = validateExit(candidate, config, opts);
    showExitErrors(errors);
    if (errors.length) return null;
    Object.keys(candidate).forEach(function (key) { save[key] = candidate[key]; });
    persist(save);
    recordPassage(config, save); /* 旅程记录：终局结算页回放用 */
    if (global.parent && global.parent !== global) {
      global.parent.postMessage({ type: 'IW_COMPLETE', save: save, history: readHistory() }, '*');
    }
    showHandoffOverlay(config, save, warnings, opts.nextUrl, opts.passViaUrl !== false);
    return save;
  }

  /* 替换旧参数、保留其他参数与锚点，导入不会再次读到旧 URL 存档。 */
  function transferUrl(nextUrl, save, history) {
    var parts = String(nextUrl).split('#');
    var hash = parts.length > 1 ? '#' + parts.slice(1).join('#') : '';
    var beforeHash = parts[0];
    var queryAt = beforeHash.indexOf('?');
    var base = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
    var query = queryAt === -1 ? [] : beforeHash.slice(queryAt + 1).split('&').filter(function (p) {
      return p && !/^(save|history)(=|$)/.test(p);
    });
    query.push('save=' + encodeURIComponent(encodeCode(save)));
    query.push('history=' + encodeURIComponent(encodeCode(history)));
    return base + '?' + query.join('&') + hash;
  }

  function jumpTo(nextUrl, save, passViaUrl) {
    if (!nextUrl) return;
    var url = nextUrl;
    if (passViaUrl) {
      url = transferUrl(nextUrl, save, readHistory());
    }
    global.location.href = url;
  }

  /* 自动过场演出：世界线移动画面 + 上家结尾钩子 + 通关存档卡 */
  function showHandoffOverlay(config, save, warnings, nextUrl, passViaUrl) {
    if (typeof document === 'undefined') return; /* 非浏览器环境（如自动化测试）跳过 UI */
    var ov = document.createElement('div');
    ov.className = 'wl-overlay';
    var seconds = 8;
    ov.innerHTML =
      '<div class="wl-handoff">' +
        '<div class="wl-handoff-kicker">世 界 线 移 动</div>' +
        '<div class="wl-handoff-route">' + esc(config.world) + ' → ' + esc(config.nextWorld || '？？？') + '</div>' +
        '<div class="wl-handoff-hook">“' + esc(save.exit_hook || '……') + '”</div>' +
        renderSaveCard(save, config.level, config.world) +
        (warnings.length ? '<div class="wl-warn">提示：' + warnings.map(esc).join('；') + '</div>' : '') +
        '<button class="wl-btn" id="wl-next-btn" type="button">进入下一关（' + seconds + 's）</button>' +
      '</div>';
    document.body.appendChild(ov);
    var done = false;
    function go() {
      if (done) return;
      done = true;
      clearInterval(timer);
      jumpTo(nextUrl, save, passViaUrl);
    }
    document.getElementById('wl-next-btn').onclick = go;
    var timer = setInterval(function () {
      seconds--;
      var btn = document.getElementById('wl-next-btn');
      if (btn) btn.textContent = '进入下一关（' + seconds + 's）';
      if (seconds <= 0) { clearInterval(timer); go(); }
    }, 1000);
  }

  /* ---------------- 渲染组件 ---------------- */

  function describeBag(items) {
    if (!items.length) return '空';
    return items.map(function (i) {
      return esc(i.name) + '（' + (TYPE_LABELS[i.type] || i.type) + '类）';
    }).join('、');
  }

  /* 前情提要条：每关开场自动渲染，零成本完成衔接最低保障 */
  function renderOpening(save) {
    if (save.prev_world) {
      return '<div class="wl-opening">前情提要：你从『' + esc(save.prev_world) + '』的结局里醒来——' +
        (save.exit_hook ? '“' + esc(save.exit_hook) + '”' : '（上家没有留下结尾钩子）') +
        '<br>随身行李：' + describeBag(save.items) + '</div>';
    }
    return '<div class="wl-opening">前情提要：（未读到上家存档，按默认开局：命 3 · 理智 2 · 空背包。' +
      '你可能是本世界线第 1 关，或直接打开了本页。）</div>';
  }

  /* 五行「通关存档卡」 */
  function renderSaveCard(save, level, world) {
    var lv = (level === undefined || level === null) ? save.level : level;
    var w = world || save.prev_world || '？？？';
    var cluesHtml = save.clues.length ? save.clues.map(esc).join('<br>') : '无';
    return '<div class="wl-card">' +
      '<div class="wl-card-title">【第 ' + toInt(lv, 1, 1) + ' 关 · ' + esc(w) + ' 通关存档卡】</div>' +
      '<div class="wl-row">命：' + save.player.hp + '/' + (save.player.max_hp || 3) + '　　等级：' + (save.player.level || 1) + '/10　　理智：' + save.player.sanity + '</div>' +
      '<div class="wl-row">背包：' + describeBag(save.items) + '</div>' +
      '<div class="wl-row">线索：' + cluesHtml + '</div>' +
      '<div class="wl-row">结尾一句话：' + (save.exit_hook ? esc(save.exit_hook) : '（未填写）') + '</div>' +
      '<div class="wl-row wl-next">（下一关：' + esc(save.next_world || '未知') + '）</div>' +
      '</div>';
  }

  /* ---------------- 调试工具 ---------------- */

  var debug = {
    json: function (save) {
      try { return JSON.stringify(save, null, 2); } catch (e) { return '{}'; }
    },
    code: function (save) { return encodeCode(save); },
    importCode: function (code) {
      var raw = decodeCode(code);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      var save = normalize(raw, null);
      persist(save);
      return save;
    },
    reset: function () {
      try { global.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    }
  };

  function mountDebug(save) {
    var jsonEl = document.getElementById('debug-json');
    var codeEl = document.getElementById('debug-code');
    function sync() {
      jsonEl.textContent = debug.json(save);
      codeEl.value = debug.code(save);
    }
    sync();
    document.getElementById('debug-copy').onclick = function () {
      sync();
      codeEl.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    };
    document.getElementById('debug-import').onclick = function () {
      var restored = debug.importCode(codeEl.value);
      if (!restored) { global.alert('存档码无法识别'); return; }
      /* 单独的存档码不含旅程；清掉当前 URL 的旧旅程，避免串线。 */
      resetRun();
      persist(restored);
      jumpTo(global.location.href, restored, true);
    };
    document.getElementById('debug-reset').onclick = function () {
      jumpTo(global.location.href, startRun(save.level), true);
    };
  }

  /* ---------------- 内置样式（过场/存档卡，避免被队伍样式影响） ---------------- */

  var LIB_CSS = [
    '.wl-card{background:#0f1724;border:1px solid #2a3b57;border-left:3px solid #35e08c;border-radius:10px;padding:14px 16px;color:#e8eef8;font:14px/23px "PingFang SC","Microsoft YaHei",system-ui,sans-serif;max-width:560px;box-sizing:border-box;}',
    '.wl-card-title{font-weight:600;margin-bottom:8px;color:#9ff5c8;}',
    '.wl-row{margin:2px 0;}',
    '.wl-next{color:#8fa3bf;font-size:12px;margin-top:6px;}',
    '.wl-opening{background:#141d2e;border:1px dashed #33455f;border-radius:8px;padding:10px 14px;color:#c6d4e8;font:14px/22px "PingFang SC","Microsoft YaHei",sans-serif;margin:0 0 16px;}',
    '.wl-overlay{position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(5,10,18,.94);display:flex;align-items:center;justify-content:center;z-index:9999;animation:wl-fade .35s ease;}',
    '.wl-handoff{display:flex;flex-direction:column;align-items:center;gap:14px;padding:28px;text-align:center;max-width:640px;}',
    '.wl-handoff-kicker{letter-spacing:12px;color:#35e08c;font:600 14px/20px sans-serif;}',
    '.wl-handoff-route{color:#e8eef8;font:600 20px/28px "PingFang SC","Microsoft YaHei",sans-serif;}',
    '.wl-handoff-hook{color:#aebdd4;font:15px/24px "PingFang SC","Microsoft YaHei",sans-serif;font-style:italic;max-width:520px;}',
    '.wl-warn{color:#f0b429;font:12px/18px "PingFang SC","Microsoft YaHei",sans-serif;max-width:560px;text-align:left;}',
    '.wl-btn{background:#35e08c;color:#04140b;border:none;border-radius:8px;padding:10px 26px;font:600 15px/22px "PingFang SC","Microsoft YaHei",sans-serif;cursor:pointer;}',
    '.wl-btn:hover{filter:brightness(1.08);}',
    '@keyframes wl-fade{from{opacity:0}to{opacity:1}}'
  ].join('');

  function injectStyles() {
    try {
      if (!document.getElementById('wl-lib-style')) {
        var s = document.createElement('style');
        s.id = 'wl-lib-style';
        s.textContent = LIB_CSS;
        document.head.appendChild(s);
      }
    } catch (e) { /* ignore */ }
  }
  if (typeof document !== 'undefined') injectStyles();

  /* 官方外链接力 SDK：只负责入场接档和结束交档，玩法由作品保留。 */
  var SDK_VERSION = '1.0.0';
  var SDK_PROTOCOL = 1;
  var hostSession = null, hostOrigin = '*', readyWaiters = [], pendingRequest = null, requestSequence = 0;
  var handshakeError = null;

  function sdkTell(message) {
    if (!global.parent || global.parent === global) throw new Error('请从大厅或本地模拟器打开本游戏。');
    global.parent.postMessage(message, hostOrigin);
  }
  function announce() {
    sdkTell({ type: 'IW_READY', protocolVersion: SDK_PROTOCOL, sdkVersion: SDK_VERSION });
  }
  function ready(options) {
    if (hostSession) return Promise.resolve(readSave());
    if (handshakeError) return Promise.reject(new Error(handshakeError));
    return new Promise(function (resolve, reject) {
      var waiter = { resolve: resolve, reject: reject, timer: null };
      waiter.timer = global.setTimeout(function () {
        readyWaiters = readyWaiters.filter(function (entry) { return entry !== waiter; });
        reject(new Error('未收到大厅存档。请检查是否在大厅内打开、SDK 是否加载成功，以及外链是否允许嵌入。'));
      }, options && options.timeoutMs || 15000);
      readyWaiters.push(waiter);
      try { announce(); } catch (error) {
        global.clearTimeout(waiter.timer);
        readyWaiters = readyWaiters.filter(function (entry) { return entry !== waiter; });
        reject(error);
      }
    });
  }
  function finishRequest(action, save, options) {
    if (!hostSession) return Promise.reject(new Error('请先等待 WL.ready() 成功再交接。'));
    if (pendingRequest) return Promise.reject(new Error('交接正在进行，请等待结果。'));
    options = options || {};
    var requestId = hostSession + ':' + (++requestSequence);
    return new Promise(function (resolve, reject) {
      var timer = global.setTimeout(function () {
        pendingRequest = null;
        reject(new Error('交接回执超时，不能据此判断保存失败。请返回大厅核对进度或刷新续玩。'));
      }, 20000);
      pendingRequest = { id: requestId, resolve: resolve, reject: reject, timer: timer };
      try {
        sdkTell({ type: 'IW_REQUEST', protocolVersion: SDK_PROTOCOL, sessionId: hostSession,
          requestId: requestId, action: action, save: normalize(save || readSave(), null),
          acquiredItemIds: options.acquiredItemIds || [], reason: options.reason || '' });
      } catch (error) {
        global.clearTimeout(timer); pendingRequest = null; reject(error);
      }
    });
  }
  function resolveReady(error) {
    var waiters = readyWaiters; readyWaiters = [];
    waiters.forEach(function (waiter) {
      global.clearTimeout(waiter.timer);
      if (error) waiter.reject(new Error(error)); else waiter.resolve(readSave());
    });
  }

  /* 外链与 ZIP 使用同一套宿主通信。 */
  if (typeof global.addEventListener === 'function') {
    global.addEventListener('message', function (event) {
      if (global.parent && event.source !== global.parent) return;
      var message = event.data;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'IW_PROTOCOL_ERROR') {
        handshakeError = String(message.error || '大厅与 SDK 协议版本不兼容。');
        resolveReady(handshakeError); return;
      }
      if (message.type === 'IW_RESULT') {
        if (!hostSession || message.sessionId !== hostSession || !pendingRequest || message.requestId !== pendingRequest.id) return;
        var request = pendingRequest; pendingRequest = null; global.clearTimeout(request.timer);
        if (message.ok === true) request.resolve(message);
        else request.reject(new Error(String(message.error || '大厅拒绝交接，请修正后重试。')));
        return;
      }
      if (message.type === 'IW_INIT_SAVE' || message.type === 'iw-init') {
        if (message.protocolVersion !== undefined && message.protocolVersion !== SDK_PROTOCOL) {
          handshakeError = '大厅与 SDK 协议版本不兼容。'; resolveReady(handshakeError); return;
        }
        if (hostSession && message.sessionId === hostSession) {
          sdkTell({type:'IW_SAVE_ACK', protocolVersion:SDK_PROTOCOL, sessionId:hostSession});
          return;
        }
        if (message.protocolVersion === SDK_PROTOCOL && typeof message.sessionId === 'string') {
          hostSession = message.sessionId;
          if (event.origin && event.origin !== 'null') hostOrigin = event.origin;
        }
        if (message.config && typeof message.config === 'object') global.CONFIG = message.config;
        var incoming = applyEntryEffects(normalize(message.save || readSave(), message.save && message.save.level));
        memoryInitialSave = normalize(incoming, incoming.level);
        persist(incoming);
        if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
          global.dispatchEvent(new global.CustomEvent('iw-save-ready', { detail: incoming }));
        }
        if (hostSession) {
          sdkTell({type:'IW_SAVE_ACK', protocolVersion:SDK_PROTOCOL, sessionId:hostSession});
          resolveReady();
        }
      }
      if (message.type !== 'IW_ADMIN_COMMAND') return;
      var command = String(message.command || message.action || '').toLowerCase();
      if (command === 'force_pass') command = 'forcepass';
      if (command === 'heal_player') command = 'heal';
      if (command === 'heal' || command === 'respawn') {
        var restored = command === 'respawn' ? respawn() : readSave();
        if (command === 'heal') {
          setPlayer(restored, { hp: restored.player.max_hp || 3, status: 'normal' });
          persist(restored);
        }
        if (typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
          global.dispatchEvent(new global.CustomEvent('iw-admin', { detail: { command: command, save: restored } }));
        }
      } else if (command === 'skip' || command === 'forcepass') {
        forcePass();
      } else if (command === 'reload' && global.location && typeof global.location.reload === 'function') {
        global.location.reload();
      } else if (command === 'audio' && typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
        global.dispatchEvent(new global.CustomEvent('iw-admin', { detail: { command: 'audio' } }));
      }
    });
    global.addEventListener('load', function () {
      if (global.parent && global.parent !== global) announce();
    });
  }

  /* ---------------- 导出 ---------------- */

  global.WL = {
    version: SCHEMA,
    sdkVersion: SDK_VERSION,
    sdkProtocol: SDK_PROTOCOL,
    ready: ready,
    complete: function (save, options) { return finishRequest('complete', save, options); },
    fail: function (reason, save, options) { return finishRequest('fail', save, Object.assign({}, options, {reason:reason})); },
    ITEM_TYPES: ITEM_TYPES,
    TYPE_LABELS: TYPE_LABELS,
    EFFECT_STATS: EFFECT_STATS,
    readSave: readSave,
    getInitialSave: getInitialSave,
    respawn: respawn,
    assist: assist,
    settle: applyEntryEffects,
    normalize: normalize,
    completeLevel: completeLevel,
    failLevel: failLevel,
    forcePass: forcePass,
    validateExit: validateExit,
    goTo: function (url, save) { jumpTo(url, save, true); },
    mountDebug: mountDebug,
    consumeAny: consumeAny,
    addItem: addItem,
    addClue: addClue,
    setPlayer: setPlayer,
    renderOpening: renderOpening,
    renderSaveCard: renderSaveCard,
    readHistory: readHistory,
    startRun: startRun,
    resetRun: resetRun,
    escapeHtml: esc,
    encodeCode: encodeCode,
    decodeCode: decodeCode,
    debug: debug
  };
})(typeof window !== 'undefined' ? window : globalThis);
