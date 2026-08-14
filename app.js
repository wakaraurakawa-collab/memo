'use strict';

/*
 * タイムスタンプ日記
 *
 * 設計上の約束(docs/requirements.md §6.1):
 *   本文テキストが唯一の正データ。打刻は本文中の文字列としてのみ存在し、
 *   別立ての記録は持たない。派生表示が必要になったら本文を解析して作る。
 */

// ---------------------------------------------------------------- 日時の整形

var WEEKDAY = ['日', '月', '火', '水', '木', '金', '土'];

function pad2(n) { return String(n).padStart(2, '0'); }

function formatDate(pattern, d) {
  d = d || new Date();
  var map = {
    YYYY: d.getFullYear(),
    MM: pad2(d.getMonth() + 1),
    DD: pad2(d.getDate()),
    ddd: WEEKDAY[d.getDay()],
    HH: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
    ss: pad2(d.getSeconds())
  };
  return String(pattern).replace(/YYYY|MM|DD|ddd|HH|mm|ss/g, function (t) { return map[t]; });
}

// 「1日の始まり」を考慮した日付キー(YYYY-MM-DD)
function dateKeyOf(d, dayStartHour) {
  var shifted = new Date(d.getTime() - (dayStartHour || 0) * 3600000);
  return shifted.getFullYear() + '-' + pad2(shifted.getMonth() + 1) + '-' + pad2(shifted.getDate());
}

