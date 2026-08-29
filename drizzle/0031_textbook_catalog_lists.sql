UPDATE material_links
SET kind = 'ebook',
	label = 'Електронна версія',
	updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE kind = 'details'
	AND is_public = 1
	AND status = 'active'
	AND url GLOB 'https://*'
	AND (
		lower(url) = 'https://pidruchnyk.com.ua'
		OR lower(url) GLOB 'https://pidruchnyk.com.ua/*'
		OR lower(url) = 'https://www.pidruchnyk.com.ua'
		OR lower(url) GLOB 'https://www.pidruchnyk.com.ua/*'
		OR lower(url) = 'https://shkola.in.ua'
		OR lower(url) GLOB 'https://shkola.in.ua/*'
		OR lower(url) = 'https://www.shkola.in.ua'
		OR lower(url) GLOB 'https://www.shkola.in.ua/*'
		OR lower(url) = 'https://lib.imzo.gov.ua'
		OR lower(url) GLOB 'https://lib.imzo.gov.ua/*'
		OR lower(url) = 'https://www.lib.imzo.gov.ua'
		OR lower(url) GLOB 'https://www.lib.imzo.gov.ua/*'
	);
--> statement-breakpoint
WITH RECURSIVE grades(grade) AS (
	SELECT 1
	UNION ALL
	SELECT grade + 1 FROM grades WHERE grade < 11
), candidates AS (
	SELECT
		ay.id AS academic_year_id,
		m.id AS material_id,
		m.catalog_number AS sort_order,
		grades.grade,
		EXISTS (
			SELECT 1 FROM material_links ml
			WHERE ml.material_id = m.id
				AND ml.kind = 'ebook'
				AND ml.is_public = 1
				AND ml.status = 'active'
				AND ml.url GLOB 'https://*'
		) AS has_ebook
	FROM academic_years ay
	JOIN materials m
		ON m.status = 'active'
		AND m.archived_at IS NULL
		AND trim(m.publication_type) = 'Підручник'
	JOIN grades
		ON m.class_from IS NOT NULL
		AND m.class_to IS NOT NULL
		AND grades.grade BETWEEN m.class_from AND m.class_to
	WHERE ay.status = 'active'
)
INSERT OR IGNORE INTO textbook_assignments (
	id, academic_year_id, material_id, grade, status, sort_order, version,
	published_at, archived_at, created_at, updated_at
)
SELECT
	'TXT-SEED-ALL-' || replace(academic_year_id, '/', '-') || '-' || grade || '-' || material_id,
	academic_year_id,
	material_id,
	grade,
	CASE WHEN has_ebook THEN 'published' ELSE 'draft' END,
	sort_order,
	1,
	CASE WHEN has_ebook THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE NULL END,
	NULL,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM candidates;
