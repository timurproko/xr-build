// XR Build control panel UI: plain ES module, no build step. Talks to the panel server
// (same origin) over JSON and a Server-Sent Events stream.
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const projectUrl = (id) => `/api/projects/${id}`;

const state = {
  projects: [],
  unregistered: [],
  /** the workspace: { path, exists } */
  workspace: null,
  archived: [],
  layout: { sections: [] },
  view: localStorage.getItem('panel.view') === 'archive' ? 'archive' : 'projects',
  search: null,  // null: search closed; a string: the query (over projects and the archive)
  selected: localStorage.getItem('panel.selected'),
  run: null,
  status: null,
  runLog: [],
  jobs: new Map(),
  packages: [],
  host: null,
  fieldErrors: {},
  logShow: { info: true, warn: true, err: true, ...JSON.parse(localStorage.getItem('panel.logShow') ?? '{}') },
};

// ---- API ----------------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, data) {
    super(data?.error ?? `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body instanceof Blob) {
    opts.body = body;
    opts.headers['content-type'] = body.type || 'application/octet-stream';
  } else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['content-type'] = 'application/json';
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** Runs a POST that may ask for confirmation (409 + details.needsConfirm), asking each time. */
async function confirmable(path, body = {}) {
  const confirm = [];
  for (;;) {
    try {
      return await api('POST', path, { ...body, confirm });
    } catch (e) {
      const need = e instanceof ApiError && e.status === 409 ? e.data?.details?.needsConfirm : null;
      if (!need || confirm.includes(need)) throw e;
      if (need === 'version' && e.data.details.suggested) {
        const v = await ask({
          title: 'Version already packaged',
          message: e.message,
          input: { label: 'Version to build', value: e.data.details.suggested },
          ok: 'Build package',
        });
        if (v === null) return null;
        if (v !== body.version) body = { ...body, version: v };
        else confirm.push(need);
        continue;
      }
      if (!(await ask({ title: need === 'host' ? 'Host is out of date' : 'Please confirm', message: e.message, ok: 'Continue' }))) return null;
      confirm.push(need);
    }
  }
}

function report(e) {
  console.error(e);
  const details = e.data?.details && !e.data.details.needsConfirm ? JSON.stringify(e.data.details, null, 2) : '';
  ask({ title: 'Something went wrong', message: e.message, details, ok: 'OK', cancel: null });
}

/**
 * The panel's own dialog (instead of the browser's alert/confirm/prompt). Resolves to true (or
 * the entered text with `input`) on OK, and null on Cancel / Escape.
 */
function ask({ title, message = '', details = '', input = null, ok = 'OK', cancel = 'Cancel', danger = false }) {
  const dlg = $('#ask');
  $('#ask-title').textContent = title;
  $('#ask-message').textContent = message;
  $('#ask-details').textContent = details;
  $('#ask-details').hidden = !details;
  const field = $('#ask-field');
  field.hidden = !input;
  if (input) {
    $('#ask-input-label').textContent = input.label;
    $('#ask-input').value = input.value ?? '';
  }
  const okBtn = $('#ask-ok');
  okBtn.textContent = ok;
  okBtn.className = danger ? 'danger-solid' : 'primary';
  $('#ask-cancel').textContent = cancel ?? '';
  $('#ask-cancel').hidden = !cancel;
  return new Promise((resolve) => {
    const done = (value) => {
      dlg.removeEventListener('close', onClose);
      okBtn.onclick = null;
      $('#ask-cancel').onclick = null;
      if (dlg.open) dlg.close();
      resolve(value);
    };
    const onClose = () => done(null);
    dlg.addEventListener('close', onClose);
    okBtn.onclick = (ev) => { ev.preventDefault(); done(input ? $('#ask-input').value.trim() : true); };
    $('#ask-cancel').onclick = (ev) => { ev.preventDefault(); done(null); };
    dlg.showModal();
    (input ? $('#ask-input') : okBtn).focus();
  });
}

const action = (fn) => (...args) => fn(...args).catch(report);

// ---- formatting ---------------------------------------------------------------------------

function ago(ms) {
  if (!ms) return 'never';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ms).toLocaleString();
}
const dur = (ms) => (ms < 60000 ? `${(ms / 1000).toFixed(0)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);
const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${(b / 1e6).toFixed(1)} MB`);
const num = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? '–' : Number(v).toFixed(d));
const iconSrc = (p) => `${projectUrl(p.id)}/icon?t=${p.icon?.mtimeMs ?? 0}${p.icon?.custom ? '' : `-${p.manifest?.iconColor ?? 'blue'}`}`;

// ---- loading ------------------------------------------------------------------------------

/** The projects the list shows now: live ones, or the archive (archived ones work the same). */
const listed = () => (state.view === 'archive' ? state.archived : state.projects);
const allProjects = () => [...state.projects, ...state.archived];

async function loadWorkspace() {
  state.workspace = await api('GET', '/api/workspace');
  const b = $('#ws-path');
  b.textContent = state.workspace.path;
  b.hidden = false;
}

/** Creates the workspace (standard folders and a starter app); only adds missing files. */
async function createWorkspace() {
  await api('POST', '/api/workspace/create');
  await loadWorkspace();
  await loadProjects();
}

/** A new app from the core's template, in the workspace's projects/Unsorted/. */
async function newProject() {
  const folder = await ask({ title: 'New project', message: 'A new app from the template. It starts under Unsorted; drag it into a section.', input: { label: 'Folder name (lower case letters, digits, dashes)', value: '' }, ok: 'Create' });
  if (!folder) return;
  const p = await api('POST', '/api/projects/new', { folder, name: folder });
  state.selected = p.id;
  localStorage.setItem('panel.selected', p.id);
  await loadProjects();
}

async function loadProjects() {
  const r = await api('GET', '/api/projects');
  state.projects = r.projects;
  state.archived = r.archived ?? [];
  state.layout = r.layout ?? { sections: [] };
  state.unregistered = r.unregistered;
  if (!allProjects().some((p) => p.id === state.selected)) state.selected = listed()[0]?.id ?? null;
  renderProjects();
  renderDetail();
}

/** Switches the list between the projects and the archive. */
function setView(view) {
  state.view = view;
  localStorage.setItem('panel.view', view);
  if (!listed().some((p) => p.id === state.selected)) state.selected = listed()[0]?.id ?? null;
  renderProjects();
  renderDetail(true);
}
const loadPackages = async () => { state.packages = (await api('GET', '/api/packages')).packages; renderPackages(); };
const loadHost = async () => {
  state.host = await api('GET', '/api/host');
  renderHost();
  // The host's providers change only with a rebuild: refreshed here, after one.
  state.plugins = await api('GET', '/api/plugins').catch(() => null);
};
async function loadJobs() {
  for (const j of (await api('GET', '/api/jobs')).jobs) state.jobs.set(j.id, j);
  renderJobs();
}
async function loadRun() {
  const r = await api('GET', '/api/run');
  state.run = r.state;
  state.status = r.state.status;
  state.runLog = r.log;
  renderRun();
}

// ---- projects list ------------------------------------------------------------------------

function renderProjects() {
  if (state.renaming) return;  // live updates must not throw away a name being typed
  const nav = $('#projects');
  const archive = state.view === 'archive';
  const query = state.search?.trim().toLowerCase() ?? '';
  const searching = query !== '';
  const item = (p) => {
    const m = p.manifest;
    const kind = m?.kind ?? 'app';
    const meta = !m ? 'manifest has errors'
      : [p.entryExists ? `built ${ago(p.webBuildMs)}` : 'not built', identity(m)?.lastPackaged ? `v${esc(identity(m).lastPackaged)}` : ''].filter(Boolean).join(' · ');
    const pill = !m ? '<span class="state err">error</span>' : p.running ? runPill() : searching && p.archived ? '<span class="state busy">archived</span>' : '';
    const color = state.layout.colors?.[layoutId(p.id)];
    return `<button class="proj ${kind} ${color ? `c-${color}` : ''} ${p.id === state.selected ? 'selected' : ''}" data-id="${esc(p.id)}" aria-current="${p.id === state.selected}" ${archive || searching ? '' : 'draggable="true"'}>
      <span class="stripe"></span>
      <img src="${iconSrc(p)}" alt="" draggable="false">
      <div class="text"><div class="name">${esc(m?.name ?? p.id)}</div><div class="meta">${meta}</div></div>${pill ? `<div class="pill">${pill}</div>` : ''}
    </button>`;
  };
  let body;
  if (searching) {
    // Every word must appear in the name or the id; live projects first, then archived ones.
    const words = query.split(/\s+/);
    const hits = allProjects().filter((p) => {
      const text = `${p.manifest?.name ?? ''} ${p.id}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    body = hits.length ? hits.map(item).join('') : '<div class="empty-note">Nothing matches.</div>';
  } else if (archive) {
    body = (state.archived.length ? state.archived.map(item).join('')
      : '<div class="empty-note">Nothing is archived. Right-click a project and choose Archive.</div>');
  } else {
    // The developer's sections (xrb-panel.json), then "Unsorted" for projects in none of them.
    const byId = new Map(state.projects.map((p) => [p.id, p]));
    const placed = new Set();
    const secs = state.layout.sections.map((s, index) => ({
      name: s.name, index,
      items: s.items.filter((id) => byId.has(id)).map((id) => { placed.add(id); return byId.get(id); }),
    }));
    const unsorted = state.projects.filter((p) => !placed.has(p.id));
    if (unsorted.length || !secs.length) secs.push({ name: 'Unsorted', index: -1, items: unsorted });
    body = secs.map((s) => `<section class="sec" data-sec="${s.index}">
        <h2 class="sec-head" title="Double-click to rename"><span class="sec-name">${esc(s.name)}</span>
          ${s.index >= 0 ? `<button type="button" class="sec-del" data-del="${s.index}" title="Delete section (its projects move to Unsorted)" aria-label="Delete section">×</button>` : ''}</h2>
        <div class="sec-items">${s.items.map(item).join('') || '<div class="sec-empty">Drag projects here</div>'}</div>
      </section>`).join('') +
      '<button type="button" class="add-section" id="add-section">+ New section</button>' +
      '<button type="button" class="add-section" id="new-project">+ New project</button>' +
      (state.unregistered.length ? `<h2>Without manifest</h2>` + state.unregistered.map((id) =>
        `<div class="unregistered row">${esc(id)}<span class="spacer"></span><button class="small" data-create="${esc(id)}">Create manifest</button></div>`).join('') : '');
  }
  // Projects | Archive tabs in the column's heading row; the list scrolls under them.
  const tab = (view, label, count) => `<button type="button" role="tab" class="tab" data-view="${view}" aria-selected="${state.view === view}">${label} <span class="count">${count}</span></button>`;
  // The search button swaps the tabs for a search field; Esc or × brings the tabs back.
  const searchIcon = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.4 10.4 14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const head = state.search === null
    ? `<div class="nav-tabs" role="tablist">${tab('projects', 'Projects', state.projects.length)}${tab('archive', 'Archive', state.archived.length)}
        <button type="button" class="nav-search-btn" id="search-open" title="Search projects and the archive" aria-label="Search">${searchIcon}</button></div>`
    : `<div class="nav-tabs nav-search">${searchIcon}<span class="nav-line"></span><input type="search" class="nav-search-input" placeholder="Search projects and archive" value="${esc(state.search)}" aria-label="Search projects and archive">
        <button type="button" class="nav-search-btn" id="search-close" title="Close search (Esc)" aria-label="Close search">×</button></div>`;
  const focused = document.activeElement?.classList.contains('nav-search-input') ? document.activeElement : null;
  const caret = focused ? [focused.selectionStart, focused.selectionEnd] : null;
  const scroll = nav.querySelector('.nav-list')?.scrollTop ?? 0;
  nav.innerHTML = `${head}<div class="nav-list">${body}</div>`;
  nav.querySelector('.nav-list').scrollTop = scroll;
  nav.querySelectorAll('.nav-tabs .tab').forEach((t) => t.addEventListener('click', () => { if (t.dataset.view !== state.view) setView(t.dataset.view); }));
  nav.querySelector('#search-open')?.addEventListener('click', openSearch);
  nav.querySelector('#search-close')?.addEventListener('click', closeSearch);
  const input = nav.querySelector('.nav-search-input');
  if (input) {
    if (caret) { input.focus(); input.setSelectionRange(...caret); }  // live updates re-render while typing
    input.addEventListener('input', () => { state.search = input.value; renderProjects(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
      if (e.key === 'Enter') nav.querySelector('.nav-list .proj')?.click();  // open the first hit
    });
  }
  nav.querySelectorAll('.proj').forEach((b) => b.addEventListener('click', () => {
    state.selected = b.dataset.id;
    // A hit from the other list switches the view, so closing the search shows it in place.
    const view = state.archived.some((p) => p.id === b.dataset.id) ? 'archive' : 'projects';
    if (view !== state.view) { state.view = view; localStorage.setItem('panel.view', view); }
    state.fieldErrors = {};
    localStorage.setItem('panel.selected', state.selected);
    renderProjects();
    renderDetail(true);
  }));
  nav.querySelectorAll('.proj').forEach((b) => b.addEventListener('contextmenu', (e) => {
    const p = allProjects().find((x) => x.id === b.dataset.id);
    if (!p) return;
    e.preventDefault();
    openMenu(e.clientX, e.clientY, p.id);
  }));
  nav.querySelector('#new-project')?.addEventListener('click', action(newProject));
  nav.querySelectorAll('[data-create]').forEach((b) => b.addEventListener('click', action(async () => {
    const p = await api('POST', '/api/projects/create', { id: b.dataset.create });
    state.selected = p.id;
    await loadProjects();
  })));
  if (!archive && !searching) wireSections(nav);
}

