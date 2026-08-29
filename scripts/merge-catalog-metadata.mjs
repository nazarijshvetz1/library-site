import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FIRST_PARTY_PUBLISHERS = {
  "ranok.com.ua": "Ранок",
  "rostok.org.ua": "РОСТОК",
  "aston.te.ua": "Астон",
  "geneza.ua": "Генеза",
  "gramota.kiev.ua": "Грамота",
  "osvita-dim.com.ua": "Освіта",
  "bohdan-books.com": "Навчальна книга — Богдан",
  "ula-books.com.ua": "УЛА",
  "svit.gov.ua": "Світ",
};

const TITLE_STOP_WORDS = new Set([
  "та", "і", "й", "у", "в", "на", "для", "до", "з", "із", "за",
  "the", "and", "for", "with", "book", "книга", "клас", "класи",
]);

const PUBLISHER_TITLE_ALIASES = new Map([
  ["Ранок", ["видавництво ранок", "ранок"]],
  ["Основа", ["видавнича група основа", "вг основа", "основа"]],
  ["Генеза", ["генеза"]],
  ["Гімназія", ["гімназія"]],
  ["Астон", ["видавництво астон", "астон"]],
  ["Грамота", ["видавництво грамота", "грамота"]],
  ["Освіта", ["видавничий дім освіта", "видавництво освіта"]],
  ["Навчальна книга — Богдан", ["навчальна книга богдан", "богдан"]],
  ["Підручники і посібники", ["підручники і посібники"]],
  ["Картографія", ["картографія"]],
  ["Мандрівець", ["мандрівець", "мандрiвець"]],
  ["Оріон", ["видавництво оріон", "оріон"]],
  ["Літера", ["видавництво літера", "літера лтд"]],
  ["Світич", ["видавництво світич", "світич"]],
  ["УЛА", ["видавництво ула"]],
  ["Школа", ["видавництво школа"]],
  ["Весна", ["видавництво весна"]],
  ["Букрек", ["видавництво букрек", "букрек"]],
  ["РОСТОК", ["видавництво росток", "росток"]],
  ["Pearson Education", ["pearson education", "pearson"]],
  ["Cambridge University Press & Assessment", ["cambridge university press", "cambridge university press assessment"]],
  ["Oxford University Press", ["oxford university press"]],
  ["MM Publications", ["mm publications"]],
  ["Macmillan", ["macmillan"]],
  ["Hodder Education", ["hodder education"]],
  ["Hueber", ["hueber"]],
  ["Ernst Klett Sprachen", ["ernst klett", "klett sprachen"]],
  ["CLE International", ["cle international"]],
  ["Edelsa", ["edelsa"]],
  ["Фабула", ["видавництво фабула", "фабула"]],
  ["Видавництво Старого Лева", ["видавництво старого лева"]],
]);

const privateRoot = path.resolve(".migration-private");
const snapshotPath = path.resolve(process.argv[2] || path.join(privateRoot, "catalog-metadata-live-20260829.json"));
const officialPath = path.resolve(process.argv[3] || path.join(privateRoot, "catalog-metadata-research-20260829.json"));
const linkedPath = path.resolve(process.argv[4] || path.join(privateRoot, "catalog-linked-metadata-clean-v2-20260829.json"));
const outputPath = path.resolve(process.argv[5] || path.join(privateRoot, "catalog-metadata-merged-20260829.json"));
const isbnPublisherPath = path.resolve(process.argv[6] || path.join(privateRoot, "catalog-publishers-by-isbn-20260829.json"));
const manifestPath = outputPath.replace(/\.json$/u, ".apply.json");
const auxiliaryPaths = {
  url: path.join(privateRoot, "isbn-url-candidates.json"),
  yakaboo: path.join(privateRoot, "isbn-yakaboo-candidates.json"),
  official: path.join(privateRoot, "isbn-official-candidates.json"),
  automatic: path.join(privateRoot, "isbn-url-candidates-auto.json"),
};

const [snapshot, official, linked, isbnPublishers, urlCandidates, yakabooCandidates, officialCandidates, automaticCandidates] = await Promise.all([
  loadJson(snapshotPath),
  loadJson(officialPath),
  loadJson(linkedPath),
  loadJson(isbnPublisherPath),
  loadJson(auxiliaryPaths.url),
  loadJson(auxiliaryPaths.yakaboo),
  loadJson(auxiliaryPaths.official),
  loadJson(auxiliaryPaths.automatic),
]);

const materials = Array.isArray(snapshot.materials) ? snapshot.materials : [];
assertCompleteInput("snapshot", materials, snapshot.summary?.activeMaterials, 1291);
assertCompleteInput("official research", official.records, official.summary?.total, materials.length);
assertCompleteInput("linked research", linked.records, linked.summary?.total, 1146);
if (official.complete !== true || linked.complete !== true || isbnPublishers.complete !== true) {
  throw new Error("Metadata merge requires complete official, clean-v2 linked, and exact-ISBN publisher research inputs.");
}
assertCompleteInput(
  "exact-ISBN publisher research",
  isbnPublishers.records,
  isbnPublishers.summary?.researched,
  isbnPublishers.summary?.total,
);

