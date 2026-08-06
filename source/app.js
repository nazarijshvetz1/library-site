const CATALOG_ID_PATTERN = /^CAT-(\d{4,})$/;

export function normalizeCatalogId(value) {
  const candidate = String(value || "").trim().toUpperCase();
  return CATALOG_ID_PATTERN.test(candidate) ? candidate : "";
}

export function catalogIdNumber(value) {
  const normalized = normalizeCatalogId(typeof value === "object" && value ? value.id : value);
  const match = normalized.match(CATALOG_ID_PATTERN);
  return match ? Number(match[1]) : -1;
}

export function materialIdFromUrl(value) {
  try {
    return normalizeCatalogId(new URL(String(value), "https://catalog.invalid/").searchParams.get("material"));
  } catch {
    return "";
  }
}

export function urlWithMaterial(value, materialId) {
  const url = new URL(String(value), "https://catalog.invalid/");
  const normalized = normalizeCatalogId(materialId);
  if (normalized) url.searchParams.set("material", normalized);
  else url.searchParams.delete("material");
  return url.toString();
}

export function urlWithoutMaterial(value) {
  return urlWithMaterial(value, "");
}

export function newestMaterialsByCatalogId(items, limit = 12) {
  const maximum = Math.max(0, Math.floor(Number(limit)) || 0);
  return (Array.isArray(items) ? [...items] : [])
    .filter((item) => catalogIdNumber(item) >= 0)
    .sort((left, right) => catalogIdNumber(right) - catalogIdNumber(left))
    .slice(0, maximum);
}

function cleanMessagePart(value, maximum = 500) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maximum);
}

export function materialShareText(item, directUrl) {
  const id = normalizeCatalogId(item && item.id);
  const title = cleanMessagePart(item && item.title) || "Матеріал бібліотеки";
  return `${title}${id ? ` (${id})` : ""}\n${String(directUrl || "").trim()}`.trim();
}

export function materialIssueText(item, directUrl) {
  const id = normalizeCatalogId(item && item.id);
  const title = cleanMessagePart(item && item.title) || "Матеріал бібліотеки";
  return [
    "Повідомлення про помилку в каталозі бібліотеки",
    id ? `Матеріал: ${id}` : "",
    `Назва: ${title}`,
    `Посилання: ${String(directUrl || "").trim()}`,
    "Що потрібно виправити: ",
  ].filter(Boolean).join("\n");
}

