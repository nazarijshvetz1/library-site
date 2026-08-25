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

export function materialOrderUrl(value, materialId, baseUrl = "https://catalog.invalid/") {
  const endpoint = normalizeVisitsBookingUrl(value, baseUrl);
  const id = normalizeCatalogId(materialId);
  if (!endpoint || !id) return "";
  const url = new URL(endpoint);
  url.searchParams.set("tab", "orders");
  url.searchParams.set("material", id);
  return url.toString();
}

export function telegramMiniAppLaunchHash(value) {
  const raw = String(value || "").trim().replace(/^#/, "");
  if (!raw || raw.length > 12_000) return "";
  const input = new URLSearchParams(raw);
  const initData = input.get("tgWebAppData");
  const version = input.get("tgWebAppVersion");
  if (!initData || !version || initData.length > 8_192 || version.length > 32) return "";
  const output = new URLSearchParams();
  for (const key of ["tgWebAppData", "tgWebAppVersion", "tgWebAppPlatform", "tgWebAppThemeParams"]) {
    const entry = input.get(key);
    if (entry) output.set(key, entry);
  }
  return `#${output.toString()}`;
}

export function materialOrderDestination(value, materialId, launchHash = "", baseUrl = "https://catalog.invalid/") {
  const browserUrl = materialOrderUrl(value, materialId, baseUrl);
  if (!browserUrl) return { url: "", withinTelegram: false };
  const telegramHash = telegramMiniAppLaunchHash(launchHash);
  if (!telegramHash) return { url: browserUrl, withinTelegram: false };
  const url = new URL(browserUrl);
  if (url.pathname.replace(/\/$/, "") !== "/teacher") return { url: browserUrl, withinTelegram: false };
  url.pathname = "/teacher/telegram";
  url.hash = telegramHash.slice(1);
  return { url: url.toString(), withinTelegram: true };
}

function normalizedSearchText(value) {
  return String(value || "")
    .toLocaleLowerCase("uk")
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleSuggestions(items, query, limit = 6) {
  const needle = normalizedSearchText(query);
  const maximum = Math.max(0, Math.min(12, Math.floor(Number(limit)) || 0));
  if (needle.length < 2 || maximum === 0) return [];
  const tokens = needle.split(" ").filter(Boolean);
  return (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const title = normalizedSearchText(item && item.title);
      if (!title || !tokens.every((token) => title.includes(token))) return null;
      const wordPrefix = title.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(needle));
      const score = title === needle ? 0 : title.startsWith(needle) ? 1 : wordPrefix ? 2 : title.includes(needle) ? 3 : 4;
      return { item, index, score };
    })
    .filter(Boolean)
    .sort((left, right) => left.score - right.score
      || normalizedSearchText(left.item.title).localeCompare(normalizedSearchText(right.item.title), "uk")
      || left.index - right.index)
    .slice(0, maximum)
    .map(({ item }) => item);
}

export function matchesMaterialSearch(item, query) {
  const needle = normalizedSearchText(query);
  if (!needle) return true;
  const tokens = needle.split(" ").filter(Boolean);
  const haystack = normalizedSearchText([
    item?.title,
    item?.author,
    item?.subject,
    item?.type,
    item?.rubric,
    item?.id,
    item?.isbn,
    item?.publisher,
  ].join(" "));
  return tokens.every((token) => haystack.includes(token));
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

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const VISIT_TIME_PATTERN = /^(\d{2}):(\d{2})$/;
const VISIT_MIN_BOOKING_MINUTES = 20;
const VISIT_HORIZON_DAYS = 90;

function isoDateValue(value) {
  const candidate = String(value || "").trim();
  const match = candidate.match(ISO_DATE_PATTERN);
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]) ? candidate : "";
}

function visitTimeMinutes(value) {
  const match = String(value || "").trim().match(VISIT_TIME_PATTERN);
  if (!match) return -1;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) return -1;
  return hours * 60 + minutes;
}

function visitTimeValue(minutes) {
  const bounded = Math.max(0, Math.min(1440, Math.floor(Number(minutes)) || 0));
  return `${String(Math.floor(bounded / 60)).padStart(2, "0")}:${String(bounded % 60).padStart(2, "0")}`;
}