const materialById = uniqueMap(materials, "materialId", "snapshot materials");
const officialById = uniqueMap(official.records, "materialId", "official research");
const linkedById = uniqueMap(linked.records, "materialId", "linked research");
const isbnPublisherById = uniqueMap(isbnPublishers.records, "materialId", "exact-ISBN publisher research");
for (const id of officialById.keys()) if (!materialById.has(id)) throw new Error(`Unknown official material ${id}.`);
for (const id of linkedById.keys()) if (!materialById.has(id)) throw new Error(`Unknown linked material ${id}.`);
for (const id of isbnPublisherById.keys()) if (!materialById.has(id)) throw new Error(`Unknown exact-ISBN publisher material ${id}.`);

const urlById = uniqueMap(urlCandidates.records ?? [], "materialId", "URL candidates");
const yakabooById = uniqueMap(yakabooCandidates.candidates ?? [], "materialId", "Yakaboo candidates");
const exactById = uniqueMap(officialCandidates.candidates ?? [], "materialId", "exact candidates");
const automaticById = uniqueMap(automaticCandidates.items ?? [], "materialId", "automatic candidates");
const existingEditionIndex = editionIndex(materials, "isbn");
const existingPublisherIndex = editionIndex(materials, "publisher");
const rejectedPublishers = [];