// Opening and closing the search: the selected tab's underline stretches across the row into the
// search field's line (and shrinks back onto the tab), while the row's content fades in.
const SEARCH_MS = 240;
const searchEase = 'cubic-bezier(.2, .8, .2, 1)';
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The selected tab's underline as left/width inside the heading row. */
function tabLine() {
  const row = $('#projects .nav-tabs');
  const tab = row?.querySelector('.tab[aria-selected="true"]');
  if (!tab) return null;
  const r = row.getBoundingClientRect(), t = tab.getBoundingClientRect();
  return { left: `${t.left - r.left}px`, width: `${t.width}px` };
}

/** Fades the heading row's content in (everything but the moving line). */
function fadeInRow(row, from) {
  row.querySelectorAll(':scope > :not(.nav-line)').forEach((el) =>
    el.animate([{ opacity: 0, transform: `translateX(${from}px)` }, { opacity: 1, transform: 'none' }],
      { duration: SEARCH_MS, delay: 60, easing: searchEase, fill: 'backwards' }));
}

function openSearch() {
  const from = tabLine();
  state.search = '';
  renderProjects();
  const row = $('#projects .nav-search');
  row.querySelector('.nav-search-input').focus();
  if (reducedMotion() || !from) return;
  row.querySelector('.nav-line').animate([from, { left: '0px', width: `${row.clientWidth}px` }], { duration: SEARCH_MS, easing: searchEase });
  fadeInRow(row, -6);
}

function closeSearch() {
  const row = $('#projects .nav-search');
  const width = row?.clientWidth;
  state.search = null;
  renderProjects();
  const to = tabLine();
  if (reducedMotion() || !to || !width) return;
  // A stand-in line shrinks onto the selected tab, which shows its own underline when it lands.
  const tabs = $('#projects .nav-tabs');
  const tab = tabs.querySelector('.tab[aria-selected="true"]');
  const line = document.createElement('span');
  line.className = 'nav-line';
  tabs.append(line);
  tab.style.borderBottomColor = 'transparent';
  line.animate([{ left: '0px', width: `${width}px` }, to], { duration: SEARCH_MS, easing: searchEase, fill: 'forwards' })
    .finished.finally(() => { line.remove(); tab.style.borderBottomColor = ''; });
  fadeInRow(tabs, 0);
}

// ---- sections: create, rename, delete, drag projects between them --------------------------

/** Saves the layout (optimistically: the list shows it at once). */
async function saveLayout(layout) {
  state.layout = layout;
  renderProjects();
  await api('PUT', '/api/layout', layout);
}

const cloneLayout = () => ({ sections: state.layout.sections.map((s) => ({ name: s.name, items: [...s.items] })), colors: { ...(state.layout.colors ?? {}) } });
/** Project id as stored in the layout: archived projects keep their live id there. */
const layoutId = (id) => id.replace(/^archive\//, '');

/** Inline name editing in a section heading (or a new heading); resolves to the name or null. */
function editName(container, value) {
  return new Promise((resolve) => {
    state.renaming = true;  // live updates must not re-render the list meanwhile
    const input = document.createElement('input');
    input.className = 'rename sec-input';
    input.value = value;
    input.placeholder = 'Section name';
    container.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      state.renaming = false;
      resolve(v);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim() || null); }
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    });
    input.addEventListener('blur', () => finish(input.value.trim() || null));
  });
}

