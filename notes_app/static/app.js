/* Notes — client (vanilla JS) */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const CSRF = $('meta[name="csrf-token"]').content;
  const app = $("#app"), editor = $("#editor"), listEl = $("#note-list");
  const mqPhone = matchMedia("(max-width: 700px)"), mqTablet = matchMedia("(max-width: 1024px)");

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem("notes." + k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("notes." + k, JSON.stringify(v)); } catch {} },
  };

  const state = {
    view: store.get("view", "all"),      // all | deleted | folder:<id> | tag:<name>
    mode: store.get("mode", "list"),     // list | gallery
    sidebar: null, notes: [], currentId: null, current: null,
    query: "", saveTimer: null, saving: null, dirty: false,
  };

  // ---------------- API ----------------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: "same-origin", keepalive: method !== "GET",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": CSRF },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) { location.href = "/login"; throw new Error("auth"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  // ---------------- Helpers ----------------
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const parseTs = s => new Date(s);
  const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const DAY = 864e5;

  function shortDate(s) {
    const d = parseTs(s), now = new Date(), diff = (startOfDay(now) - startOfDay(d)) / DAY;
    if (diff === 0) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (diff === 1) return "Yesterday";
    if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
    return d.toLocaleDateString(undefined, { day: "numeric", month: "numeric", year: "2-digit" });
  }
  function longDate(s) {
    const d = parseTs(s);
    return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) +
      " at " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  function groupLabel(note) {
    if (note.pinned && state.view !== "deleted") return "Pinned";
    const d = parseTs(note.updated_at), now = new Date(), diff = (startOfDay(now) - startOfDay(d)) / DAY;
    if (diff <= 0) return "Today";
    if (diff === 1) return "Yesterday";
    if (diff < 7) return "Previous 7 Days";
    if (diff < 30) return "Previous 30 Days";
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: "long" });
    return String(d.getFullYear());
  }
  function highlight(text) {
    let html = esc(text);
    if (!state.query) return html;
    for (const w of state.query.split(/\s+/).filter(Boolean)) {
      const re = new RegExp("(" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
      html = html.replace(/(<[^>]*>)|([^<]+)/g, (m, tag, txt) => tag || txt.replace(re, "<mark>$1</mark>"));
    }
    return html;
  }
  function folderName(id) {
    return state.sidebar?.folders.find(f => f.id === id)?.name ?? "";
  }
  function viewTitle() {
    if (state.view === "all") return "All Notes";
    if (state.view === "deleted") return "Recently Deleted";
    if (state.view.startsWith("tag:")) return "#" + state.view.slice(4);
    return folderName(+state.view.slice(7)) || "Notes";
  }
  const inTrash = () => state.view === "deleted";

  // ---------------- Sidebar ----------------
  async function loadSidebar() {
    state.sidebar = await api("GET", "/api/sidebar");
    if (state.view.startsWith("folder:") && !folderName(+state.view.slice(7))) state.view = "all";
    renderSidebar();
  }

  function sideItem(view, icon, name, count, extra = "") {
    return `<button class="side-item${state.view === view ? " active" : ""}" data-view="${esc(view)}" ${extra}>
      <svg><use href="#${icon}"/></svg><span class="name">${esc(name)}</span><span class="count">${count}</span></button>`;
  }

  function renderSidebar() {
    const s = state.sidebar;
    let html = `<div class="side-section"><div class="side-heading">Notes</div>`;
    html += sideItem("all", "i-all", "All Notes", s.all_count);
    for (const f of s.folders) html += sideItem("folder:" + f.id, "i-folder", f.name, f.count, `data-folder="${f.id}"`);
    if (s.deleted_count) html += sideItem("deleted", "i-trash", "Recently Deleted", s.deleted_count);
    html += `</div>`;
    if (s.tags.length) {
      html += `<div class="side-section"><div class="side-heading">Tags</div>`;
      for (const t of s.tags) html += sideItem("tag:" + t.name, "i-tag", t.name, t.count);
      html += `</div>`;
    }
    $("#sidebar-nav").innerHTML = html;
    $("#list-title").textContent = viewTitle();
  }

  $("#sidebar-nav").addEventListener("click", e => {
    const b = e.target.closest(".side-item");
    if (!b || b.querySelector("input")) return;
    selectView(b.dataset.view);
  });

  async function selectView(view) {
    await flushSave();
    state.view = view; store.set("view", view);
    state.query = ""; $("#search").value = "";
    renderSidebar();
    await loadNotes({ selectFirst: !mqPhone.matches });
    closeDrawer();
    if (mqPhone.matches) setPane("list");
  }

  // Folder context menu (right click / long-press)
  $("#sidebar-nav").addEventListener("contextmenu", e => {
    const b = e.target.closest("[data-folder]");
    if (!b) return;
    e.preventDefault();
    const id = +b.dataset.folder;
    showCtx(e.clientX, e.clientY, [
      ["Rename Folder", () => renameFolderInline(b, id)],
      ["Delete Folder", () => deleteFolder(id), true],
    ]);
  });

  function renameFolderInline(btn, id) {
    const span = btn.querySelector(".name"), old = span.textContent;
    const input = document.createElement("input");
    input.value = old; span.replaceWith(input); input.focus(); input.select();
    let done = false;
    const finish = async ok => {
      if (done) return; done = true;
      const name = input.value.trim();
      if (ok && name && name !== old) await api("PATCH", `/api/folders/${id}`, { name });
      await loadSidebar();
    };
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") finish(true);
      if (e.key === "Escape") finish(false);
      e.stopPropagation();
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", e => e.stopPropagation());
  }

  async function deleteFolder(id) {
    const f = state.sidebar.folders.find(x => x.id === id);
    const ok = await dialog({
      title: `Delete “${f.name}”?`,
      text: f.count ? `Its ${f.count} note${f.count > 1 ? "s" : ""} will be moved to Recently Deleted.` : "This folder is empty.",
      ok: "Delete", danger: true,
    });
    if (!ok) return;
    await api("DELETE", `/api/folders/${id}`);
    if (state.view === "folder:" + id) state.view = "all";
    await loadSidebar(); await loadNotes({ selectFirst: !mqPhone.matches });
  }

  $("#btn-new-folder").addEventListener("click", async () => {
    const name = await dialog({ title: "New Folder", input: "New Folder", ok: "OK" });
    if (!name) return;
    const f = await api("POST", "/api/folders", { name });
    await loadSidebar(); selectView("folder:" + f.id);
  });

  // ---------------- Note list ----------------
  async function loadNotes({ selectFirst = false, keep = true } = {}) {
    const params = new URLSearchParams({ view: state.view });
    if (state.query) params.set("q", state.query);
    const data = await api("GET", "/api/notes?" + params);
    state.notes = data.notes;
    renderList();
    const stillThere = keep && state.notes.some(n => n.id === state.currentId);
    if (stillThere) { highlightSelected(); return; }
    if (selectFirst && state.notes.length) openNote(state.notes[0].id);
    else if (!stillThere) showEmpty();
  }

  function renderList() {
    $("#list-title").textContent = viewTitle();
    $("#list-count").textContent = state.notes.length ? `${state.notes.length} note${state.notes.length > 1 ? "s" : ""}` : "";
    $("#trash-banner").hidden = !(inTrash() && state.notes.length);
    listEl.classList.toggle("gallery", state.mode === "gallery");
    if (!state.notes.length) {
      listEl.innerHTML = `<div class="empty-list">${state.query ? "No Results" : "No Notes"}</div>`;
      return;
    }
    const showFolder = state.sidebar.folders.length > 1 && (state.view === "all" || state.view.startsWith("tag:") || state.query);
    let html = "", last = null;
    for (const n of state.notes) {
      const g = groupLabel(n);
      if (g !== last) { html += `<div class="group-label">${esc(g)}</div>`; last = g; }
      const title = n.title || "New Note";
      const snippet = n.snippet || "No additional text";
      if (state.mode === "gallery") {
        html += `<button class="note-row" data-id="${n.id}" draggable="true" role="option">
          <div class="thumb"><b>${esc(title)}</b>${esc(n.snippet)}</div>
          <div class="t">${n.pinned && !inTrash() ? '<svg><use href="#i-pin-fill"/></svg>' : ""}${highlight(title)}</div>
          <div class="m">${esc(shortDate(n.updated_at))}</div></button>`;
      } else {
        html += `<button class="note-row" data-id="${n.id}" draggable="true" role="option">
          <div class="t">${highlight(title)}</div>
          <div class="m"><span class="d">${esc(shortDate(n.updated_at))}</span>${highlight(snippet)}</div>
          ${showFolder && n.folder_id ? `<div class="f"><svg><use href="#i-folder"/></svg>${esc(folderName(n.folder_id))}</div>` : ""}
        </button>`;
      }
    }
    listEl.innerHTML = html;
    highlightSelected();
  }

  function highlightSelected() {
    $$(".note-row", listEl).forEach(r => {
      const sel = +r.dataset.id === state.currentId;
      r.classList.toggle("selected", sel);
      r.setAttribute("aria-selected", sel);
    });
  }

  listEl.addEventListener("click", e => {
    const row = e.target.closest(".note-row");
    if (row) { listEl.classList.add("focused"); openNote(+row.dataset.id); }
  });
  listEl.addEventListener("contextmenu", e => {
    const row = e.target.closest(".note-row");
    if (!row) return;
    e.preventDefault();
    const id = +row.dataset.id, n = state.notes.find(x => x.id === id);
    openNote(id);
    const items = inTrash()
      ? [["Recover", () => restoreNote(id)], ["Delete Permanently", () => deleteNote(id), true]]
      : [[n.pinned ? "Unpin Note" : "Pin Note", () => togglePin(id)], ["Delete", () => deleteNote(id), true]];
    showCtx(e.clientX, e.clientY, items);
  });
  document.addEventListener("mousedown", e => {
    if (!e.target.closest("#note-list")) listEl.classList.remove("focused");
  });

  // Drag notes onto folders
  listEl.addEventListener("dragstart", e => {
    const row = e.target.closest(".note-row");
    if (!row || inTrash()) { e.preventDefault(); return; }
    e.dataTransfer.setData("text/x-note", row.dataset.id);
    e.dataTransfer.effectAllowed = "move";
  });
  const nav = $("#sidebar-nav");
  nav.addEventListener("dragover", e => {
    const t = e.target.closest("[data-folder]");
    $$(".drop-target", nav).forEach(x => x !== t && x.classList.remove("drop-target"));
    if (t && e.dataTransfer.types.includes("text/x-note")) { e.preventDefault(); t.classList.add("drop-target"); }
  });
  nav.addEventListener("dragleave", e => e.target.closest?.("[data-folder]")?.classList.remove("drop-target"));
  nav.addEventListener("drop", async e => {
    const t = e.target.closest("[data-folder]");
    if (!t) return;
    e.preventDefault(); t.classList.remove("drop-target");
    await moveNote(+e.dataTransfer.getData("text/x-note"), +t.dataset.folder);
  });

  // Keyboard navigation in the list
  document.addEventListener("keydown", e => {
    if (document.activeElement === editor || e.target.closest("input, textarea, .dialog")) return;
    if (!["ArrowDown", "ArrowUp", "Backspace", "Delete"].includes(e.key) || !state.notes.length) return;
    const idx = state.notes.findIndex(n => n.id === state.currentId);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = state.notes[Math.max(0, Math.min(state.notes.length - 1, idx + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) { openNote(next.id); listEl.classList.add("focused"); $(`.note-row[data-id="${next.id}"]`)?.scrollIntoView({ block: "nearest" }); }
    } else if (state.currentId && listEl.classList.contains("focused")) {
      e.preventDefault(); deleteNote(state.currentId);
    }
  });

  // Search
  let searchTimer;
  $("#search").addEventListener("input", e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      await flushSave();
      state.query = e.target.value.trim();
      await loadNotes({ selectFirst: !mqPhone.matches });
    }, 180);
  });

  // View mode
  function setMode(m) {
    state.mode = m; store.set("mode", m);
    $("#btn-view-list").classList.toggle("active", m === "list");
    $("#btn-view-gallery").classList.toggle("active", m === "gallery");
    renderList();
  }
  $("#btn-view-list").addEventListener("click", () => setMode("list"));
  $("#btn-view-gallery").addEventListener("click", () => setMode("gallery"));

  // ---------------- Editor ----------------
  try { document.execCommand("defaultParagraphSeparator", false, "div"); } catch {}

  function showEmpty() {
    state.currentId = null; state.current = null;
    editor.innerHTML = ""; editor.hidden = true;
    $("#note-date").textContent = "";
    $("#empty-state").hidden = false;
    updateToolbar(); highlightSelected();
    if (mqPhone.matches && app.dataset.pane === "editor") setPane("list");
  }

  async function openNote(id, { focus = false } = {}) {
    if (id !== state.currentId) await flushSave();
    const note = await api("GET", `/api/notes/${id}`);
    state.currentId = id; state.current = note;
    editor.hidden = false; $("#empty-state").hidden = true;
    editor.innerHTML = note.body_html || "<h1><br></h1>";
    editor.contentEditable = inTrash() || note.deleted_at ? "false" : "true";
    $("#note-date").textContent = longDate(note.updated_at);
    $("#editor-scroll").scrollTop = 0;
    updateToolbar(); highlightSelected();
    if (mqPhone.matches) { $("#back-label").textContent = viewTitle(); setPane("editor"); }
    if (focus) placeCaretAtEnd();
  }

  function placeCaretAtEnd() {
    editor.focus();
    const r = document.createRange();
    r.selectNodeContents(editor); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }

  function updateToolbar() {
    const has = !!state.current, trash = inTrash() || !!state.current?.deleted_at;
    $("#format-tools").hidden = trash;
    $("#trash-tools").hidden = !(trash && has);
    for (const id of ["btn-format", "btn-checklist", "btn-pin", "btn-more"]) $("#" + id).disabled = !has;
    $("#btn-delete").disabled = !has;
    const pinned = !!state.current?.pinned;
    $("#btn-pin").classList.toggle("active", pinned);
    $("#btn-pin use").setAttribute("href", pinned ? "#i-pin-fill" : "#i-pin");
    $("#btn-pin").title = pinned ? "Unpin note" : "Pin note";
  }

  // Autosave
  const indicator = $("#save-indicator");
  editor.addEventListener("input", () => {
    if (!state.current) return;
    state.dirty = true;
    indicator.textContent = "Editing…";
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(save, 700);
    // live-update title/snippet in the list
    const lines = editor.innerText.split("\n").map(s => s.trim()).filter(Boolean);
    const row = $(`.note-row[data-id="${state.currentId}"]`);
    if (row && state.mode === "list") {
      row.querySelector(".t").textContent = lines[0] || "New Note";
      row.querySelector(".m").innerHTML = `<span class="d">${esc(shortDate(new Date().toISOString()))}</span>${esc(lines.slice(1, 3).join(" ") || "No additional text")}`;
    }
  });

  async function save() {
    clearTimeout(state.saveTimer);
    if (!state.dirty || !state.current) return;
    const id = state.currentId, html = editor.innerHTML;
    state.dirty = false;
    indicator.textContent = "Saving…";
    state.saving = api("PATCH", `/api/notes/${id}`, { body_html: html })
      .then(async n => {
        indicator.textContent = "Saved";
        setTimeout(() => { if (indicator.textContent === "Saved") indicator.textContent = ""; }, 1500);
        if (id === state.currentId) { state.current = { ...state.current, ...n }; $("#note-date").textContent = longDate(n.updated_at); }
        const i = state.notes.findIndex(x => x.id === id);
        if (i >= 0) state.notes[i] = { ...state.notes[i], ...n };
        state.notes.sort((a, b) => (b.pinned - a.pinned) || (b.updated_at.localeCompare(a.updated_at)));
        if (document.activeElement !== editor || i !== 0) renderList();
        await loadSidebar(); // refresh counts and #tags
      })
      .catch(err => { state.dirty = true; indicator.textContent = "Not saved — " + err.message; })
      .finally(() => { state.saving = null; });
    return state.saving;
  }
  async function flushSave() { if (state.dirty) await save(); else if (state.saving) await state.saving; }
  window.addEventListener("beforeunload", e => { if (state.dirty) { save(); e.preventDefault(); } });
  document.addEventListener("visibilitychange", () => { if (document.hidden) save(); });

  // Checklist toggling
  editor.addEventListener("click", e => {
    const li = e.target.closest("ul.checklist > li");
    if (!li || editor.contentEditable === "false") return;
    const rect = li.getBoundingClientRect();
    if (e.clientX - rect.left <= 24) {
      e.preventDefault();
      li.dataset.checked = li.dataset.checked === "true" ? "false" : "true";
      editor.dispatchEvent(new Event("input"));
    }
  });
  editor.addEventListener("mousedown", e => {
    const li = e.target.closest("ul.checklist > li");
    if (li && e.clientX - li.getBoundingClientRect().left <= 24) e.preventDefault(); // keep caret
  });
  editor.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      const li = closestInEditor("li");
      if (li?.parentElement.classList.contains("checklist")) {
        setTimeout(() => { const n = closestInEditor("li"); if (n && n !== li) n.dataset.checked = "false"; });
      }
    }
  });
  // Links: Cmd/Ctrl+click to open
  editor.addEventListener("click", e => {
    const a = e.target.closest("a");
    if (a && (e.metaKey || e.ctrlKey || editor.contentEditable === "false")) { e.preventDefault(); window.open(a.href, "_blank", "noopener"); }
  });

  function closestInEditor(sel) {
    const s = getSelection();
    if (!s.rangeCount) return null;
    let n = s.anchorNode;
    if (n?.nodeType === 3) n = n.parentElement;
    const el = n?.closest?.(sel);
    return el && editor.contains(el) ? el : null;
  }

  // Formatting
  function ensureFocus() { if (!editor.contains(getSelection().anchorNode)) placeCaretAtEnd(); }
  function exec(cmd, val = null) { ensureFocus(); document.execCommand(cmd, false, val); editor.dispatchEvent(new Event("input")); }

  function setBlock(tag) {
    ensureFocus();
    const li = closestInEditor("li");
    if (li) { // leave list first
      const list = li.parentElement;
      document.execCommand(list.tagName === "OL" ? "insertOrderedList" : "insertUnorderedList");
    }
    document.execCommand("formatBlock", false, tag === "div" ? "div" : tag);
    editor.dispatchEvent(new Event("input"));
  }

  function setList(kind) {
    ensureFocus();
    const cur = closestInEditor("ul, ol");
    const curKind = !cur ? null : cur.tagName === "OL" ? "ol" : cur.classList.contains("checklist") ? "checklist" : cur.classList.contains("dashed") ? "dashed" : "ul";
    if (curKind === kind) { // toggle off
      document.execCommand(cur.tagName === "OL" ? "insertOrderedList" : "insertUnorderedList");
      editor.dispatchEvent(new Event("input")); return;
    }
    const block = closestInEditor("h1, h2, h3, pre, blockquote");
    if (block) document.execCommand("formatBlock", false, "div");
    if (curKind && (curKind === "ol") !== (kind === "ol")) {
      document.execCommand(kind === "ol" ? "insertOrderedList" : "insertUnorderedList");
    } else if (!curKind) {
      document.execCommand(kind === "ol" ? "insertOrderedList" : "insertUnorderedList");
    }
    const list = closestInEditor("ul, ol");
    if (list && kind !== "ol") {
      list.classList.remove("checklist", "dashed");
      if (kind === "checklist" || kind === "dashed") list.classList.add(kind);
      if (!list.className) list.removeAttribute("class");
      $$(":scope > li", list).forEach(li => {
        if (kind === "checklist") li.dataset.checked ||= "false"; else li.removeAttribute("data-checked");
      });
    }
    editor.dispatchEvent(new Event("input"));
  }

  const formatMenu = $("#format-menu"), moreMenu = $("#more-menu");
  let savedRange = null;
  function toggleMenu(menu, btn) {
    const open = menu.hidden;
    closeMenus();
    if (open) {
      const s = getSelection();
      savedRange = s.rangeCount && editor.contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null;
      menu.hidden = false; btn.classList.add("active");
    }
  }
  function restoreRange() {
    if (!savedRange) return;
    editor.focus();
    const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange);
  }
  function closeMenus() {
    formatMenu.hidden = moreMenu.hidden = true; $("#ctx-menu").hidden = true;
    $("#btn-format").classList.remove("active"); $("#btn-more").classList.remove("active");
  }
  $("#btn-format").addEventListener("mousedown", e => e.preventDefault());
  $("#btn-format").addEventListener("click", e => { e.stopPropagation(); toggleMenu(formatMenu, e.currentTarget); });
  formatMenu.addEventListener("mousedown", e => e.preventDefault());
  formatMenu.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    restoreRange();
    if (b.dataset.block) setBlock(b.dataset.block);
    else if (b.dataset.list) setList(b.dataset.list);
    else if (b.dataset.cmd) exec(b.dataset.cmd);
    closeMenus();
  });
  $("#btn-checklist").addEventListener("mousedown", e => e.preventDefault());
  $("#btn-checklist").addEventListener("click", () => setList("checklist"));
  $("#btn-more").addEventListener("click", e => {
    e.stopPropagation();
    $("#move-list").innerHTML = state.sidebar.folders.map(f =>
      `<button data-move="${f.id}"${f.id === state.current?.folder_id ? ' disabled style="opacity:.45"' : ""}><svg><use href="#i-folder"/></svg>${esc(f.name)}</button>`).join("");
    toggleMenu(moreMenu, e.currentTarget);
  });
  moreMenu.addEventListener("click", e => {
    const b = e.target.closest("[data-move]");
    if (b) { moveNote(state.currentId, +b.dataset.move); closeMenus(); }
  });
  $("#btn-delete-2").addEventListener("click", () => { closeMenus(); deleteNote(state.currentId); });
  document.addEventListener("click", e => { if (!e.target.closest(".menu, .menu-anchor")) closeMenus(); });

  // Paste: keep simple structure, strip foreign styling
  const OK_TAGS = new Set(["P","DIV","BR","B","STRONG","I","EM","U","S","STRIKE","H1","H2","H3","UL","OL","LI","PRE","CODE","BLOCKQUOTE","A"]);
  function cleanNode(node) {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 1) {
        if (["SCRIPT","STYLE","META","LINK","TITLE"].includes(child.tagName)) { child.remove(); continue; }
        cleanNode(child);
        if (!OK_TAGS.has(child.tagName)) { child.replaceWith(...child.childNodes); continue; }
        for (const a of [...child.attributes]) if (!(child.tagName === "A" && a.name === "href")) child.removeAttribute(a.name);
      } else if (child.nodeType === 8) child.remove();
    }
  }
  editor.addEventListener("paste", e => {
    const html = e.clipboardData.getData("text/html");
    if (!html) return;
    e.preventDefault();
    const doc = new DOMParser().parseFromString(html, "text/html");
    cleanNode(doc.body);
    document.execCommand("insertHTML", false, doc.body.innerHTML);
  });

  // ---------------- Note actions ----------------
  async function newNote() {
    await flushSave();
    let folder_id = state.view.startsWith("folder:") ? +state.view.slice(7) : null;
    if (inTrash() || state.view.startsWith("tag:")) { state.view = "all"; store.set("view", "all"); }
    state.query = ""; $("#search").value = "";
    const n = await api("POST", "/api/notes", { folder_id });
    await loadSidebar();
    await loadNotes({ keep: false });
    await openNote(n.id);
    editor.innerHTML = "<h1><br></h1>";
    placeCaretAtEnd();
  }
  $("#btn-new").addEventListener("click", newNote);
  $("#btn-new-mobile").addEventListener("click", newNote);

  async function deleteNote(id) {
    if (!id) return;
    if (id === state.currentId) { clearTimeout(state.saveTimer); state.dirty = false; if (state.saving) await state.saving; }
    const n = state.notes.find(x => x.id === id);
    if (inTrash() || n?.deleted_at) {
      const ok = await dialog({ title: "Delete this note permanently?", text: "You can’t undo this action.", ok: "Delete", danger: true });
      if (!ok) return;
    }
    const idx = state.notes.findIndex(x => x.id === id);
    await api("DELETE", `/api/notes/${id}`);
    state.notes.splice(idx, 1);
    renderList();
    await loadSidebar();
    if (id === state.currentId) {
      const next = state.notes[Math.min(idx, state.notes.length - 1)];
      if (next && !mqPhone.matches) openNote(next.id); else showEmpty();
    }
  }
  $("#btn-delete").addEventListener("click", () => deleteNote(state.currentId));

  async function restoreNote(id) {
    await api("POST", `/api/notes/${id}/restore`);
    await loadSidebar(); await loadNotes({ keep: false, selectFirst: !mqPhone.matches });
  }
  $("#btn-restore").addEventListener("click", () => restoreNote(state.currentId));
  $("#btn-empty-trash").addEventListener("click", async () => {
    const ok = await dialog({ title: "Delete all notes in Recently Deleted?", text: "You can’t undo this action.", ok: "Delete All", danger: true });
    if (!ok) return;
    await api("DELETE", "/api/trash");
    await loadSidebar(); await loadNotes();
  });

  async function togglePin(id) {
    await flushSave();
    const n = state.notes.find(x => x.id === id) || state.current;
    const res = await api("PATCH", `/api/notes/${id}`, { pinned: !n.pinned });
    if (state.current?.id === id) state.current.pinned = res.pinned;
    await loadNotes(); updateToolbar();
  }
  $("#btn-pin").addEventListener("click", () => state.currentId && togglePin(state.currentId));

  async function moveNote(id, folderId) {
    await flushSave();
    await api("PATCH", `/api/notes/${id}`, { folder_id: folderId });
    if (state.current?.id === id) state.current.folder_id = folderId;
    await loadSidebar(); await loadNotes({ selectFirst: !mqPhone.matches });
  }

  // ---------------- Context menu & dialog ----------------
  function showCtx(x, y, items) {
    const m = $("#ctx-menu");
    m.innerHTML = "";
    for (const [label, fn, danger] of items) {
      const b = document.createElement("button");
      b.textContent = label; if (danger) b.className = "danger";
      b.onclick = () => { m.hidden = true; fn(); };
      m.appendChild(b);
    }
    m.hidden = false;
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
    m.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
  }

  function dialog({ title, text, input, ok = "OK", danger = false }) {
    return new Promise(resolve => {
      const d = $("#dialog"), form = $("#dialog-form"), inp = $("#dialog-input");
      $("#dialog-title").textContent = title;
      $("#dialog-text").hidden = !text; $("#dialog-text").textContent = text || "";
      inp.hidden = input === undefined; inp.value = input || "";
      $("#dialog-ok").textContent = ok; $("#dialog-ok").classList.toggle("danger", danger);
      d.hidden = false;
      setTimeout(() => (input !== undefined ? (inp.focus(), inp.select()) : $("#dialog-ok").focus()));
      const done = v => { d.hidden = true; form.onsubmit = null; $("#dialog-cancel").onclick = null; d.onkeydown = null; resolve(v); };
      form.onsubmit = e => { e.preventDefault(); done(input !== undefined ? inp.value.trim() : true); };
      $("#dialog-cancel").onclick = () => done(null);
      d.onkeydown = e => { if (e.key === "Escape") done(null); };
    });
  }

  // ---------------- Layout / navigation ----------------
  function setPane(p) { app.dataset.pane = p; }
  function closeDrawer() { app.classList.remove("drawer-open"); }
  $("#btn-sidebar").addEventListener("click", () => {
    if (mqTablet.matches) app.classList.toggle("drawer-open");
    else { app.classList.toggle("sidebar-hidden"); store.set("sidebarHidden", app.classList.contains("sidebar-hidden")); }
  });
  $("#btn-sidebar-close").addEventListener("click", () => {
    if (mqTablet.matches) closeDrawer();
    else { app.classList.add("sidebar-hidden"); store.set("sidebarHidden", true); }
  });
  $("#scrim").addEventListener("click", closeDrawer);
  $("#btn-list-back").addEventListener("click", () => setPane("sidebar"));
  $("#btn-editor-back").addEventListener("click", async () => {
    await flushSave(); editor.blur(); setPane("list");
    await loadNotes();
  });
  if (store.get("sidebarHidden", false)) app.classList.add("sidebar-hidden");

  // ---------------- Shortcuts (macOS Notes–style) ----------------
  document.addEventListener("keydown", e => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) { if (e.key === "Escape") closeMenus(); return; }
    const k = e.key.toLowerCase();
    if (e.altKey && (k === "n" || e.code === "KeyN")) { e.preventDefault(); newNote(); return; }
    if (e.altKey && e.code === "KeyF") { e.preventDefault(); $("#search").focus(); return; }
    if (document.activeElement !== editor) return;
    if (e.shiftKey) {
      const map = { KeyT: () => setBlock("h1"), KeyH: () => setBlock("h2"), KeyJ: () => setBlock("h3"),
                    KeyB: () => setBlock("div"), KeyM: () => setBlock("pre"), KeyL: () => setList("checklist"),
                    Digit7: () => setList("ol"), Digit8: () => setList("ul") };
      if (map[e.code]) { e.preventDefault(); map[e.code](); }
    } else if (k === "s") { e.preventDefault(); save(); }
  });

  // ---------------- Theme (auto / light / warm / dark) ----------------
  const THEME_BAR = { light: "#f5f5f7", warm: "#efe7d8", dark: "#161617" };
  function markTheme(t) {
    $$(".theme-opt").forEach(b => {
      const on = b.dataset.theme === t;
      b.classList.toggle("active", on); b.setAttribute("aria-checked", on);
    });
  }
  function applyTheme(t) {
    const root = document.documentElement;
    root.classList.add("theme-anim");
    root.dataset.theme = t;
    setTimeout(() => root.classList.remove("theme-anim"), 300);
    $$('meta[name="theme-color"]').forEach(m => m.remove());
    const add = (c, media) => { const m = document.createElement("meta"); m.name = "theme-color"; m.content = c; if (media) m.media = media; document.head.appendChild(m); };
    if (t === "auto") { add(THEME_BAR.light, "(prefers-color-scheme: light)"); add(THEME_BAR.dark, "(prefers-color-scheme: dark)"); }
    else add(THEME_BAR[t]);
    markTheme(t);
  }
  $("#theme-picker").addEventListener("click", async e => {
    const b = e.target.closest(".theme-opt");
    if (!b) return;
    const prev = document.documentElement.dataset.theme, t = b.dataset.theme;
    applyTheme(t);
    try { await api("PATCH", "/api/settings", { theme: t }); }
    catch (err) { applyTheme(prev); indicator.textContent = "Theme not saved — " + err.message; }
  });
  markTheme(document.documentElement.dataset.theme || "auto");

  // ---------------- Boot ----------------
  (async () => {
    setMode(state.mode);
    await loadSidebar();
    if (mqPhone.matches) setPane("list");
    await loadNotes({ selectFirst: !mqPhone.matches });
  })().catch(err => console.error(err));
})();