const records = materials.map((material) => {
  const isbnCandidates = [];
  const publisherCandidates = [];
  const exact = exactById.get(material.materialId);
  const url = urlById.get(material.materialId);
  const yakaboo = yakabooById.get(material.materialId);
  const automatic = automaticById.get(material.materialId);
  const linkedRecord = linkedById.get(material.materialId);
  const officialRecord = officialById.get(material.materialId);
  const isbnPublisherRecord = isbnPublisherById.get(material.materialId);

  addIsbn(isbnCandidates, exact?.isbn13, {
    confidence: "exact", tier: 110, provider: "verified_exact_candidate",
    url: exact?.sourceUrl, title: exact?.title, direct: true,
  });
  addIsbn(isbnCandidates, url?.isbn13, {
    confidence: url?.status === "exact" ? "exact" : "doubtful",
    tier: url?.status === "exact" ? 100 : 66,
    provider: "linked_url_evidence", url: url?.sourceUrl, title: url?.sourcePageTitle,
    direct: true,
  });
  addIsbn(isbnCandidates, yakaboo?.isbn13, {
    confidence: yakaboo?.status === "exact" ? "exact" : "doubtful",
    tier: yakaboo?.status === "exact" ? 102 : 70,
    provider: "yakaboo", url: yakaboo?.evidenceUrl, title: yakaboo?.source?.title,
    direct: true,
  });
  addIsbn(isbnCandidates, automatic?.proposedIsbn13, {
    confidence: automatic?.status === "exact_url_evidence" ? "exact" : "doubtful",
    tier: automatic?.status === "exact_url_evidence" ? 98 : 64,
    provider: "catalog_url_isbn", url: automatic?.evidence?.[0]?.url, title: automatic?.title,
    direct: true,
  });
  addIsbn(isbnCandidates, linkedRecord?.proposedIsbn, {
    confidence: linkedRecord?.confidence === "probable" ? "probable" : "doubtful",
    tier: linkedRecord?.confidence === "probable" ? 94 : 76,
    provider: "catalog_link_clean_v2", url: linkedRecord?.sourceUrl, title: linkedRecord?.sourceTitle,
    host: linkedRecord?.sourceHost, score: linkedRecord?.score, direct: true,
  });
  addIsbn(isbnCandidates, officialRecord?.proposedIsbn, {
    confidence: normalizeConfidence(officialRecord?.confidence),
    tier: officialRecord?.isbnSeed && officialRecord.isbnSeed !== "existing" ? 72
      : officialRecord?.sourceProvider === "google_books" ? 82 : 74,
    provider: officialRecord?.sourceProvider || "bibliographic_api",
    url: officialRecord?.sourceUrl, title: officialRecord?.matchTitle,
    score: officialRecord?.score, direct: Boolean(officialRecord?.isbnSeed),
  });

  const editionKey = materialEditionKey(material);
  const inheritedIsbns = existingEditionIndex.get(editionKey) ?? [];
  const uniqueInheritedIsbns = [...new Set(inheritedIsbns.map((item) => compactIsbn(item.value)).filter(validIsbn13))];
  if (uniqueInheritedIsbns.length === 1) {
    addIsbn(isbnCandidates, uniqueInheritedIsbns[0], {
      confidence: "exact", tier: 108, provider: "catalog_exact_edition",
      title: material.title, direct: true,
    });
  }

  for (const link of material.links ?? []) {
    const host = safeHost(link.url);
    const inferred = FIRST_PARTY_PUBLISHERS[host];
    if (inferred) addPublisher(publisherCandidates, inferred, {
      confidence: "exact", tier: 112, provider: "publisher_first_party_domain",
      url: link.url, title: material.title, host, direct: true,
    }, rejectedPublishers, material.materialId);
  }
  for (const inferred of publishersFromSourceTitle(linkedRecord?.sourceTitle)) {
    addPublisher(publisherCandidates, inferred, {
      confidence: linkedRecord?.confidence === "probable" ? "probable" : "doubtful",
      tier: linkedRecord?.confidence === "probable" ? 98 : 80,
      provider: "catalog_link_source_title", url: linkedRecord?.sourceUrl,
      title: linkedRecord?.sourceTitle, host: linkedRecord?.sourceHost,
      score: linkedRecord?.score, direct: true,
    }, rejectedPublishers, material.materialId);
  }
  const normalizedLinkedPublisher = normalizePublisher(linkedRecord?.proposedPublisher);
  if (normalizedLinkedPublisher && publisherSupportedByTitle(normalizedLinkedPublisher, linkedRecord?.sourceTitle)) {
    addPublisher(publisherCandidates, normalizedLinkedPublisher, {
      confidence: linkedRecord?.confidence === "probable" ? "probable" : "doubtful",
      tier: linkedPublisherTier(linkedRecord), provider: "catalog_link_clean_v2",
      url: linkedRecord?.sourceUrl, title: linkedRecord?.sourceTitle,
      host: linkedRecord?.sourceHost, score: linkedRecord?.score, direct: true,
      associatedIsbn: linkedRecord?.proposedIsbn,
    }, rejectedPublishers, material.materialId);
  } else if (text(linkedRecord?.proposedPublisher)) {
    rejectedPublishers.push({
      materialId: material.materialId,
      rawValue: text(linkedRecord.proposedPublisher),
      reason: "marketplace_publisher_not_corroborated_by_source_title",
      sourceUrl: linkedRecord.sourceUrl || "",
    });
  }
  const officialPublisherProvenanceSafe = !officialRecord?.isbnSeed || officialRecord.isbnSeed === "existing";
  if (officialPublisherProvenanceSafe) {
    addPublisher(publisherCandidates, officialRecord?.proposedPublisher, {
      confidence: normalizeConfidence(officialRecord?.confidence),
      tier: officialRecord?.sourceProvider === "google_books" ? 82 : 74,
      provider: officialRecord?.sourceProvider || "bibliographic_api",
      url: officialRecord?.sourceUrl, title: officialRecord?.matchTitle,
      score: officialRecord?.score, associatedIsbn: officialRecord?.proposedIsbn,
    }, rejectedPublishers, material.materialId);
  }
  const inheritedPublishers = existingPublisherIndex.get(editionKey) ?? [];
  const uniqueInheritedPublishers = [...new Set(inheritedPublishers.map((item) => normalizePublisher(item.value)).filter(Boolean))];
  if (uniqueInheritedPublishers.length === 1) {
    addPublisher(publisherCandidates, uniqueInheritedPublishers[0], {
      confidence: "exact", tier: 108, provider: "catalog_exact_edition",
      title: material.title, direct: true,
    }, rejectedPublishers, material.materialId);
  }

  const rejectedEvidence = [];
  const safeIsbnCandidates = deduplicateCandidates(isbnCandidates).filter((item) => {
    const compatible = evidenceCompatible(material, item);
    if (!compatible) rejectedEvidence.push(`Rejected ${item.sourceProvider} ISBN evidence because the linked edition role, series, or level conflicts.`);
    return compatible;
  });
  const isbnDecision = material.isbn ? existingDecision(material.isbn) : chooseCandidate(safeIsbnCandidates, "isbn");
  const selectedIsbn = isbnDecision.action === "set" || isbnDecision.action === "preserve_existing"
    ? compactIsbn(isbnDecision.selectedValue)
    : "";
  for (const verifiedPublisher of verifiedEditionPublishers(material, selectedIsbn)) {
    addPublisher(publisherCandidates, verifiedPublisher.value, {
      confidence: verifiedPublisher.confidence || "exact",
      tier: 120,
      provider: verifiedPublisher.provider,
      url: verifiedPublisher.sourceUrl,
      title: verifiedPublisher.sourceTitle,
      associatedIsbn: selectedIsbn,
      exactIsbnMatch: Boolean(selectedIsbn),
      direct: true,
    }, rejectedPublishers, material.materialId);
  }
  if (isbnPublisherRecord) {
    const researchedIsbn = compactIsbn(isbnPublisherRecord.isbn);
    if (selectedIsbn && researchedIsbn === selectedIsbn) {
      for (const exactPublisher of isbnPublisherRecord.candidates ?? []) {
        addPublisher(publisherCandidates, exactPublisher.value, {
          confidence: "probable",
          tier: 96,
          provider: exactPublisher.provider,
          url: exactPublisher.sourceUrl,
          title: exactPublisher.sourceTitle,
          exactIsbnMatch: true,
        }, rejectedPublishers, material.materialId);
      }
    } else {
      rejectedEvidence.push(`Rejected exact-ISBN publisher evidence because researched ISBN ${researchedIsbn || "(blank)"} does not match the selected ISBN.`);
    }
  }
  const safePublisherCandidates = deduplicateCandidates(publisherCandidates).filter((item) => {
    const associatedIsbnMatches = !item.associatedIsbn || selectedIsbn === item.associatedIsbn;
    const compatible = associatedIsbnMatches && (item.exactIsbnMatch || evidenceCompatible(material, item));
    if (!compatible) rejectedEvidence.push(`Rejected ${item.sourceProvider} publisher evidence because the linked edition role, series, or level conflicts.`);
    return compatible;
  });

  return {
    materialId: material.materialId,
    fingerprint: fingerprint(material),
    expected: {
      title: material.title,
      author: material.author,
      year: material.year,
      classFrom: material.classFrom,
      classTo: material.classTo,
      publicationType: material.publicationType,
      isbn: material.isbn,
      publisher: material.publisher,
      totalQuantity: material.totalQuantity,
    },
    isbnCandidates: safeIsbnCandidates,
    publisherCandidates: safePublisherCandidates,
    decisions: {
      isbn: isbnDecision,
      publisher: material.publisher ? existingDecision(material.publisher) : chooseCandidate(safePublisherCandidates, "publisher"),
    },
    warnings: rejectedEvidence,
  };
});