function wireSections(nav) {
  const taken = (name, except = -1) => state.layout.sections.some((s, i) => i !== except && s.name.toLowerCase() === name.toLowerCase());

  $('#add-section').addEventListener('click', action(async (e) => {
    // The "+ New section" row itself becomes the name field (no extra row).
    const holder = document.createElement('div');
    holder.className = 'add-section-edit';
    e.currentTarget.replaceWith(holder);
    const name = await editName(holder, '');
    if (!name || taken(name)) { if (name) await ask({ title: 'Section exists', message: `There is already a section named "${name}".`, cancel: null }); return renderProjects(); }
    const l = cloneLayout();
    l.sections.push({ name, items: [] });
    await saveLayout(l);
  }));

  nav.querySelectorAll('.sec-head[title]').forEach((h) => h.addEventListener('dblclick', action(async (e) => {
    if (e.target.closest('.sec-del')) return;
    const index = Number(h.closest('.sec').dataset.sec);
    if (index < 0) {
      // Naming "Unsorted" turns it into a real section holding the projects it shows now.
      const name = await editName(h, '');
      if (!name || taken(name)) { if (name) await ask({ title: 'Section exists', message: `There is already a section named "${name}".`, cancel: null }); return renderProjects(); }
      const placed = new Set(state.layout.sections.flatMap((s) => s.items));
      const l = cloneLayout();
      l.sections.push({ name, items: state.projects.map((p) => p.id).filter((id) => !placed.has(id)) });
      return saveLayout(l);
    }
    const name = await editName(h, state.layout.sections[index].name);
    if (!name || name === state.layout.sections[index].name || taken(name, index)) return renderProjects();
    const l = cloneLayout();
    l.sections[index].name = name;
    await saveLayout(l);
  })));

  // Right-click a section heading: move it up or down, or rename it. Unsorted stays last.
  nav.querySelectorAll('.sec-head').forEach((h) => h.addEventListener('contextmenu', (e) => {
    const index = Number(h.closest('.sec').dataset.sec);
    e.preventDefault();
    closeMenu();
    const menu = $('#sec-menu');
    menu.dataset.sec = String(index);
    menu.querySelector('[data-act="up"]').disabled = index <= 0;
    menu.querySelector('[data-act="down"]').disabled = index < 0 || index >= state.layout.sections.length - 1;
    placeMenu(menu, e.clientX, e.clientY);
  }));

  nav.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', action(async (e) => {
    e.stopPropagation();
    const l = cloneLayout();
    l.sections.splice(Number(b.dataset.del), 1);  // its projects show under Unsorted
    await saveLayout(l);
  })));

  // Drag a project onto a section (end of it) or onto another project (before/after it).
  let dragId = null;
  const clearMarks = () => nav.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((x) => x.classList.remove('drop-before', 'drop-after', 'drop-into'));
  nav.querySelectorAll('.proj[draggable="true"]').forEach((b) => {
    b.addEventListener('dragstart', (e) => {
      dragId = b.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
      requestAnimationFrame(() => b.classList.add('dragging'));
    });
    b.addEventListener('dragend', () => { dragId = null; b.classList.remove('dragging'); clearMarks(); });
  });
  const target = (e) => {
    const sec = e.target.closest('.sec');
    if (!sec) return null;
    const over = e.target.closest('.proj');
    if (over && over.dataset.id !== dragId) {
      const r = over.getBoundingClientRect();
      return { sec, over, after: e.clientY > r.top + r.height / 2 };
    }
    return { sec, over: null, after: true, self: over?.dataset.id === dragId };
  };
  // A drop that would leave the project where it is: no marker, nothing saved.
  const unchanged = (t) => {
    const dragged = [...nav.querySelectorAll('.proj')].find((p) => p.dataset.id === dragId);
    if (!t || !dragged || dragged.closest('.sec') !== t.sec) return false;
    if (t.self || t.sec.dataset.sec === '-1') return true;  // Unsorted keeps no order of its own
    const prev = dragged.previousElementSibling, next = dragged.nextElementSibling;
    if (!t.over) return !next?.classList.contains('proj');  // already last in the section
    return t.after ? t.over === prev : t.over === next;
  };
  nav.querySelectorAll('.sec').forEach((sec) => {
    sec.addEventListener('dragover', (e) => {
      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const t = target(e);
      clearMarks();
      if (unchanged(t)) return;
      if (t?.over) t.over.classList.add(t.after ? 'drop-after' : 'drop-before');
      else if (t) t.sec.classList.add('drop-into');
    });
    sec.addEventListener('dragleave', (e) => { if (!sec.contains(e.relatedTarget)) sec.classList.remove('drop-into'); });
    sec.addEventListener('drop', action(async (e) => {
      e.preventDefault();
      const t = target(e);
      const id = dragId;
      if (unchanged(t)) { clearMarks(); return; }
      clearMarks();
      if (!t || !id) return;
      const index = Number(t.sec.dataset.sec);
      const l = cloneLayout();
      for (const s of l.sections) s.items = s.items.filter((x) => x !== id);
      if (index >= 0) {
        const items = l.sections[index].items;
        let at = items.length;
        if (t.over) {
          const i = items.indexOf(t.over.dataset.id);
          if (i >= 0) at = t.after ? i + 1 : i;
        }
        items.splice(at, 0, id);
      }  // dropped on Unsorted: in no section
      await saveLayout(l);
    }));
  });
}

// ---- right-click menu and rename -----------------------------------------------------------

/** Shows a menu at the cursor, kept inside the window. */
function placeMenu(menu, x, y) {
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  menu.querySelector('button:not(:disabled)')?.focus();
}

/** Right-click on the project's thumbnail: change the icon, or the colour of the default icon. */
function openIconMenu(x, y, p) {
  closeMenu();
  const menu = $('#icon-menu');
  menu.dataset.project = p.id;
  const custom = !!p.icon?.custom;
  const current = p.manifest?.iconColor ?? 'blue';
  // Colours only apply to the default icon: a project with its own icon gets no swatches.
  menu.querySelector('.menu-colors').hidden = custom;
  menu.querySelectorAll('[data-icon-color]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.iconColor === current)));
  placeMenu(menu, x, y);
}

$('#icon-menu').addEventListener('click', action(async (e) => {
  const menu = $('#icon-menu');
  const p = allProjects().find((x) => x.id === menu.dataset.project);
  const b = e.target.closest('button');
  if (!b || !p) return;
  closeMenu();
  if (b.dataset.act === 'studio') return openStudio(p);
  const color = b.dataset.iconColor;
  if (!color || color === (p.manifest.iconColor ?? 'blue')) return;
  const m = structuredClone(p.manifest);
  if (color === 'blue') delete m.iconColor;  // blue is the default
  else m.iconColor = color;
  await api('PUT', `${projectUrl(p.id)}/manifest`, { manifest: m, mtimeMs: p.manifestMtimeMs });
  await loadProjects();
}));

function openMenu(x, y, projectId) {
  closeMenu();
  const menu = $('#ctx-menu');
  const p = allProjects().find((x) => x.id === projectId);
  menu.dataset.project = projectId;
  menu.querySelector('[data-act="rename"]').disabled = !p?.manifest;  // a broken manifest can only be deleted
  menu.querySelector('[data-act="delete"]').disabled = !!p?.running;
  // Archive for live projects, Unarchive for archived ones
  // the swatch of the project's current colour is marked
  const current = state.layout.colors?.[layoutId(projectId)] ?? '';
  menu.querySelectorAll('[data-color]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === current)));
  const arch = menu.querySelector('[data-act="archive"]');
  arch.textContent = p?.archived ? 'Unarchive' : 'Archive';
  arch.disabled = !!p?.running;
  placeMenu(menu, x, y);
}
// A dropdown's option list is a .menu too, but it closes itself (closeDropdown): hiding it here would hide
// the list the same click just opened.
const closeMenu = () => document.querySelectorAll('.menu:not(.dropdown-list)').forEach((m) => { m.hidden = true; });

$('#sec-menu').addEventListener('click', action(async (e) => {
  const act = e.target.closest('button')?.dataset.act;
  const index = Number($('#sec-menu').dataset.sec);
  closeMenu();
  if (act === 'rename') {
    $(`#projects .sec[data-sec="${index}"] .sec-head`)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return;
  }
  const to = act === 'up' ? index - 1 : act === 'down' ? index + 1 : -1;
  if (index < 0 || to < 0 || to >= state.layout.sections.length) return;
  const l = cloneLayout();
  [l.sections[index], l.sections[to]] = [l.sections[to], l.sections[index]];
  await saveLayout(l);
}));
addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenu(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
addEventListener('scroll', closeMenu, true);
addEventListener('blur', closeMenu);

$('#ctx-menu').addEventListener('click', (e) => {
  const swatch = e.target.closest('[data-color]');
  if (swatch) {
    const id = layoutId($('#ctx-menu').dataset.project);
    closeMenu();
    const l = cloneLayout();
    if (swatch.dataset.color) l.colors[id] = swatch.dataset.color;
    else delete l.colors[id];
    saveLayout(l).catch(report);
    return;
  }
  const act = e.target.closest('button')?.dataset.act;
  const id = $('#ctx-menu').dataset.project;
  closeMenu();
  if (act === 'rename') startRename(id);
  if (act === 'delete') deleteProject(id).catch(report);
  if (act === 'archive') archiveProject(id).catch(report);
});

/**
 * Archive (live -> archive/) or Unarchive (archived -> back), no confirmation: either is undone
 * by the other. The list stays where it is; the project leaves it.
 */
async function archiveProject(id) {
  const p = allProjects().find((x) => x.id === id);
  await api('POST', `${projectUrl(id)}/${p?.archived ? 'unarchive' : 'archive'}`);
  if (state.selected === id) state.selected = null;
  await loadProjects();
}

/** Moves the project folder to the Recycle Bin, after a confirmation. */
async function deleteProject(id) {
  const p = allProjects().find((x) => x.id === id);
  const name = p?.manifest?.name ?? id;
  const ok = await ask({
    title: `Delete "${name}"?`,
    message: `The folder ${id} goes to the Recycle Bin; you can restore it from there.`,
    ok: 'Delete',
    danger: true,
  });
  if (!ok) return;
  await api('POST', `${projectUrl(id)}/delete`);
  if (state.selected === id) state.selected = null;
  await loadProjects();
}

/** Edits a project's name in place in the list. For apps the name is also the package title (when it followed it). */
function startRename(id) {
  const p = allProjects().find((x) => x.id === id);
  const nameEl = document.querySelector(`.proj[data-id="${CSS.escape(id)}"] .name`);
  if (!p?.manifest || !nameEl) return;
  state.renaming = true;
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = p.manifest.name;
  input.setAttribute('aria-label', 'Project name');
  nameEl.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    try {
      if (save && name && name !== p.manifest.name) {
        const m = structuredClone(p.manifest);
        const oldName = m.name;
        m.name = name;
        syncIdentityTitle(m, oldName);
        await api('PUT', `${projectUrl(p.id)}/manifest`, { manifest: m, mtimeMs: p.manifestMtimeMs });
      }
    } catch (e) {
      report(e);
    } finally {
      state.renaming = false;
      await loadProjects();
    }
  };
  // The input sits inside the project button: keep its clicks and keys to itself.
  for (const t of ['click', 'mousedown', 'keyup']) input.addEventListener(t, (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    if (e.key === ' ') e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
}

// ---- project detail -----------------------------------------------------------------------

/** The package identity: the platform's section of `plugins` (null standalone). */
const identity = (m) => (m?.platform ? (m.plugins?.[m.platform] ?? null) : null);

/** A package title that followed the project name keeps following it. */
function syncIdentityTitle(m, oldName) {
  const id = m.platform ? m.plugins?.[m.platform] : null;
  if (id && typeof id.title === 'string' && (id.title === oldName || !id.title)) id.title = m.name;
}

const selected = () => allProjects().find((p) => p.id === state.selected) ?? null;

/**
 * An option's text: `data-default` names the empty choice, `data-labels` ("value:Text|...") names others,
 * `data-raw` keeps names as they are (provider names).
 */
const optionLabel = (o, owner) => {
  if (!o) return owner?.dataset.default || 'Default';
  const named = (owner?.dataset.labels ?? '').split('|').map((x) => x.split(':')).find(([v]) => v === o);
  if (named) return named[1];
  return owner?.dataset.raw ? o : o[0].toUpperCase() + o.slice(1);
};

function field(label, name, value, opts = {}) {
  const err = state.fieldErrors[name];
  // Options: the panel's own dropdown (the browser's option list cannot be styled). A hidden
  // input carries the value, so the form and its autosave treat it like any field.
  const labels = Object.entries(opts.labels ?? {}).map(([v, t]) => `${v}:${t}`).join('|');
  const owner = { dataset: { default: opts.defaultLabel ?? '', raw: opts.raw ? '1' : '', labels } };
  const input = opts.options
    ? `<div class="dropdown" data-options="${esc(opts.options.join('|'))}" data-default="${esc(opts.defaultLabel ?? '')}" ${labels ? `data-labels="${esc(labels)}"` : ''} ${opts.raw ? 'data-raw="1"' : ''} ${opts.title ? `title="${esc(opts.title)}"` : ''}>
        <input type="hidden" name="${name}" value="${esc(value ?? '')}">
        <button type="button" class="dropdown-btn" aria-haspopup="listbox" aria-expanded="false">${esc(optionLabel(value ?? '', owner))}</button>
      </div>`
    : `<input name="${name}" value="${esc(value ?? '')}" ${err ? 'aria-invalid="true"' : ''} ${opts.readonly ? 'readonly' : ''} title="${esc(opts.title ?? '')}" placeholder="${esc(opts.placeholder ?? '')}">`;
  return `<label>${label}${input}${err ? `<span class="field-error">${esc(err)}</span>` : ''}</label>`;
}

// ---- dropdown: one shared option list, opened under the dropdown that was clicked ------------

const dropdown = { el: null, owner: null, index: 0 };

function openDropdown(owner) {
  closeDropdown();
  const options = owner.dataset.options.split('|');
  const current = owner.querySelector('input').value;
  const list = document.createElement('div');
  list.className = 'menu dropdown-list';
  list.setAttribute('role', 'listbox');
  list.innerHTML = options.map((o, i) => `<button type="button" role="option" data-i="${i}" aria-selected="${o === current}">${esc(optionLabel(o, owner))}</button>`).join('');
  document.body.append(list);
  const r = owner.getBoundingClientRect();
  list.style.minWidth = `${r.width}px`;
  list.style.left = `${r.left}px`;
  const below = r.bottom + 4 + list.offsetHeight <= innerHeight;
  list.style.top = `${below ? r.bottom + 4 : r.top - 4 - list.offsetHeight}px`;
  Object.assign(dropdown, { el: list, owner, index: Math.max(0, options.indexOf(current)) });
  owner.querySelector('.dropdown-btn').setAttribute('aria-expanded', 'true');
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (b) chooseDropdown(Number(b.dataset.i));
  });
  focusDropdown();
}

function focusDropdown() {
  dropdown.el?.querySelectorAll('[data-i]')[dropdown.index]?.focus();
}

function chooseDropdown(i) {
  const { owner } = dropdown;
  const value = owner.dataset.options.split('|')[i];
  closeDropdown();
  const input = owner.querySelector('input');
  owner.querySelector('.dropdown-btn').focus();
  if (input.value === value) return;
  input.value = value;
  owner.querySelector('.dropdown-btn').textContent = optionLabel(value, owner);
  input.dispatchEvent(new Event('change', { bubbles: true }));  // -> the form's autosave
}

function closeDropdown() {
  dropdown.owner?.querySelector('.dropdown-btn')?.setAttribute('aria-expanded', 'false');
  dropdown.el?.remove();
  Object.assign(dropdown, { el: null, owner: null });
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.dropdown-btn');
  if (btn) {
    e.preventDefault();
    const owner = btn.closest('.dropdown');
    if (dropdown.owner === owner) closeDropdown();
    else openDropdown(owner);
  } else if (!e.target.closest('.dropdown-list')) closeDropdown();
});
document.addEventListener('keydown', (e) => {
  const btn = e.target.closest?.('.dropdown-btn');
  if (btn && !dropdown.el && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
    e.preventDefault();
    openDropdown(btn.closest('.dropdown'));
    return;
  }
  if (!dropdown.el) return;
  const n = dropdown.owner.dataset.options.split('|').length;
  if (e.key === 'ArrowDown') { e.preventDefault(); dropdown.index = (dropdown.index + 1) % n; focusDropdown(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); dropdown.index = (dropdown.index - 1 + n) % n; focusDropdown(); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseDropdown(dropdown.index); }
  else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); const o = dropdown.owner; closeDropdown(); o.querySelector('.dropdown-btn').focus(); }
});
addEventListener('scroll', (e) => { if (!dropdown.el?.contains(e.target)) closeDropdown(); }, true);
addEventListener('resize', closeDropdown);

