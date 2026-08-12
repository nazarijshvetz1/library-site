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

export function normalizeCatalogApiUrl(value, baseUrl = "https://catalog.invalid/") {
  try {
    const url = new URL(String(value || "").trim(), String(baseUrl || "https://catalog.invalid/"));
    const localDevelopment = url.protocol === "http:"
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if ((url.protocol !== "https:" && !localDevelopment) || url.username || url.password) return "";
    if (!/\/api\/catalog-v2\/?$/.test(url.pathname)) return "";
    url.pathname = url.pathname.replace(/\/$/, "");
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function catalogDetailApiUrl(apiUrl, materialId, baseUrl = "https://catalog.invalid/") {
  const endpoint = normalizeCatalogApiUrl(apiUrl, baseUrl);
  const id = normalizeCatalogId(materialId);
  if (!endpoint || !id) return "";
  const url = new URL(endpoint);
  url.pathname = `${url.pathname}/${encodeURIComponent(id)}`;
  return url.toString();
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
const emptyStock = () => ({ total: 0, available: 0, library: 0, other: 0, loaned: 0, locations: [] });

const COLLECTIONS = Object.freeze([
  { id: "latest", symbol: "＋", title: "Останні додані до каталогу", description: "Останні записи за порядком CAT-ID" },
  { id: "primary", symbol: "1–4", title: "Для початкової школи", description: "Матеріали для 1–4 класів" },
  { id: "languages", symbol: "Aa", title: "Іноземні мови", description: "Англійська, німецька, французька та інші" },
  { id: "exams", symbol: "✓", title: "ЗНО і НМТ", description: "Матеріали для підготовки до іспитів" },
]);

let materials = [];
let syncPromise = null;
let currentMaterialId = "";
let fallbackLocationCount = 0;
let hasLiveCatalog = false;
const materialDetails = new Map();
const detailPromises = new Map();

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
  try {
    const candidate = cleanText(value, 1000);
    if (!candidate) return "";
    const apiUrl = normalizeCatalogApiUrl(config.catalogApiUrl, window.location.href);
    const url = new URL(candidate, apiUrl || window.location.href);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function safePublicLinkUrl(value) {
  try {
    const url = new URL(cleanText(value, 2000));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function normalizeStock(rawStock, quantityHint) {
  const source = rawStock && typeof rawStock === "object" ? rawStock : {};
  const locations = Array.isArray(source.locations) ? source.locations.map((location) => ({
    name: cleanText(location && location.name, 160),
    quantity: nonNegativeInteger(location && location.quantity),
  })).filter((location) => location.name && location.quantity > 0).slice(0, 100) : [];
  const total = nonNegativeInteger(source.total ?? quantityHint);
  const loaned = Math.min(total, nonNegativeInteger(source.loaned));
  const available = Math.min(total, nonNegativeInteger(source.available ?? Math.max(0, total - loaned)));
  const library = Math.min(total, nonNegativeInteger(source.library));
  const other = Math.min(total, nonNegativeInteger(source.other));
  return { total, available, library, other, loaned, locations };
}

function normalizeLinks(rawLinks) {
  return (Array.isArray(rawLinks) ? rawLinks : []).map((link) => ({
    kind: cleanText(link && link.kind, 80),
    label: cleanText(link && link.label, 240) || "Відкрити посилання",
    url: safePublicLinkUrl(link && link.url),
  })).filter((link) => link.url).slice(0, 50);
}

function normalizeMaterial(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanText(raw.id, 24).toUpperCase();
  const title = cleanText(raw.title, 500);
  if (!/^CAT-\d{4,}$/.test(id) || !title) return null;
  const holdings = Array.isArray(raw.holdings) ? raw.holdings.map((holding) => ({
    id: cleanText(holding && holding.locationId, 80),
    name: cleanText(holding && holding.locationName, 160),
    quantity: nonNegativeInteger(holding && holding.quantity),
  })).filter((holding) => holding.name && holding.quantity > 0) : [];
  const stock = normalizeStock(raw.stock || {
    total: raw.totalQuantity,
    available: raw.availableQuantity,
    library: raw.libraryQuantity,
    other: raw.otherLocationQuantity,
    loaned: raw.loanedQuantity,
    locations: holdings,
  }, raw.quantity);
  const classFrom = gradeNumber(raw.classFrom);
  return {
    id,
    rubric: cleanText(raw.rubric, 180) || "Без рубрики",
    type: cleanText(raw.publicationType ?? raw.type, 180) || "Не зазначено",
    subject: cleanText(raw.subject, 180) || "Не зазначено",
    classFrom,
    classTo: gradeNumber(raw.classTo) || classFrom,
    title,
    author: cleanText(raw.author, 300),
    year: nonNegativeInteger(raw.year) || "",
    isbn: cleanText(raw.isbn, 32),
    publisher: cleanText(raw.publisher, 240),
    cover: safeCoverUrl(raw.cover && typeof raw.cover === "object" ? raw.cover.url : (raw.thumbnailUrl ?? raw.cover)),
    quantity: stock.total,
    availableQuantity: stock.available,
    stock,
    links: normalizeLinks(raw.links),
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

function normalizeCatalogPage(payload) {
  if (!payload || payload.success === false || Number(payload.schemaVersion) !== 2 || !Array.isArray(payload.items)) {
    throw new Error("Некоректна відповідь каталогу");
  }
  const items = payload.items.map(normalizeMaterial).filter(Boolean);
  if (items.length !== payload.items.length) throw new Error("Отримано пошкоджену сторінку каталогу");
  const page = payload.page && typeof payload.page === "object" ? payload.page : {};
  const hasMore = page.hasMore === true;
  const nextCursor = cleanText(page.nextCursor, 2000);
  if (hasMore && (!items.length || !nextCursor)) throw new Error("Каталог повернув некоректний курсор");
  return { items, hasMore, nextCursor };
}

function normalizeDetailPayload(payload) {
  if (!payload || payload.success === false || Number(payload.schemaVersion) !== 2 || !payload.material) {
    throw new Error("Некоректна картка матеріалу");
  }
  const material = normalizeMaterial(payload.material);
  if (!material) throw new Error("Некоректна картка матеріалу");
  return material;
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
  materialDetails.clear();
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
    if (query && !normalized([item.title, item.author, item.subject, item.type, item.rubric, item.id, item.isbn, item.publisher].join(" ")).includes(query)) return false;
    if (grade && !(Number(item.classFrom) <= grade && Number(item.classTo || item.classFrom) >= grade)) return false;
    if (state.rubric && item.rubric !== state.rubric) return false;
    if (state.subject && item.subject !== state.subject) return false;
    if (state.type && item.type !== state.type) return false;
    if (state.available && Number(item.availableQuantity) <= 0) return false;
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
  const available = Number(item.availableQuantity) > 0;
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

function stockMarkup(item, { loadingDetail = false, detailError = false } = {}) {
  const locations = Array.isArray(item.stock.locations) ? item.stock.locations : [];
  const locationMarkup = locations.length
    ? `<ul class="location-list">${locations.map((location) => `<li class="stock-location"><i></i><span>${escapeHtml(location.name)}</span><strong>${escapeHtml(location.quantity)}</strong></li>`).join("")}</ul>`
    : `<p class="stock-empty">${loadingDetail
      ? "Завантажуємо розміщення…"
      : detailError
        ? "Не вдалося оновити розміщення. Спробуйте відкрити картку ще раз."
        : "Для цього матеріалу немає відкритих даних про розміщення."}</p>`;
  return `<div class="stock-box">
    <div class="stock-summary">
      <div class="stock-total"><span>Усього</span><strong>${escapeHtml(item.stock.total)}</strong></div>
      <div class="stock-total"><span>Доступно</span><strong>${escapeHtml(item.stock.available)}</strong></div>
      <div class="stock-total"><span>У бібліотеці</span><strong>${escapeHtml(item.stock.library)}</strong></div>
      <div class="stock-total"><span>В інших кабінетах</span><strong>${escapeHtml(item.stock.other)}</strong></div>
      ${item.stock.loaned ? `<div class="stock-total"><span>Видано</span><strong>${escapeHtml(item.stock.loaned)}</strong></div>` : ""}
    </div>${locationMarkup}
  </div>`;
}

function linksMarkup(item, { loadingDetail = false, detailError = false } = {}) {
  if (loadingDetail) return `<div class="material-links" aria-busy="true"><h3>Посилання</h3><p>Завантажуємо відкриті джерела…</p></div>`;
  if (detailError) return `<div class="material-links"><h3>Посилання</h3><p>Не вдалося завантажити посилання. Спробуйте відкрити картку ще раз.</p></div>`;
  if (!item.links.length) return "";
  return `<div class="material-links"><h3>Посилання</h3><ul>${item.links.map((link) => `<li><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer"><span>${escapeHtml(link.label)}</span><i aria-hidden="true">↗</i></a></li>`).join("")}</ul></div>`;
}

function directMaterialUrl(id) {
  return urlWithMaterial(window.location.href, id);
}

function renderMaterialDialog(item, detailState = {}) {
  const directUrl = directMaterialUrl(item.id);
  const secondaryMeta = [item.publisher, item.isbn ? `ISBN ${item.isbn}` : ""].filter(Boolean);
  elements.dialogContent.innerHTML = `<div class="dialog-layout"><div class="dialog-cover">${coverMarkup(item, true)}</div><div class="dialog-copy">
    <p class="dialog-id">${escapeHtml(item.id)} · ${escapeHtml(item.rubric)}</p><h2>${escapeHtml(item.title)}</h2>
    <p class="dialog-meta">${escapeHtml(item.author)}${item.year ? ` · ${escapeHtml(item.year)} рік` : ""}</p>
    ${secondaryMeta.length ? `<p class="dialog-secondary-meta">${secondaryMeta.map(escapeHtml).join(" · ")}</p>` : ""}
    <div class="dialog-tags"><span>${escapeHtml(classLabel(item))}</span><span>${escapeHtml(item.subject)}</span><span>${escapeHtml(item.type)}</span></div>
    ${stockMarkup(item, detailState)}
    ${linksMarkup(item, detailState)}
    <div class="dialog-actions" aria-label="Дії з карткою">
      <button type="button" data-copy-material="${escapeHtml(item.id)}">Скопіювати посилання</button>
      <button type="button" data-share-material="${escapeHtml(item.id)}">Поділитися</button>
      <button class="report-error-button" type="button" data-report-error="${escapeHtml(item.id)}">Повідомити про помилку</button>
    </div>
    <p class="dialog-note">Каталог доступний лише для перегляду. Зміни вносяться у захищеному кабінеті бібліотекаря.</p>
  </div></div>`;
  bindCoverErrors(elements.dialogContent);
  return directUrl;
}

async function loadMaterialDetail(id) {
  if (materialDetails.has(id)) return materialDetails.get(id);
  if (detailPromises.has(id)) return detailPromises.get(id);
  const url = catalogDetailApiUrl(config.catalogApiUrl, id, window.location.href);
  if (!url) throw new Error("catalog_api_unavailable");
  const request = fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  }).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const detail = normalizeDetailPayload(await response.json());
    materialDetails.set(id, detail);
    return detail;
  }).finally(() => detailPromises.delete(id));
  detailPromises.set(id, request);
  return request;
}

function showMaterial(id, { updateHistory = true } = {}) {
  const summary = materials.find((material) => material.id === id); if (!summary) return false;
  const cachedDetail = materialDetails.get(id);
  const hasApi = Boolean(catalogDetailApiUrl(config.catalogApiUrl, id, window.location.href));
  const item = cachedDetail || summary;
  const directUrl = renderMaterialDialog(item, { loadingDetail: !cachedDetail && hasApi });
  currentMaterialId = item.id;
  if (updateHistory && materialIdFromUrl(window.location.href) !== item.id) {
    window.history.pushState({ ...(window.history.state || {}), libraryMaterial: item.id }, "", directUrl);
  }
  if (!elements.dialog.open) elements.dialog.showModal();
  if (!cachedDetail && hasApi) {
    loadMaterialDetail(id).then((detail) => {
      if (currentMaterialId === id && elements.dialog.open) renderMaterialDialog(detail);
    }).catch(() => {
      if (currentMaterialId === id && elements.dialog.open) renderMaterialDialog(summary, { detailError: true });
    });
  }
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

async function fetchCatalogPage(apiUrl, cursor = "") {
  const url = new URL(apiUrl);
  url.searchParams.set("limit", "48");
  url.searchParams.set("sort", "title");
  if (cursor) url.searchParams.set("cursor", cursor);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return normalizeCatalogPage(await response.json());
}

async function requestLiveCatalog(apiUrl) {
  const items = [];
  const ids = new Set();
  const cursors = new Set();
  let cursor = "";
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await fetchCatalogPage(apiUrl, cursor);
    page.items.forEach((item) => {
      if (ids.has(item.id)) throw new Error("Каталог повернув повторний CAT-ID");
      ids.add(item.id);
      items.push(item);
    });
    if (!page.hasMore) {
      if (!items.length) throw new Error("Каталог не містить матеріалів");
      return items;
    }
    if (cursors.has(page.nextCursor)) throw new Error("Каталог повернув повторний курсор");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("Каталог перевищив безпечну кількість сторінок");
}

function formattedUpdatedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "щойно";
  return date.toLocaleString("uk-UA", { dateStyle: "short", timeStyle: "short" });
}

async function synchronizeCatalog() {
  const apiUrl = normalizeCatalogApiUrl(config.catalogApiUrl, window.location.href);
  if (!apiUrl) {
    setSyncStatus("snapshot", "Показано локальну резервну копію каталогу");
    return;
  }
  if (syncPromise) return syncPromise;
  setSyncStatus("loading", "Оновлюємо каталог із захищеної бази…");
  syncPromise = requestLiveCatalog(apiUrl).then((liveMaterials) => {
    applyDataset(liveMaterials, { locations: fallbackLocationCount });
    hasLiveCatalog = true;
    setSyncStatus("live", `Актуальні дані · ${formattedUpdatedAt(new Date().toISOString())}`);
  }).catch(() => {
    setSyncStatus("error", hasLiveCatalog
      ? "Не вдалося оновити — показано останні отримані дані"
      : "Захищена база тимчасово недоступна — показано локальну резервну копію", true);
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
elements.filterToggle.addEventListener("click", () => { const open = elements.filters.classList.toggle("open"); elements.filterToggle.setAttribute("aria-expanded", String(open)); });

const snapshot = localSnapshot();
fallbackLocationCount = datasetStats(snapshot).locations;
applyDataset(snapshot, { locations: fallbackLocationCount });
synchronizeCatalog();
const refreshMinutes = Math.min(60, Math.max(5, nonNegativeInteger(config.refreshMinutes) || 10));
if (normalizeCatalogApiUrl(config.catalogApiUrl, window.location.href)) window.setInterval(synchronizeCatalog, refreshMinutes * 60 * 1000);
}