resolveIncompatibleIsbnCollisions(records, materialById);
propagatePublisherByIsbn(records, rejectedPublishers);

const counters = summarize(records, materials, rejectedPublishers);
const document = {
  schemaVersion: 2,
  policyVersion: "catalog-metadata-merge-v1",
  generatedAt: new Date().toISOString(),
  sourceSnapshot: await fileDescriptor(snapshotPath, materials.length),
  inputs: [
    { kind: "official_api", ...(await fileDescriptor(officialPath, official.records.length)), complete: official.complete },
    { kind: "linked_pages_clean_v2", ...(await fileDescriptor(linkedPath, linked.records.length)), complete: linked.complete },
    { kind: "exact_isbn_publisher_api", ...(await fileDescriptor(isbnPublisherPath, isbnPublishers.records.length)), complete: isbnPublishers.complete },
  ],
  summary: counters,
  records: records.map(({ isbnCandidates, publisherCandidates, ...record }) => ({
    ...record,
    evidence: [...isbnCandidates, ...publisherCandidates],
  })),
  rejectedPublisherSamples: rejectedPublishers.slice(0, 40),
};
const manifest = {
  schemaVersion: 1,
  policyVersion: document.policyVersion,
  generatedAt: document.generatedAt,
  sourceSnapshotSha256: document.sourceSnapshot.sha256,
  records: document.records.flatMap((record) => {
    const set = {};
    const audit = {};
    for (const field of ["isbn", "publisher"]) {
      const decision = record.decisions[field];
      if (decision.action !== "set") continue;
      set[field] = decision.selectedValue;
      audit[field] = {
        confidence: decision.confidence,
        sourceProvider: decision.sourceProvider,
        sourceUrl: decision.sourceUrl,
        sourceTitle: decision.sourceTitle,
        reasonCode: decision.reasonCode,
      };
    }
    return Object.keys(set).length ? [{
      materialId: record.materialId,
      fingerprint: record.fingerprint,
      expected: {
        title: record.expected.title,
        author: record.expected.author,
        year: record.expected.year,
        isbn: record.expected.isbn,
        publisher: record.expected.publisher,
      },
      set,
      audit,
    }] : [];
  }),
};
manifest.mergeSha256 = sha256(JSON.stringify(document));
await writeFile(outputPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ outputPath, manifestPath, summary: counters }, null, 2));

function addIsbn(candidates, value, evidence) {
  const normalized = compactIsbn(value);
  if (!validIsbn13(normalized)) return;
  candidates.push(candidate("isbn", normalized, evidence));
}

function addPublisher(candidates, value, evidence, rejected, materialId) {
  if (!text(value)) return;
  const normalized = normalizePublisher(value);
  if (!normalized) {
    rejected.push({ materialId, rawValue: text(value), reason: "unsafe_or_non_bibliographic_publisher", sourceUrl: evidence.url || "" });
    return;
  }
  candidates.push(candidate("publisher", normalized, { ...evidence, rawValue: text(value) }));
}

function candidate(field, value, evidence) {
  return {
    evidenceId: sha256(`${field}|${value}|${evidence.provider || ""}|${evidence.url || ""}`).slice(0, 16),
    field,
    rawValue: evidence.rawValue || value,
    normalizedValue: value,
    confidence: normalizeConfidence(evidence.confidence),
    tier: Number(evidence.tier) || 0,
    sourceProvider: text(evidence.provider),
    sourceHost: text(evidence.host) || safeHost(evidence.url),
    sourceUrl: safeHttps(evidence.url),
    sourceTitle: text(evidence.title),
    score: Number.isFinite(Number(evidence.score)) ? Number(evidence.score) : null,
    directCatalogLink: Boolean(evidence.direct),
    exactIsbnMatch: Boolean(evidence.exactIsbnMatch),
    associatedIsbn: validIsbn13(compactIsbn(evidence.associatedIsbn)) ? compactIsbn(evidence.associatedIsbn) : "",
  };
}

function deduplicateCandidates(candidates) {
  const output = new Map();
  for (const item of candidates) {
    const key = `${item.field}|${item.normalizedValue}|${item.sourceProvider}|${item.sourceUrl}`;
    const current = output.get(key);
    if (!current || item.tier > current.tier) output.set(key, item);
  }
  return [...output.values()];
}

