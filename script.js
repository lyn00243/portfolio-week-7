// Personal website — shared interactivity

// Mobile menu toggle
const menuBtn = document.getElementById('menuBtn');
const mobileMenu = document.getElementById('mobileMenu');
if (menuBtn && mobileMenu) {
  menuBtn.addEventListener('click', () => mobileMenu.classList.toggle('open'));
  mobileMenu.querySelectorAll('a').forEach(a =>
    a.addEventListener('click', () => mobileMenu.classList.remove('open'))
  );
}

// Scroll reveal via IntersectionObserver
const revealEls = document.querySelectorAll('.reveal');
if (revealEls.length) {
  const io = new IntersectionObserver(
    entries => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('in-view');
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12 }
  );
  revealEls.forEach(el => io.observe(el));
}

// Contact form — save name/email/message to Supabase contacts table
const form = document.getElementById('contactForm');
const formMsg = document.getElementById('formMsg');
if (form && formMsg) {
  const CONTACT_SUPABASE_URL = 'https://zpofpzbarnpizpajgjcu.supabase.co';
  const CONTACT_SUPABASE_KEY = 'sb_publishable_mGkgx3UnODX3KDcoL9S4jw_dyBanj-K';
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const submitBtn = form.querySelector('button[type="submit"]');
    const payload = {
      name: document.getElementById('name').value.trim(),
      email: document.getElementById('email').value.trim(),
      message: document.getElementById('message').value.trim()
    };
    formMsg.classList.remove('show', 'error');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await fetch(CONTACT_SUPABASE_URL + '/rest/v1/contacts', {
        method: 'POST',
        headers: {
          apikey: CONTACT_SUPABASE_KEY,
          Authorization: 'Bearer ' + CONTACT_SUPABASE_KEY,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      form.reset();
      formMsg.textContent = "Thanks for reaching out! I'll get back to you soon. 🌿";
    } catch (err) {
      console.error('Contact save failed:', err);
      formMsg.textContent = 'Could not send your message. Please try again.';
      formMsg.classList.add('error');
    }
    formMsg.classList.add('show');
    if (submitBtn) submitBtn.disabled = false;
  });
}