if (typeof window !== "undefined" && typeof document !== "undefined") {

const config = window.LIBRARY_CONFIG && typeof window.LIBRARY_CONFIG === "object" ? window.LIBRARY_CONFIG : {};
const balanceData = window.BALANCE_DATA && typeof window.BALANCE_DATA === "object" ? window.BALANCE_DATA : {};
const collator = new Intl.Collator("uk", { sensitivity: "base", numeric: true });
const state = { search: "", grade: "", rubric: "", subject: "", type: "", available: false, collection: "", sort: "recommended", limit: 18 };
const emptyStock = () => ({ total: 0, library: 0, other: 0, locations: [] });

const COLLECTIONS = Object.freeze([
  { id: "latest", symbol: "＋", title: "Останні додані до каталогу", description: "Останні записи за порядком CAT-ID" },
  { id: "primary", symbol: "1–4", title: "Для початкової школи", description: "Матеріали для 1–4 класів" },
  { id: "languages", symbol: "Aa", title: "Іноземні мови", description: "Англійська, німецька, французька та інші" },
  { id: "exams", symbol: "✓", title: "ЗНО і НМТ", description: "Матеріали для підготовки до іспитів" },
]);

let materials = [];
let syncPromise = null;
let currentMaterialId = "";

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
  collectionGrid: document.querySelector("#collectionGrid"),
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

function collectionById(id) {
  return COLLECTIONS.find((collection) => collection.id === id) || null;
}

function materialsForCollection(id) {
  if (id === "latest") return newestMaterialsByCatalogId(materials, 12);
  if (id === "primary") {
    return materials.filter((item) => item.classFrom && item.classFrom <= 4);
  }
  if (id === "languages") {
    return materials.filter((item) => /(?:англійська|німецька|французька|іспанська|польська)\s+мова/i.test(`${item.rubric} ${item.subject}`));
  }
  if (id === "exams") {
    return materials.filter((item) => /(?:^|\s)(?:ЗНО|НМТ)(?:\s|$)/i.test(`${item.rubric} ${item.subject} ${item.type} ${item.title}`));
  }
  return materials;
}

function renderCollections() {
  elements.collectionGrid.innerHTML = COLLECTIONS.map((collection) => {
    const count = materialsForCollection(collection.id).length;
    const active = state.collection === collection.id;
    return `<button class="collection-card${active ? " active" : ""}" type="button" data-collection="${collection.id}" aria-pressed="${active}">
      <span class="collection-symbol" aria-hidden="true">${collection.symbol}</span>
      <span class="collection-copy"><strong>${escapeHtml(collection.title)}</strong><small>${escapeHtml(collection.description)}</small></span>
      <span class="collection-count">${count.toLocaleString("uk-UA")} матеріалів <i aria-hidden="true">→</i></span>
    </button>`;
  }).join("");
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
  openLinkedMaterial();
}

function filteredMaterials() {
  const query = normalized(state.search); const grade = Number(state.grade);
  const collectionIds = state.collection ? new Set(materialsForCollection(state.collection).map((item) => item.id)) : null;
  const result = materials.filter((item) => {
    if (collectionIds && !collectionIds.has(item.id)) return false;
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
  if (state.sort === "recommended" && state.collection === "latest") result.sort((a, b) => catalogIdNumber(b) - catalogIdNumber(a));
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
  const activeCollection = collectionById(state.collection);
  const chips = [["collection", activeCollection ? activeCollection.title : ""], ["search", state.search ? `Пошук: ${state.search}` : ""], ["grade", state.grade ? `${state.grade} клас` : ""], ["rubric", state.rubric], ["subject", state.subject], ["type", state.type], ["available", state.available ? "Лише в наявності" : ""]].filter(([, label]) => label);
  elements.chips.innerHTML = chips.map(([key, label]) => `<span class="filter-chip">${escapeHtml(label)}<button type="button" data-remove="${key}" aria-label="Прибрати фільтр ${escapeHtml(label)}">×</button></span>`).join("");
}

function render() {
  const result = filteredMaterials(); const shown = result.slice(0, state.limit);
  elements.grid.innerHTML = shown.map(cardMarkup).join("");
  bindCoverErrors(elements.grid);
  elements.count.innerHTML = `Знайдено <strong>${result.length.toLocaleString("uk-UA")}</strong> матеріалів`;
  elements.empty.hidden = result.length !== 0; elements.grid.hidden = result.length === 0; elements.loadMore.hidden = result.length <= state.limit; renderChips(); renderCollections();
}

function resetLimitAndRender() { state.limit = 18; render(); }
function clearFilters() {
  Object.assign(state, { search: "", grade: "", rubric: "", subject: "", type: "", available: false, collection: "", limit: 18 });
  elements.search.value = ""; elements.grade.value = ""; elements.rubric.value = ""; elements.subject.value = ""; elements.type.value = ""; elements.available.checked = false; render();
}

function activateCollection(id) {
  if (!collectionById(id)) return;
  Object.assign(state, { search: "", grade: "", rubric: "", subject: "", type: "", available: false, collection: id, limit: 18 });
  elements.search.value = ""; elements.grade.value = ""; elements.rubric.value = ""; elements.subject.value = ""; elements.type.value = ""; elements.available.checked = false;
  render();
  document.querySelector("#catalog").scrollIntoView({ behavior: "smooth" });
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

function directMaterialUrl(id) {
  return urlWithMaterial(window.location.href, id);
}

function showMaterial(id, { updateHistory = true } = {}) {
  const item = materials.find((material) => material.id === id); if (!item) return false;
  const directUrl = directMaterialUrl(item.id);
  elements.dialogContent.innerHTML = `<div class="dialog-layout"><div class="dialog-cover">${coverMarkup(item, true)}</div><div class="dialog-copy">
    <p class="dialog-id">${escapeHtml(item.id)} · ${escapeHtml(item.rubric)}</p><h2>${escapeHtml(item.title)}</h2>
    <p class="dialog-meta">${escapeHtml(item.author)}${item.year ? ` · ${escapeHtml(item.year)} рік` : ""}</p>
    <div class="dialog-tags"><span>${escapeHtml(classLabel(item))}</span><span>${escapeHtml(item.subject)}</span><span>${escapeHtml(item.type)}</span></div>
    ${stockMarkup(item)}
    <div class="dialog-actions" aria-label="Дії з карткою">
      <button type="button" data-copy-material="${escapeHtml(item.id)}">Скопіювати посилання</button>
      <button type="button" data-share-material="${escapeHtml(item.id)}">Поділитися</button>
      <button class="report-error-button" type="button" data-report-error="${escapeHtml(item.id)}">Повідомити про помилку</button>
    </div>
    <p class="dialog-note">Це безпечна версія для перегляду. Вона не змінює дані у службовій таблиці.</p>
  </div></div>`;
  bindCoverErrors(elements.dialogContent);
  currentMaterialId = item.id;
  if (updateHistory && materialIdFromUrl(window.location.href) !== item.id) {
    window.history.pushState({ ...(window.history.state || {}), libraryMaterial: item.id }, "", directUrl);
  }
  if (!elements.dialog.open) elements.dialog.showModal();
  return true;
}

function openLinkedMaterial() {
  const id = materialIdFromUrl(window.location.href);
  if (!id) return false;
  return showMaterial(id, { updateHistory: false });
}

function closeMaterial({ fromHistory = false } = {}) {
  const closingId = currentMaterialId;
  currentMaterialId = "";
  if (elements.dialog.open) elements.dialog.close();
  if (fromHistory || !materialIdFromUrl(window.location.href)) return;
  if (window.history.state && window.history.state.libraryMaterial === closingId) {
    window.history.back();
  } else {
    window.history.replaceState(window.history.state, "", urlWithoutMaterial(window.location.href));
  }
}

async function copyText(value) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy_failed");
}

async function shareOrCopyMaterial(id, mode) {
  const item = materials.find((material) => material.id === id);
  if (!item) return;
  const directUrl = directMaterialUrl(item.id);
  const report = mode === "report";
  const text = report ? materialIssueText(item, directUrl) : materialShareText(item, directUrl);
  if (mode !== "copy" && navigator.share) {
    try {
      await navigator.share(report
        ? { title: "Повідомлення про помилку в каталозі", text }
        : { title: item.title, text: materialShareText(item, ""), url: directUrl });
      showToast(report ? "Повідомлення підготовлено для надсилання." : "Карткою поділено.");
      return;
    } catch (error) {
      if (error && error.name === "AbortError") return;
    }
  }
  try {
    await copyText(mode === "copy" ? directUrl : text);
    showToast(report ? "Текст повідомлення скопійовано. Надішліть його бібліотекарю." : "Посилання на картку скопійовано.");
  } catch {
    showToast("Не вдалося скопіювати. Скопіюйте адресу сторінки з браузера.");
  }
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
  const collection = event.target.closest("[data-collection]"); if (collection) activateCollection(collection.dataset.collection);
  const copyMaterial = event.target.closest("[data-copy-material]"); if (copyMaterial) shareOrCopyMaterial(copyMaterial.dataset.copyMaterial, "copy");
  const shareMaterial = event.target.closest("[data-share-material]"); if (shareMaterial) shareOrCopyMaterial(shareMaterial.dataset.shareMaterial, "share");
  const reportError = event.target.closest("[data-report-error]"); if (reportError) shareOrCopyMaterial(reportError.dataset.reportError, "report");
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

document.querySelector(".dialog-close").addEventListener("click", () => closeMaterial());
elements.dialog.addEventListener("click", (event) => { if (event.target === elements.dialog) closeMaterial(); });
elements.dialog.addEventListener("cancel", (event) => { event.preventDefault(); closeMaterial(); });
window.addEventListener("popstate", () => {
  const linkedId = materialIdFromUrl(window.location.href);
  if (linkedId) showMaterial(linkedId, { updateHistory: false });
  else closeMaterial({ fromHistory: true });
});
document.querySelector("#librarianButton").addEventListener("click", () => showToast("Режим бібліотекаря підключимо на наступному етапі після затвердження каталогу."));
elements.filterToggle.addEventListener("click", () => { const open = elements.filters.classList.toggle("open"); elements.filterToggle.setAttribute("aria-expanded", String(open)); });

const snapshot = localSnapshot();
applyDataset(snapshot, { locations: 13 });
synchronizeCatalog();
const refreshMinutes = Math.min(60, Math.max(5, nonNegativeInteger(config.refreshMinutes) || 10));
if (validApiUrl(config.apiUrl)) window.setInterval(synchronizeCatalog, refreshMinutes * 60 * 1000);
}
