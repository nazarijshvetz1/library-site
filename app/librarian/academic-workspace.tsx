"use client";

import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";

import {
  resolveLiveFormTextForSubmission,
  suggestNextAcademicYearStart,
  todayInKyiv,
} from "@/lib/librarian-d1-client";

import styles from "./d1-workspace.module.css";

export type AcademicTool =
  | "academic-year"
  | "class-create"
  | "class-update"
  | "class-close"
  | "rollover";

type Curator = { id: string; fullName: string; role: "teacher" | "admin" | "librarian" };
type Location = { id: string; name: string; type: string; isPublic: boolean };
type AcademicYear = {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  status: "draft" | "active" | "closed";
  notes: string;
  version: number;
};
type Cohort = { id: string; status: "active" | "graduated" | "closed"; notes: string };
type ClassYear = {
  id: string;
  academicYearId: string;
  academicYearLabel: string;
  cohortId: string;
  className: string;
  grade: number;
  code: string;
  teacherUserId: string | null;
  teacherName: string;
  locationId: string | null;
  locationName: string;
  startDate: string;
  endDate: string;
  status: "planned" | "active" | "closed";
  actualClosedDate: string | null;
  notes: string;
  version: number;
};
type AcademicReference = {
  curators: Curator[];
  academicYears: AcademicYear[];
  cohorts: Cohort[];
  classYears: ClassYear[];
};
type AcademicEnvelope = {
  success: boolean;
  referenceData: AcademicReference;
  generatedAt: string;
};
type MutationEnvelope<T> = { success: boolean; result: T };
type ApiFailure = {
  success?: false;
  code?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
};

export function isAcademicTool(tool: string): tool is AcademicTool {
  return new Set<string>([
    "academic-year",
    "class-create",
    "class-update",
    "class-close",
    "rollover",
  ]).has(tool);
}

