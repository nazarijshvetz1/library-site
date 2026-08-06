const config = window.LIBRARY_CONFIG && typeof window.LIBRARY_CONFIG === "object" ? window.LIBRARY_CONFIG : {};
const balanceData = window.BALANCE_DATA && typeof window.BALANCE_DATA === "object" ? window.BALANCE_DATA : {};
const collator = new Intl.Collator("uk", { sensitivity: "base", numeric: true });
const state = { search: "", grade: "", rubric: "", subject: "", type: "", available: false, sort: "recommended", limit: 18 };
const emptyStock = () => ({ total: 0, library: 0, other: 0, locations: [] });

let materials = [];
let syncPromise = null;

const elements = {
  grid: document.querySelector("#materialGrid"), count: document.querySelector("#resultsCount"), empty: document.querySelector("#emptyState"),
  loadMore: document.querySelector("#loadMore"), search: document.querySelector("#heroSearch"), grade: document.querySelector("#gradeFilter"),
  rubric: document.querySelector("#rubricFilter"), subject: document.querySelector("#subjectFilter"), type: document.querySelector("#typeFilter"),
  available: document.querySelector("#availableFilter"), sort: document.querySelector("#sortSelect"), chips: document.querySelector("#activeFilters"),
  dialog: document.querySelector("#materialDialog"), dialogContent: document.querySelector("#dialogContent"), toast: document.querySelector("#toast"),
  filters: document.querySelector("#filters"), filterToggle: document.querySelector("#filterToggle"),
  materialStat: document.querySelector("#materialStat"), copiesStat: document.querySelector("#copiesStat"),
  locationsStat: document.querySelector("#locationsStat"), rubricsStat: document.querySelector("#rubricsStat"),
  dataSync: document.querySelector("#dataSync"), dataSyncText: document.querySelector("#dataSyncText"), syncRetry: document.querySelector("#syncRetry"),
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" })[character]);
const normalized = (value) => String(value || "").toLocaleLowerCase("uk").replace(/[’`]/g, "'").trim();
const cleanText = (value, maximum = 500) => String(value ?? "").trim().slice(0, maximum);
const nonNegativeInteger = (value) => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 0 ? number : 0;
};
const gradeNumber = (value) => {
  const number = nonNegativeInteger(value);
  return number >= 1 && number <= 11 ? number : 0;
};

function safeCoverUrl(value) {
  const url = cleanText(value, 1000);
  return /^https:\/\/raw\.githubusercontent\.com\/nazarijshvetz1\/library-covers\/main\/covers\/CAT-\d{4,}\.jpg(?:\?.*)?$/i.test(url) ? url : "";
}

function normalizeStock(rawStock, quantityHint) {
  const source = rawStock && typeof rawStock === "object" ? rawStock : {};
  const locations = Array.isArray(source.locations) ? source.locations.map((location) => ({
    name: cleanText(location && location.name, 160),
    quantity: nonNegativeInteger(location && location.quantity),
  })).filter((location) => location.name && location.quantity > 0).slice(0, 100) : [];
  const total = nonNegativeInteger(source.total ?? quantityHint);
  const library = Math.min(total, nonNegativeInteger(source.library));
  const other = Math.min(total, nonNegativeInteger(source.other));
  return { total, library, other, locations };
}

function normalizeMaterial(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanText(raw.id, 24).toUpperCase();
  const title = cleanText(raw.title, 500);
  if (!/^CAT-\d{4,}$/.test(id) || !title) return null;
  const stock = normalizeStock(raw.stock, raw.quantity);
  const classFrom = gradeNumber(raw.classFrom);
  return {
    id,
    rubric: cleanText(raw.rubric, 180) || "Без рубрики",
    type: cleanText(raw.type, 180) || "Не зазначено",
    subject: cleanText(raw.subject, 180) || "Не зазначено",
    classFrom,
    classTo: gradeNumber(raw.classTo) || classFrom,
    title,
    author: cleanText(raw.author, 300),
    year: nonNegativeInteger(raw.year) || "",
    cover: safeCoverUrl(raw.cover),
    quantity: stock.total,
    stock,
  };
}

function localSnapshot() {
  return (Array.isArray(window.CATALOG_DATA) ? window.CATALOG_DATA : []).map((item) => {
    const stock = balanceData[item.id] || emptyStock();
    return normalizeMaterial({ ...item, quantity: stock.total, stock });
  }).filter(Boolean);
}

function datasetStats(items, supplied = {}) {
  const locations = new Set();
  const rubrics = new Set();
  let copies = 0;
  items.forEach((item) => {
    copies += item.quantity;
    rubrics.add(item.rubric);
    item.stock.locations.forEach((location) => locations.add(location.name));
  });
  return {
    materials: items.length,
    copies,
    locations: nonNegativeInteger(supplied.locations) || locations.size,
    rubrics: nonNegativeInteger(supplied.rubrics) || rubrics.size,
  };
}

function normalizePayload(payload) {
  if (!payload || payload.success === false || Number(payload.schemaVersion) !== 1 || !Array.isArray(payload.materials)) {
    throw new Error("Некоректна відповідь каталогу");
  }
  const items = payload.materials.map(normalizeMaterial).filter(Boolean);
  const reportedCount = nonNegativeInteger(payload.stats && payload.stats.materials);
  if (!items.length || (reportedCount && reportedCount !== items.length)) throw new Error("Отримано неповний каталог");
  return { materials: items, stats: datasetStats(items, payload.stats), generatedAt: cleanText(payload.generatedAt, 60) };
}

function classLabel(item) {
  if (!item.classFrom) return "Клас не зазначено";
  if (item.classFrom === item.classTo) return `${item.classFrom} клас`;
  return `${item.classFrom}–${item.classTo} класи`;
}

function fillSelect(select, values) {
  values.filter(Boolean).sort(collator.compare).forEach((value) => {
    const option = document.createElement("option"); option.value = value; option.textContent = value; select.append(option);
  });
}

function refreshSelect(select, values, stateKey) {
  while (select.options.length > 1) select.remove(1);
  fillSelect(select, [...new Set(values)]);
  if ([...select.options].some((option) => option.value === state[stateKey])) select.value = state[stateKey];
  else { state[stateKey] = ""; select.value = ""; }
}

function updateFiltersAndStats(stats) {
  refreshSelect(elements.rubric, materials.map((item) => item.rubric), "rubric");
  refreshSelect(elements.subject, materials.map((item) => item.subject), "subject");
  refreshSelect(elements.type, materials.map((item) => item.type), "type");
  elements.materialStat.textContent = stats.materials.toLocaleString("uk-UA");
  elements.copiesStat.textContent = stats.copies.toLocaleString("uk-UA");
  elements.locationsStat.textContent = stats.locations.toLocaleString("uk-UA");
  elements.rubricsStat.textContent = stats.rubrics.toLocaleString("uk-UA");
}

function applyDataset(nextMaterials, suppliedStats) {
  materials = nextMaterials;
  updateFiltersAndStats(datasetStats(materials, suppliedStats));
  state.limit = 18;
  render();
}

function filteredMaterials() {
  const query = normalized(state.search); const grade = Number(state.grade);
  const result = materials.filter((item) => {
    if (query && !normalized([item.title, item.author, item.subject, item.type, item.rubric, item.id].join(" ")).includes(query)) return false;
    if (grade && !(Number(item.classFrom) <= grade && Number(item.classTo || item.classFrom) >= grade)) return false;
    if (state.rubric && item.rubric !== state.rubric) return false;
    if (state.subject && item.subject !== state.subject) return false;
    if (state.type && item.type !== state.type) return false;
    if (state.available && Number(item.quantity) <= 0) return false;
    return true;
  });
  if (state.sort === "title") result.sort((a, b) => collator.compare(a.title, b.title));
  if (state.sort === "grade") result.sort((a, b) => (a.classFrom || 99) - (b.classFrom || 99) || collator.compare(a.title, b.title));
  if (state.sort === "quantity") result.sort((a, b) => b.quantity - a.quantity || collator.compare(a.title, b.title));
  return result;
}

function coverMarkup(item, large = false) {
  const fallback = `<div class="cover-fallback"><span>${escapeHtml(item.subject)}</span></div>`;
  if (!item.cover) return fallback;
  return `<img data-cover src="${escapeHtml(item.cover)}" alt="Обкладинка: ${escapeHtml(item.title)}" loading="${large ? "eager" : "lazy"}"><div class="cover-fallback" hidden><span>${escapeHtml(item.subject)}</span></div>`;
}

function bindCoverErrors(root) {
  root.querySelectorAll("img[data-cover]").forEach((image) => image.addEventListener("error", () => {
    image.hidden = true;
    if (image.nextElementSibling) image.nextElementSibling.hidden = false;
  }, { once: true }));
}

function cardMarkup(item) {
  const available = Number(item.quantity) > 0;
  return `<article class="material-card"><div class="cover-wrap"><span class="class-badge">${escapeHtml(classLabel(item))}</span>${coverMarkup(item)}</div><div class="card-body">
    <div class="card-kicker"><span>${escapeHtml(item.subject)}</span><span class="availability ${available ? "" : "none"}">${available ? "У наявності" : "Немає"}</span></div>
    <h3>${escapeHtml(item.title)}</h3><p class="author-line">${escapeHtml(item.author)}${item.year ? ` · ${escapeHtml(item.year)}` : ""}</p>
    <div class="card-footer"><span class="quantity"><strong>${escapeHtml(item.quantity)}</strong><span>примірників</span></span><button class="details-button" type="button" data-details="${escapeHtml(item.id)}">Детальніше →</button></div>
  </div></article>`;
}

function renderChips() {
  const chips = [["search", state.search ? `Пошук: ${state.search}` : ""], ["grade", state.grade ? `${state.grade} клас` : ""], ["rubric", state.rubric], ["subject", state.subject], ["type", state.type], ["available", state.available ? "Лише в наявності" : ""]].filter(([, label]) => label);
  elements.chips.innerHTML = chips.map(([key, label]) => `<span class="filter-chip">${escapeHtml(label)}<button type="button" data-remove="${key}" aria-label="Прибрати фільтр ${escapeHtml(label)}">×</button></span>`).join("");
}

function render() {
  const result = filteredMaterials(); const shown = result.slice(0, state.limit);
  elements.grid.innerHTML = shown.map(cardMarkup).join("");
  bindCoverErrors(elements.grid);
  elements.count.innerHTML = `Знайдено <strong>${result.length.toLocaleString("uk-UA")}</strong> матеріалів`;
  elements.empty.hidden = result.length !== 0; elements.grid.hidden = result.length === 0; elements.loadMore.hidden = result.length <= state.limit; renderChips();
}

function resetLimitAndRender() { state.limit = 18; render(); }
function clearFilters() {
  Object.assign(state, { search: "", grade: "", rubric: "", subject: "", type: "", available: false, limit: 18 });
  elements.search.value = ""; elements.grade.value = ""; elements.rubric.value = ""; elements.subject.value = ""; elements.type.value = ""; elements.available.checked = false; render();
}

function stockMarkup(item) {
  const locations = Array.isArray(item.stock.locations) ? item.stock.locations : [];
  const locationMarkup = locations.length
    ? `<ul class="location-list">${locations.map((location) => `<li class="stock-location"><i></i><span>${escapeHtml(location.name)}</span><strong>${escapeHtml(location.quantity)}</strong></li>`).join("")}</ul>`
    : `<p class="stock-empty">Наразі доступних примірників немає.</p>`;
  return `<div class="stock-box">
    <div class="stock-summary">
      <div class="stock-total"><span>Усього</span><strong>${escapeHtml(item.stock.total)}</strong></div>
      <div class="stock-total"><span>У бібліотеці</span><strong>${escapeHtml(item.stock.library)}</strong></div>
      <div class="stock-total"><span>В інших кабінетах</span><strong>${escapeHtml(item.stock.other)}</strong></div>
    </div>${locationMarkup}
  </div>`;
}

function showMaterial(id) {
  const item = materials.find((material) => material.id === id); if (!item) return;
  elements.dialogContent.innerHTML = `<div class="dialog-layout"><div class="dialog-cover">${coverMarkup(item, true)}</div><div class="dialog-copy">
    <p class="dialog-id">${escapeHtml(item.id)} · ${escapeHtml(item.rubric)}</p><h2>${escapeHtml(item.title)}</h2>
    <p class="dialog-meta">${escapeHtml(item.author)}${item.year ? ` · ${escapeHtml(item.year)} рік` : ""}</p>
    <div class="dialog-tags"><span>${escapeHtml(classLabel(item))}</span><span>${escapeHtml(item.subject)}</span><span>${escapeHtml(item.type)}</span></div>
    ${stockMarkup(item)}
    <p class="dialog-note">Це безпечна версія для перегляду. Вона не змінює дані у службовій таблиці.</p>
  </div></div>`;
  bindCoverErrors(elements.dialogContent);
  elements.dialog.showModal();
}

function setSyncStatus(status, message, retry = false) {
  elements.dataSync.dataset.state = status;
  elements.dataSyncText.textContent = message;
  elements.syncRetry.hidden = !retry;
}

function validApiUrl(value) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(String(value || "").trim());
}

async function fetchPayload(apiUrl) {
  const url = new URL(apiUrl);
  url.searchParams.set("client", "library-site");
  const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function jsonpPayload(apiUrl) {
  return new Promise((resolve, reject) => {
    const callback = `libraryCatalogCallback_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement("script");
    const url = new URL(apiUrl);
    url.searchParams.set("callback", callback);
    url.searchParams.set("client", "library-site");
    const cleanup = () => { delete window[callback]; script.remove(); };
    const timer = window.setTimeout(() => { cleanup(); reject(new Error("Перевищено час очікування")); }, 15000);
    window[callback] = (payload) => { window.clearTimeout(timer); cleanup(); resolve(payload); };
    script.onerror = () => { window.clearTimeout(timer); cleanup(); reject(new Error("Не вдалося підключитися")); };
    script.src = url.toString();
    script.async = true;
    document.head.append(script);
  });
}

