// Pure save normalization and settlement from the participant delivery kit v2.
  var SCHEMA = 'v3';
  var ITEM_TYPES = ['key', 'tool', 'light', 'food', 'token', 'info', 'weapon', 'strange'];
  var EFFECT_STATS = ['hp', 'sanity', 'max_hp', 'cleanse', 'attack'];
  var EFFECT_TRIGGERS = ['on_enter', 'passive'];
  var EFFECT_RANGE = { hp: [1, 2], sanity: [1, 1], max_hp: [1, 1], attack: [1, 1] };
  var ITEMS_MAX = 3;
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

export {normalize,coerceEffect,coerceItems,applyEntryEffects as settleEntrySave};