/**
 * Run and Run with dev server. While this project runs, the button that started it turns into
 * Stop (no extra button); while another project runs, both wait.
 */
function runButtons(p, busy) {
  const stopping = p.running && state.run?.phase === 'stopping';
  const button = p.running
    ? `<button id="act-stop" class="danger" ${stopping ? 'disabled' : ''}>${stopping ? 'Stopping…' : 'Stop'}</button>`
    : `<button id="act-run" class="primary go" ${busy ? 'disabled' : ''}>Run</button>`;
  // One Run button; the checkboxes pick the mode (remembered per project). While the app runs they
  // show the mode it was started in and cannot change, except 2D mode: with a switchable session the host
  // switches between 2D and 3D live, and the checkbox follows what the host reports.
  const dev = p.running ? state.run?.mode === 'dev' : devMode(p.id);
  const box = p.canDev
    ? `<label class="toggle" title="Serve the app from its sources with live reload (Vite dev server) instead of the build">
        <input type="checkbox" id="act-dev" ${dev ? 'checked' : ''} ${p.running || busy ? 'disabled' : ''}> Dev server</label>`
    : '';
  const flat = p.running ? !!state.run?.flat : flatMode(p.id);
  const flatLocked = p.running ? state.run?.phase !== 'running' || !state.run?.switchable : busy;
  const flatBox = `<label class="toggle" title="${p.running ? 'Switch the running app between 2D (no 3D effect) and 3D' : 'Start without the 3D effect; can be switched while the app runs'}">
        <input type="checkbox" id="act-flat" ${flat ? 'checked' : ''} ${flatLocked ? 'disabled' : ''}> 2D mode</label>`;
  const cams = p.running ? !!state.run?.cameraView : cameraMode(p.id);
  const camBox = `<label class="toggle" title="Show the input provider's camera images (e.g. infrared with the hand detections, and colour) in the Running card">
        <input type="checkbox" id="act-cams" ${cams ? 'checked' : ''} ${p.running || busy ? 'disabled' : ''}> Cameras</label>`;
  return button + flatBox + camBox + box;
}

/** A WebXR headset app does not run on the host: its build opens in the browser (WebXR where the browser has it). */
function headsetButtons(p) {
  return `<button id="act-open" class="primary go" ${p.entryExists ? 'title="Open the build in a browser tab: one view on the desktop; Enter starts a session in a browser with WebXR"' : 'disabled title="Build the app first"'}>Open in browser</button>`;
}

/** Whether a project is built for a WebXR headset (manifest `target`; unset = the host). */
const isHeadset = (m) => m?.target === 'webxr';
/**
 * A role selector: the providers the built host offers for the role (built-ins and plugins, from
 * `xrb-host --list-plugins`); the platform also lists the platforms a packager plugin packages for.
 * A name the project uses but the host lacks stays selectable (marked missing), so nothing is lost.
 */
function roleField(label, role, value, defaultLabel, headset = false) {
  const l = state.plugins;
  // A headset app has no host providers: its platforms are the packagers building for headsets.
  const names = new Set(headset ? [] : (l?.providers ?? []).filter((x) => x.role === role && x.name !== defaultLabel).map((x) => x.name));
  if (role === 'platform') for (const n of (headset ? l?.headsetPlatforms : l?.packagers) ?? []) names.add(n);
  const missing = value && !names.has(value) && value !== defaultLabel;
  if (value) names.add(value);
  const describe = (l?.providers ?? []).filter((x) => x.role === role).map((x) => `${x.name}: ${x.description}${x.builtin ? ' (built in)' : ''}`).join('\n');
  return field(`${label}${missing ? ' <span class="state none" title="not built next to the host">missing</span>' : ''}`, role, value ?? '',
    { options: ['', ...[...names].sort()], defaultLabel, raw: true, title: describe || 'build the host to list its providers' });
}