function chooseCandidate(input, field) {
  const candidates = deduplicateCandidates(input);
  if (!candidates.length) return skippedDecision("skip_no_match", "no_safe_candidate");
  const groups = new Map();
  for (const item of candidates) {
    const group = groups.get(item.normalizedValue) ?? [];
    group.push(item);
    groups.set(item.normalizedValue, group);
  }
  const ranked = [...groups.entries()].map(([value, evidence]) => {
    const best = [...evidence].sort(compareEvidence)[0];
    const hosts = new Set(evidence.map((item) => item.sourceHost || item.sourceProvider).filter(Boolean));
    return {
      value,
      evidence,
      best,
      tier: best.tier,
      independentSupport: hosts.size,
      score: Number(best.score) || 0,
    };
  }).sort(compareGroups);
  const top = ranked[0];
  const next = ranked[1];
  if (next && top.tier === next.tier && top.independentSupport === next.independentSupport && Math.abs(top.score - next.score) < 0.05) {
    return skippedDecision("skip_conflict", `${field}_candidates_tied`, ranked.slice(0, 5).map((item) => item.value));
  }
  return {
    action: "set",
    selectedValue: top.value,
    confidence: top.best.confidence,
    evidenceIds: top.evidence.map((item) => item.evidenceId),
    sourceProvider: top.best.sourceProvider,
    sourceUrl: top.best.sourceUrl,
    sourceTitle: top.best.sourceTitle,
    reasonCode: top.best.directCatalogLink ? "direct_catalog_evidence" : "bibliographic_evidence",
    ranking: { tier: top.tier, independentSupport: top.independentSupport, score: top.score },
  };
}

function existingDecision(value) {
  return { action: "preserve_existing", selectedValue: value, confidence: "existing", evidenceIds: [], reasonCode: "existing_nonempty_field", ranking: null };
}

function skippedDecision(action, reasonCode, conflicts = []) {
  return { action, selectedValue: null, confidence: null, evidenceIds: [], reasonCode, conflicts, ranking: null };
}

function resolveIncompatibleIsbnCollisions(records, materialById) {
  const groups = new Map();
  for (const record of records) {
    const decision = record.decisions.isbn;
    const value = decision.action === "preserve_existing" || decision.action === "set" ? compactIsbn(decision.selectedValue) : "";
    if (!value) continue;
    const group = groups.get(value) ?? [];
    group.push(record);
    groups.set(value, group);
  }
  for (const [isbn, group] of groups) {
    for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
        const left = group[leftIndex];
        const right = group[rightIndex];
        if (compatibleMaterials(materialById.get(left.materialId), materialById.get(right.materialId))) continue;
        const leftExisting = left.decisions.isbn.action === "preserve_existing";
        const rightExisting = right.decisions.isbn.action === "preserve_existing";
        if (leftExisting && !rightExisting) quarantine(right, isbn, left.materialId);
        else if (rightExisting && !leftExisting) quarantine(left, isbn, right.materialId);
        else if (!leftExisting && !rightExisting) {
          const leftTier = left.decisions.isbn.ranking?.tier ?? 0;
          const rightTier = right.decisions.isbn.ranking?.tier ?? 0;
          if (leftTier > rightTier + 5) quarantine(right, isbn, left.materialId);
          else if (rightTier > leftTier + 5) quarantine(left, isbn, right.materialId);
          else {
            quarantine(left, isbn, right.materialId);
            quarantine(right, isbn, left.materialId);
          }
        }
      }
    }
  }
}

function quarantine(record, isbn, conflictMaterialId) {
  if (record.decisions.isbn.action !== "set") return;
  record.decisions.isbn = skippedDecision("skip_conflict", "incompatible_shared_isbn", [isbn, conflictMaterialId]);
  record.warnings.push(`ISBN ${isbn} conflicts with ${conflictMaterialId}.`);
}

function propagatePublisherByIsbn(records, rejected) {
  const groups = new Map();
  for (const record of records) {
    const isbnDecision = record.decisions.isbn;
    const isbn = isbnDecision.action === "preserve_existing" || isbnDecision.action === "set" ? compactIsbn(isbnDecision.selectedValue) : "";
    if (!isbn) continue;
    const group = groups.get(isbn) ?? [];
    group.push(record);
    groups.set(isbn, group);
  }
  for (const [isbn, group] of groups) {
    const publishers = [...new Set(group.flatMap((record) => {
      const decision = record.decisions.publisher;
      return decision.action === "preserve_existing" || decision.action === "set" ? [normalizePublisher(decision.selectedValue)] : [];
    }).filter(Boolean))];
    if (publishers.length !== 1) continue;
    for (const record of group) {
      if (record.decisions.publisher.action !== "skip_no_match") continue;
      addPublisher(record.publisherCandidates, publishers[0], {
        confidence: "exact", tier: 115, provider: "catalog_shared_isbn",
        title: record.expected.title, direct: true,
      }, rejected, record.materialId);
      record.decisions.publisher = chooseCandidate(record.publisherCandidates, "publisher");
      record.decisions.publisher.reasonCode = `publisher_shared_by_isbn_${isbn}`;
    }
  }
}

function compatibleMaterials(left, right) {
  if (!left || !right) return false;
  if (role(left.title, left.publicationType) !== role(right.title, right.publicationType)) return false;
  if (normalizedText(left.title) === normalizedText(right.title)) return true;
  const leftTokens = titleTokens(left.title);
  const rightTokens = titleTokens(right.title);
  const coverage = Math.max(tokenCoverage(leftTokens, rightTokens), tokenCoverage(rightTokens, leftTokens));
  if (coverage < 0.55) return false;
  const leftAuthors = titleTokens(left.author);
  const rightAuthors = titleTokens(right.author);
  if (leftAuthors.length && rightAuthors.length && Math.max(tokenCoverage(leftAuthors, rightAuthors), tokenCoverage(rightAuthors, leftAuthors)) < 0.34) return false;
  return true;
}