async function requestLivePayload(apiUrl) {
  try { return await fetchPayload(apiUrl); }
  catch (fetchError) { return jsonpPayload(apiUrl); }
}

function formattedUpdatedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "щойно";
  return date.toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" });
}

async function synchronizeCatalog() {
  const apiUrl = String(config.apiUrl || "").trim();
  if (!validApiUrl(apiUrl)) {
    setSyncStatus("snapshot", "Показано перевірену копію бази");
    return;
  }
  if (syncPromise) return syncPromise;
  setSyncStatus("loading", "Оновлюємо дані з Google Sheets…");
  syncPromise = requestLivePayload(apiUrl).then((payload) => {
    const live = normalizePayload(payload);
    applyDataset(live.materials, live.stats);
    setSyncStatus("live", `Оновлено з Google Sheets · ${formattedUpdatedAt(live.generatedAt)}`);
  }).catch(() => {
    setSyncStatus("error", "Google Sheets тимчасово недоступна — показано перевірену копію", true);
  }).finally(() => { syncPromise = null; });
  return syncPromise;
}

let toastTimer;
function showToast(message) { clearTimeout(toastTimer); elements.toast.textContent = message; elements.toast.classList.add("show"); toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3500); }

for (let grade = 1; grade <= 11; grade += 1) {
  const option = document.createElement("option"); option.value = String(grade); option.textContent = `${grade} клас`; elements.grade.append(option);
}