/** The identity fields the platform's packager declares (version excepted: it sits next to Build package). */
function identityFields(p) {
  const pk = p.packaging, m = p.manifest;
  if (!pk?.available) return '';
  const id = m.plugins?.[pk.platform] ?? {};
  return pk.fields.filter((f) => f.kind !== 'version').map((f) => {
    const fixed = f.fixed && id.lastPackaged;
    return field(f.label, `plugins.${pk.platform}.${f.key}`, id[f.key] ?? '', {
      readonly: fixed, title: fixed ? `${f.label} is fixed after the first package` : (f.hint ?? ''),
    });
  }).join('');
}

/**
 * Package build, through the packager plugin of the project's platform. Without one (no plugin for the
 * platform, or a standalone app) the panel says why instead; the packager's own checks show below.
 */
function packageAction(p, pkg) {
  const pk = p.packaging;
  if (!pkg && !pk?.available) return '';
  if (!pk?.available) return `<div class="act"><div class="row"><span class="state none" title="${esc(pk?.reason ?? '')}">packaging unavailable: ${esc(pk?.reason ?? 'no packager')}</span></div></div>`;
  const errors = pk.errors.map((e) => `<span class="field-error">${esc(e.message)}</span>`).join('');
  return `<div class="act"><div class="row">
        <button id="act-package" ${pk.errors.length ? 'disabled' : ''} title="${esc(`${pk.packager} package`)}">Build package</button>
        <input class="version" id="act-version" value="${esc(pkg?.version ?? '')}" aria-label="version">
        ${pkg?.lastPackaged ? `<span class="state ok">last ${esc(pkg.lastPackaged)}</span>` : ''}</div>${errors}</div>`;
}

const cameraMode = (id) => localStorage.getItem(`panel.cams.${id}`) === '1';
const devMode = (id) => localStorage.getItem(`panel.dev.${id}`) === '1';
const flatMode = (id) => localStorage.getItem(`panel.flat.${id}`) === '1';

/**
 * vscode:// link to a workspace file. The browser hands it to VS Code itself, which then comes to the
 * front (a window opened by the background panel server would stay behind the browser).
 */
function vscodeLink(workspaceRelative) {
  const root = (state.repo ?? '').replace(/\\/g, '/');
  return `vscode://file/${root}/${workspaceRelative}`.replace(/ /g, '%20');
}

/** The tab icon is the selected project's icon. */
function syncFavicon(p) {
  const link = $('#favicon');
  const href = p ? iconSrc(p) : null;
  if (link.getAttribute('href') === href) return;
  if (href) link.setAttribute('href', href);
  else link.removeAttribute('href');
}