function summarize(records, materials, rejected) {
  const selectedIsbn = records.filter((record) => record.decisions.isbn.action === "set");
  const selectedPublisher = records.filter((record) => record.decisions.publisher.action === "set");
  const touched = records.filter((record) => record.decisions.isbn.action === "set" || record.decisions.publisher.action === "set");
  const confidence = (field, value) => records.filter((record) => record.decisions[field].action === "set" && record.decisions[field].confidence === value).length;
  const conflict = records.filter((record) => record.decisions.isbn.action === "skip_conflict" || record.decisions.publisher.action === "skip_conflict").length;
  return {
    materials: materials.length,
    physicalCopies: materials.reduce((total, material) => total + Number(material.totalQuantity || 0), 0),
    before: {
      isbn: materials.filter((material) => text(material.isbn)).length,
      publisher: materials.filter((material) => text(material.publisher)).length,
    },
    selected: {
      isbn: selectedIsbn.length,
      publisher: selectedPublisher.length,
      both: records.filter((record) => record.decisions.isbn.action === "set" && record.decisions.publisher.action === "set").length,
      materialsTouched: touched.length,
      physicalCopiesTouched: touched.reduce((total, record) => total + Number(record.expected.totalQuantity || 0), 0),
    },
    predicted: {
      isbn: materials.filter((material) => text(material.isbn)).length + selectedIsbn.length,
      publisher: materials.filter((material) => text(material.publisher)).length + selectedPublisher.length,
    },
    byConfidence: {
      isbn: { exact: confidence("isbn", "exact"), probable: confidence("isbn", "probable"), doubtful: confidence("isbn", "doubtful") },
      publisher: { exact: confidence("publisher", "exact"), probable: confidence("publisher", "probable"), doubtful: confidence("publisher", "doubtful") },
    },
    skipped: {
      noIsbnMatch: records.filter((record) => !text(record.expected.isbn) && record.decisions.isbn.action === "skip_no_match").length,
      noPublisherMatch: records.filter((record) => !text(record.expected.publisher) && record.decisions.publisher.action === "skip_no_match").length,
      conflict,
      unsafePublisherEvidence: rejected.length,
    },
    safety: {
      selectedInvalidIsbn: selectedIsbn.filter((record) => !validIsbn13(record.decisions.isbn.selectedValue)).length,
      existingFieldOverwrite: records.filter((record) => text(record.expected.isbn) && record.decisions.isbn.action === "set" || text(record.expected.publisher) && record.decisions.publisher.action === "set").length,
      selectedWithoutEvidence: records.filter((record) => record.decisions.isbn.action === "set" && !record.decisions.isbn.evidenceIds.length || record.decisions.publisher.action === "set" && !record.decisions.publisher.evidenceIds.length).length,
    },
  };
}

function editionIndex(materials, field) {
  const map = new Map();
  for (const material of materials) {
    const value = text(material[field]);
    if (!value) continue;
    const key = materialEditionKey(material);
    const group = map.get(key) ?? [];
    group.push({ materialId: material.materialId, value });
    map.set(key, group);
  }
  return map;
}

function materialEditionKey(material) {
  return [
    normalizedText(material.title),
    normalizedText(material.author),
    Number(material.year) || "",
    Number(material.classFrom) || "",
    Number(material.classTo) || "",
    role(material.title, material.publicationType),
  ].join("|");
}

function fingerprint(material) {
  return sha256(JSON.stringify({
    materialId: material.materialId,
    title: material.title,
    author: material.author,
    year: material.year,
    isbn: material.isbn,
    publisher: material.publisher,
  }));
}

function role(title, publicationType) {
  const value = normalizedText(`${title} ${publicationType}`);
  if (/(teacher|вчител|учител|книга для викладача)/u.test(value)) return "teacher";
  if (/(workbook|activity book|робочий зошит|arbeitsbuch)/u.test(value)) return "workbook";
  if (/(coursebook|student|students|kursbuch|підручник)/u.test(value)) return "student";
  return "general";
}