function normalizedVisitEndpoint(value, expectedPath, baseUrl) {
  try {
    const url = new URL(String(value || "").trim(), String(baseUrl || "https://catalog.invalid/"));
    const localDevelopment = url.protocol === "http:"
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if ((url.protocol !== "https:" && !localDevelopment) || url.username || url.password) return "";
    if (url.pathname.replace(/\/$/, "") !== expectedPath) return "";
    url.pathname = expectedPath;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

export function normalizeVisitsApiUrl(value, baseUrl = "https://catalog.invalid/") {
  return normalizedVisitEndpoint(value, "/api/visits/public", baseUrl);
}

export function normalizeVisitsBookingUrl(value, baseUrl = "https://catalog.invalid/") {
  return normalizedVisitEndpoint(value, "/teacher", baseUrl)
    || normalizedVisitEndpoint(value, "/visits", baseUrl);
}

export function normalizeContactsApiUrl(value, baseUrl = "https://catalog.invalid/") {
  return normalizedVisitEndpoint(value, "/api/public/contacts", baseUrl);
}

export function visitsPublicApiUrl(value, from, to, baseUrl = "https://catalog.invalid/") {
  const endpoint = normalizeVisitsApiUrl(value, baseUrl);
  const firstDate = isoDateValue(from);
  const lastDate = isoDateValue(to);
  if (!endpoint || !firstDate || !lastDate || firstDate > lastDate) return "";
  const url = new URL(endpoint);
  url.searchParams.set("from", firstDate);
  url.searchParams.set("to", lastDate);
  return url.toString();
}

export function startOfVisitWeek(value) {
  const candidate = isoDateValue(value);
  if (!candidate) return "";
  const date = new Date(`${candidate}T00:00:00.000Z`);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - weekday + 1);
  return date.toISOString().slice(0, 10);
}

export function visitWeekDates(monday) {
  const firstDate = startOfVisitWeek(monday);
  if (!firstDate) return [];
  const start = new Date(`${firstDate}T00:00:00.000Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

export function visitHorizonEnd(today, days = VISIT_HORIZON_DAYS) {
  const candidate = isoDateValue(today);
  const boundedDays = Number(days);
  if (!candidate || !Number.isInteger(boundedDays) || boundedDays < 0 || boundedDays > 366) return "";
  const end = new Date(`${candidate}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + boundedDays);
  return end.toISOString().slice(0, 10);
}

export function visitWeekNavigation(weekStart, today) {
  const currentWeek = startOfVisitWeek(weekStart);
  const firstWeek = startOfVisitWeek(today);
  const lastDate = visitHorizonEnd(today);
  const lastWeek = startOfVisitWeek(lastDate);
  if (!currentWeek || !firstWeek || !lastWeek) {
    return { firstWeek: "", lastWeek: "", canPrevious: false, canNext: false };
  }
  return {
    firstWeek,
    lastWeek,
    canPrevious: currentWeek > firstWeek,
    canNext: currentWeek < lastWeek,
  };
}

export function visitScheduleQueryRange(weekStart, today) {
  const dates = visitWeekDates(weekStart);
  const firstDate = isoDateValue(today);
  const lastDate = visitHorizonEnd(firstDate);
  if (!dates.length || !firstDate || !lastDate) return null;
  const from = dates[0] < firstDate ? firstDate : dates[0];
  const to = dates.at(-1) > lastDate ? lastDate : dates.at(-1);
  return from <= to ? { from, to } : null;
}

function normalizeVisitInterval(raw, expectedStatus = "") {
  if (!raw || typeof raw !== "object") return null;
  const startTime = String(raw.startTime || "").trim();
  const endTime = String(raw.endTime || "").trim();
  const start = visitTimeMinutes(startTime);
  const end = visitTimeMinutes(endTime);
  if (start < 0 || end <= start) return null;
  if (expectedStatus && raw.status !== expectedStatus) return null;
  return { startTime, endTime, start, end };
}

function normalizeVisitBlockers(items, status, from, to) {
  if (!Array.isArray(items)) throw new Error("Некоректні інтервали графіка");
  return items.map((raw) => {
    const date = isoDateValue(raw && raw.date);
    const interval = normalizeVisitInterval(raw, status);
    if (!date || !interval || (from && date < from) || (to && date > to)) {
      throw new Error("Некоректний інтервал графіка");
    }
    return { date, startTime: interval.startTime, endTime: interval.endTime, start: interval.start, end: interval.end, status };
  }).sort((left, right) => left.date.localeCompare(right.date) || left.start - right.start || left.end - right.end);
}

function normalizeVisitPublicBookings(items, from, to) {
  if (!Array.isArray(items)) throw new Error("Некоректні публічні записи графіка");
  return items.map((raw) => {
    const date = isoDateValue(raw && raw.date);
    const interval = normalizeVisitInterval(raw);
    const identityVerified = raw && raw.identityVerified;
    const directoryMatched = raw && raw.directoryMatched === true;
    const rawName = String(raw && raw.displayName || "");
    const hasControl = Array.from(rawName).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
    const normalizedName = rawName.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!date || !interval || (from && date < from) || (to && date > to)
      || typeof identityVerified !== "boolean") {
      throw new Error("Некоректний публічний запис графіка");
    }
    const safeName = !hasControl && normalizedName.length >= 2 && normalizedName.length <= 120;
    return {
      date,
      startTime: interval.startTime,
      endTime: interval.endTime,
      start: interval.start,
      end: interval.end,
      status: "busy",
      displayName: identityVerified && safeName
        ? normalizedName
        : !identityVerified && directoryMatched && safeName
          ? `Заявлено: ${normalizedName} · гостьовий запис · особу не підтверджено`
          : identityVerified
            ? "Заброньовано"
            : "Непідтверджений гостьовий запис",
      identityVerified,
      directoryMatched,
    };
  }).sort((left, right) => left.date.localeCompare(right.date) || left.start - right.start || left.end - right.end)
    .map((booking, index) => ({ ...booking, sourceKey: `public-booking-${index}` }));
}

export function normalizeVisitSchedule(payload, from = "", to = "") {
  const firstDate = from ? isoDateValue(from) : "";
  const lastDate = to ? isoDateValue(to) : "";
  if (!payload || typeof payload !== "object" || payload.success === false || Number(payload.schemaVersion) !== 1
    || payload.timeZone !== "Europe/Kyiv" || !payload.hours || typeof payload.hours !== "object") {
    throw new Error("Некоректна відповідь графіка");
  }
  const slotMinutes = Number(payload.slotMinutes);
  if (!Number.isInteger(slotMinutes) || slotMinutes !== 5 || (firstDate && lastDate && firstDate > lastDate)) {
    throw new Error("Некоректна точність графіка");
  }
  const hours = {};
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const rawIntervals = payload.hours[String(weekday)];
    if (!Array.isArray(rawIntervals)) throw new Error("Некоректні години бібліотеки");
    hours[String(weekday)] = rawIntervals.map((raw) => normalizeVisitInterval(raw)).map((interval) => {
      if (!interval) throw new Error("Некоректні години бібліотеки");
      return interval;
    }).sort((left, right) => left.start - right.start || left.end - right.end);
  }
  const generatedAt = String(payload.generatedAt || "").trim();
  if (generatedAt && Number.isNaN(new Date(generatedAt).getTime())) throw new Error("Некоректний час оновлення графіка");
  return {
    schemaVersion: 1,
    timeZone: "Europe/Kyiv",
    slotMinutes,
    hours,
    closures: normalizeVisitBlockers(payload.closures, "closed", firstDate, lastDate),
    busy: normalizeVisitBlockers(payload.busy, "busy", firstDate, lastDate),
    publicBookings: normalizeVisitPublicBookings(payload.publicBookings || [], firstDate, lastDate),
    generatedAt,
  };
}