document.querySelector("#heroSearchForm").addEventListener("submit", (event) => { event.preventDefault(); state.search = elements.search.value; resetLimitAndRender(); document.querySelector("#catalog").scrollIntoView({ behavior: "smooth" }); });
elements.search.addEventListener("input", () => { state.search = elements.search.value; resetLimitAndRender(); });
elements.grade.addEventListener("change", () => { state.grade = elements.grade.value; resetLimitAndRender(); });
elements.rubric.addEventListener("change", () => { state.rubric = elements.rubric.value; resetLimitAndRender(); });
elements.subject.addEventListener("change", () => { state.subject = elements.subject.value; resetLimitAndRender(); });
elements.type.addEventListener("change", () => { state.type = elements.type.value; resetLimitAndRender(); });
elements.available.addEventListener("change", () => { state.available = elements.available.checked; resetLimitAndRender(); });
elements.sort.addEventListener("change", () => { state.sort = elements.sort.value; render(); });
elements.loadMore.addEventListener("click", () => { state.limit += 18; render(); });
elements.syncRetry.addEventListener("click", synchronizeCatalog);
document.querySelector("#clearFilters").addEventListener("click", clearFilters); document.querySelector("[data-clear]").addEventListener("click", clearFilters);

document.addEventListener("click", (event) => {
  const detail = event.target.closest("[data-details]"); if (detail) showMaterial(detail.dataset.details);
  const quick = event.target.closest("[data-quick]");
  if (quick) {
    const value = quick.dataset.quick;
    if (/^\d+$/.test(value)) { state.grade = value; elements.grade.value = value; }
    else if ([...elements.rubric.options].some((option) => option.value === value)) { state.rubric = value; elements.rubric.value = value; }
    else { state.search = value; elements.search.value = value; }
    resetLimitAndRender(); document.querySelector("#catalog").scrollIntoView({ behavior: "smooth" });
  }
  const remove = event.target.closest("[data-remove]");
  if (remove) {
    const key = remove.dataset.remove; state[key] = key === "available" ? false : "";
    if (key === "search") elements.search.value = ""; else if (elements[key]) elements[key].value = "";
    if (key === "available") elements.available.checked = false; resetLimitAndRender();
  }
});

document.querySelector(".dialog-close").addEventListener("click", () => elements.dialog.close());
elements.dialog.addEventListener("click", (event) => { if (event.target === elements.dialog) elements.dialog.close(); });
document.querySelector("#librarianButton").addEventListener("click", () => showToast("Режим бібліотекаря підключимо на наступному етапі після затвердження каталогу."));
elements.filterToggle.addEventListener("click", () => { const open = elements.filters.classList.toggle("open"); elements.filterToggle.setAttribute("aria-expanded", String(open)); });

const snapshot = localSnapshot();
applyDataset(snapshot, { locations: 13 });
synchronizeCatalog();
const refreshMinutes = Math.min(60, Math.max(5, nonNegativeInteger(config.refreshMinutes) || 10));
if (validApiUrl(config.apiUrl)) window.setInterval(synchronizeCatalog, refreshMinutes * 60 * 1000);