// ===== To-do planner (Projects page) =====
(function () {
  const todoForm = document.getElementById('todoForm');
  if (!todoForm) return;

  const calGrid = document.getElementById('calGrid');
  const calTitle = document.getElementById('calTitle');
  const calPrev = document.getElementById('calPrev');
  const calNext = document.getElementById('calNext');
  const todoInput = document.getElementById('todoInput');
  const todoList = document.getElementById('todoList');
  const todoEmpty = document.getElementById('todoEmpty');
  const todoDateDisplay = document.getElementById('todoDateDisplay');
  const todoTags = document.getElementById('todoTags');
  const todoCount = document.getElementById('todoCount');
  const todoCountText = document.getElementById('todoCountText');
  const todoProgressBar = document.getElementById('todoProgressBar');
  const todoError = document.getElementById('todoError');

  // --- Persistence: Supabase primary, localStorage fallback ---
  // Supabase is the primary store. When a Supabase call fails (the todos
  // table schema is currently broken: done/tag/text/created_at missing),
  // we fall back to localStorage so the app keeps working and no tasks
  // are lost. Once the table is fixed, writes succeed against Supabase
  // automatically. localStorage stays in sync as a mirror/fallback.
  const SUPABASE_URL = 'https://keksxtnrjwcsqagyrlqe.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_o9mwEyLpfWl5T3_bBrivdg_z4rarCDB';
  const TABLE = 'todos';
  const STORE_KEY = 'lin-todo-v2';
  let supa = null;
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    try { supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); }
    catch (e) { console.error('Supabase init failed:', e); supa = null; }
  }

  let tasks = [];
  let errorTimer = null;
  function showError(msg) {
    if (!todoError) return;
    todoError.textContent = msg;
    todoError.hidden = false;
    clearTimeout(errorTimer);
    errorTimer = setTimeout(() => { todoError.hidden = true; }, 4000);
  }

  // --- localStorage fallback helpers ---
  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveStore(rows) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(rows)); }
    catch (e) { console.error('Save to localStorage failed:', e); }
  }
  function genId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }
  function sortByDate(a, b) {
    const d = String(a.date).localeCompare(String(b.date));
    if (d !== 0) return d;
    const aT = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bT = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return aT - bT;
  }

  // --- Supabase <-> app shape mapping (real table columns) ---
  // Real table: id(int), task(text), is_complete(bool), date(date),
  //             create_at(timestamptz), priority(text), emoji(text)
  // App shape:  id, text, date, done, tag({kind,value}|null), createdAt
  // NOTE: the `emoji` column has a bad DEFAULT ('"::text'); we always set
  // emoji explicitly on insert/update so the broken default never fires.
  const BROKEN_EMOJI_DEFAULT = '"::text';
  function tagFromRow(priority, emoji) {
    const pri = (priority == null || priority === '') ? null : priority;
    if (pri) return { kind: 'pri', value: pri };
    const emo = (emoji == null || emoji === '' || emoji === BROKEN_EMOJI_DEFAULT) ? null : emoji;
    if (emo) return { kind: 'emoji', value: emo };
    return null;
  }
  function fromRow(r) {
    return {
      id: r.id,
      text: r.task,
      date: typeof r.date === 'string' ? r.date : isoDate(new Date(r.date)),
      done: !!r.is_complete,
      tag: tagFromRow(r.priority, r.emoji),
      createdAt: r.create_at
    };
  }
  // app draft/patch -> real columns (always set priority & emoji explicitly)
  function tagToColumns(tag) {
    if (!tag) return { priority: null, emoji: null };
    if (tag.kind === 'pri') return { priority: tag.value, emoji: null };
    if (tag.kind === 'emoji') return { priority: null, emoji: tag.value };
    return { priority: null, emoji: null };
  }
  function toRowInsert(task) {
    return Object.assign(
      { task: task.text, date: task.date, is_complete: !!task.done },
      tagToColumns(task.tag)
    );
  }
  function toRowPatch(p) {
    const out = {};
    if ('text' in p) out.task = p.text;
    if ('done' in p) out.is_complete = p.done;
    if ('date' in p) out.date = p.date;
    if ('tag' in p) Object.assign(out, tagToColumns(p.tag));
    return out;
  }

  // --- Store helpers (Supabase first, localStorage fallback) ---
  async function dbSelectAll() {
    let supaRows = null;
    if (supa) {
      try {
        const { data, error } = await supa.from(TABLE)
          .select('id, task, is_complete, date, create_at, priority, emoji')
          .order('date', { ascending: true })
          .order('create_at', { ascending: true });
        if (!error) supaRows = (data || []).map(fromRow);
      } catch (e) { supaRows = null; }
    }
    const localRows = loadStore();
    if (supaRows) {
      // Merge: Supabase rows win; keep any local-only rows (created during outage)
      const seen = new Set(supaRows.map(r => String(r.id)));
      const merged = supaRows.slice();
      for (const r of localRows) {
        if (!seen.has(String(r.id))) merged.push(r);
      }
      saveStore(merged);   // keep fallback mirror in sync
      return merged.slice().sort(sortByDate);
    }
    return localRows.slice().sort(sortByDate);
  }
  async function dbInsert(task) {
    if (supa) {
      try {
        const { data, error } = await supa.from(TABLE)
          .insert(toRowInsert(task))
          .select('id, task, is_complete, date, create_at, priority, emoji')
          .single();
        if (!error && data) {
          const row = fromRow(data);
          const rows = loadStore(); rows.push(row); saveStore(rows);
          return row;
        }
      } catch (e) { /* fall through to local */ }
    }
    // Fallback: local insert with client-generated id
    const rows = loadStore();
    const row = {
      id: genId(),
      text: task.text,
      date: task.date,
      done: !!task.done,
      tag: task.tag || null,
      createdAt: new Date().toISOString()
    };
    rows.push(row);
    saveStore(rows);
    return row;
  }
  async function dbUpdate(id, patch) {
    if (supa) {
      try {
        const { error } = await supa.from(TABLE).update(toRowPatch(patch)).eq('id', id);
        if (!error) {
          const rows = loadStore();
          const i = rows.findIndex(r => String(r.id) === String(id));
          if (i >= 0) { Object.assign(rows[i], patch); saveStore(rows); }
          return;
        }
      } catch (e) { /* fall through to local */ }
    }
    const rows = loadStore();
    const i = rows.findIndex(r => String(r.id) === String(id));
    if (i >= 0) { Object.assign(rows[i], patch); saveStore(rows); }
  }
  async function dbDelete(id) {
    if (supa) {
      try { await supa.from(TABLE).delete().eq('id', id); }
      catch (e) { /* ignore — still remove locally */ }
    }
    const rows = loadStore().filter(r => String(r.id) !== String(id));
    saveStore(rows);
  }
  function findTaskById(id) {
    return tasks.find(t => String(t.id) === String(id));
  }

  const today = new Date();
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth();
  let selectedDate = isoDate(today);
  // Selected tag in the picker: { kind: 'pri', value: 'pri-low' } | { kind: 'emoji', value: '📝' } | null
  let selectedTag = null;

  function isoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function parseDate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function formatPretty(s) {
    return parseDate(s).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
    });
  }
  function escapeHTML(s) {
    return s.replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function renderCalendar() {
    calTitle.textContent = new Date(viewYear, viewMonth, 1).toLocaleDateString('en-US', {
      month: 'long', year: 'numeric'
    });
    const first = new Date(viewYear, viewMonth, 1);
    // Monday-first index (getDay(): 0=Sun..6=Sat)
    let startIdx = first.getDay() - 1;
    if (startIdx < 0) startIdx = 6;
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const todayStr = isoDate(new Date());
    let html = '';
    for (let i = 0; i < startIdx; i++) html += '<span class="cal-blank"></span>';
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = isoDate(new Date(viewYear, viewMonth, d));
      const cls = ['cal-day'];
      if (iso === todayStr) cls.push('today');
      if (iso === selectedDate) cls.push('selected');
      html += `<button type="button" class="${cls.join(' ')}" data-date="${iso}">${d}</button>`;
    }
    calGrid.innerHTML = html;
  }

  function updateDateDisplay() {
    if (!selectedDate) {
      todoDateDisplay.textContent = 'Select a date';
      todoDateDisplay.classList.add('empty');
    } else {
      todoDateDisplay.textContent = formatPretty(selectedDate);
      todoDateDisplay.classList.remove('empty');
    }
  }

  function markerHTML(t) {
    if (!t.tag) return '';
    if (t.tag.kind === 'pri') {
      const label = t.tag.value === 'pri-low' ? 'Low'
        : t.tag.value === 'pri-med' ? 'Med' : 'High';
      return `<span class="todo-marker ${t.tag.value}">${label}</span>`;
    }
    if (t.tag.kind === 'emoji') {
      return `<span class="todo-marker emoji" aria-hidden="true">${escapeHTML(t.tag.value)}</span>`;
    }
    return '';
  }

  function updateCounter() {
    const total = tasks.length;
    const done = tasks.filter(t => t.done).length;
    if (total === 0) {
      todoCount.hidden = true;
      return;
    }
    todoCount.hidden = false;
    todoCountText.innerHTML = `<strong>${done}</strong> of <strong>${total}</strong> task${total === 1 ? '' : 's'} completed`;
    const pct = total ? (done / total) * 100 : 0;
    todoProgressBar.style.width = pct + '%';
  }

  function renderList() {
    if (!tasks.length) {
      todoList.innerHTML = '';
      todoEmpty.style.display = 'block';
      updateCounter();
      return;
    }
    todoEmpty.style.display = 'none';
    const sorted = [...tasks].sort((a, b) => {
      const d = a.date.localeCompare(b.date);
      if (d !== 0) return d;
      const aT = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bT = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return aT - bT;
    });
    todoList.innerHTML = sorted.map(t => `
      <li class="todo-item${t.done ? ' done' : ''}" data-id="${t.id}">
        <label class="todo-check">
          <input type="checkbox" ${t.done ? 'checked' : ''} aria-label="Mark task done" />
          <span class="todo-check-box" aria-hidden="true"></span>
        </label>
        <div class="todo-content">
          <div class="todo-row">
            ${markerHTML(t)}<span class="todo-text" title="Click to edit">${escapeHTML(t.text)}</span>
          </div>
          <div class="todo-date">${formatPretty(t.date)}</div>
        </div>
        <button class="todo-del" type="button" aria-label="Delete task" title="Delete">&times;</button>
      </li>
    `).join('');
    updateCounter();
  }

  function syncTagPicker() {
    if (!todoTags) return;
    todoTags.querySelectorAll('.todo-tag').forEach(btn => {
      const isActive = selectedTag
        && ((selectedTag.kind === 'pri' && btn.dataset.tag === selectedTag.value)
        || (selectedTag.kind === 'emoji' && btn.dataset.tag === 'emoji' && btn.dataset.emoji === selectedTag.value));
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  function clearTagPicker() {
    selectedTag = null;
    syncTagPicker();
  }

  // Calendar: prev / next month
  calPrev.addEventListener('click', () => {
    viewMonth--;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    renderCalendar();
  });
  calNext.addEventListener('click', () => {
    viewMonth++;
    if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    renderCalendar();
  });

  // Calendar: pick a day (event delegation)
  calGrid.addEventListener('click', e => {
    const btn = e.target.closest('.cal-day');
    if (!btn) return;
    selectedDate = btn.dataset.date;
    renderCalendar();
    updateDateDisplay();
  });

  // Tag picker (single-select, click again to clear)
  if (todoTags) {
    todoTags.addEventListener('click', e => {
      const btn = e.target.closest('.todo-tag');
      if (!btn) return;
      const tag = btn.dataset.tag;        // 'pri-low' | 'pri-med' | 'pri-high' | 'emoji'
      const emoji = btn.dataset.emoji;
      const next = (tag === 'emoji')
        ? { kind: 'emoji', value: emoji }
        : { kind: 'pri', value: tag };
      // Toggle off if clicking the active one
      if (selectedTag && selectedTag.kind === next.kind && selectedTag.value === next.value) {
        selectedTag = null;
      } else {
        selectedTag = next;
      }
      syncTagPicker();
    });
  }

  // Add task — insert into DB, then add the returned row to the list
  todoForm.addEventListener('submit', async e => {
    e.preventDefault();
    const text = todoInput.value.trim();
    if (!text || !selectedDate) return;
    const draft = {
      text,
      date: selectedDate,
      done: false,
      tag: selectedTag ? { ...selectedTag } : null
    };
    todoInput.value = '';
    clearTagPicker();
    try {
      const saved = await dbInsert(draft);
      tasks.push(saved);
      renderList();
    } catch (err) {
      console.error('Insert failed:', err);
      showError('Could not save task. Please try again.');
    }
  });

  // Toggle done — optimistic update + DB write, rollback on failure
  todoList.addEventListener('change', async e => {
    if (!e.target.matches('input[type="checkbox"]')) return;
    const li = e.target.closest('.todo-item');
    const t = findTaskById(li.dataset.id);
    if (!t) return;
    const newDone = e.target.checked;
    const oldDone = t.done;
    t.done = newDone;
    li.classList.toggle('done', t.done);
    updateCounter();
    try {
      await dbUpdate(t.id, { done: newDone });
    } catch (err) {
      console.error('Toggle failed:', err);
      t.done = oldDone;
      e.target.checked = oldDone;
      li.classList.toggle('done', oldDone);
      updateCounter();
      showError('Could not update task. Reverted.');
    }
  });

  // Delete + start inline edit on text click
  todoList.addEventListener('click', async e => {
    const del = e.target.closest('.todo-del');
    if (del) {
      const li = del.closest('.todo-item');
      const t = findTaskById(li.dataset.id);
      if (!t) return;
      const idx = tasks.indexOf(t);
      tasks.splice(idx, 1);
      renderList();
      try {
        await dbDelete(t.id);
      } catch (err) {
        console.error('Delete failed:', err);
        tasks.splice(idx, 0, t);   // restore at original position
        renderList();
        showError('Could not delete task. Restored.');
      }
      return;
    }
    const text = e.target.closest('.todo-text');
    if (text && text.getAttribute('contenteditable') !== 'true') {
      const li = text.closest('.todo-item');
      if (li.classList.contains('done')) return;  // don't edit completed tasks
      text.setAttribute('contenteditable', 'true');
      text.focus();
      const range = document.createRange();
      range.selectNodeContents(text);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });

  // Inline edit keyboard: Enter saves, Esc cancels
  todoList.addEventListener('keydown', e => {
    if (!e.target.matches('.todo-text[contenteditable="true"]')) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      const li = e.target.closest('.todo-item');
      const t = findTaskById(li.dataset.id);
      if (t) e.target.textContent = t.text;
      e.target.blur();
    }
  });

  // Inline edit save on blur — optimistic update + DB write, rollback on failure
  todoList.addEventListener('focusout', async e => {
    if (!e.target.matches('.todo-text[contenteditable="true"]')) return;
    const text = e.target;
    const li = text.closest('.todo-item');
    const t = findTaskById(li.dataset.id);
    text.removeAttribute('contenteditable');
    if (!t) return;
    const newText = text.textContent.trim();
    if (!newText) {
      text.textContent = t.text;  // revert empty
      return;
    }
    if (newText === t.text) return;  // no change
    const oldText = t.text;
    t.text = newText;
    try {
      await dbUpdate(t.id, { text: newText });
    } catch (err) {
      console.error('Edit save failed:', err);
      t.text = oldText;
      text.textContent = oldText;
      showError('Could not save edit. Reverted.');
    }
  });

  // Init — render UI immediately, then load tasks from DB
  renderCalendar();
  updateDateDisplay();
  syncTagPicker();
  todoEmpty.textContent = 'Loading tasks…';
  todoEmpty.classList.add('todo-loading');
  todoEmpty.style.display = 'block';
  dbSelectAll()
    .then(loaded => {
      tasks = loaded;
      todoEmpty.classList.remove('todo-loading');
      todoEmpty.textContent = 'No tasks yet. Pick a date and add your first one.';
      renderList();
    })
    .catch(err => {
      console.error('Load failed:', err);
      todoEmpty.classList.remove('todo-loading');
      todoEmpty.textContent = 'Could not load tasks.';
      todoEmpty.style.display = 'block';
      updateCounter();
    });
})();

/* ===== Weather mini app — UAPI Weather API ===== */
(function () {
  const form = document.getElementById('weatherForm');
  if (!form) return; // only run on the Projects page

  // Weather requests cannot leave a file:// document (the browser sends a
  // "null" Origin, which the API will not allow). When the site is opened
  // straight from disk and the local server is reachable, hand over to the
  // served copy so search works without the user having to change the URL.
  if (location.protocol === 'file:') {
    const LOCAL_BASE = 'http://localhost:8765/';
    const page = location.pathname.split('/').pop() || 'projects.html';
    fetch(LOCAL_BASE + 'index.html', { mode: 'no-cors', cache: 'no-store' })
      .then(() => { location.replace(LOCAL_BASE + page + location.search + location.hash); })
      .catch(() => { /* server not running — keep the explanatory message */ });
  }

  const input = document.getElementById('weatherInput');
  const btn = document.getElementById('weatherBtn');
  const msg = document.getElementById('weatherMsg');
  const suggestBox = document.getElementById('weatherSuggest');
  const suggestChips = document.getElementById('weatherSuggestChips');
  const result = document.getElementById('weatherResult');
  const iconEl = document.getElementById('weatherIcon');
  const tempEl = document.getElementById('weatherTemp');
  const tempUnitEl = document.getElementById('weatherTempUnit');
  const cityEl = document.getElementById('weatherCity');
  const condEl = document.getElementById('weatherCond');
  const humidityEl = document.getElementById('weatherHumidity');
  const windEl = document.getElementById('weatherWind');
  const updatedEl = document.getElementById('weatherUpdated');
  const forecastEl = document.getElementById('weatherForecast');
  const timeRowEl = document.getElementById('weatherTimeRow');
  const localTimeEl = document.getElementById('weatherLocalTime');
  const unitBtns = document.querySelectorAll('.weather-unit-btn');

  // Temperature unit preference (persisted) + latest payload for re-render.
  let unit = localStorage.getItem('lin-weather-unit') === 'F' ? 'F' : 'C';
  let lastData = null;

  function toUnit(celsius) {
    const n = Number(celsius);
    if (Number.isNaN(n)) return '—';
    return Math.round(unit === 'F' ? n * 9 / 5 + 32 : n);
  }

  // Forecast days have text conditions but no icon codes — map the
  // English condition text (returned with lang=en) to an emoji + label.
  function iconForText(text) {
    const t = String(text || '').toLowerCase();
    if (/thunder/.test(t)) return ['⛈️', 'Thunderstorm'];
    if (/snow|sleet|ice/.test(t)) return ['🌨️', 'Snow'];
    if (/storm|extreme|heavy rain/.test(t)) return ['🌧️', 'Heavy rain'];
    if (/drizzle|shower|light rain/.test(t)) return ['🌦️', 'Light rain'];
    if (/rain/.test(t)) return ['🌧️', 'Rain'];
    if (/fog|mist|haze|sand|dust/.test(t)) return ['🌫️', 'Fog'];
    if (/partly/.test(t)) return ['⛅', 'Partly cloudy'];
    if (/overcast|cloud/.test(t)) return ['☁️', 'Cloudy'];
    if (/sunny|clear/.test(t)) return ['☀️', 'Clear'];
    return ['☁️', text || 'Unknown'];
  }

  const API_URL = 'https://uapis.cn/api/v1/misc/weather';
  const TIME_URL = 'https://uapis.cn/api/v1/misc/worldtime';

  // Live city clock — ticks locally from the API's UTC offset (no refetch).
  let clockTimer = null;
  let clockOffset = null; // seconds east of UTC

  function stopClock() {
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    clockOffset = null;
  }

  function formatUtcOffset(sec) {
    const sign = sec >= 0 ? '+' : '-';
    const abs = Math.abs(sec);
    const h = Math.floor(abs / 3600);
    const m = Math.round((abs % 3600) / 60);
    return 'UTC' + sign + h + (m ? ':' + String(m).padStart(2, '0') : '');
  }

  function renderClock() {
    if (clockOffset === null) return;
    const d = new Date(Date.now() + clockOffset * 1000);
    const pad = n => String(n).padStart(2, '0');
    localTimeEl.textContent =
      pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds())
      + ' (' + formatUtcOffset(clockOffset) + ')';
  }

  function startClock(offsetSeconds) {
    stopClock();
    clockOffset = Number(offsetSeconds);
    if (Number.isNaN(clockOffset)) return;
    timeRowEl.hidden = false;
    renderClock();
    clockTimer = setInterval(renderClock, 1000);
  }

  // One silent retry so a transient network drop is not reported as a failure.
  async function fetchWeather(query) {
    const url = API_URL + '?city=' + encodeURIComponent(query) + '&forecast=true&lang=en';
    try {
      return await fetch(url);
    } catch (err) {
      await new Promise(r => setTimeout(r, 600));
      return await fetch(url);
    }
  }

  // Enhancement only: a time failure must never block the weather result.
  async function fetchCityTime(canonical) {
    try {
      const res = await fetch(TIME_URL + '?city=' + encodeURIComponent(canonical));
      if (!res.ok) return null;
      const t = await res.json();
      return (t && t.offset_seconds !== undefined) ? t : null;
    } catch (e) {
      console.warn('World time request failed:', e);
      return null;
    }
  }

  // The API returns QWeather-style icon codes + Chinese condition text.
  // Map codes to an emoji icon and an English label for the UI.
  const ICON_MAP = {
    100: ['☀️', 'Clear'], 101: ['🌤️', 'Cloudy'], 102: ['🌤️', 'Few clouds'],
    103: ['⛅', 'Partly cloudy'], 104: ['☁️', 'Overcast'],
    150: ['🌙', 'Clear'], 151: ['🌛', 'Few clouds'], 152: ['⛅', 'Partly cloudy'], 153: ['☁️', 'Overcast'],
    300: ['🌦️', 'Light showers'], 301: ['🌦️', 'Heavy showers'],
    302: ['⛈️', 'Thundershowers'], 303: ['⛈️', 'Heavy thundershowers'], 304: ['⛈️', 'Thundershowers with hail'],
    305: ['🌧️', 'Light rain'], 306: ['🌧️', 'Moderate rain'], 307: ['🌧️', 'Heavy rain'],
    308: ['🌧️', 'Extreme rain'], 309: ['🌦️', 'Drizzle'], 310: ['🌧️', 'Storm'],
    311: ['⛈️', 'Severe storm'], 312: ['🌧️', 'Freezing rain'],
    313: ['🌧️', 'Heavy rain'], 314: ['🌧️', 'Rain'], 315: ['🌧️', 'Rain'],
    316: ['🌧️', 'Rain'], 317: ['⛈️', 'Storm'], 318: ['🌧️', 'Rain'],
    350: ['🌦️', 'Drizzle'], 351: ['🌧️', 'Rain'], 399: ['🌧️', 'Rain'],
    400: ['🌨️', 'Light snow'], 401: ['🌨️', 'Moderate snow'], 402: ['❄️', 'Heavy snow'],
    403: ['🌨️', 'Snow showers'], 404: ['🌨️', 'Snow flurry'],
    405: ['🌨️', 'Snow'], 406: ['🌨️', 'Snow'], 407: ['🌨️', 'Snow showers'],
    408: ['🌨️', 'Snow'], 409: ['🌨️', 'Snow'], 410: ['🌨️', 'Snow'],
    456: ['🌨️', 'Sleet'], 457: ['🌨️', 'Sleet'], 499: ['❄️', 'Snow'],
    500: ['🌫️', 'Mist'], 501: ['🌫️', 'Fog'], 502: ['🌫️', 'Haze'],
    503: ['🌫️', 'Drifting sand'], 504: ['🌫️', 'Duststorm'],
    507: ['🌫️', 'Haze'], 508: ['🌫️', 'Haze'], 509: ['🌫️', 'Fog'],
    510: ['🌫️', 'Fog'], 511: ['🌫️', 'Fog'], 512: ['🌫️', 'Fog'],
    513: ['🌫️', 'Fog'], 514: ['🌫️', 'Fog'], 515: ['🌫️', 'Fog'],
    900: ['🥵', 'Hot'], 901: ['🥶', 'Cold'], 999: ['🌡️', 'N/A']
  };

  const WIND_MAP = {
    '北风': 'N', '东北风': 'NE', '东风': 'E', '东南风': 'SE',
    '南风': 'S', '西南风': 'SW', '西风': 'W', '西北风': 'NW'
  };

  // Canonical cities used for STRICT client-side validation.
  // The UAPI server silently fuzzy-matches typos (e.g. "shanghi" -> 上海),
  // so a 200 response alone can't be trusted; the input must match a known
  // spelling exactly. `cn` is the API's Chinese name (used for Chinese queries).
  const CN_CITIES = [
    ['Beijing', '北京'], ['Shanghai', '上海'], ['Guangzhou', '广州'], ['Shenzhen', '深圳'],
    ['Chengdu', '成都'], ['Chongqing', '重庆'], ['Tianjin', '天津'], ['Wuhan', '武汉'],
    ["Xi'an", '西安'], ['Hangzhou', '杭州'], ['Nanjing', '南京'], ['Suzhou', '苏州'],
    ['Qingdao', '青岛'], ['Xiamen', '厦门'], ['Dalian', '大连'], ['Ningbo', '宁波'],
    ['Changsha', '长沙'], ['Zhengzhou', '郑州'], ['Kunming', '昆明'], ['Sanya', '三亚'],
    ['Harbin', '哈尔滨'], ['Shenyang', '沈阳'], ['Jinan', '济南'], ['Hefei', '合肥'],
    ['Nanchang', '南昌'], ['Fuzhou', '福州'], ['Guiyang', '贵阳'], ['Nanning', '南宁'],
    ['Urumqi', '乌鲁木齐'], ['Lhasa', '拉萨'], ['Haikou', '海口'], ['Lanzhou', '兰州'],
    ['Taiyuan', '太原'], ['Shijiazhuang', '石家庄'], ['Changchun', '长春'],
    ['Hohhot', '呼和浩特'], ['Yinchuan', '银川'], ['Xining', '西宁'], ['Wuxi', '无锡'],
    ['Wenzhou', '温州'], ['Zhuhai', '珠海'], ['Dongguan', '东莞'], ['Foshan', '佛山'],
    ['Guilin', '桂林'], ['Lijiang', '丽江'], ['Macau', '澳门'], ['Hong Kong', '香港'],
    ['Taipei', '台北'], ['Kaohsiung', '高雄']
  ];

  const WORLD_CITIES = [
    'Amsterdam', 'Athens', 'Auckland', 'Bangkok', 'Barcelona', 'Berlin', 'Boston',
    'Brussels', 'Buenos Aires', 'Cairo', 'Canberra', 'Cape Town', 'Chicago',
    'Copenhagen', 'Dubai', 'Dublin', 'Edinburgh', 'Frankfurt', 'Geneva', 'Hanoi',
    'Istanbul', 'Jakarta', 'Kabul', 'Kuala Lumpur', 'Kyoto', 'Lisbon', 'London',
    'Los Angeles', 'Madrid', 'Manchester', 'Melbourne', 'Mexico City', 'Miami',
    'Milan', 'Montreal', 'Moscow', 'Mumbai', 'Munich', 'Nairobi',
    'New Delhi', 'New York', 'Osaka', 'Oslo', 'Paris', 'Perth', 'Prague', 'Reykjavik',
    'Rio de Janeiro', 'Rome', 'San Francisco', 'Santiago', 'Sao Paulo', 'Seattle',
    'Seoul', 'Singapore', 'Stockholm', 'Sydney', 'Tokyo', 'Toronto', 'Vancouver',
    'Venice', 'Vienna', 'Warsaw', 'Washington', 'Yokohama', 'Zurich', 'Lyon',
    'Marseille', 'Birmingham', 'Liverpool', 'Glasgow', 'Hamburg', 'Cologne',
    'Valencia', 'Seville', 'Naples', 'Florence', 'Turin', 'Lagos',
    'Johannesburg', 'Casablanca', 'Accra', 'Addis Ababa',
    'Karachi', 'Lahore', 'Dhaka', 'Bangalore', 'Chennai', 'Kolkata', 'Hyderabad',
    'Tehran', 'Baghdad', 'Riyadh', 'Doha', 'Abu Dhabi', 'Kuwait City', 'Muscat',
    'Jerusalem', 'Beirut', 'Ankara', 'St Petersburg', 'Kiev', 'Budapest',
    'Bucharest', 'Sofia', 'Belgrade', 'Zagreb', 'Bratislava', 'Ljubljana', 'Tallinn',
    'Riga', 'Vilnius', 'Helsinki', 'Ho Chi Minh City', 'Phnom Penh', 'Vientiane',
    'Yangon', 'Manila', 'Cebu', 'Busan', 'Incheon', 'Nagoya', 'Kobe', 'Sapporo',
    'Brisbane', 'Adelaide', 'Wellington', 'Christchurch', 'Honolulu',
    'San Diego', 'Houston', 'Dallas', 'Denver', 'Atlanta', 'Philadelphia',
    'Phoenix', 'Detroit', 'Calgary', 'Ottawa', 'Bogota', 'Lima', 'Quito', 'Caracas',
    'Havana', 'Kingston', 'Panama City', 'San Jose', 'Guatemala City', 'Montevideo'
  ];

  // normalized spelling -> canonical display name
  const CITY_INDEX = {};
  // canonical English names, used for "did you mean" chips
  const KNOWN_CITIES = [];

  function normCity(s) {
    return String(s).trim().toLowerCase()
      .replace(/\s+city$/i, '')
      .replace(/市$/, '')
      .replace(/\s+/g, ' ');
  }

  function registerCity(en, cn) {
    if (KNOWN_CITIES.indexOf(en) === -1) KNOWN_CITIES.push(en);
    CITY_INDEX[normCity(en)] = en;
    if (cn) {
      CITY_INDEX[normCity(cn)] = en;
      CITY_INDEX[normCity(cn.replace(/市$/, ''))] = en;
    }
  }

  CN_CITIES.forEach(pair => registerCity(pair[0], pair[1]));
  WORLD_CITIES.forEach(en => registerCity(en));
  // Common spelling variants
  CITY_INDEX['xian'] = "Xi'an";

  // Strict: the input must exactly match a known city spelling.
  function resolveCity(raw) {
    return CITY_INDEX[normCity(raw)] || null;
  }

  // Classic Levenshtein edit distance.
  function editDistance(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      }
    }
    return dp[m][n];
  }

  // Return up to 3 known cities that look like what the user typed.
  function suggestCities(raw) {
    const q = normCity(raw);
    if (!q) return [];
    const maxDist = q.length <= 4 ? 1 : q.length <= 8 ? 2 : 3;
    return KNOWN_CITIES
      .map(name => {
        const dist = editDistance(q, name.toLowerCase());
        const prefix = name.toLowerCase().startsWith(q) ? 0 : 1;
        return { name, dist, prefix };
      })
      .filter(c => c.dist <= maxDist || c.prefix === 0)
      .sort((a, b) => a.prefix - b.prefix || a.dist - b.dist || a.name.length - b.name.length)
      .slice(0, 3)
      .map(c => c.name);
  }

  function hideSuggestions() {
    suggestBox.hidden = true;
    suggestChips.innerHTML = '';
  }

  function showSuggestions(city) {
    const names = suggestCities(city);
    if (!names.length) { hideSuggestions(); return; }
    suggestChips.innerHTML = '';
    names.forEach(name => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'weather-suggest-chip';
      chip.textContent = name;
      chip.addEventListener('click', () => {
        input.value = name;
        searchWeather(name);
      });
      suggestChips.appendChild(chip);
    });
    suggestBox.hidden = false;
  }

  function showMessage(text, kind) {
    result.hidden = true;
    stopClock();
    timeRowEl.hidden = true;
    hideSuggestions();
    msg.textContent = text;
    msg.className = 'weather-msg' + (kind ? ' ' + kind : '');
    msg.hidden = false;
  }

  // Not-found outlet: message plus "did you mean" chips.
  function showNotFound(city) {
    result.hidden = true;
    msg.textContent = "Couldn't find that city — check the spelling.";
    msg.className = 'weather-msg error';
    msg.hidden = false;
    showSuggestions(city);
  }

  function hideMessage() {
    msg.hidden = true;
    msg.textContent = '';
    msg.className = 'weather-msg';
    hideSuggestions();
  }

  // Single friendly error outlet; keeps the UI state consistent.
  function handleError(message) {
    showMessage(message, 'error');
  }

  function renderForecast(days) {
    if (!Array.isArray(days) || !days.length) {
      forecastEl.hidden = true;
      forecastEl.innerHTML = '';
      return;
    }
    forecastEl.innerHTML = days.slice(0, 3).map((day, i) => {
      const cond = day.weather_day || day.weather_night || '';
      const ic = iconForText(cond);
      const label = i === 0 ? 'Today' : (day.week || '');
      let dateLabel = '';
      if (day.date) {
        const dt = new Date(day.date + 'T00:00:00');
        if (!Number.isNaN(dt.getTime())) {
          dateLabel = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }
      }
      const pop = Number(day.pop);
      const popHtml = pop > 0 ? '<span class="wf-pop">💧 ' + pop + '%</span>' : '';
      return '<div class="weather-forecast-day">'
        + '<span class="wf-day">' + label + '</span>'
        + (dateLabel ? '<span class="wf-date">' + dateLabel + '</span>' : '')
        + '<span class="wf-icon" aria-hidden="true">' + ic[0] + '</span>'
        + '<span class="wf-cond">' + ic[1] + '</span>'
        + '<span class="wf-range"><span class="wf-high">' + toUnit(day.temp_max) + '°</span>'
        + ' <span class="wf-low">' + toUnit(day.temp_min) + '°</span></span>'
        + popHtml
        + '</div>';
    }).join('');
    forecastEl.hidden = false;
  }

  function syncUnitBtns() {
    unitBtns.forEach(b => b.classList.toggle('is-active', b.dataset.unit === unit));
  }

  function renderWeather(d, displayName) {
    lastData = d;
    const code = String(d.weather_icon != null ? d.weather_icon : '999');
    const mapped = ICON_MAP[code];
    iconEl.textContent = mapped ? mapped[0] : '☁️';
    tempEl.textContent = toUnit(d.temperature);
    tempUnitEl.textContent = '°' + unit;
    cityEl.textContent = displayName || d.city || input.value.trim();
    condEl.textContent = mapped ? mapped[1] : (d.weather || 'Unknown');
    humidityEl.textContent = (d.humidity != null ? d.humidity : '—') + '%';
    const dir = WIND_MAP[d.wind_direction] || d.wind_direction || '';
    const power = d.wind_power ? String(d.wind_power).replace('级', '').replace(/^Level\s+/i, '') : '';
    windEl.textContent = (dir + ' ' + power).trim() || '—';
    updatedEl.textContent = d.report_time || '—';

    renderForecast(d.forecast);
    hideMessage();
    result.hidden = false;
  }

  unitBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.unit;
      if (next === unit) return;
      unit = next;
      localStorage.setItem('lin-weather-unit', unit);
      syncUnitBtns();
      if (lastData) renderWeather(lastData, cityEl.textContent || undefined);
    });
  });
  syncUnitBtns();

  // `city` is the raw user input; strict spelling is enforced before any
  // network call because the API silently corrects typos server-side.
  async function searchWeather(city) {
    const canonical = resolveCity(city);
    if (!canonical) {
      // Misspelled / unknown — say so directly, do NOT call the API.
      showNotFound(city);
      return;
    }

    // Query the API with the canonical spelling (Chinese name for CN cities).
    const query = CN_CITIES
      .filter(pair => pair[0] === canonical)
      .map(pair => (/[\u4e00-\u9fa5]/.test(normCity(city)) ? pair[1] : pair[0]))[0]
      || canonical;

    btn.disabled = true;
    btn.textContent = 'Searching…';
    showMessage('Loading…', 'loading');
    try {
      // Fetch weather (forecast=true adds up to 7 days, lang=en English text)
      // and the city's local time in parallel. World Time takes the canonical
      // English city name; its failure is non-blocking.
      const [weatherSettled, timeData] = await Promise.all([
        fetchWeather(query),
        fetchCityTime(canonical)
      ]);
      if (!weatherSettled.ok) {
        showNotFound(city);
        return;
      }
      const data = await weatherSettled.json();
      if (!data || data.temperature === undefined) {
        showNotFound(city);
        return;
      }
      renderWeather(data, canonical);
      if (timeData) {
        startClock(timeData.offset_seconds);
      } else {
        stopClock();
        timeRowEl.hidden = true;
      }
    } catch (err) {
      console.error('Weather request failed:', err);
      // Browsers block cross-origin API calls from a file:// document (the
      // request has a "null" origin, which the API does not allow), so a page
      // opened straight from disk can never reach the service.
      handleError(location.protocol === 'file:'
        ? 'Open this page through the local server at http://localhost:8765/projects.html, then search again.'
        : 'Could not reach the weather service. Please try again.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Search';
    }
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    const city = input.value.trim();
    if (!city) {
      // No input — do NOT call the API.
      showMessage('Enter a city first.', 'error');
      return;
    }
    searchWeather(city);
  });
})();