function mergeVisitSegments(segments) {
  return segments.reduce((result, segment) => {
    const previous = result.at(-1);
    if (previous && previous.status === segment.status
      && previous.displayName === segment.displayName
      && previous.sourceKey === segment.sourceKey
      && previous.end === segment.start) {
      previous.end = segment.end;
      previous.endTime = segment.endTime;
    } else result.push({ ...segment });
    return result;
  }, []);
}

export function visitSegmentsForDate(schedule, value) {
  const date = isoDateValue(value);
  if (!date || !schedule || typeof schedule !== "object") return [];
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay() || 7;
  const openings = Array.isArray(schedule.hours && schedule.hours[String(weekday)]) ? schedule.hours[String(weekday)] : [];
  const blockers = [
    ...(Array.isArray(schedule.busy) ? schedule.busy : []),
    ...(Array.isArray(schedule.closures) ? schedule.closures : []),
    ...(Array.isArray(schedule.publicBookings) ? schedule.publicBookings : []),
  ].filter((item) => item.date === date);
  const segments = [];
  openings.forEach((opening) => {
    const overlapping = blockers.filter((item) => item.start < opening.end && item.end > opening.start);
    const boundaries = new Set([opening.start, opening.end]);
    overlapping.forEach((item) => {
      boundaries.add(Math.max(opening.start, item.start));
      boundaries.add(Math.min(opening.end, item.end));
    });
    const points = [...boundaries].sort((left, right) => left - right);
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      if (end <= start) continue;
      const active = overlapping.filter((item) => item.start < end && item.end > start);
      const publicBooking = active.find((item) => item.sourceKey && item.status === "busy");
      const status = active.some((item) => item.status === "closed") ? "closed"
        : active.some((item) => item.status === "busy") ? "busy" : "free";
      segments.push({
        date,
        startTime: visitTimeValue(start),
        endTime: visitTimeValue(end),
        start,
        end,
        status,
        displayName: status === "busy" ? publicBooking && publicBooking.displayName : undefined,
        identityVerified: status === "busy" ? publicBooking && publicBooking.identityVerified : undefined,
        directoryMatched: status === "busy" ? publicBooking && publicBooking.directoryMatched : undefined,
        sourceKey: status === "busy" ? publicBooking && publicBooking.sourceKey : undefined,
      });
    }
  });
  return mergeVisitSegments(segments.sort((left, right) => left.start - right.start || left.end - right.end));
}

export function visitBookingSelection(segment, preferredMinutes = 40, constraints = {}) {
  if (!segment || segment.status !== "free" || !isoDateValue(segment.date)) return null;
  let start = visitTimeMinutes(segment.startTime);
  const segmentEnd = visitTimeMinutes(segment.endTime);
  const today = constraints && isoDateValue(constraints.today);
  const horizonEnd = constraints && isoDateValue(constraints.horizonEnd);
  if ((today && segment.date < today) || (horizonEnd && segment.date > horizonEnd)) return null;
  if (today && segment.date === today) {
    const currentTime = visitTimeMinutes(constraints.currentTime);
    if (currentTime >= 0) start = Math.max(start, Math.floor(currentTime / 5) * 5 + 5);
  }
  const duration = Math.max(VISIT_MIN_BOOKING_MINUTES, Math.floor(Number(preferredMinutes)) || 40);
  if (start < 0 || segmentEnd <= start) return null;
  if (segmentEnd - start < VISIT_MIN_BOOKING_MINUTES) return null;
  return { date: segment.date, startTime: visitTimeValue(start), endTime: visitTimeValue(Math.min(segmentEnd, start + duration)) };
}

export function visitsBookingUrl(value, selection, baseUrl = "https://catalog.invalid/") {
  const endpoint = normalizeVisitsBookingUrl(value, baseUrl);
  const date = isoDateValue(selection && selection.date);
  const startTime = String(selection && selection.startTime || "").trim();
  const endTime = String(selection && selection.endTime || "").trim();
  if (!endpoint || !date || visitTimeMinutes(startTime) < 0 || visitTimeMinutes(endTime) <= visitTimeMinutes(startTime)) return "";
  const url = new URL(endpoint);
  url.searchParams.set("date", date);
  url.searchParams.set("start", startTime);
  url.searchParams.set("end", endTime);
  return url.toString();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {

const config = window.LIBRARY_CONFIG && typeof window.LIBRARY_CONFIG === "object" ? window.LIBRARY_CONFIG : {};
const telegramLaunchHash = telegramMiniAppLaunchHash(window.location.hash);
const balanceData = window.BALANCE_DATA && typeof window.BALANCE_DATA === "object" ? window.BALANCE_DATA : {};
const collator = new Intl.Collator("uk", { sensitivity: "base", numeric: true });
const state = { search: "", grade: "", rubric: "", subject: "", type: "", available: false, collection: "", sort: "recommended", limit: 18 };
const visitState = { weekStart: "", view: "week", schedule: null, loading: false, requestVersion: 0 };
const emptyStock = () => ({ total: 0, available: 0, library: 0, other: 0, loaned: 0, locations: [] });

const COLLECTIONS = Object.freeze([
  { id: "latest", icon: "plus", title: "Останні додані до каталогу", description: "Останні записи за порядком CAT-ID" },
  { id: "primary", symbol: "1–4", title: "Для початкової школи", description: "Матеріали для 1–4 класів" },
  { id: "languages", symbol: "Aa", title: "Іноземні мови", description: "Англійська, німецька, французька та інші" },
  { id: "exams", icon: "check", title: "ЗНО і НМТ", description: "Матеріали для підготовки до іспитів" },
]);

let materials = [];
let syncPromise = null;
let currentMaterialId = "";
let fallbackLocationCount = 0;
let hasLiveCatalog = false;
let activeSuggestionIndex = -1;
let visibleSuggestions = [];
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
  suggestions: document.querySelector("#titleSuggestions"),
  visitContent: document.querySelector("#visitScheduleContent"), visitEmpty: document.querySelector("#visitScheduleEmpty"),
  visitStatus: document.querySelector("#visitScheduleStatus"), visitStatusText: document.querySelector("#visitScheduleStatusText"),
  visitRetry: document.querySelector("#visitScheduleRetry"), visitWeekLabel: document.querySelector("#visitWeekLabel"),
  visitPrevWeek: document.querySelector("#visitPrevWeek"), visitNextWeek: document.querySelector("#visitNextWeek"),
  visitThisWeek: document.querySelector("#visitThisWeek"),
  contactsStatus: document.querySelector("#contactsStatus"), contactsGrid: document.querySelector("#contactsGrid"),
  librarianContact: document.querySelector("#librarianContact"), assistantContact: document.querySelector("#assistantContact"),
};

const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" })[character]);
const UI_ICON_NAMES = new Set(["external-link", "search", "check", "arrow-right", "chevron-left", "chevron-right", "circle-off", "list-filter", "info", "sparkles", "x", "plus"]);
const uiIcon = (name, className = "") => UI_ICON_NAMES.has(name)
  ? `<svg class="ui-icon${className ? ` ${escapeHtml(className)}` : ""}" aria-hidden="true" focusable="false"><use href="#icon-${name}"></use></svg>`
  : "";
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

function normalizedContact(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    name: cleanText(source.name, 160),
    description: cleanText(source.description, 2000),
    phone: cleanText(source.phone, 80),
    email: cleanText(source.email, 254).toLocaleLowerCase("uk"),
  };
}