function renderDetail(force = false) {
  // Live events re-render the view; never throw away settings the developer is editing.
  if (state.dirty && !force) return;
  state.dirty = false;
  const el = $('#detail');
  const p = selected();
  syncFavicon(p);
  if (!p) {
    const ws = state.workspace;
    el.innerHTML = ws && !ws.exists
      ? `<div class="card"><h3>No workspace yet</h3><p>Projects and plugins live in your workspace, outside the XR Build core: <code>${esc(ws.path)}</code>.
          Create it with the standard folders and a starter app; keep it in your own git repo.</p>
          <div class="actions"><button class="primary" id="ws-create">Create workspace</button></div></div>`
      : `<div class="card"><h3>No projects yet</h3><p>Create one from the template, or add a folder with an xrb-project.json to a section folder in the workspace (projects/&lt;section&gt;/&lt;project&gt;).</p>
          <div class="actions"><button class="primary" id="empty-new">New project</button></div></div>`;
    el.querySelector('#ws-create')?.addEventListener('click', action(createWorkspace));
    el.querySelector('#empty-new')?.addEventListener('click', action(newProject));
    syncRunDock(null);
    return;
  }
  const m = p.manifest;
  const busy = !!state.run && state.run.phase !== 'idle';
  const top = `<div class="hero-top">
      <button type="button" class="icon-btn" id="open-studio" ${m ? '' : 'disabled'} title="Change the icon (icon studio)" aria-label="Change the icon">
        <img src="${iconSrc(p)}" alt="">
        <span class="hint">Change icon</span>
      </button>
      <div>
        <h3>${esc(m?.name ?? p.id)}</h3>
        <div class="sub"><a href="#" class="path link" id="open-dir" title="Open the project folder in Explorer">${esc(p.dir)}</a></div>
        ${p.errors.length ? `<ul class="errors">${p.errors.map((e) => `<li>${esc(e.field ? `${e.field}: ` : '')}${esc(e.message)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="hero-tag">${p.archived ? '<span class="state busy" title="Kept in the archive folder; right-click it in the list to unarchive">archived</span> ' : ''}${!m ? '' : !p.icon?.custom ? '<span class="state none" title="The project uses the default icon">default icon</span>'
        : p.icon?.changedSincePackage ? '<span class="state busy" title="Changed since the last package build: the next package uses it">icon changed</span>' : ''}</div>
    </div>`;
  if (!m) {
    el.innerHTML = `<div class="card hero">${top}</div>` + '<p class="empty">Fix the manifest file, then it reloads here.</p>';
    syncRunDock(p);
    return;
  }
  const pkg = identity(m);
  const headset = isHeadset(m);
  const actions = `<div class="actions">
      <div class="act"><div class="row">
        ${headset ? headsetButtons(p) : runButtons(p, busy)}</div></div>
      <div class="act"><div class="row">
        <button id="act-web" ${m.scripts?.build ? '' : 'disabled title="no build script"'}>Build</button>
        ${p.entryExists ? `<span class="state ok">built ${ago(p.webBuildMs)}</span>` : `<span class="state none">${esc(m.entry ?? '')} has no index.html yet</span>`}</div></div>
      ${packageAction(p, pkg)}
    </div>`;
  const settings = `<form id="settings">
      <div class="grid3">
        ${field('Title', 'name', m.name)}
        ${headset ? '' : roleField('Display', 'display', m.display, 'desktop')}
        ${headset ? '' : roleField('Input', 'input', m.input, 'none')}
      </div>
      <div class="grid3">
        ${m.kind === 'app' ? field('Target', 'target', m.target ?? '', {
          options: ['', 'webxr'], defaultLabel: 'Host', labels: { webxr: 'WebXR headset' },
          title: 'Host: xrb-host on a display, with display, input and platform providers.\nWebXR headset: a standalone headset runs the app in its browser engine, with its own hand tracking; no host.',
        }) : ''}
        ${m.kind === 'app' ? roleField('Platform', 'platform', m.platform, 'standalone', headset) : ''}
        ${identityFields(p)}
      </div>
      <span class="field-error">${esc(state.fieldErrors[''] ?? '')}</span>
    </form>`;
  // The project and what can be done with it in one card; its settings in a card below.
  el.innerHTML = `<div class="card hero">${top}${actions}</div>
    <section class="card">
      <div class="row"><h2>Settings</h2><span class="spacer"></span><span id="save-state" class="state" hidden></span>
        <a href="${esc(vscodeLink(`${p.dir}/xrb-project.json`))}" class="path link" id="open-manifest" title="Open ${esc(p.dir)}/xrb-project.json in VS Code">Open JSON</a></div>
      ${settings}
    </section>`;

  $('#open-studio').addEventListener('click', () => openStudio(p));
  $('#open-studio').addEventListener('contextmenu', (e) => {
    if (!m) return;
    e.preventDefault();
    openIconMenu(e.clientX, e.clientY, p);
  });
  $('#open-dir').addEventListener('click', action(async (e) => { e.preventDefault(); await api('POST', `${projectUrl(p.id)}/open-folder`); }));
  $('#act-web')?.addEventListener('click', action(() => api('POST', `${projectUrl(p.id)}/build-web`)));
  $('#act-package')?.addEventListener('click', action(() => confirmable(`${projectUrl(p.id)}/package`, { version: $('#act-version').value.trim() })));
  $('#act-run')?.addEventListener('click', action(() => api('POST', `${projectUrl(p.id)}/run`, { mode: p.canDev && devMode(p.id) ? 'dev' : 'built', flat: flatMode(p.id), cameraView: cameraMode(p.id) })));
  $('#act-dev')?.addEventListener('change', (e) => localStorage.setItem(`panel.dev.${p.id}`, e.target.checked ? '1' : '0'));
  $('#act-flat')?.addEventListener('change', (e) => {
    if (p.running) {
      // The state event re-renders the box once the host confirms; a refused switch puts it back now.
      api('POST', '/api/run/view', { flat: e.target.checked }).catch((err) => { e.target.checked = !e.target.checked; report(err); });
      return;
    }
    localStorage.setItem(`panel.flat.${p.id}`, e.target.checked ? '1' : '0');
  });
  $('#act-cams')?.addEventListener('change', (e) => localStorage.setItem(`panel.cams.${p.id}`, e.target.checked ? '1' : '0'));
  $('#act-stop')?.addEventListener('click', action(() => api('POST', '/api/run/stop')));
  $('#act-open')?.addEventListener('click', () => window.open(`/preview/${p.id}/`, '_blank', 'noopener'));
  syncRunDock(p);
  // Saved without a button: "change" fires when a select gets a new value, and for the title
  // on Enter or when it loses focus (not per keystroke: a half-typed title would reach a package).
  const form = $('#settings');
  form.addEventListener('input', () => { state.dirty = true; });
  form.addEventListener('submit', (ev) => { ev.preventDefault(); ev.target.querySelector(':focus')?.blur(); });
  form.addEventListener('change', action(async () => {
    if (form.querySelector('[name="name"]').value.trim() === '') return showFieldErrors({ name: 'title is required' });
    await saveSettings(p, new FormData(form));
  }));
}

async function saveSettings(p, form) {
  const get = (k) => String(form.get(k) ?? '').trim();
  const opt = (k) => get(k) || undefined;
  // The form has the title, the providers per role and the packager's identity fields. Everything
  // else in the manifest (entry, scripts, icon, host options, plugin settings, versions) is kept.
  const m = structuredClone(p.manifest);
  const oldName = m.name;
  m.name = get('name');
  for (const role of ['target', 'display', 'input', 'platform']) if (form.has(role)) m[role] = opt(role);
  for (const [k, v] of form.entries()) {
    const at = /^plugins\.([^.]+)\.(.+)$/.exec(k);
    if (!at) continue;
    m.plugins = { ...m.plugins, [at[1]]: { ...m.plugins?.[at[1]], [at[2]]: String(v).trim() } };
  }
  syncIdentityTitle(m, oldName);
  for (const k of Object.keys(m)) if (m[k] === undefined) delete m[k];
  try {
    await api('PUT', `${projectUrl(p.id)}/manifest`, { manifest: m, mtimeMs: p.manifestMtimeMs });
    state.fieldErrors = {};
    state.dirty = false;
    await loadProjects();
    const note = $('#save-state');
    if (note) {
      note.className = 'state ok';
      note.textContent = 'saved';
      note.hidden = false;
      setTimeout(() => { note.hidden = true; }, 1600);
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 400 && e.data?.fields) {
      // Keep what was typed: patch the error messages into the form instead of re-rendering.
      state.fieldErrors = Object.fromEntries(e.data.fields.map((f) => [f.field, f.message]));
      showFieldErrors();
      return;
    }
    if (e instanceof ApiError && e.status === 409) {
      await ask({ title: 'Settings changed on disk', message: e.message, ok: 'Reload', cancel: null });
      state.dirty = false;
      await loadProjects();
      return;
    }
    throw e;
  }
}

function showFieldErrors(errors) {
  if (errors) state.fieldErrors = errors;
  const form = $('#settings');
  form.querySelectorAll('.field-error').forEach((e) => { if (e.closest('label')) e.remove(); });
  form.querySelectorAll('[aria-invalid]').forEach((i) => i.removeAttribute('aria-invalid'));
  for (const [name, message] of Object.entries(state.fieldErrors)) {
    const input = form.querySelector(`[name="${CSS.escape(name)}"]`);
    if (!input) continue;
    input.setAttribute('aria-invalid', 'true');
    const span = document.createElement('span');
    span.className = 'field-error';
    span.textContent = message;
    input.after(span);
  }
  const general = Object.entries(state.fieldErrors).filter(([n]) => !form.querySelector(`[name="${CSS.escape(n)}"]`)).map(([, m]) => m);
  form.querySelector(':scope > .field-error').textContent = general.join('; ');
}

// ---- host, run, jobs, packages ------------------------------------------------------------

function renderHost() {
  const h = state.host;
  const chip = $('#host-chip');
  if (!h) return;
  chip.className = `chip ${!h.exists ? 'bad' : h.outdated ? 'warn' : 'good'}`;
  chip.textContent = !h.exists ? 'xrb-host not built' : h.outdated ? 'update available' : `up to date (${ago(h.exeMs)})`;
  chip.title = h.exists && h.staleHostPlugins?.length ? `plugins from an older build sit next to xrb-host.exe (${h.staleHostPlugins.join(', ')}): rebuild to use the workspace's plugins`
    : h.exists && h.outdated ? `xrb-host.exe is older than ${h.newestSource}: ${h.exe}` : `xrb-host.exe: ${h.exe}`;
  // Only a problem is worth a chip: nothing is shown while the host is up to date.
  chip.hidden = h.exists && !h.outdated;
  $('#host-rebuild').hidden = h.exists && !h.outdated;
}

function tile(k, v, cls = '') {
  return `<div class="tile ${cls}"><div class="v">${v}</div><div class="k">${k}</div></div>`;
}

/**
 * The run state as a pill: launching (blue) until the page reports its first frame rate, then
 * running (green); stopping (amber).
 */
function runPill() {
  const r = state.run;
  if (!r || r.phase === 'idle') return '';
  const phase = r.phase === 'stopping' ? 'stopping' : r.phase === 'running' && state.status?.pageFps != null ? 'running' : 'launching';
  return `<span class="run-dot ${phase}" title="${phase}" aria-label="${phase}"></span>`;
}

function renderRun() {
  const r = state.run;
  const s = state.status;
  const running = r && r.phase !== 'idle';
  const warn = $('#run-warning');
  warn.hidden = !r?.warning;
  warn.innerHTML = r?.warning ? esc(r.warning) + (r.foreign ?? []).map((f) => ` <button class="small" data-foreign="${f.pid}">Stop pid ${f.pid}</button>`).join('') : '';
  warn.querySelectorAll('[data-foreign]').forEach((b) => b.addEventListener('click', action(() => api('POST', '/api/run/stop-foreign', { pid: Number(b.dataset.foreign) }))));
  $('#run-metrics').innerHTML = runMetrics(running ? s : null);
  renderStatsDock(running ? s : null);
  renderCameras(running && r.cameraView ? r.channelUrl : null);
  renderRunLog();
}

// ---- Camera view --------------------------------------------------------------------------
// With "Cameras" on, the host streams the input provider's debug images on its channel (e.g.
// per camera the infrared view with the tracker's 2D detections and the colour view). The panel
// connects to the channel like a page would (binary WebSocket, 16-byte header, types 10..17,
// protocol v2: stream, format, label, boxes, pixels; see packages/sdk/src/protocol.ts).
const DEBUG_IMAGE = 10;
const cams = { url: null, ws: null, seen: new Map() };

function renderCameras(url) {
  const box = $('#run-cameras');
  if (!url) {
    if (cams.ws) { cams.ws.close(); cams.ws = null; }
    cams.url = null;
    cams.seen.clear();
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  if (cams.url === url) return;
  cams.url = url;
  cams.seen.clear();
  box.innerHTML = '<div class="cam-note">Waiting for camera frames…</div>';
  if (cams.ws) cams.ws.close();
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  cams.ws = ws;
  ws.onmessage = (e) => { if (cams.ws === ws) drawCameraFrame(e.data); };
  ws.onclose = () => { if (cams.ws === ws) cams.ws = null; };
}

function drawCameraFrame(buffer) {
  if (buffer.byteLength < 28) return;
  const v = new DataView(buffer);
  const type = v.getUint8(0);
  if (type < DEBUG_IMAGE || type >= DEBUG_IMAGE + 8 || v.getUint8(1) < 2) return;
  const p = 16;
  const stream = v.getUint8(p), rgb = v.getUint8(p + 1) === 2, nBoxes = v.getUint8(p + 2), labelLen = v.getUint8(p + 3);
  const w = v.getUint16(p + 4, true), h = v.getUint16(p + 6, true);
  const scale = w ? (v.getUint16(p + 8, true) || w) / w : 1;  // boxes are in full-size pixels
  const bpp = rgb ? 3 : 1;
  if (buffer.byteLength < p + 12 + labelLen) return;
  const label = new TextDecoder().decode(new Uint8Array(buffer, p + 12, labelLen)) || `stream ${stream}`;
  let o = p + 12 + labelLen;
  if (buffer.byteLength < o + nBoxes * 20) return;
  const boxes = [];
  for (let i = 0; i < nBoxes; i++, o += 20) boxes.push([v.getFloat32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true), v.getFloat32(o + 12, true), v.getFloat32(o + 16, true)]);
  if (buffer.byteLength < o + w * h * bpp) return;
  const key = String(stream);
  let slot = cams.seen.get(key);
  if (!slot) {
    const box = $('#run-cameras');
    box.querySelector('.cam-note')?.remove();
    const div = document.createElement('div');
    div.className = 'cam';
    div.style.order = String(stream);
    div.innerHTML = `<canvas width="${w}" height="${h}"></canvas><span class="cam-label"></span>`;
    box.appendChild(div);
    slot = { canvas: div.querySelector('canvas'), label: div.querySelector('.cam-label'), image: null };
    cams.seen.set(key, slot);
  }
  const canvas = slot.canvas;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; slot.image = null; }
  const ctx = canvas.getContext('2d');
  if (!slot.image) slot.image = ctx.createImageData(w, h);
  const px = slot.image.data, src = new Uint8Array(buffer, o, w * h * bpp);
  if (rgb) for (let i = 0, j = 0; i < w * h; i++, j += 3) { px[i * 4] = src[j]; px[i * 4 + 1] = src[j + 1]; px[i * 4 + 2] = src[j + 2]; px[i * 4 + 3] = 255; }
  else for (let i = 0; i < w * h; i++) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = src[i]; px[i * 4 + 3] = 255; }
  ctx.putImageData(slot.image, 0, 0);
  if (boxes.length) {
    ctx.lineWidth = 2;
    ctx.font = '11px sans-serif';
    for (const [x, y, bw, bh, score] of boxes) {
      ctx.strokeStyle = score >= 0.5 ? '#5bd18b' : '#ffb84d';
      ctx.strokeRect(x / scale, y / scale, bw / scale, bh / scale);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillText(score.toFixed(2), x / scale + 3, y / scale - 3);
    }
  }
  slot.label.textContent = `${label}${nBoxes || !rgb ? ` · ${boxes.length} box${boxes.length === 1 ? '' : 'es'}` : ''}`;
}

// The headline figures in the top bar while the Running card is scrolled out of view.
let metricsInView = true;
new IntersectionObserver(([e]) => { metricsInView = e.isIntersecting; renderStatsDock(state.run && state.run.phase !== 'idle' ? state.status : null); },
  { rootMargin: `-${getComputedStyle(document.documentElement).getPropertyValue('--top-h').trim() || '54px'} 0px 0px 0px` })
  .observe($('#run-metrics'));