export default function AcademicWorkspace({
  tool,
  writesEnabled,
  locations,
}: {
  tool: AcademicTool;
  writesEnabled: boolean;
  locations: Location[];
}) {
  const [reference, setReference] = useState<AcademicReference | null>(null);
  const [generatedAt, setGeneratedAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await academicApi<AcademicEnvelope>("/api/librarian/academic-reference");
      setReference(response.referenceData);
      setGeneratedAt(response.generatedAt);
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (loading && !reference) return <AcademicLoading />;
  if (!reference) return <AcademicMessage tone="error">{error || "Не вдалося завантажити навчальні роки й класи."}</AcademicMessage>;

  const common = {
    reference,
    writesEnabled,
    locations: locations.filter((location) => location.type !== "service"),
    onSaved: load,
  };

  return (
    <>
      {error ? <AcademicMessage tone="error">{error}</AcademicMessage> : null}
      {tool === "academic-year" ? <AcademicYearCreate key={`${tool}-${generatedAt}`} {...common} /> : null}
      {tool === "class-create" ? <ClassCreate key={`${tool}-${generatedAt}`} {...common} /> : null}
      {tool === "class-update" ? <ClassUpdate key={`${tool}-${generatedAt}`} {...common} /> : null}
      {tool === "class-close" ? <ClassClose key={`${tool}-${generatedAt}`} {...common} /> : null}
      {tool === "rollover" ? <Rollover key={`${tool}-${generatedAt}`} {...common} /> : null}
    </>
  );
}

type CommonProps = {
  reference: AcademicReference;
  writesEnabled: boolean;
  locations: Location[];
  onSaved: () => Promise<void>;
};

function AcademicYearCreate({ reference, writesEnabled, onSaved }: CommonProps) {
  const suggestedStart = suggestNextAcademicYearStart(
    reference.academicYears,
    new Date().getFullYear(),
  );
  const [label, setLabel] = useState(`${suggestedStart}/${suggestedStart + 1}`);
  const [startDate, setStartDate] = useState(`${suggestedStart}-09-01`);
  const [endDate, setEndDate] = useState(`${suggestedStart + 1}-08-31`);
  const [notes, setNotes] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const startDateInputRef = useRef<HTMLInputElement>(null);
  const endDateInputRef = useRef<HTMLInputElement>(null);
  const form = useAcademicMutation(onSaved);

  function updateStartDate(event: FormEvent<HTMLInputElement>) {
    setStartDate(event.currentTarget.value);
    setRequestId(crypto.randomUUID());
  }

  function updateEndDate(event: FormEvent<HTMLInputElement>) {
    setEndDate(event.currentTarget.value);
    setRequestId(crypto.randomUUID());
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const submittedStartDate = resolveLiveFormTextForSubmission(
      startDateInputRef.current?.value,
      formData.get("startDate"),
      startDate,
    );
    const submittedEndDate = resolveLiveFormTextForSubmission(
      endDateInputRef.current?.value,
      formData.get("endDate"),
      endDate,
    );
    await form.run(async () => {
      const response = await academicApi<MutationEnvelope<{ academicYearId: string }>>(
        "/api/librarian/academic-years",
        jsonPost({
          requestId,
          label,
          startDate: submittedStartDate,
          endDate: submittedEndDate,
          notes: notes.trim(),
        }),
      );
      setRequestId(crypto.randomUUID());
      return `Навчальний рік ${response.result.academicYearId} створено як чернетку.`;
    });
  }

  return (
    <form className={styles.createCard} onSubmit={submit} aria-busy={form.saving}>
      <AcademicHeading eyebrow={`${reference.academicYears.length} навчальних років`} title="Створити навчальний рік" subtitle="Новий рік зберігається одразу в D1 як чернетка." />
      <div className={styles.formGrid}>
        <AcademicField label="Назва" required><input value={label} onChange={(event) => { setLabel(event.target.value); setRequestId(crypto.randomUUID()); }} placeholder="2027/2028" required /></AcademicField>
        <AcademicField label="Початок" required><input ref={startDateInputRef} name="startDate" type="date" value={startDate} onInput={updateStartDate} required /></AcademicField>
        <AcademicField label="Завершення" required><input ref={endDateInputRef} name="endDate" type="date" value={endDate} min={startDate} onInput={updateEndDate} required /></AcademicField>
        <AcademicField label="Примітка" wide><textarea rows={3} value={notes} onChange={(event) => { setNotes(event.target.value); setRequestId(crypto.randomUUID()); }} /></AcademicField>
      </div>
      <MutationFooter form={form} writesEnabled={writesEnabled} label="Створити навчальний рік" pending="Створюємо…" />
    </form>
  );
}

function ClassCreate({ reference, writesEnabled, locations, onSaved }: CommonProps) {
  const years = reference.academicYears.filter((year) => year.status === "active");
  const cohorts = reference.cohorts.filter((cohort) => cohort.status === "active");
  const [academicYearId, setAcademicYearId] = useState(years[0]?.id || "");
  const [cohortMode, setCohortMode] = useState<"new" | "existing">("new");
  const [cohortId, setCohortId] = useState(cohorts[0]?.id || "");
  const [grade, setGrade] = useState("1");
  const [code, setCode] = useState("А");
  const [teacherUserId, setTeacherUserId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [notes, setNotes] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const form = useAcademicMutation(onSaved);
  const renew = () => setRequestId(crypto.randomUUID());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await form.run(async () => {
      const response = await academicApi<MutationEnvelope<{ className: string }>>(
        "/api/librarian/class-years",
        jsonPost({
          requestId,
          academicYearId,
          cohortMode,
          cohortId: cohortMode === "existing" ? cohortId : null,
          grade: Number(grade),
          code: code.trim(),
          teacherUserId: teacherUserId || null,
          locationId: locationId || null,
          notes: notes.trim(),
        }),
      );
      setRequestId(crypto.randomUUID());
      return `Клас ${response.result.className} відкрито.`;
    });
  }

  return (
    <form className={styles.createCard} onSubmit={submit} aria-busy={form.saving}>
      <AcademicHeading eyebrow={`${reference.classYears.length} записів класів`} title="Відкрити клас" subtitle="Створіть нову групу або продовжте наявну в обраному навчальному році." />
      {years.length ? (
        <div className={styles.formGrid}>
          <AcademicField label="Навчальний рік" required wide><select value={academicYearId} onChange={(event) => { setAcademicYearId(event.target.value); renew(); }}>{years.map((year) => <option key={year.id} value={year.id}>{year.label} · {yearStatusLabel(year.status)}</option>)}</select></AcademicField>
          <AcademicField label="Група" required><select value={cohortMode} onChange={(event) => { setCohortMode(event.target.value as "new" | "existing"); renew(); }}><option value="new">Нова група</option><option value="existing" disabled={!cohorts.length}>Наявна група</option></select></AcademicField>
          {cohortMode === "existing" ? <AcademicField label="ID групи" required><select value={cohortId} onChange={(event) => { setCohortId(event.target.value); renew(); }} required>{cohorts.map((cohort) => <option key={cohort.id} value={cohort.id}>{cohort.id}</option>)}</select></AcademicField> : null}
          <AcademicField label="Паралель" required><input type="number" min="1" max="11" value={grade} onChange={(event) => { setGrade(event.target.value); renew(); }} required /></AcademicField>
          <AcademicField label="Літера / код" required><input value={code} maxLength={24} onChange={(event) => { setCode(event.target.value); renew(); }} required /></AcademicField>
          <AcademicField label="Класний керівник"><select value={teacherUserId} onChange={(event) => { setTeacherUserId(event.target.value); renew(); }}><option value="">Не призначено</option>{(reference.curators ?? []).map((curator) => <option key={curator.id} value={curator.id}>{curator.fullName}{curator.role === "teacher" ? "" : ` · ${curatorRoleLabel(curator.role)}`}</option>)}</select></AcademicField>
          <AcademicField label="Кабінет"><select value={locationId} onChange={(event) => { setLocationId(event.target.value); renew(); }}><option value="">Не призначено</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></AcademicField>
          <AcademicField label="Примітка" wide><textarea rows={3} value={notes} onChange={(event) => { setNotes(event.target.value); renew(); }} /></AcademicField>
        </div>
      ) : <AcademicMessage tone="info">Щоб відкрити клас, потрібен активний навчальний рік.</AcademicMessage>}
      <MutationFooter form={form} writesEnabled={writesEnabled && Boolean(years.length)} label="Відкрити клас" pending="Відкриваємо…" />
    </form>
  );
}

function ClassUpdate({ reference, writesEnabled, locations, onSaved }: CommonProps) {
  const classes = reference.classYears.filter((item) => item.status !== "closed");
  const [classId, setClassId] = useState(classes[0]?.id || "");
  const initial = classes.find((item) => item.id === classId) ?? null;
  const [grade, setGrade] = useState(() => String(initial?.grade ?? 1));
  const [code, setCode] = useState(initial?.code || "");
  const [teacherUserId, setTeacherUserId] = useState(initial?.teacherUserId || "");
  const [locationId, setLocationId] = useState(initial?.locationId || "");
  const [notes, setNotes] = useState(initial?.notes || "");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const form = useAcademicMutation(onSaved);
  const selected = classes.find((item) => item.id === classId) ?? null;
  const renew = () => setRequestId(crypto.randomUUID());

  function chooseClass(id: string) {
    const item = classes.find((candidate) => candidate.id === id);
    setClassId(id);
    setGrade(String(item?.grade ?? 1));
    setCode(item?.code || "");
    setTeacherUserId(item?.teacherUserId || "");
    setLocationId(item?.locationId || "");
    setNotes(item?.notes || "");
    renew();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const changes: Record<string, unknown> = {};
    if (Number(grade) !== selected.grade) changes.grade = Number(grade);
    if (code.trim() !== selected.code) changes.code = code.trim();
    if ((teacherUserId || null) !== selected.teacherUserId) changes.teacherUserId = teacherUserId || null;
    if ((locationId || null) !== selected.locationId) changes.locationId = locationId || null;
    if (notes.trim() !== selected.notes) changes.notes = notes.trim();
    if (!Object.keys(changes).length) {
      form.notice("Змін немає.", false);
      return;
    }
    await form.run(async () => {
      const response = await academicApi<MutationEnvelope<{ className: string }>>(
        `/api/librarian/class-years/${encodeURIComponent(selected.id)}`,
        jsonPatch({ requestId, expectedVersion: selected.version, reason: "Оновлення картки класу", changes }),
      );
      setRequestId(crypto.randomUUID());
      return `Клас ${response.result.className} оновлено.`;
    });
  }

  return (
    <form className={styles.createCard} onSubmit={submit} aria-busy={form.saving}>
      <AcademicHeading eyebrow={`${classes.length} відкритих класів`} title="Змінити клас" subtitle="Керівник, кабінет, назва та примітка змінюються відразу." />
      {selected ? (
        <div className={styles.formGrid}>
          <AcademicField label="Клас" required wide><select value={classId} onChange={(event) => chooseClass(event.target.value)}>{classes.map((item) => <option key={item.id} value={item.id}>{item.academicYearLabel} · {item.className}</option>)}</select></AcademicField>
          <AcademicField label="Паралель" required><input type="number" min="1" max="11" value={grade} onChange={(event) => { setGrade(event.target.value); renew(); }} required /></AcademicField>
          <AcademicField label="Літера / код" required><input value={code} onChange={(event) => { setCode(event.target.value); renew(); }} required /></AcademicField>
          <AcademicField label="Класний керівник"><select value={teacherUserId} onChange={(event) => { setTeacherUserId(event.target.value); renew(); }}><option value="">Не призначено</option>{(reference.curators ?? []).map((curator) => <option key={curator.id} value={curator.id}>{curator.fullName}{curator.role === "teacher" ? "" : ` · ${curatorRoleLabel(curator.role)}`}</option>)}</select></AcademicField>
          <AcademicField label="Кабінет"><select value={locationId} onChange={(event) => { setLocationId(event.target.value); renew(); }}><option value="">Не призначено</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></AcademicField>
          <AcademicField label="Примітка" wide><textarea rows={3} value={notes} onChange={(event) => { setNotes(event.target.value); renew(); }} /></AcademicField>
        </div>
      ) : <AcademicMessage tone="info">Відкритих класів немає.</AcademicMessage>}
      <MutationFooter form={form} writesEnabled={writesEnabled && Boolean(selected)} label="Зберегти зміни" pending="Зберігаємо…" />
    </form>
  );
}

function ClassClose({ reference, writesEnabled, onSaved }: CommonProps) {
  const classes = reference.classYears.filter((item) => item.status !== "closed");
  const [classId, setClassId] = useState(classes[0]?.id || "");
  const selected = classes.find((item) => item.id === classId) ?? null;
  const [actualClosedDate, setActualClosedDate] = useState(() => todayInKyiv());
  const [reason, setReason] = useState("closed");
  const [closeCohort, setCloseCohort] = useState(false);
  const [notes, setNotes] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const actualClosedDateInputRef = useRef<HTMLInputElement>(null);
  const form = useAcademicMutation(onSaved);
  const renew = () => setRequestId(crypto.randomUUID());

  function updateActualClosedDate(event: FormEvent<HTMLInputElement>) {
    setActualClosedDate(event.currentTarget.value);
    renew();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const submittedActualClosedDate = resolveLiveFormTextForSubmission(
      actualClosedDateInputRef.current?.value,
      new FormData(event.currentTarget).get("actualClosedDate"),
      actualClosedDate,
    );
    if (!window.confirm(`Закрити клас ${selected.className} у ${selected.academicYearLabel}?`)) return;
    await form.run(async () => {
      const response = await academicApi<MutationEnvelope<{ className: string }>>(
        `/api/librarian/class-years/${encodeURIComponent(selected.id)}/close`,
        jsonPost({
          requestId,
          expectedVersion: selected.version,
          actualClosedDate: submittedActualClosedDate,
          reason,
          closeCohort,
          notes: notes.trim(),
        }),
      );
      setRequestId(crypto.randomUUID());
      return `Клас ${response.result.className} закрито.`;
    });
  }

  return (
    <form className={styles.createCard} onSubmit={submit} aria-busy={form.saving}>
      <AcademicHeading eyebrow={`${classes.length} відкритих класів`} title="Закрити клас" subtitle="Історія класу зберігається; запис не видаляється." />
      {selected ? (
        <div className={styles.formGrid}>
          <AcademicField label="Клас" required wide><select value={classId} onChange={(event) => { setClassId(event.target.value); renew(); }}>{classes.map((item) => <option key={item.id} value={item.id}>{item.academicYearLabel} · {item.className}</option>)}</select></AcademicField>
          <AcademicField label="Дата закриття" required><input ref={actualClosedDateInputRef} name="actualClosedDate" type="date" value={actualClosedDate} onInput={updateActualClosedDate} required /></AcademicField>
          <AcademicField label="Причина" required><select value={reason} onChange={(event) => { setReason(event.target.value); renew(); }}><option value="closed">Завершено</option><option value="merged">Об’єднано</option><option value="graduated">Випуск</option><option value="reorganized">Реорганізовано</option><option value="other">Інша причина</option></select></AcademicField>
          <label className={styles.receiptToggle} htmlFor="close-class-cohort">
            <input id="close-class-cohort" aria-label="Також завершити групу" type="checkbox" checked={closeCohort} onChange={(event) => { setCloseCohort(event.target.checked); renew(); }} />
            <span><strong>Також завершити групу</strong><small>Лише якщо ця група більше не використовується іншим відкритим класом.</small></span>
          </label>
          <AcademicField label="Примітка" wide><textarea rows={3} value={notes} onChange={(event) => { setNotes(event.target.value); renew(); }} required={reason === "other"} /></AcademicField>
        </div>
      ) : <AcademicMessage tone="info">Відкритих класів немає.</AcademicMessage>}
      <MutationFooter form={form} writesEnabled={writesEnabled && Boolean(selected)} label="Закрити клас" pending="Закриваємо…" />
    </form>
  );
}

type RolloverRow = {
  sourceClassYearId: string;
  expectedVersion: number;
  cohortId: string;
  sourceGrade: number;
  className: string;
  action: "promote" | "graduate" | "close";
  targetGrade: number;
  targetCode: string;
  teacherUserId: string | null;
  locationId: string | null;
  overrideReason: string;
  notes: string;
};

function Rollover({ reference, writesEnabled, locations, onSaved }: CommonProps) {
  const sourceYears = reference.academicYears.filter((year) => year.status === "active");
  const initialSource = sourceYears[0] ?? null;
  const initialTargets = nextDraftAcademicYears(reference, initialSource);
  const [sourceYearId, setSourceYearId] = useState(initialSource?.id || "");
  const [targetYearId, setTargetYearId] = useState(initialTargets[0]?.id || "");
  const [effectiveDate, setEffectiveDate] = useState(() => initialTargets[0]?.startDate || todayInKyiv());
  const [notes, setNotes] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [rows, setRows] = useState<RolloverRow[]>(() => buildRolloverRows(reference, sourceYears[0]?.id || ""));
  const effectiveDateInputRef = useRef<HTMLInputElement>(null);
  const form = useAcademicMutation(onSaved);
  const sourceYear = sourceYears.find((year) => year.id === sourceYearId) ?? null;
  const targetYears = nextDraftAcademicYears(reference, sourceYear);
  const targetYear = targetYears.find((year) => year.id === targetYearId) ?? targetYears[0] ?? null;
  const renew = () => setRequestId(crypto.randomUUID());

  function updateEffectiveDate(event: FormEvent<HTMLInputElement>) {
    setEffectiveDate(event.currentTarget.value);
    renew();
  }

  function chooseSource(id: string) {
    const nextSource = sourceYears.find((year) => year.id === id) ?? null;
    const nextTarget = nextDraftAcademicYears(reference, nextSource)[0] ?? null;
    setSourceYearId(id);
    setTargetYearId(nextTarget?.id || "");
    setEffectiveDate(nextTarget?.startDate || todayInKyiv());
    setRows(buildRolloverRows(reference, id));
    renew();
  }

  function updateRow(id: string, patch: Partial<RolloverRow>) {
    setRows((current) => current.map((row) => row.sourceClassYearId === id ? { ...row, ...patch } : row));
    renew();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sourceYear || !targetYear || !rows.length) return;
    const submittedEffectiveDate = resolveLiveFormTextForSubmission(
      effectiveDateInputRef.current?.value,
      new FormData(event.currentTarget).get("effectiveDate"),
      effectiveDate,
    );
    if (!window.confirm(`Завершити ${sourceYear.label} і перенести ${rows.length} класів до ${targetYear.label}?`)) return;
    await form.run(async () => {
      const response = await academicApi<MutationEnvelope<{ promoted: unknown[]; graduated: string[]; closed: string[] }>>(
        "/api/librarian/academic-years/rollover",
        jsonPost({
          requestId,
          sourceYearId: sourceYear.id,
          sourceYearVersion: sourceYear.version,
          targetYearId: targetYear.id,
          targetYearVersion: targetYear.version,
          effectiveDate: submittedEffectiveDate,
          notes: notes.trim(),
          classes: rows.map((row) => ({
            sourceClassYearId: row.sourceClassYearId,
            expectedVersion: row.expectedVersion,
            cohortId: row.cohortId,
            sourceGrade: row.sourceGrade,
            action: row.action,
            ...(row.action === "promote" ? {
              targetGrade: row.targetGrade,
              targetCode: row.targetCode,
              teacherUserId: row.teacherUserId,
              locationId: row.locationId,
              ...(row.targetGrade !== row.sourceGrade + 1 ? { overrideReason: row.overrideReason.trim() } : {}),
            } : {}),
            ...(row.notes.trim() ? { notes: row.notes.trim() } : {}),
          })),
        }),
      );
      setRequestId(crypto.randomUUID());
      return `Перехід завершено: перенесено ${response.result.promoted.length}, випущено ${response.result.graduated.length}, закрито ${response.result.closed.length}.`;
    });
  }

  return (
    <form className={styles.createCard} onSubmit={submit} aria-busy={form.saving}>
      <AcademicHeading eyebrow="Одна атомарна операція" title="Перехід на новий навчальний рік" subtitle="Кожен відкритий клас має отримати одну явну дію; пропущених класів не буде." />
      {sourceYear && targetYear ? (
        <>
          <div className={styles.formGrid}>
            <AcademicField label="Поточний активний рік" required><select value={sourceYearId} onChange={(event) => chooseSource(event.target.value)}>{sourceYears.map((year) => <option key={year.id} value={year.id}>{year.label}</option>)}</select></AcademicField>
            <AcademicField label="Наступний рік-чернетка" required><select value={targetYear?.id || ""} onChange={(event) => { const id = event.target.value; setTargetYearId(id); setEffectiveDate(targetYears.find((year) => year.id === id)?.startDate || todayInKyiv()); renew(); }}>{targetYears.map((year) => <option key={year.id} value={year.id}>{year.label}</option>)}</select></AcademicField>
            <AcademicField label="Дата переходу" required><input ref={effectiveDateInputRef} name="effectiveDate" type="date" value={effectiveDate} onInput={updateEffectiveDate} required /></AcademicField>
            <AcademicField label="Загальна примітка"><input value={notes} onChange={(event) => { setNotes(event.target.value); renew(); }} /></AcademicField>
          </div>
          <div className={styles.academicRows}>
            {rows.map((row) => (
              <article key={row.sourceClassYearId}>
                <div><strong>{row.className}</strong><small>{row.cohortId} · {row.sourceClassYearId}</small></div>
                <AcademicField label="Дія"><select value={row.action} onChange={(event) => { const action = event.target.value as RolloverRow["action"]; updateRow(row.sourceClassYearId, { action }); }}><option value="promote">Перевести</option>{row.sourceGrade === 11 ? <option value="graduate">Випуск</option> : null}<option value="close">Закрити</option></select></AcademicField>
                {row.action === "promote" ? (
                  <>
                    <AcademicField label="Новий клас"><input type="number" min="1" max="11" value={row.targetGrade} onChange={(event) => updateRow(row.sourceClassYearId, { targetGrade: Number(event.target.value) })} /></AcademicField>
                    <AcademicField label="Літера"><input value={row.targetCode} onChange={(event) => updateRow(row.sourceClassYearId, { targetCode: event.target.value })} /></AcademicField>
                    <AcademicField label="Керівник"><select value={row.teacherUserId || ""} onChange={(event) => updateRow(row.sourceClassYearId, { teacherUserId: event.target.value || null })}><option value="">Не призначено</option>{(reference.curators ?? []).map((curator) => <option key={curator.id} value={curator.id}>{curator.fullName}{curator.role === "teacher" ? "" : ` · ${curatorRoleLabel(curator.role)}`}</option>)}</select></AcademicField>
                    <AcademicField label="Кабінет"><select value={row.locationId || ""} onChange={(event) => updateRow(row.sourceClassYearId, { locationId: event.target.value || null })}><option value="">Не призначено</option>{locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></AcademicField>
                    {row.targetGrade !== row.sourceGrade + 1 ? <AcademicField label="Причина нестандартного переходу" wide><input value={row.overrideReason} onChange={(event) => updateRow(row.sourceClassYearId, { overrideReason: event.target.value })} required /></AcademicField> : null}
                  </>
                ) : null}
              </article>
            ))}
          </div>
        </>
      ) : <AcademicMessage tone="info">Потрібні один активний рік і один новий рік зі статусом «Чернетка».</AcademicMessage>}
      <MutationFooter form={form} writesEnabled={writesEnabled && Boolean(sourceYear && targetYear && rows.length)} label="Виконати перехід" pending="Переносимо класи…" />
    </form>
  );
}

function buildRolloverRows(reference: AcademicReference, sourceYearId: string): RolloverRow[] {
  return reference.classYears
    .filter((item) => item.academicYearId === sourceYearId && item.status !== "closed")
    .sort((left, right) => left.grade - right.grade || left.code.localeCompare(right.code, "uk"))
    .map((item) => ({
      sourceClassYearId: item.id,
      expectedVersion: item.version,
      cohortId: item.cohortId,
      sourceGrade: item.grade,
      className: item.className,
      action: item.grade === 11 ? "graduate" : "promote",
      targetGrade: Math.min(11, item.grade + 1),
      targetCode: item.code,
      teacherUserId: item.teacherUserId,
      locationId: item.locationId,
      overrideReason: "",
      notes: "",
    }));
}

function nextDraftAcademicYears(
  reference: AcademicReference,
  sourceYear: AcademicYear | null,
): AcademicYear[] {
  if (!sourceYear) return [];
  const futureDrafts = reference.academicYears
    .filter((year) => year.status === "draft" && year.startDate > sourceYear.startDate)
    .sort((left, right) => left.startDate.localeCompare(right.startDate) || left.id.localeCompare(right.id));
  return futureDrafts.length ? [futureDrafts[0]] : [];
}

function AcademicHeading({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) {
  return <div className={styles.formHeading}><div><p>{eyebrow}</p><h2>{title}</h2><small>{subtitle}</small></div></div>;
}

function AcademicField({ label, children, required = false, wide = false }: { label: string; children: React.ReactNode; required?: boolean; wide?: boolean }) {
  return <label className={wide ? styles.fieldWide : undefined}><span>{label}{required ? " *" : ""}</span>{children}</label>;
}

function AcademicMessage({ children, tone }: { children: React.ReactNode; tone: "error" | "success" | "info" }) {
  const suffix = tone.charAt(0).toUpperCase() + tone.slice(1);
  return (
    <div
      className={`${styles.message} ${styles[`message${suffix}`]}`}
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
    >
      {children}
    </div>
  );
}

function AcademicLoading() {
  return <div className={styles.loading} aria-live="polite"><i /><i /><i /> Завантажуємо навчальні роки й класи…</div>;
}

type AcademicMutationState = {
  saving: boolean;
  message: string;
  success: boolean;
  fieldErrors: Record<string, string>;
  run: (operation: () => Promise<string>) => Promise<void>;
  notice: (message: string, success: boolean) => void;
};

function useAcademicMutation(onSaved: () => Promise<void>): AcademicMutationState {
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  async function run(operation: () => Promise<string>) {
    if (saving) return;
    setSaving(true);
    setMessage("");
    setSuccess(false);
    setFieldErrors({});
    try {
      const nextMessage = await operation();
      setMessage(nextMessage);
      setSuccess(true);
      await onSaved();
    } catch (error) {
      if (error instanceof AcademicApiError) setFieldErrors(error.fieldErrors);
      setMessage(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  return {
    saving,
    message,
    success,
    fieldErrors,
    run,
    notice(nextMessage, nextSuccess) {
      setMessage(nextMessage);
      setSuccess(nextSuccess);
      setFieldErrors({});
    },
  };
}

function MutationFooter({ form, writesEnabled, label, pending }: { form: AcademicMutationState; writesEnabled: boolean; label: string; pending: string }) {
  return (
    <>
      {form.message ? <AcademicMessage tone={form.success ? "success" : "error"}>{form.message}</AcademicMessage> : null}
      {Object.keys(form.fieldErrors).length ? (
        <AcademicMessage tone="error">
          {Object.entries(form.fieldErrors).map(([field, message]) => (
            <span key={field} className={styles.academicFieldError}><strong>{field}:</strong> {message}</span>
          ))}
        </AcademicMessage>
      ) : null}
      <div className={styles.formActions}>
        <span>Зміни записуються напряму в D1 та журнал аудиту.</span>
        <button className={styles.primaryButton} type="submit" disabled={!writesEnabled || form.saving}>{form.saving ? pending : label}</button>
      </div>
    </>
  );
}

function jsonPost(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function jsonPatch(body: unknown): RequestInit {
  return { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function academicApi<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, headers: { accept: "application/json", ...(init.headers || {}) } });
  const body = await response.json().catch(() => null) as (T & ApiFailure) | null;
  if (!response.ok || !body || body.success === false) {
    throw new AcademicApiError(
      body?.error || `Запит не виконано (${response.status}).`,
      response.status,
      body?.code || "",
      body?.fieldErrors || {},
    );
  }
  return body;
}

class AcademicApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly fieldErrors: Record<string, string>,
  ) {
    super(message);
    this.name = "AcademicApiError";
  }
}

function yearStatusLabel(status: AcademicYear["status"]): string {
  if (status === "active") return "активний";
  if (status === "closed") return "завершений";
  return "чернетка";
}

function curatorRoleLabel(role: Curator["role"]): string {
  if (role === "admin") return "адміністратор";
  if (role === "librarian") return "бібліотекар";
  return "вчитель";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Сталася невідома помилка.";
}