function keyToDate(key) {
  var p = key.split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

function shiftKey(key, days) {
  var d = keyToDate(key);
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function keyLabel(key) {
  var d = keyToDate(key);
  return formatDate('YYYY/MM/DD(ddd)', d);
}

var STAMP_FORMATS = [
  'HH:mm',
  'HH:mm:ss',
  '[HH:mm]',
  'YYYY/MM/DD HH:mm',
  'MM/DD(ddd) HH:mm',
  'YYYY/MM/DD(ddd)',
  'YYYY-MM-DDTHH:mm:ss'
];

// ---------------------------------------------------------------- 保存

/*
 * localStorage を直に触るのはここだけにしておく。
 * 容量の上限(概ね 5MB)に当たったら IndexedDB へ移せるようにするため。
 */
var STORAGE_KEY = 'timestamp-diary-v1';

var Store = {
  read: function () {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  },
  write: function (data) {
    // 失敗したら呼び出し側に伝える。黙って失敗させない(§9.4)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  },
  bytes: function () {
    var raw = localStorage.getItem(STORAGE_KEY);
    return raw ? raw.length : 0;
  }
};

function defaultData() {
  return {
    version: 1,
    settings: {
      stampFormat: 'HH:mm',
      insertPosition: 'cursor',
      autoStampOnNewParagraph: false,
      enableF5: true,
      dayStartHour: 0,
      autocorrect: false,
      expansions: [
        { key: 'いま', format: 'HH:mm' },
        { key: 'きょう', format: 'YYYY/MM/DD(ddd)' }
      ]
    },
    entries: {},
    lastBackupAt: null
  };
}

var PRESET_WORD = [
  { key: 'いま', format: 'HH:mm' },
  { key: 'きょう', format: 'YYYY/MM/DD(ddd)' }
];

var PRESET_SYMBOL = [
  { key: ';t', format: 'HH:mm' },
  { key: ';s', format: 'HH:mm:ss' },
  { key: ';d', format: 'YYYY/MM/DD(ddd)' }
];

var data = Store.read() || defaultData();
// 古い保存や手で書き換えた JSON でも落ちないように埋める
(function normalize() {
  var base = defaultData();
  if (!data || typeof data !== 'object') data = base;
  data.settings = Object.assign({}, base.settings, data.settings || {});
  if (!Array.isArray(data.settings.expansions)) data.settings.expansions = base.settings.expansions;
  if (!data.entries || typeof data.entries !== 'object') data.entries = {};
})();

var settings = data.settings;

// ---------------------------------------------------------------- 画面の参照

function $(id) { return document.getElementById(id); }

var app = $('app');
var editor = $('editor');
var dateLabel = $('dateLabel');
var saveState = $('saveState');
var toast = $('toast');
var toastText = $('toastText');
var toastUndo = $('toastUndo');

var currentKey = dateKeyOf(new Date(), settings.dayStartHour);

// ---------------------------------------------------------------- エントリ

function getEntry(key) {
  return data.entries[key] || null;
}

function bodyOf(key) {
  var e = getEntry(key);
  return e ? e.body : '';
}

function openDay(key) {
  flushSave();
  currentKey = key;
  editor.value = bodyOf(key);
  dateLabel.textContent = keyLabel(key);
  editor.setSelectionRange(editor.value.length, editor.value.length);
  setSaveState('');
}

// ---------------------------------------------------------------- 自動保存

var saveTimer = null;
var dirty = false;

function setSaveState(text, isError) {
  saveState.textContent = text;
  saveState.classList.toggle('error', !!isError);
}

function scheduleSave() {
  dirty = true;
  setSaveState('…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

/*
 * persist は「いま data にあるものを書き出す」だけ。
 * 本文を data へ写す責務は flushSave だけが持つ。設定の保存で本文が
 * 巻き添えになる事故(復元直後に空の本文で上書きする等)を防ぐため。
 */
function persist() {
  try {
    Store.write(data);
    setSaveState('保存済み');
    return true;
  } catch (e) {
    setSaveState('保存できません', true);
    alert('保存できませんでした。保存容量がいっぱいの可能性があります。\n設定から書き出して、不要な日を整理してください。');
    return false;
  }
}

function flushSave() {
  clearTimeout(saveTimer);
  if (!dirty) return;

  var body = editor.value;
  var now = new Date().toISOString();
  var entry = data.entries[currentKey];

  if (!body.trim() && !entry) { dirty = false; setSaveState(''); return; }

  if (!entry) {
    entry = data.entries[currentKey] = { date: currentKey, body: '', createdAt: now, updatedAt: now };
  }
  entry.body = body;
  entry.updatedAt = now;

  dirty = !persist();
}

// 離脱時・バックグラウンド化時は必ず保存する
window.addEventListener('pagehide', flushSave);
window.addEventListener('beforeunload', flushSave);
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden') flushSave();
});

// ---------------------------------------------------------------- 文字の挿入

/*
 * execCommand('insertText') は非推奨だが、端末側の「取り消す」履歴を
 * 壊さない唯一の手段なので優先して使う。iOS の振って取り消しもこれで効く。
 */
/*
 * プログラムから本文を書き換えている間は、そこから出る input を
 * 「利用者の打鍵」として扱わない。展開の取り消しが即座に再展開されるのを防ぐ。
 */
var programmatic = 0;

function replaceRange(start, end, text) {
  programmatic++;
  try {
    editor.focus();
    editor.setSelectionRange(start, end);
    var ok = false;
    try {
      ok = text ? document.execCommand('insertText', false, text)
                : document.execCommand('delete');
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      editor.setRangeText(text, start, end, 'end');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
  } finally {
    programmatic--;
  }
}

function insertAtCursor(text) {
  replaceRange(editor.selectionStart, editor.selectionEnd, text);
}

function lineStartOf(pos) {
  var i = editor.value.lastIndexOf('\n', pos - 1);
  return i < 0 ? 0 : i + 1;
}

// ---------------------------------------------------------------- 日本語入力

/*
 * 変換の未確定中に本文を書き換えると入力が壊れる(§9.2-4)。
 * 打刻の指示は取っておき、確定後に実行する。
 */
var composing = false;
var pendingStamp = null;

editor.addEventListener('compositionstart', function () { composing = true; });
editor.addEventListener('compositionend', function () {
  composing = false;
  if (pendingStamp !== null) {
    var f = pendingStamp;
    pendingStamp = null;
    stamp(f);
  }
});

// ---------------------------------------------------------------- 打刻

function stamp(format) {
  if (composing) { pendingStamp = format || settings.stampFormat; return; }

  var text = formatDate(format || settings.stampFormat) + ' ';
  if (settings.insertPosition === 'lineStart') {
    var p = lineStartOf(editor.selectionStart);
    replaceRange(p, p, text);
  } else {
    insertAtCursor(text);
  }
  scheduleSave();
}

// 打刻バー: 押しても本文のフォーカスとカーソル位置を失わせない(§9.2-1)
function keepFocus(el) {
  function block(e) { e.preventDefault(); }
  el.addEventListener('pointerdown', block);
  el.addEventListener('mousedown', block);
}

Array.prototype.forEach.call(document.querySelectorAll('#stampbar .stamp'), keepFocus);

$('stampBtn').addEventListener('click', function () { stamp(null); });

Array.prototype.forEach.call(document.querySelectorAll('#stampbar .stamp[data-fmt]'), function (b) {
  b.addEventListener('click', function () { stamp(b.getAttribute('data-fmt')); });
});

// 長押し / … で書式メニュー
var pressTimer = null;
$('stampBtn').addEventListener('pointerdown', function () {
  clearTimeout(pressTimer);
  pressTimer = setTimeout(openFormatMenu, 550);
});
['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
  $('stampBtn').addEventListener(ev, function () { clearTimeout(pressTimer); });
});
$('stampMenuBtn').addEventListener('click', openFormatMenu);

function openFormatMenu() {
  clearTimeout(pressTimer);
  var body = $('fmtBody');
  body.innerHTML = '';
  STAMP_FORMATS.forEach(function (f) {
    var b = document.createElement('button');
    b.className = 'item';
    b.innerHTML = '<span class="d"></span><span class="p"></span>';
    b.querySelector('.d').textContent = formatDate(f);
    b.querySelector('.p').textContent = f;
    b.addEventListener('click', function () {
      closePanels();
      stamp(f);
    });
    body.appendChild(b);
  });
  openPanel('fmtPanel');
}

// ---------------------------------------------------------------- 展開キーワード

function activeExpansions() {
  return (settings.expansions || [])
    .filter(function (e) { return e && e.key && e.format; })
    // 長い方を先に見る。ただし短い方が先頭一致すると先に発火する点は設定画面で警告する
    .sort(function (a, b) { return b.key.length - a.key.length; });
}

function tryExpand() {
  var caret = editor.selectionStart;
  if (caret !== editor.selectionEnd) return false;
  var before = editor.value.slice(0, caret);
  var list = activeExpansions();

  for (var i = 0; i < list.length; i++) {
    var key = list[i].key;
    if (before.length < key.length || before.slice(-key.length) !== key) continue;

    var out = formatDate(list[i].format);
    var start = caret - key.length;
    replaceRange(start, caret, out);
    scheduleSave();

    showUndo('「' + key + '」を展開しました', function () {
      var end = start + out.length;
      replaceRange(start, end, key);
      scheduleSave();
    });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- 自動打刻

function tryAutoStamp() {
  if (!settings.autoStampOnNewParagraph) return;
  var caret = editor.selectionStart;
  if (editor.value.slice(0, caret).slice(-2) !== '\n\n') return;

  var out = formatDate(settings.stampFormat) + ' ';
  replaceRange(caret, caret, out);
  scheduleSave();

  showUndo('自動で打刻しました', function () {
    replaceRange(caret, caret + out.length, '');
    scheduleSave();
  });
}

// ---------------------------------------------------------------- 入力の監視

editor.addEventListener('input', function (e) {
  scheduleSave();
  if (programmatic || composing || e.isComposing) return;

  if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
    tryAutoStamp();
    return;
  }
  // 文字が増えたときだけ展開を試す。削除で発火すると戻せなくなる
  if (e.inputType && e.inputType.indexOf('delete') === 0) return;
  tryExpand();
});

// ---------------------------------------------------------------- 取り消し通知

var undoAction = null;
var toastTimer = null;

function showUndo(message, action) {
  undoAction = action;
  toastText.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideUndo, 6000);
}

function hideUndo() {
  clearTimeout(toastTimer);
  toast.hidden = true;
  undoAction = null;
}

keepFocus(toastUndo);
toastUndo.addEventListener('click', function () {
  var a = undoAction;
  hideUndo();
  if (a) a();
});

// ---------------------------------------------------------------- キー操作(PC)

document.addEventListener('keydown', function (e) {
  if (e.target !== editor) return;

  if (e.key === 'F5' && settings.enableF5 && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    stamp(null);
    return;
  }
  // Ctrl/⌘ + ; は常に打刻。再読み込み(Ctrl/⌘ + R)には手を出さない
  if ((e.ctrlKey || e.metaKey) && e.key === ';') {
    e.preventDefault();
    stamp(null);
  }
});

// ---------------------------------------------------------------- 日付の移動

$('prevDay').addEventListener('click', function () { openDay(shiftKey(currentKey, -1)); });
$('nextDay').addEventListener('click', function () { openDay(shiftKey(currentKey, 1)); });
dateLabel.addEventListener('click', openList);

// ---------------------------------------------------------------- パネル

function openPanel(id) {
  closePanels();
  $(id).hidden = false;
}

function closePanels() {
  Array.prototype.forEach.call(document.querySelectorAll('.panel'), function (p) { p.hidden = true; });
}

Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (b) {
  b.addEventListener('click', function () {
    closePanels();
    editor.focus();
  });
});

// ---------------------------------------------------------------- 日付一覧

function writtenKeys() {
  return Object.keys(data.entries)
    .filter(function (k) { return (data.entries[k].body || '').trim(); })
    .sort()
    .reverse();
}

function openList() {
  flushSave();
  var body = $('listBody');
  body.innerHTML = '';
  var keys = writtenKeys();

  if (!keys.length) {
    body.innerHTML = '<p class="empty">まだ何も書かれていません。</p>';
  } else {
    keys.forEach(function (k) {
      var first = (data.entries[k].body || '').split('\n').find(function (l) { return l.trim(); }) || '';
      var b = document.createElement('button');
      b.className = 'item';
      b.innerHTML = '<span class="d"></span><span class="p"></span>';
      b.querySelector('.d').textContent = keyLabel(k);
      b.querySelector('.p').textContent = first;
      b.addEventListener('click', function () {
        closePanels();
        openDay(k);
        editor.focus();
      });
      body.appendChild(b);
    });
  }
  openPanel('listPanel');
}

// ---------------------------------------------------------------- 検索

$('openSearch').addEventListener('click', function () {
  flushSave();
  openPanel('searchPanel');
  $('searchInput').value = '';
  runSearch();
  $('searchInput').focus();
});

$('searchInput').addEventListener('input', runSearch);

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function runSearch() {
  var q = $('searchInput').value.trim();
  var body = $('searchBody');
  body.innerHTML = '';
  if (!q) { body.innerHTML = '<p class="empty">探したい言葉を入れてください。</p>'; return; }

  var needle = q.toLowerCase();
  var hits = 0;

  writtenKeys().forEach(function (k) {
    var text = data.entries[k].body || '';
    var at = text.toLowerCase().indexOf(needle);
    if (at < 0) return;
    hits++;

    var from = Math.max(0, at - 20);
    var snippet = (from > 0 ? '…' : '') + text.slice(from, at + q.length + 40).replace(/\n/g, ' ');
    var marked = escapeHtml(snippet).replace(
      new RegExp(escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'),
      function (m) { return '<mark>' + m + '</mark>'; }
    );

    var b = document.createElement('button');
    b.className = 'item';
    b.innerHTML = '<span class="d">' + keyLabel(k) + '</span><span class="p">' + marked + '</span>';
    b.addEventListener('click', function () {
      closePanels();
      openDay(k);
      editor.focus();
      editor.setSelectionRange(at, at + q.length);
    });
    body.appendChild(b);
  });

  if (!hits) body.innerHTML = '<p class="empty">見つかりませんでした。</p>';
}

// ---------------------------------------------------------------- 設定

$('openSettings').addEventListener('click', function () {
  flushSave();
  renderSettings();
  openPanel('settingsPanel');
});

function saveSettings() {
  persist();
}

function renderSettings() {
  var sel = $('setFormat');
  sel.innerHTML = '';
  STAMP_FORMATS.forEach(function (f) {
    var o = document.createElement('option');
    o.value = f;
    o.textContent = formatDate(f);
    sel.appendChild(o);
  });
  sel.value = settings.stampFormat;
  if (sel.value !== settings.stampFormat) sel.value = STAMP_FORMATS[0];
  $('formatPreview').textContent = '今なら「' + formatDate(settings.stampFormat) + '」と入ります。';

  $('setInsertPos').value = settings.insertPosition;
  $('setAutoStamp').checked = !!settings.autoStampOnNewParagraph;
  $('setF5').checked = !!settings.enableF5;
  $('setAutocorrect').checked = !!settings.autocorrect;

  var ds = $('setDayStart');
  if (!ds.options.length) {
    for (var h = 0; h < 12; h++) {
      var o = document.createElement('option');
      o.value = String(h);
      o.textContent = h === 0 ? '0時(ふつう)' : h + '時';
      ds.appendChild(o);
    }
  }
  ds.value = String(settings.dayStartHour);

  renderExpansions();
  renderBackupState();
}

$('setFormat').addEventListener('change', function () {
  settings.stampFormat = this.value;
  $('formatPreview').textContent = '今なら「' + formatDate(settings.stampFormat) + '」と入ります。';
  saveSettings();
});

$('setInsertPos').addEventListener('change', function () {
  settings.insertPosition = this.value;
  saveSettings();
});

$('setAutoStamp').addEventListener('change', function () {
  settings.autoStampOnNewParagraph = this.checked;
  saveSettings();
});

$('setF5').addEventListener('change', function () {
  settings.enableF5 = this.checked;
  saveSettings();
});

$('setAutocorrect').addEventListener('change', function () {
  settings.autocorrect = this.checked;
  applyEditorAttrs();
  saveSettings();
});

$('setDayStart').addEventListener('change', function () {
  settings.dayStartHour = Number(this.value);
  saveSettings();
  currentKey = dateKeyOf(new Date(), settings.dayStartHour);
  openDay(currentKey);
});

function applyEditorAttrs() {
  var on = !!settings.autocorrect;
  editor.setAttribute('autocapitalize', on ? 'sentences' : 'off');
  editor.setAttribute('autocorrect', on ? 'on' : 'off');
  editor.setAttribute('spellcheck', on ? 'true' : 'false');
}

// ---- 展開キーワードの編集

function renderExpansions() {
  var wrap = $('expList');
  wrap.innerHTML = '';

  settings.expansions.forEach(function (exp, i) {
    var row = document.createElement('div');
    row.className = 'exprow';

    var k = document.createElement('input');
    k.type = 'text';
    k.className = 'k';
    k.value = exp.key;
    k.placeholder = 'キーワード';
    k.addEventListener('change', function () {
      settings.expansions[i].key = k.value.trim();
      saveSettings();
      updateExpWarning();
    });

    var v = document.createElement('select');
    v.className = 'v';
    STAMP_FORMATS.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f;
      o.textContent = formatDate(f);
      v.appendChild(o);
    });
    v.value = exp.format;
    if (v.value !== exp.format) v.value = STAMP_FORMATS[0];
    v.addEventListener('change', function () {
      settings.expansions[i].format = v.value;
      saveSettings();
    });

    var del = document.createElement('button');
    del.type = 'button';
    del.textContent = '削除';
    del.addEventListener('click', function () {
      settings.expansions.splice(i, 1);
      saveSettings();
      renderExpansions();
    });

    row.appendChild(k);
    row.appendChild(v);
    row.appendChild(del);
    wrap.appendChild(row);
  });

  if (!settings.expansions.length) {
    var p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '展開キーワードはありません。本文の入力が奪われることはありません。';
    wrap.appendChild(p);
  }

  updateExpWarning();
}

function updateExpWarning() {
  var keys = settings.expansions.map(function (e) { return e.key; }).filter(Boolean);
  var shadowed = [];
  keys.forEach(function (a) {
    keys.forEach(function (b) {
      if (a !== b && b.indexOf(a) === 0) shadowed.push(b);
    });
  });
  $('expWarn').textContent = shadowed.length
    ? '「' + shadowed.join('」「') + '」は、より短いキーワードが先に展開されるため使えません。'
    : '';
}

$('expAdd').addEventListener('click', function () {
  settings.expansions.push({ key: '', format: 'HH:mm' });
  saveSettings();
  renderExpansions();
});

$('expPresetWord').addEventListener('click', function () {
  settings.expansions = PRESET_WORD.map(function (e) { return Object.assign({}, e); });
  saveSettings();
  renderExpansions();
});

$('expPresetSymbol').addEventListener('click', function () {
  settings.expansions = PRESET_SYMBOL.map(function (e) { return Object.assign({}, e); });
  saveSettings();
  renderExpansions();
});

// ---------------------------------------------------------------- 書き出し / 復元

function download(text, filename, type) {
  var blob = new Blob([text], { type: type + ';charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

  data.lastBackupAt = new Date().toISOString();
  saveSettings();
  renderBackupState();
}

function renderBackupState() {
  $('backupState').textContent = data.lastBackupAt
    ? '最後に書き出したのは ' + formatDate('YYYY/MM/DD HH:mm', new Date(data.lastBackupAt)) + ' です。'
    : 'まだ一度も書き出していません。';

  var kb = Math.round(Store.bytes() / 1024);
  var note = kb > 4096 ? ' 上限が近づいています。書き出して整理してください。' : '';
  $('usageState').textContent = '記録している日数: ' + writtenKeys().length + '日 / 使用量: 約 ' + kb + 'KB。' + note;
}

$('exportMd').addEventListener('click', function () {
  flushSave();
  var keys = writtenKeys().slice().reverse();
  var out = keys.map(function (k) {
    return '# ' + keyLabel(k) + '\n\n' + (data.entries[k].body || '').trim() + '\n';
  }).join('\n');
  download(out || '', '日記-' + dateKeyOf(new Date(), settings.dayStartHour) + '.md', 'text/markdown');
});

$('exportJson').addEventListener('click', function () {
  flushSave();
  download(JSON.stringify(data, null, 2), '日記-' + dateKeyOf(new Date(), settings.dayStartHour) + '.json', 'application/json');
});

$('importJson').addEventListener('click', function () { $('importFile').click(); });

$('importFile').addEventListener('change', function () {
  var file = this.files && this.files[0];
  this.value = '';
  if (!file) return;

  var reader = new FileReader();
  reader.onload = function () {
    var incoming;
    try {
      incoming = JSON.parse(String(reader.result));
    } catch (e) {
      alert('このファイルは読み込めませんでした。');
      return;
    }
    if (!incoming || typeof incoming.entries !== 'object') {
      alert('この日記の書き出しファイルではないようです。');
      return;
    }

    var count = Object.keys(incoming.entries).length;
    if (!confirm(count + '日分を読み込みます。\n同じ日付は読み込んだ内容で置き換わります。よろしいですか?')) return;

    // 書きかけを先に確定させてから重ねる。あとで空の本文が上書きしないように
    flushSave();

    Object.keys(incoming.entries).forEach(function (k) {
      data.entries[k] = incoming.entries[k];
    });
    if (incoming.settings) {
      settings = data.settings = Object.assign({}, data.settings, incoming.settings);
    }

    saveSettings();
    applyEditorAttrs();
    openDay(currentKey);
    renderSettings();
    alert('読み込みました。');
  };
  reader.readAsText(file);
});

// ---------------------------------------------------------------- 画面の高さ

/*
 * iOS Safari はキーボードが出ても画面の高さが変わらない(§9.2-2, 9.2-3)。
 * visualViewport から実際に見えている領域を取って、打刻バーをキーボードの
 * すぐ上に置く。
 */
var vv = window.visualViewport;

function syncViewport() {
  if (!vv) return;
  app.style.height = vv.height + 'px';
  app.style.transform = 'translateY(' + vv.offsetTop + 'px)';

  // キーボードが出ている間は下端の安全領域の余白が要らない
  var keyboardOpen = window.innerHeight - vv.height > 120;
  app.classList.toggle('kb', keyboardOpen);

  // 取り消し通知を打刻バーの上に置く
  var barHeight = $('stampbar').offsetHeight;
  var bottomGap = window.innerHeight - (vv.height + vv.offsetTop);
  toast.style.bottom = (bottomGap + barHeight) + 'px';
}

if (vv) {
  vv.addEventListener('resize', syncViewport);
  vv.addEventListener('scroll', syncViewport);
}
window.addEventListener('resize', syncViewport);
window.addEventListener('orientationchange', function () { setTimeout(syncViewport, 300); });

// フォーカス時にページ自体がずれるのを戻す
editor.addEventListener('focus', function () {
  setTimeout(function () { window.scrollTo(0, 0); syncViewport(); }, 50);
});

// ---------------------------------------------------------------- 日付の変わり目

/*
 * 書いている途中で日付をまたいだら、その場では切り替えない(書きかけを守る)。
 * 次に画面へ戻ってきたときに今日のページを開く。
 */
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState !== 'visible') return;
  var today = dateKeyOf(new Date(), settings.dayStartHour);
  if (today !== currentKey && !editor.value.trim()) openDay(today);
});

// ---------------------------------------------------------------- 起動

applyEditorAttrs();
openDay(currentKey);
syncViewport();