function normalizePublisher(value) {
  let normalized = decodeHtml(text(value)).normalize("NFKC")
    .replace(/[«»„“”]/gu, '"')
    .replace(/[–—]/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/^[-:;,.\s]+|[-:;,.\s]+$/gu, "");
  if (!normalized || normalized.length < 2 || normalized.length > 140) return "";
  if (/[{}<>]/u.test(normalized)) return "";
  if (/(?:pidruchnyk|рік видання|завантажити прайс|усі права захищені|придбати в|інтернет-магазин|книгарня|bookshop|marketplace|including|cookies?|privacy|маркетинг|реклама|стартап|підручника$|french and european publications|master boo$|independently published)/iu.test(normalized)) return "";
  if (normalized.split(/\s+/u).length > 10) return "";
  if (/^(?:book|product|книга|купити|автор|мова|формат|обкладинка|isbn|brand|бренд)$/iu.test(normalized)) return "";
  if (/ранок/iu.test(normalized)) return "Ранок";
  if (/^(?:видавнича група )?основа(?: харків)?$/iu.test(normalized)) return "Основа";
  if (/^(?:видавничий дім )?["']?освіта["']?$/iu.test(normalized)) return "Освіта";
  if (/підручники і посібники/iu.test(normalized)) return "Підручники і посібники";
  if (/^(?:тов )?["']?(?:видавництво )?астон["']?$/iu.test(normalized)) return "Астон";
  if (/^(?:навчальна книга\s*[-:]?\s*)?богдан$/iu.test(normalized)) return "Навчальна книга — Богдан";
  if (/старого лева/iu.test(normalized)) return "Видавництво Старого Лева";
  if (/^картографія(?: київ)?$/iu.test(normalized)) return "Картографія";
  if (/^манд.*вець$/iu.test(normalized)) return "Мандрівець";
  if (/^pearson(?: education(?:,? (?:ltd|limited))?)?$/iu.test(normalized)) return "Pearson Education";
  if (/^cambridge university press(?: and assessment)?$/iu.test(normalized)) return "Cambridge University Press & Assessment";
  if (/^hodder education(?: group)?$/iu.test(normalized)) return "Hodder Education";
  if (/^hueber(?: verlag)?(?: gmbh(?: & co\. kg)?)?$/iu.test(normalized)) return "Hueber";
  if (/^ernst klett sprachen(?: gmbh)?$/iu.test(normalized) || /^klett(?: verlag(?:sservice)?(?: gmbh)?)?$/iu.test(normalized)) return "Ernst Klett Sprachen";
  if (/^cle internat(?:ional)?$/iu.test(normalized)) return "CLE International";
  if (/^edelsa(?: grupo didascalia)?$/iu.test(normalized)) return "Edelsa";
  if (/^metodika$/iu.test(normalized)) return "Методика";
  if (/^mm publica(?:tions)?$/iu.test(normalized)) return "MM Publications";
  if (/^maison langues$/iu.test(normalized)) return "Éditions Maison des Langues";
  if (/^wydawnictw[a-z]*\s+["']?alfa["']?$/iu.test(normalized)) return "Wydawnictwo Alfa";
  if (/^к\.:\s*грайлик$/iu.test(normalized)) return "Грайлик";
  if (/^букрек(?: чернівці)?$/iu.test(normalized)) return "Букрек";
  if (/^а-?ба-?ба-?га-?ла-?ма-?га$/iu.test(normalized)) return "А-БА-БА-ГА-ЛА-МА-ГА";
  normalized = normalized
    .replace(/^тов\s+["']?(?:видавництво\s+)?/iu, "")
    .replace(/^["']+|["']+$/gu, "");
  return normalized;
}

function verifiedEditionPublishers(material, selectedIsbn) {
  const title = normalizedText(material.title);
  const values = [];
  const add = (value, provider, sourceUrl, sourceTitle, confidence = "exact") => values.push({ value, provider, sourceUrl, sourceTitle, confidence });
  if (selectedIsbn.startsWith("978960443")) {
    add(
      "MM Publications",
      "verified_mm_publications_isbn_prefix",
      "https://www.mmpublications.gr/readers-catalogue.pdf",
      `${material.title} · ISBN ${selectedIsbn}`,
    );
  }
  if (selectedIsbn === "9781292125022") {
    add(
      "Pearson Education",
      "verified_pearson_isbn",
      "https://www.pearson.com/en-au/subject-catalog/p/expert-ielts-6-coursebook/GPROG_A100062651008_learnerau-availability/9781292125022",
      "Expert IELTS 6 Coursebook",
    );
  }
  if (title.includes("cambridge") && selectedIsbn.startsWith("978110")) {
    add(
      "Cambridge University Press & Assessment",
      "verified_cambridge_isbn_prefix",
      "https://www.merlinlibrary.com/shop/textbooks/cambridge-global-english-learners-book-2/",
      `${material.title} · ISBN ${selectedIsbn}`,
    );
  }
  if (title.includes("cambridge") && (selectedIsbn.startsWith("9781398") || selectedIsbn.startsWith("9781510") || selectedIsbn.startsWith("9781471"))) {
    add(
      "Hodder Education",
      "verified_hodder_isbn_prefix",
      "https://www.hachettelearning.com/english/cambridge-primary-english-learner-s-book-4-second-edition",
      `${material.title} · ISBN ${selectedIsbn}`,
    );
  }
  if (title.includes("die deutschprofis") && selectedIsbn.startsWith("978617")) {
    add(
      "Методика",
      "verified_metodika_isbn_prefix",
      "https://ubd.ua/die-deutschprofis/",
      `${material.title} · ISBN ${selectedIsbn}`,
    );
  } else if (title.includes("die deutschprofis") && selectedIsbn.startsWith("978312")) {
    add(
      "Ernst Klett Sprachen",
      "verified_klett_series",
      "https://klettwl.com/store/module/serialnet_protectedresources/getfile?id=1604",
      material.title,
    );
  }
  if (title.includes("beste freunde")) {
    add(
      "Hueber",
      "verified_hueber_series",
      "https://shop.hueber.de/de/reihen-und-lehrwerke/beste-freunde/beste-freunde-a2-2.html",
      material.title,
    );
  }
  if (/^pixel\s+[1-9]/u.test(title)) {
    add("CLE International", "verified_cle_series", "https://www.cle-international.com/recherche/collection/pixel-600", material.title);
  }
  return values;
}

function evidenceCompatible(material, evidence) {
  const sourceTitle = text(evidence.sourceTitle);
  if (!sourceTitle) return true;
  const materialRole = explicitRole(`${material.title} ${material.publicationType}`);
  const sourceRole = explicitRole(sourceTitle);
  if (materialRole && sourceRole && materialRole !== sourceRole) return false;
  const materialText = normalizedText(material.title);
  const sourceText = normalizedText(sourceTitle);
  if (materialText.includes("cambridge") && sourceText.includes("cambridge")) {
    const materialGlobal = materialText.includes("global");
    const sourceGlobal = sourceText.includes("global");
    if (materialGlobal !== sourceGlobal) return false;
  }
  const materialLevels = smallNumbers(material.title);
  const sourceLevels = smallNumbers(sourceTitle);
  if (materialLevels.length === 1 && sourceLevels.length === 1 && materialLevels[0] !== sourceLevels[0]) return false;
  return true;
}

function publisherSupportedByTitle(publisher, sourceTitle) {
  const title = normalizedText(sourceTitle);
  if (!title) return false;
  const canonical = normalizePublisher(publisher);
  if (!canonical) return false;
  const aliases = PUBLISHER_TITLE_ALIASES.get(canonical) ?? [canonical];
  return aliases.some((alias) => title.includes(normalizedText(alias)));
}

function publishersFromSourceTitle(sourceTitle) {
  const title = normalizedText(sourceTitle);
  if (!title) return [];
  const output = [];
  for (const [publisher, aliases] of PUBLISHER_TITLE_ALIASES) {
    if (aliases.some((alias) => title.includes(normalizedText(alias)))) output.push(publisher);
  }
  return [...new Set(output)];
}

function explicitRole(value) {
  const normalized = normalizedText(value);
  if (/(teacher|вчител|учител|книга для викладача)/u.test(normalized)) return "teacher";
  if (/(workbook|activity book|робочий зошит|arbeitsbuch|ubungsbuch|cuaderno|cahier)/u.test(normalized)) return "workbook";
  if (/(coursebook|student|students|kursbuch|learner|libro del alumno)/u.test(normalized)) return "student";
  if (/(games book|testheft|worterheft|grammar book|livret grammaire)/u.test(normalized)) return "supplement";
  return "";
}

function smallNumbers(value) {
  return [...new Set((text(value).match(/\d+/gu) ?? []).map(Number).filter((number) => number >= 1 && number <= 20))];
}


function linkedPublisherTier(record) {
  const host = text(record?.sourceHost);
  if (FIRST_PARTY_PUBLISHERS[host]) return 112;
  if (/\.(?:ua|com\.ua)$/u.test(host) || host.endsWith(".ua")) return record?.confidence === "probable" ? 92 : 74;
  return record?.confidence === "probable" ? 82 : 64;
}

function compareEvidence(left, right) {
  if (right.tier !== left.tier) return right.tier - left.tier;
  if ((right.score ?? 0) !== (left.score ?? 0)) return (right.score ?? 0) - (left.score ?? 0);
  return left.evidenceId.localeCompare(right.evidenceId);
}

function compareGroups(left, right) {
  if (right.tier !== left.tier) return right.tier - left.tier;
  if (right.independentSupport !== left.independentSupport) return right.independentSupport - left.independentSupport;
  if (right.score !== left.score) return right.score - left.score;
  return left.value.localeCompare(right.value, "uk");
}

function titleTokens(value) {
  return normalizedText(value).split(/\s+/u).filter((token) => token.length >= 2 && !TITLE_STOP_WORDS.has(token));
}

function tokenCoverage(needle, haystack) {
  if (!needle.length) return 0;
  const set = new Set(haystack);
  return needle.filter((token) => set.has(token)).length / needle.length;
}

function normalizedText(value) {
  return text(value).normalize("NFKC").toLocaleLowerCase("uk-UA")
    .replace(/[’']/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function compactIsbn(value) {
  return text(value).replace(/[^\d]/gu, "");
}

function validIsbn13(value) {
  const isbn = compactIsbn(value);
  if (!/^(?:978|979)\d{10}$/u.test(isbn)) return false;
  const sum = [...isbn.slice(0, 12)].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return (10 - sum % 10) % 10 === Number(isbn[12]);
}

function normalizeConfidence(value) {
  return value === "exact" ? "exact" : value === "probable" ? "probable" : "doubtful";
}

function safeHttps(value) {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function safeHost(value) {
  const url = safeHttps(value);
  return url ? new URL(url).hostname.replace(/^www\./u, "").toLocaleLowerCase("en-US") : "";
}

function decodeHtml(value) {
  return text(value)
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&laquo;|&raquo;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&copy;/giu, "©")
    .replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)));
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueMap(values, key, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`);
  const map = new Map();
  for (const value of values) {
    const id = text(value?.[key]);
    if (!id) throw new Error(`${label} contains a blank ${key}.`);
    if (map.has(id)) throw new Error(`${label} contains duplicate ${id}.`);
    map.set(id, value);
  }
  return map;
}

function assertCompleteInput(label, values, declared, expected) {
  if (!Array.isArray(values) || values.length !== expected || Number(declared) !== expected) {
    throw new Error(`${label} is incomplete: expected ${expected}, received ${values?.length ?? 0}/${declared ?? "?"}.`);
  }
}

async function loadJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function fileDescriptor(file, recordCount) {
  const body = await readFile(file);
  return { file: path.basename(file), sha256: sha256(body), recordCount };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