function renderStatsDock(s) {
  const dock = $('#stats-dock');
  dock.hidden = !s || metricsInView;
  if (dock.hidden) return;
  const fpsCls = s.pageFps == null ? '' : s.pageFps >= 55 ? 'good' : s.pageFps >= 40 ? 'warn' : 'bad';
  const handsOff = s.handState === 'off';
  const handsBad = ['failed', 'device-missing', 'needs-setup'].includes(s.handState);
  const handsCls = handsOff ? '' : handsBad ? 'bad' : s.handState === 'running' ? (s.handsHz >= 45 ? 'good' : 'warn') : '';
  dock.innerHTML = `<span class="stat ${fpsCls}" title="Page frames per second">${num(s.pageFps, 1)}<small>fps</small></span>`
    + `<span class="stat ${handsCls}" title="Hand tracking: ${esc(s.handState ?? '')}">${handsOff ? 'hands off' : `${num(s.handsHz, 0)}<small>Hz</small>`}</span>`;
}

/**
 * Two headline figures (page, hands) and a strip of facts. Always shown: without a running app
 * (or before its first status) every value is "–" and nothing is coloured.
 */
function runMetrics(s) {
  const idle = !s;
  const fpsCls = idle || s.pageFps == null ? '' : s.pageFps >= 55 ? 'good' : s.pageFps >= 40 ? 'warn' : 'bad';
  const handsOff = !idle && s.handState === 'off';
  const handsBad = !idle && ['failed', 'device-missing', 'needs-setup'].includes(s.handState);
  const handsCls = idle || handsOff ? '' : handsBad ? 'bad' : s.handState === 'running' ? (s.handsHz >= 45 ? 'good' : 'warn') : '';
  const v = (x) => (idle ? '–' : x);
  // value, label: one small cell each
  const facts = [
    handsOff ? null : [v(s?.latencyMs != null ? `${num(s.latencyMs, 0)} ms` : '–'), 'latency'],
    handsOff ? null : [v(String(s?.hands)), s?.hands === 1 ? 'hand' : 'hands'],
    [v(s?.eyeW ? `${s.eyeW}×${s.eyeH}` : '–'), 'per eye'],
    [v(String(s?.clients)), s?.clients === 1 ? 'client' : 'clients'],
    [v(dur((s?.uptimeS ?? 0) * 1000)), 'up'],
  ].filter(Boolean);
  return `<div class="metrics ${idle ? 'idle' : ''}">
      <div class="metric ${fpsCls}"><div class="v">${v(num(s?.pageFps, 1))}<small>fps</small></div><div class="k">page · ${v(num(s?.frameMs, 1))} ms per frame</div></div>
      <div class="metric ${handsCls}"><div class="v">${handsOff ? 'off' : v(num(s?.handsHz, 0))}${handsOff ? '' : '<small>Hz</small>'}</div><div class="k">hands · ${esc(idle ? '–' : handsOff ? 'tracking off' : s.handState)}</div></div>
    </div>
    <div class="facts ${idle ? 'idle' : ''}">${facts.map(([val, k]) => `<div><b>${esc(val)}</b><span>${esc(k)}</span></div>`).join('')}</div>`;
}

/**
 * The host log, without the plugins' debug output unless asked for: the host tags those lines
 * "[<plugin> debug]", and the untagged lines that follow one (a multi-line profiling report)
 * belong to it.
 */
/**
 * Log lines -> entries like a game engine's console: one entry per message, the untagged lines after a
 * message (multi-line output such as a tracker's profiling report) belong to it. Recognised:
 *   "   12.345 [host] text"                  host log: seconds since start, source
 *   "[2026-10-09 15:26:46.795] [info] text"  a display runtime: wall clock, level
 *   "[panel] text", "[dev] text"            panel and dev server
 */
function logEntries(lines) {
  const entries = [];
  for (const l of lines) {
    let m;
    if ((m = l.match(/^\s*(\d+\.\d{3}) \[([^\]]+)\] ?(.*)$/))) entries.push({ time: `${m[1]} s`, src: m[2], text: m[3] });
    else if ((m = l.match(/^\[\d{4}-\d\d-\d\d (\d\d:\d\d:\d\d)[.\d]*\] \[(\w+)\] ?(.*)$/))) entries.push({ time: m[1], src: `runtime ${m[2]}`, text: m[3] });
    else if ((m = l.match(/^\[(panel|dev)\] ?(.*)$/))) entries.push({ time: '', src: m[1], text: m[2] });
    // A display runtime's own lines, e.g. "[client][7212][42396] send: keepalive to server"
    else if ((m = l.match(/^\[([A-Za-z][\w-]*)\]((?:\[[^\]]*\])*) ?(.*)$/))) entries.push({ time: '', src: `runtime ${m[1]}`, text: m[3] });
    else if (entries.length) entries[entries.length - 1].text += `\n${l}`;
    else entries.push({ time: '', src: '', text: l });
  }
  // Collapse repeats: the same message right after itself -> one row xN.
  const collapsed = [];
  for (const e of entries) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.src === e.src && prev.text === e.text) {
      prev.count++;
      prev.time = e.time || prev.time;
    } else collapsed.push({ ...e, count: 1 });
  }
  entries.length = 0;
  entries.push(...collapsed);
  for (const e of entries) {
    const s = `${e.src} ${e.text}`;
    e.level = /\b(error|crash|failed|fail:)\b/i.test(s) ? 'err' : /\b(warn|warning)\b/i.test(s) ? 'warn' : 'info';
    e.debug = / debug$/.test(e.src);
    // short source badge: "tracker debug" -> "tracker", "display-runtime 2" -> "display-runtime"
    e.badge = e.src.replace(/ debug$/, '').replace(/\.dll\b.*/, '').replace(/ \d+$/, '');
  }
  return entries;
}

function renderRunLog() {
  const el = $('#run-log');
  const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  const all = logEntries(state.runLog).filter((e) => state.logDebug || !e.debug);
  // Console-style filters: each kind counted (repeats included) and shown or hidden.
  for (const b of document.querySelectorAll('.log-filter[data-level]')) {
    const level = b.dataset.level;
    b.querySelector('.n').textContent = String(all.reduce((n, e) => n + (e.level === level ? e.count : 0), 0));
    b.setAttribute('aria-pressed', String(state.logShow[level]));
  }
  const entries = all.filter((e) => state.logShow[e.level]).slice(-300);
  el.innerHTML = entries.map((e) => `<div class="entry ${e.level}">
      <span class="time">${esc(e.time)}</span>
      <span class="src">${e.badge ? `<span class="badge">${esc(e.badge)}</span>` : ''}</span>
      <span class="msg">${esc(e.text)}${e.count > 1 ? ` <span class="count">×${e.count}</span>` : ''}</span>
    </div>`).join('');
  el.hidden = entries.length === 0;
  $('#log-empty').hidden = entries.length > 0;
  $('#log-empty').textContent = all.length ? 'Nothing to show: the kinds with entries are filtered out.' : 'The host log shows here while an app runs.';
  $('#log-clear').setAttribute('aria-disabled', String(state.runLog.length === 0));  // stays in place: the filters do not move
  if (atEnd) el.scrollTop = el.scrollHeight;
}
$('#log-debug').addEventListener('click', (e) => {
  state.logDebug = !state.logDebug;
  e.currentTarget.setAttribute('aria-pressed', String(state.logDebug));
  renderRunLog();
});
for (const b of document.querySelectorAll('.log-filter[data-level]')) b.addEventListener('click', () => {
  state.logShow[b.dataset.level] = !state.logShow[b.dataset.level];
  localStorage.setItem('panel.logShow', JSON.stringify(state.logShow));
  renderRunLog();
});
$('#log-clear').addEventListener('click', action(async (e) => {
  e.preventDefault();
  if (e.currentTarget.getAttribute('aria-disabled') === 'true') return;
  await api('POST', '/api/run/clear-log');
  state.runLog = [];
  renderRunLog();
}));

/**
 * The one list item every list in the sidebar uses (jobs, built packages): a coloured stripe,
 * a title with a small detail line under it, a value with a note on the right, and optional
 * content below (HTML strings, already escaped by the caller).
 */
function item({ tone = 'accent', title, detail = '', value = '', note = '', body = '' }) {
  return `<div class="item tone-${tone}">
      <span class="stripe"></span>
      <div class="main"><div class="title">${title}</div>${detail ? `<div class="detail">${detail}</div>` : ''}</div>
      <div class="aside">${value ? `<div class="value">${value}</div>` : ''}${note ? `<div class="detail">${note}</div>` : ''}</div>
      ${body ? `<div class="body">${body}</div>` : ''}
    </div>`;
}

function renderJobs() {
  const jobs = [...state.jobs.values()].sort((a, b) => b.id - a.id).slice(0, 12);
  const pill = { running: 'live', done: 'ok', failed: 'err' };
  const tone = { running: 'accent', done: 'ok', failed: 'err' };
  $('#jobs').innerHTML = jobs.length ? jobs.map((j) => item({
    tone: tone[j.state],
    title: esc(j.title),
    detail: j.error ? `<span style="color:var(--err)">${esc(j.error)}</span>` : '',
    value: `<span class="state ${pill[j.state]}">${j.state}</span>`,
    note: dur((j.endedMs ?? Date.now()) - j.startedMs),
    body: `<details ${j.state === 'running' || j.id === state.openJob ? 'open' : ''} data-job="${j.id}"><summary>output</summary>
        <pre class="log">${esc((j.lines ?? []).slice(-200).join('\n'))}</pre></details>`,
  })).join('') : '<div class="empty-note">No jobs yet.</div>';
  $('#jobs-clear').hidden = !jobs.some((j) => j.state !== 'running');
  $('#jobs').querySelectorAll('details').forEach((d) => {
    d.addEventListener('toggle', () => { if (d.open) state.openJob = Number(d.dataset.job); });
    const pre = d.querySelector('pre');
    pre.scrollTop = pre.scrollHeight;
  });
}