function safePhoneHref(value) {
  const phone = cleanText(value, 80);
  if (!phone || !/^[+()\d\s.-]{5,80}$/u.test(phone)) return "";
  const normalizedPhone = phone.replace(/[^+\d]/gu, "");
  return /^\+?\d{5,20}$/u.test(normalizedPhone) ? `tel:${normalizedPhone}` : "";
}

function safeEmailHref(value) {
  const email = cleanText(value, 254).toLocaleLowerCase("uk");
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? `mailto:${email}` : "";
}

function renderContactCard(card, value) {
  if (!(card instanceof HTMLElement)) return false;
  const contact = normalizedContact(value);
  const visible = Object.values(contact).some(Boolean);
  card.hidden = !visible;
  if (!visible) return false;
  const name = card.querySelector("[data-contact-name]");
  const description = card.querySelector("[data-contact-description]");
  const phone = card.querySelector("[data-contact-phone]");
  const email = card.querySelector("[data-contact-email]");
  if (name) name.textContent = contact.name || "Інформацію буде додано";
  if (description) {
    description.textContent = contact.description;
    description.hidden = !contact.description;
  }
  const phoneHref = safePhoneHref(contact.phone);
  if (phone instanceof HTMLAnchorElement) {
    phone.hidden = !phoneHref;
    phone.href = phoneHref || "#";
    phone.textContent = contact.phone;
  }
  const emailHref = safeEmailHref(contact.email);
  if (email instanceof HTMLAnchorElement) {
    email.hidden = !emailHref;
    email.href = emailHref || "#";
    email.textContent = contact.email;
  }
  return true;
}