let jobsFrame = 0;
const renderJobsSoon = () => { if (!jobsFrame) jobsFrame = requestAnimationFrame(() => { jobsFrame = 0; renderJobs(); }); };

function renderPackages() {
  $('#packages').innerHTML = state.packages.length ? state.packages.map((k) => item({
    tone: k.error ? 'err' : 'accent',
    title: esc(k.id ?? k.file),
    detail: `${esc(k.file)} · ${gb(k.sizeBytes)}${k.error ? ` · ${esc(k.error)}` : ''}`,
    value: `<span class="mono">${esc(k.version ?? '?')}</span>`,
    note: ago(k.builtMs),
  })).join('') : '<div class="empty-note">No packages in the workspace builds/ folder yet.</div>';
}

// ---- icon studio --------------------------------------------------------------------------

const studio = { project: null, helloTimer: 0, nextId: 1, pending: new Map(), paused: false };

/** Pause / play over the big preview; the app holds its animation frames while paused. */
function studioPause(paused) {
  studio.paused = paused;
  const btn = $('#studio-pause');
  btn.setAttribute('aria-pressed', String(paused));
  // No input reaches the app while paused: drags would pile up in its controls and jump on resume.
  btn.closest('.studio-live').classList.toggle('paused', paused);
  btn.title = btn.ariaLabel = paused ? 'Play the animation' : 'Pause the animation';
}

/** The studio's overlay: a spinner while loading, a plain message otherwise, none once the app answers. */
function studioMessage(kind, text = '', withPick = false) {
  const el = $('#studio-msg');
  el.hidden = !kind;
  el.dataset.kind = kind ?? '';
  el.querySelector('.text').textContent = text;
  $('#studio-pick').hidden = !withPick;
}

/** Saves a PNG as the project's icon (Take, or a picked file) and refreshes the thumbnail. */
async function saveStudioIcon(p, png) {
  const updated = await api('PUT', `${projectUrl(p.id)}/icon`, new Blob([png], { type: 'image/png' }));
  $('#studio-current').src = iconSrc(updated);
  await loadProjects();
}

function openStudio(p) {
  const dlg = $('#studio');
  const frame = $('#studio-frame');
  studio.project = p;
  $('#studio-name').textContent = p.manifest?.name ?? p.id;
  $('#studio-current').src = iconSrc(p);
  $('#studio-take').disabled = true;
  $('#studio-pause').hidden = true;
  studioPause(false);
  if (p.entryExists) studioMessage('loading', 'Loading the app…');
  else studioMessage('info', 'The app is not built yet: Build it for the live view, or use a PNG.', true);
  if (p.entryExists) {
    frame.src = `/preview/${p.id}/?xrb-icon=512&interactive`;
    clearTimeout(studio.helloTimer);
    studio.helloTimer = setTimeout(() => {
      // Pages on the SDK (createXrb) always answer; plain pages without it cannot.
      studioMessage('info', 'This page has no live icon view (it does not use createXrb from @xr-build/sdk). Use a PNG instead.', true);
    }, 10000);
  }
  dlg.showModal();
  document.activeElement?.blur();  // no focus ring on the close button right away
}

$('#studio-pause').addEventListener('click', () => {
  studioPause(!studio.paused);
  $('#studio-frame').contentWindow?.postMessage({ type: 'xrb-icon:pause', paused: studio.paused }, location.origin);
});

$('#studio').addEventListener('close', () => {
  clearTimeout(studio.helloTimer);
  $('#studio-frame').src = 'about:blank';
  studio.pending.clear();
});

window.addEventListener('message', (e) => {
  const frame = $('#studio-frame');
  if (e.source !== frame.contentWindow || e.origin !== location.origin) return;
  const m = e.data;
  if (m?.type === 'xrb-icon:hello') {
    clearTimeout(studio.helloTimer);
    studioMessage(null);
    $('#studio-take').disabled = false;
    $('#studio-pause').hidden = !m.canPause;
  } else if (m?.type === 'xrb-icon:png' || m?.type === 'xrb-icon:error') {
    const done = studio.pending.get(m.id);
    studio.pending.delete(m.id);
    done?.(m);
  }
});

$('#studio-take').addEventListener('click', action(async () => {
  const p = studio.project;
  const frame = $('#studio-frame');
  const btn = $('#studio-take');
  btn.disabled = true;
  try {
    const id = studio.nextId++;
    const reply = await new Promise((resolve, reject) => {
      studio.pending.set(id, resolve);
      frame.contentWindow.postMessage({ type: 'xrb-icon:capture', id }, location.origin);
      setTimeout(() => reject(new Error('the app did not answer the capture')), 5000);
    });
    if (reply.type === 'xrb-icon:error') throw new Error(reply.message);
    await saveStudioIcon(p, reply.png);
  } finally {
    btn.disabled = false;
  }
}));

// ---- header -------------------------------------------------------------------------------

$('#host-rebuild').addEventListener('click', action(() => api('POST', '/api/host/rebuild')));
$('#ws-path').addEventListener('click', action(() => api('POST', '/api/workspace/open-folder')));
$('#jobs-clear').addEventListener('click', action(async (e) => {
  e.preventDefault();
  const r = await api('POST', '/api/jobs/clear');
  state.jobs = new Map(r.jobs.map((j) => [j.id, { ...j, lines: state.jobs.get(j.id)?.lines ?? j.lines }]));
  renderJobs();
}));
$('#out-path').addEventListener('click', action(async (e) => { e.preventDefault(); await api('POST', '/api/packages/open-folder'); }));

// ---- live events --------------------------------------------------------------------------

function connect() {
  const es = new EventSource('/api/events');
  const on = (type, fn) => es.addEventListener(type, (e) => fn(JSON.parse(e.data)));
  on('run', (r) => {
    state.run = r;
    if (r.phase === 'idle') state.status = null;
    renderRun();
    renderDetail();
  });
  on('status', (s) => {
    const wasUp = state.status?.pageFps != null;
    state.status = s;
    renderRun();
    // launching -> running: the list and the project header show the run state too.
    if (!wasUp && s.pageFps != null) { renderProjects(); renderDetail(); }
  });
  on('run-log', (text) => {
    state.runLog.push(text);
    if (state.runLog.length > 1000) state.runLog.splice(0, state.runLog.length - 1000);
    renderRunLog();
  });
  on('job', (j) => {
    const prev = state.jobs.get(j.id);
    state.jobs.set(j.id, { ...j, lines: prev?.lines ?? [] });
    renderJobsSoon();
    if (j.state !== 'running' && j.kind === 'host-rebuild') loadHost().catch(report);
  });
  on('job-line', ({ id, text }) => {
    const j = state.jobs.get(id);
    if (!j) return;
    j.lines.push(text);
    if (j.lines.length > 2000) j.lines.splice(0, j.lines.length - 2000);
    renderJobsSoon();
  });
  on('projects-changed', () => {
    loadProjects().catch(report);
    loadPackages().catch(report);
    loadHost().catch(report);
  });
  on('project', () => loadProjects().catch(report));
  es.onerror = () => { /* EventSource reconnects by itself */ };
}

// The workspace path first: links to project files and the out folder need it.
state.repo = (await api('GET', '/api/ping').catch(() => ({}))).workspace ?? '';
$('#out-path').title = `Open ${state.repo ? `${state.repo}\\builds` : 'builds'} in Explorer`;
await loadWorkspace().catch(report);
await Promise.all([loadProjects(), loadPackages(), loadHost(), loadJobs(), loadRun()]).catch(report);
connect();
setInterval(() => { renderProjects(); loadHost().catch(() => {}); }, 30000);

$('#studio-pick').addEventListener('click', () => $('#studio-file').click());
$('#studio-file').addEventListener('change', action(async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) await saveStudioIcon(studio.project, file);
}));

// ---- run dock ------------------------------------------------------------------------------
// The project's Run / Stop, pinned in the top bar while its own button is scrolled away, so a
// run can be stopped (or started) from anywhere on the page. It mirrors the button and clicks it.


function syncRunDock(p) {
  const dock = $('#run-dock');
  const src = $('#act-stop') ?? $('#act-run');
  syncRunDock.observer?.disconnect();
  if (!src) {
    dock.hidden = true;
    return;
  }
  dock.querySelector('img').src = iconSrc(p);
  dock.querySelector('.name').textContent = p.manifest?.name ?? p.id;
  const btn = dock.querySelector('button');
  btn.className = src.className;
  btn.textContent = src.textContent;
  btn.disabled = src.disabled;
  // Hidden while the real button shows below the top bar.
  const top = getComputedStyle(document.documentElement).getPropertyValue('--top-h').trim() || '54px';
  syncRunDock.observer = new IntersectionObserver(([e]) => { dock.hidden = e.isIntersecting; }, { rootMargin: `-${top} 0px 0px 0px` });
  syncRunDock.observer.observe(src);
}
$('#run-dock button').addEventListener('click', () => ($('#act-stop') ?? $('#act-run'))?.click());