async function synchronizeContacts() {
  if (!elements.contactsStatus || !elements.contactsGrid) return;
  const apiUrl = normalizeContactsApiUrl(config.contactsApiUrl, window.location.href);
  if (!apiUrl) {
    elements.contactsStatus.textContent = "Контакти ще не опубліковано.";
    elements.contactsGrid.hidden = true;
    return;
  }
  elements.contactsStatus.textContent = "Завантажуємо контакти…";
  try {
    const response = await fetch(apiUrl, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body || body.success !== true || !body.profile) throw new Error("invalid contacts");
    const librarianVisible = renderContactCard(elements.librarianContact, body.profile.librarian);
    const assistantVisible = renderContactCard(elements.assistantContact, body.profile.assistant);
    elements.contactsGrid.hidden = !librarianVisible && !assistantVisible;
    elements.contactsStatus.textContent = librarianVisible || assistantVisible
      ? "Контактні дані оновлюються бібліотекарем."
      : "Контакти ще не опубліковано.";
  } catch {
    elements.contactsGrid.hidden = true;
    elements.contactsStatus.textContent = "Контакти тимчасово недоступні. Спробуйте пізніше.";
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
      <span class="collection-symbol" aria-hidden="true">${collection.icon ? uiIcon(collection.icon) : escapeHtml(collection.symbol)}</span>
      <span class="collection-copy"><strong>${escapeHtml(collection.title)}</strong><small>${escapeHtml(collection.description)}</small></span>
      <span class="collection-count">${count.toLocaleString("uk-UA")} матеріалів ${uiIcon("arrow-right")}</span>
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
  const query = state.search; const grade = Number(state.grade);
  const collectionIds = state.collection ? new Set(materialsForCollection(state.collection).map((item) => item.id)) : null;
  const result = materials.filter((item) => {
    if (collectionIds && !collectionIds.has(item.id)) return false;
    if (!matchesMaterialSearch(item, query)) return false;
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
  const fallback = `<span class="cover-fallback"><span>${escapeHtml(item.subject)}</span></span>`;
  if (!item.cover) return fallback;
  return `<img data-cover src="${escapeHtml(item.cover)}" alt="Обкладинка: ${escapeHtml(item.title)}" loading="${large ? "eager" : "lazy"}"><span class="cover-fallback" hidden><span>${escapeHtml(item.subject)}</span></span>`;
}

function bindCoverErrors(root) {
  root.querySelectorAll("img[data-cover]").forEach((image) => image.addEventListener("error", () => {
    image.hidden = true;
    if (image.nextElementSibling) image.nextElementSibling.hidden = false;
  }, { once: true }));
}

function cardMarkup(item) {
  const available = Number(item.availableQuantity) > 0;
  return `<article class="material-card"><button class="cover-wrap cover-button" type="button" data-details="${escapeHtml(item.id)}" aria-label="Відкрити інформацію про ${escapeHtml(item.title)}"><span class="class-badge">${escapeHtml(classLabel(item))}</span>${coverMarkup(item)}</button><div class="card-body">
    <div class="card-kicker"><span>${escapeHtml(item.subject)}</span><span class="availability ${available ? "" : "none"}">${available ? "У наявності" : "Немає"}</span></div>
    <h3>${escapeHtml(item.title)}</h3><p class="author-line">${escapeHtml(item.author)}${item.year ? ` · ${escapeHtml(item.year)}` : ""}</p>
    <div class="card-footer"><div class="card-stock"><span class="quantity"><strong>${escapeHtml(item.quantity)}</strong><span>примірників</span></span><span class="quantity available-quantity${available ? "" : " none"}"><strong>${escapeHtml(item.availableQuantity)}</strong><span>Доступно</span></span></div><button class="details-button" type="button" data-details="${escapeHtml(item.id)}">Детальніше ${uiIcon("arrow-right")}</button></div>
  </div></article>`;
}

function renderChips() {
  const activeCollection = collectionById(state.collection);
  const chips = [["collection", activeCollection ? activeCollection.title : ""], ["search", state.search ? `Пошук: ${state.search}` : ""], ["grade", state.grade ? `${state.grade} клас` : ""], ["rubric", state.rubric], ["subject", state.subject], ["type", state.type], ["available", state.available ? "Лише в наявності" : ""]].filter(([, label]) => label);
  elements.chips.innerHTML = chips.map(([key, label]) => `<span class="filter-chip">${escapeHtml(label)}<button type="button" data-remove="${key}" aria-label="Прибрати фільтр ${escapeHtml(label)}">${uiIcon("x")}</button></span>`).join("");
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

function closeTitleSuggestions() {
  visibleSuggestions = [];
  activeSuggestionIndex = -1;
  elements.suggestions.hidden = true;
  elements.suggestions.innerHTML = "";
  elements.search.setAttribute("aria-expanded", "false");
  elements.search.removeAttribute("aria-activedescendant");
}

function suggestionCoverMarkup(item) {
  if (!item.cover) return `<span class="suggestion-cover-fallback" aria-hidden="true">${escapeHtml((item.title || "?").slice(0, 1))}</span>`;
  return `<img data-cover src="${escapeHtml(item.cover)}" alt="" loading="lazy"><span class="suggestion-cover-fallback" aria-hidden="true" hidden>${escapeHtml((item.title || "?").slice(0, 1))}</span>`;
}

function renderTitleSuggestions() {
  visibleSuggestions = titleSuggestions(materials, elements.search.value, 6);
  activeSuggestionIndex = -1;
  if (!visibleSuggestions.length || document.activeElement !== elements.search) {
    closeTitleSuggestions();
    return;
  }
  elements.suggestions.innerHTML = visibleSuggestions.map((item, index) => `
    <button class="title-suggestion" id="title-suggestion-${index}" type="button" role="option" aria-selected="false" data-title-suggestion="${escapeHtml(item.id)}">
      <span class="suggestion-cover">${suggestionCoverMarkup(item)}</span>
      <span class="suggestion-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml([item.author || "Автор не вказаний", item.year || "Рік не вказаний"].join(" · "))}</small></span>
    </button>`).join("");
  bindCoverErrors(elements.suggestions);
  elements.suggestions.hidden = false;
  elements.search.setAttribute("aria-expanded", "true");
}

function setActiveSuggestion(index) {
  if (!visibleSuggestions.length) return;
  activeSuggestionIndex = (index + visibleSuggestions.length) % visibleSuggestions.length;
  elements.suggestions.querySelectorAll("[role=option]").forEach((option, optionIndex) => {
    const active = optionIndex === activeSuggestionIndex;
    option.setAttribute("aria-selected", String(active));
    if (active) option.scrollIntoView({ block: "nearest" });
  });
  elements.search.setAttribute("aria-activedescendant", `title-suggestion-${activeSuggestionIndex}`);
}

function chooseTitleSuggestion(materialId) {
  const item = materials.find((material) => material.id === materialId);
  if (!item) return;
  elements.search.value = item.title;
  state.search = item.title;
  closeTitleSuggestions();
  resetLimitAndRender();
  showMaterial(item.id);
}

function linksMarkup(item, { loadingDetail = false, detailError = false } = {}) {
  if (loadingDetail) return `<div class="material-links" aria-busy="true"><h3>Посилання</h3><p>Завантажуємо відкриті джерела…</p></div>`;
  if (detailError) return `<div class="material-links"><h3>Посилання</h3><p>Не вдалося завантажити посилання. Спробуйте відкрити картку ще раз.</p></div>`;
  if (!item.links.length) return "";
  return `<div class="material-links"><h3>Посилання</h3><ul>${item.links.map((link) => `<li><a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer"><span>${escapeHtml(link.label)}</span>${uiIcon("external-link")}</a></li>`).join("")}</ul></div>`;
}

function directMaterialUrl(id) {
  return urlWithMaterial(window.location.href, id);
}

function renderMaterialDialog(item, detailState = {}) {
  const directUrl = directMaterialUrl(item.id);
  const orderDestination = materialOrderDestination(
    config.teacherPortalUrl || config.visitsBookingUrl,
    item.id,
    telegramLaunchHash,
    window.location.href,
  );
  const canOrder = Boolean(orderDestination.url) && Number(item.availableQuantity) > 0;
  const secondaryMeta = [item.publisher, item.isbn ? `ISBN ${item.isbn}` : ""].filter(Boolean);
  elements.dialogContent.innerHTML = `<div class="dialog-layout"><div class="dialog-cover">${coverMarkup(item, true)}</div><div class="dialog-copy">
    <p class="dialog-id">${escapeHtml(item.id)} · ${escapeHtml(item.rubric)}</p><h2 id="material-dialog-title">${escapeHtml(item.title)}</h2>
    <p class="dialog-meta">${escapeHtml(item.author)}${item.year ? ` · ${escapeHtml(item.year)} рік` : ""}</p>
    ${secondaryMeta.length ? `<p class="dialog-secondary-meta">${secondaryMeta.map(escapeHtml).join(" · ")}</p>` : ""}
    <div class="dialog-tags"><span>${escapeHtml(classLabel(item))}</span><span>${escapeHtml(item.subject)}</span><span>${escapeHtml(item.type)}</span></div>
    ${stockMarkup(item, detailState)}
    ${linksMarkup(item, detailState)}
    <div class="dialog-order">
      ${canOrder
        ? `${orderDestination.withinTelegram
          ? `<button class="order-material-button" type="button" data-order-material="${escapeHtml(item.id)}">Замовити ${uiIcon("arrow-right")}</button>`
          : `<a class="order-material-button" href="${escapeHtml(orderDestination.url)}" target="_blank" rel="noopener noreferrer">Замовити ${uiIcon("arrow-right")}</a>`}<p>Матеріал буде додано до кошика в кабінеті учителя. Там можна змінити кількість і надіслати замовлення бібліотекарю.</p>`
        : `<span class="order-material-unavailable" aria-disabled="true">Зараз немає доступних примірників для замовлення</span><p>Перевірте картку пізніше — доступність оновлюється з бібліотечної бази.</p>`}
    </div>
    <div class="dialog-actions" aria-label="Дії з карткою">
      <button type="button" data-copy-material="${escapeHtml(item.id)}">Скопіювати посилання</button>
      <button type="button" data-share-material="${escapeHtml(item.id)}">Поділитися</button>
      <button class="report-error-button" type="button" data-report-error="${escapeHtml(item.id)}">Повідомити про помилку</button>
    </div>
    <p class="dialog-note" id="material-dialog-note">Перегляд каталогу відкритий для всіх. Замовлення та їхня історія доступні після входу до кабінету учителя.</p>
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
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const detail = normalizeDetailPayload(await response.json());
    materialDetails.set(id, detail);
    return detail;
  }).finally(() => detailPromises.delete(id));
  detailPromises.set(id, request);
  return request;
}

function showMaterial(id, { updateHistory = true } = {}) {
  const cachedDetail = materialDetails.get(id);
  const summary = materials.find((material) => material.id === id);
  if (!summary && !cachedDetail) return false;
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

function renderLinkedMaterialStatus(id, message, { error = false, retry = false } = {}) {
  elements.dialogContent.innerHTML = `<div class="dialog-copy linked-material-status" ${error ? 'role="alert"' : 'role="status"'}>
    <p class="dialog-id">${escapeHtml(id)}</p>
    <h2 id="material-dialog-title">${error ? "Матеріал не відкрився" : "Завантажуємо матеріал…"}</h2>
    <p id="material-dialog-note">${escapeHtml(message)}</p>
    ${retry ? '<button class="details-button" type="button" data-retry-linked-material>Спробувати ще раз</button>' : ''}
  </div>`;
}

function openLinkedMaterial() {
  const id = materialIdFromUrl(window.location.href);
  if (!id) return false;
  if (showMaterial(id, { updateHistory: false })) return true;
  if (!catalogDetailApiUrl(config.catalogApiUrl, id, window.location.href)) return false;
  currentMaterialId = id;
  renderLinkedMaterialStatus(id, "Отримуємо актуальну картку без очікування повної синхронізації каталогу.");
  if (!elements.dialog.open) elements.dialog.showModal();
  loadMaterialDetail(id).then((detail) => {
    if (currentMaterialId !== id || !elements.dialog.open) return;
    renderMaterialDialog(detail);
  }).catch((error) => {
    if (currentMaterialId !== id || !elements.dialog.open) return;
    const missing = Number(error?.status) === 404;
    renderLinkedMaterialStatus(
      id,
      missing ? "Матеріал із таким CAT-ID не знайдено." : "Не вдалося завантажити картку. Перевірте з’єднання та спробуйте ще раз.",
      { error: true, retry: !missing },
    );
  });
  return true;
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
  const item = materialDetails.get(id) || materials.find((material) => material.id === id);
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

const visitDateFormatter = new Intl.DateTimeFormat("uk-UA", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const visitShortDateFormatter = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short", timeZone: "UTC" });

function localVisitNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZone: "Europe/Kyiv",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function localVisitDate() {
  return localVisitNow().date;
}

function shiftedVisitWeek(weekStart, amount) {
  const dates = visitWeekDates(weekStart);
  if (!dates.length) return "";
  const date = new Date(`${dates[0]}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount * 7);
  return date.toISOString().slice(0, 10);
}

function formatVisitWeekLabel(dates) {
  if (!dates.length) return "";
  return `${visitShortDateFormatter.format(new Date(`${dates[0]}T00:00:00.000Z`))} – ${visitShortDateFormatter.format(new Date(`${dates.at(-1)}T00:00:00.000Z`))}`;
}

function visitSegmentLabel(segment) {
  const day = visitDateFormatter.format(new Date(`${segment.date}T00:00:00.000Z`));
  const prefix = day.charAt(0).toLocaleUpperCase("uk") + day.slice(1);
  const status = segment.status === "free" ? "Вільно" : segment.status === "busy" ? segment.displayName || "Заброньовано" : "Бібліотека зачинена";
  return `${status}: ${prefix}, ${segment.startTime}–${segment.endTime}${segment.status === "free" ? ". Забронювати відвідування" : ""}`;
}

function unavailableVisitReason(segment, now, horizonEnd) {
  const end = visitTimeMinutes(segment.endTime);
  if (segment.date < now.date || (segment.date === now.date && end <= visitTimeMinutes(now.time))) return "Час минув";
  if (segment.date > horizonEnd) return "Поза періодом запису";
  return "Замало часу для запису";
}

function visitSegmentMarkup(segment, now, horizonEnd) {
  let time = `${escapeHtml(segment.startTime)}–${escapeHtml(segment.endTime)}`;
  if (segment.status !== "free") {
    const status = segment.status === "busy" ? segment.displayName || "Заброньовано" : "Зачинено";
    return `<li class="visit-slot" data-status="${segment.status}" aria-label="${escapeHtml(visitSegmentLabel(segment))}"><strong>${time}</strong><span>${escapeHtml(status)}</span></li>`;
  }
  const constraints = { today: now.date, currentTime: now.time, horizonEnd };
  const selection = visitBookingSelection(segment, 40, constraints);
  if (!selection) {
    const reason = unavailableVisitReason(segment, now, horizonEnd);
    return `<li class="visit-slot" data-status="unavailable" aria-label="${escapeHtml(`${reason}: ${visitSegmentLabel(segment)}`)}"><strong>${time}</strong><span>${escapeHtml(reason)}</span></li>`;
  }
  const remainingSegment = { ...segment, startTime: selection.startTime };
  time = `${escapeHtml(remainingSegment.startTime)}–${escapeHtml(remainingSegment.endTime)}`;
  return `<li class="visit-slot" data-status="free"><a data-visit-booking="true" data-visit-date="${segment.date}" data-visit-start="${segment.startTime}" data-visit-end="${segment.endTime}" href="${escapeHtml(visitsBookingUrl(config.visitsBookingUrl, selection, window.location.href))}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(visitSegmentLabel(remainingSegment))}"><strong>${time}</strong><span>Забронювати ${uiIcon("external-link")}</span></a></li>`;
}

function renderVisitSchedule() {
  const dates = visitWeekDates(visitState.weekStart);
  const now = localVisitNow();
  const horizonEnd = visitHorizonEnd(now.date);
  const navigation = visitWeekNavigation(visitState.weekStart, now.date);
  elements.visitPrevWeek.disabled = !navigation.canPrevious;
  elements.visitNextWeek.disabled = !navigation.canNext;
  elements.visitWeekLabel.textContent = formatVisitWeekLabel(dates);
  elements.visitContent.dataset.view = visitState.view;
  document.querySelectorAll("[data-visit-view]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.visitView === visitState.view)));
  if (!visitState.schedule) return;
  const days = dates.map((date) => ({ date, segments: visitSegmentsForDate(visitState.schedule, date) }));
  const hasPublishedHours = days.some((day) => day.segments.length);
  elements.visitEmpty.hidden = hasPublishedHours;
  elements.visitContent.hidden = !hasPublishedHours;
  if (!hasPublishedHours) {
    elements.visitContent.innerHTML = "";
    return;
  }
  elements.visitContent.innerHTML = `<div class="visit-days">${days.map(({ date, segments }) => {
    const dateLabel = visitDateFormatter.format(new Date(`${date}T00:00:00.000Z`));
    const heading = dateLabel.charAt(0).toLocaleUpperCase("uk") + dateLabel.slice(1);
    return `<article class="visit-day${date === localVisitDate() ? " is-today" : ""}">
      <h3><time datetime="${date}">${escapeHtml(heading)}</time>${date === localVisitDate() ? "<span>Сьогодні</span>" : ""}</h3>
      ${segments.length ? `<ul>${segments.map((segment) => visitSegmentMarkup(segment, now, horizonEnd)).join("")}</ul>` : `<p class="visit-day-closed">Бібліотека зачинена</p>`}
    </article>`;
  }).join("")}</div>`;
}

function setVisitStatus(status, message, retry = false) {
  elements.visitStatus.dataset.state = status;
  elements.visitStatus.setAttribute("role", status === "error" ? "alert" : "status");
  elements.visitStatusText.textContent = message;
  elements.visitRetry.hidden = !retry;
}

async function synchronizeVisitSchedule() {
  const dates = visitWeekDates(visitState.weekStart);
  const now = localVisitNow();
  const queryRange = visitScheduleQueryRange(visitState.weekStart, now.date);
  const url = queryRange
    ? visitsPublicApiUrl(config.visitsApiUrl, queryRange.from, queryRange.to, window.location.href)
    : "";
  const requestVersion = ++visitState.requestVersion;
  const navigation = visitWeekNavigation(visitState.weekStart, now.date);
  elements.visitPrevWeek.disabled = !navigation.canPrevious;
  elements.visitNextWeek.disabled = !navigation.canNext;
  elements.visitWeekLabel.textContent = formatVisitWeekLabel(dates);
  if (!url) {
    visitState.schedule = null;
    elements.visitContent.hidden = true;
    elements.visitEmpty.hidden = true;
    elements.visitContent.setAttribute("aria-busy", "false");
    setVisitStatus("error", "Графік тимчасово недоступний. Спробуйте ще раз за кілька хвилин.", false);
    return;
  }
  visitState.loading = true;
  elements.visitContent.hidden = false;
  elements.visitEmpty.hidden = true;
  elements.visitContent.setAttribute("aria-busy", "true");
  elements.visitContent.innerHTML = `<div class="visit-loading" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>`;
  setVisitStatus("loading", "Завантажуємо графік…");
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const schedule = normalizeVisitSchedule(await response.json(), queryRange.from, queryRange.to);
    if (requestVersion !== visitState.requestVersion) return;
    visitState.schedule = schedule;
    renderVisitSchedule();
    setVisitStatus("live", `Графік оновлено · ${formattedUpdatedAt(visitState.schedule.generatedAt)}`);
  } catch {
    if (requestVersion !== visitState.requestVersion) return;
    visitState.schedule = null;
    elements.visitContent.hidden = true;
    elements.visitEmpty.hidden = true;
    setVisitStatus("error", "Графік тимчасово недоступний. Спробуйте ще раз за кілька хвилин.", true);
  } finally {
    if (requestVersion === visitState.requestVersion) {
      visitState.loading = false;
      elements.visitContent.setAttribute("aria-busy", "false");
    }
  }
}

function selectVisitWeek(amount) {
  const today = localVisitDate();
  const navigation = visitWeekNavigation(visitState.weekStart, today);
  if ((amount < 0 && !navigation.canPrevious) || (amount > 0 && !navigation.canNext)) return;
  const next = amount === 0 ? navigation.firstWeek : shiftedVisitWeek(visitState.weekStart, amount);
  if (!next || next === visitState.weekStart) return;
  visitState.weekStart = next;
  synchronizeVisitSchedule();
}

function updatePrimaryNavigation() {
  const hash = window.location.hash;
  const activeId = hash === "#visit-schedule"
    ? "visit-schedule"
    : hash === "#how-it-works"
      ? "how-it-works"
      : hash === "#contacts"
        ? "contacts"
        : "catalog";
  document.querySelectorAll("[data-primary-section]").forEach((link) => {
    const active = link.dataset.primarySection === activeId;
    link.classList.toggle("nav-active", active);
    if (active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  });
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

document.querySelector("#heroSearchForm").addEventListener("submit", (event) => { event.preventDefault(); state.search = elements.search.value; closeTitleSuggestions(); resetLimitAndRender(); document.querySelector("#catalog").scrollIntoView({ behavior: "smooth" }); });
elements.search.addEventListener("input", () => { state.search = elements.search.value; resetLimitAndRender(); renderTitleSuggestions(); });
elements.search.addEventListener("focus", renderTitleSuggestions);
elements.search.addEventListener("blur", () => window.setTimeout(closeTitleSuggestions, 120));
elements.search.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" && visibleSuggestions.length) { event.preventDefault(); setActiveSuggestion(activeSuggestionIndex + 1); }
  else if (event.key === "ArrowUp" && visibleSuggestions.length) { event.preventDefault(); setActiveSuggestion(activeSuggestionIndex - 1); }
  else if (event.key === "Enter" && activeSuggestionIndex >= 0) { event.preventDefault(); chooseTitleSuggestion(visibleSuggestions[activeSuggestionIndex].id); }
  else if (event.key === "Escape") closeTitleSuggestions();
});
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
  const suggestion = event.target.closest("[data-title-suggestion]"); if (suggestion) chooseTitleSuggestion(suggestion.dataset.titleSuggestion);
  const detail = event.target.closest("[data-details]"); if (detail) showMaterial(detail.dataset.details);
  const retryLinkedMaterial = event.target.closest("[data-retry-linked-material]"); if (retryLinkedMaterial) openLinkedMaterial();
  const collection = event.target.closest("[data-collection]"); if (collection) activateCollection(collection.dataset.collection);
  const copyMaterial = event.target.closest("[data-copy-material]"); if (copyMaterial) shareOrCopyMaterial(copyMaterial.dataset.copyMaterial, "copy");
  const shareMaterial = event.target.closest("[data-share-material]"); if (shareMaterial) shareOrCopyMaterial(shareMaterial.dataset.shareMaterial, "share");
  const reportError = event.target.closest("[data-report-error]"); if (reportError) shareOrCopyMaterial(reportError.dataset.reportError, "report");
  const orderMaterial = event.target.closest("[data-order-material]");
  if (orderMaterial) {
    const destination = materialOrderDestination(
      config.teacherPortalUrl || config.visitsBookingUrl,
      orderMaterial.dataset.orderMaterial,
      telegramLaunchHash,
      window.location.href,
    );
    if (destination.withinTelegram) window.location.assign(destination.url);
  }
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
  if (linkedId) openLinkedMaterial();
  else closeMaterial({ fromHistory: true });
});
elements.filterToggle.addEventListener("click", () => { const open = elements.filters.classList.toggle("open"); elements.filterToggle.setAttribute("aria-expanded", String(open)); });
elements.visitRetry.addEventListener("click", synchronizeVisitSchedule);
elements.visitPrevWeek.addEventListener("click", () => selectVisitWeek(-1));
elements.visitNextWeek.addEventListener("click", () => selectVisitWeek(1));
elements.visitThisWeek.addEventListener("click", () => selectVisitWeek(0));
document.querySelectorAll("[data-visit-view]").forEach((button) => button.addEventListener("click", () => {
  visitState.view = button.dataset.visitView === "list" ? "list" : "week";
  renderVisitSchedule();
}));
elements.visitContent.addEventListener("click", (event) => {
  const link = event.target instanceof Element ? event.target.closest("[data-visit-booking]") : null;
  if (!(link instanceof HTMLAnchorElement)) return;
  const now = localVisitNow();
  const selection = visitBookingSelection({
    date: link.dataset.visitDate,
    startTime: link.dataset.visitStart,
    endTime: link.dataset.visitEnd,
    status: "free",
  }, 40, { today: now.date, currentTime: now.time, horizonEnd: visitHorizonEnd(now.date) });
  const url = visitsBookingUrl(config.visitsBookingUrl, selection, window.location.href);
  if (!url) {
    event.preventDefault();
    renderVisitSchedule();
    setVisitStatus("live", "Графік оновлено · оберіть інший вільний час");
    return;
  }
  link.href = url;
});
window.addEventListener("hashchange", updatePrimaryNavigation);

const snapshot = localSnapshot();
fallbackLocationCount = datasetStats(snapshot).locations;
applyDataset(snapshot, { locations: fallbackLocationCount });
synchronizeCatalog();
visitState.weekStart = startOfVisitWeek(localVisitDate());
updatePrimaryNavigation();
synchronizeVisitSchedule();
synchronizeContacts();
const refreshMinutes = Math.min(60, Math.max(5, nonNegativeInteger(config.refreshMinutes) || 10));
if (normalizeCatalogApiUrl(config.catalogApiUrl, window.location.href)) window.setInterval(synchronizeCatalog, refreshMinutes * 60 * 1000);
if (normalizeVisitsApiUrl(config.visitsApiUrl, window.location.href)) window.setInterval(synchronizeVisitSchedule, refreshMinutes * 60 * 1000);
if (normalizeContactsApiUrl(config.contactsApiUrl, window.location.href)) window.setInterval(synchronizeContacts, refreshMinutes * 60 * 1000);
window.setInterval(() => { if (visitState.schedule) renderVisitSchedule(); }, 60 * 1000);
}
