"use client";

/* eslint-disable @next/next/no-img-element -- the official emblem is hosted with the public catalog. */

import { type FormEvent, useEffect, useRef, useState } from "react";
import styles from "./suggest-book.module.css";

const PUBLIC_CATALOG_URL = "https://nazarijshvetz1.github.io/library-site/";
const TEACHER_CABINET_URL = "https://yedyna-biblioteka-liceiu.nazarijshvetz1.chatgpt.site/teacher";
const LOGO_URL = `${PUBLIC_CATALOG_URL}library-logo.png`;

type ClassReference = { id: string; name: string };
type PublicResponseBody = {
  success?: boolean;
  classes?: ClassReference[];
  academicYear?: string;
  publicNumber?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
};

export default function SuggestBookForm() {
  const [classes, setClasses] = useState<ClassReference[]>([]);
  const [academicYear, setAcademicYear] = useState("");
  const [className, setClassName] = useState("");
  const [fullName, setFullName] = useState("");
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [year, setYear] = useState("");
  const [quantity, setQuantity] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [note, setNote] = useState("");
  const [website, setWebsite] = useState("");
  const [startedAt, setStartedAt] = useState(() => new Date().toISOString());
  const [busy, setBusy] = useState(false);
  const [referenceBusy, setReferenceBusy] = useState(true);
  const [referenceError, setReferenceError] = useState("");
  const [referenceKey, setReferenceKey] = useState(0);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const feedbackRef = useRef<HTMLDivElement>(null);
  const submissionRef = useRef<{ fingerprint: string; requestId: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/public/acquisition-reference", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await readPublicResponse(response, "Не вдалося завантажити список класів.");
        if (!response.ok) throw new PublicFormError(body.error || "Не вдалося завантажити список класів.");
        if (body.success !== true || !Array.isArray(body.classes)) {
          throw new PublicFormError("Сервіс повернув некоректний список класів.");
        }
        const nextClasses = body.classes;
        if (nextClasses.length === 0) throw new PublicFormError("У бібліотеці ще не налаштовано активні класи.");
        setClasses(nextClasses);
        setAcademicYear(body.academicYear ?? "");
      })
      .catch((loadError) => {
        if (!controller.signal.aborted) {
          setClasses([]);
          setReferenceError(publicErrorMessage(loadError, "Не вдалося завантажити список класів."));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setReferenceBusy(false);
      });
    return () => controller.abort();
  }, [referenceKey]);

  useEffect(() => {
    if (error || success) feedbackRef.current?.focus();
  }, [error, success]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const fingerprint = JSON.stringify({
        fullName, className, title, author, year, quantity, sourceUrl, note, website, startedAt,
      });
      if (!submissionRef.current || submissionRef.current.fingerprint !== fingerprint) {
        submissionRef.current = { fingerprint, requestId: crypto.randomUUID() };
      }
      const response = await fetch("/api/public/book-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: submissionRef.current.requestId,
          fullName,
          className,
          title,
          author,
          publicationYear:year.trim()?Number(year):null,
          requestedQuantity:quantity.trim()?Number(quantity):null,
          sourceUrl,
          note,
          website,
          startedAt,
        }),
      });
      const body = await readPublicResponse(response, "Не вдалося надіслати пропозицію.");
      if (!response.ok || body.success !== true || !body.publicNumber) {
        throw new PublicFormError(Object.values(body.fieldErrors ?? {})[0] || body.error || "Не вдалося надіслати пропозицію.");
      }
      setSuccess(`Дякуємо! Пропозицію ${body.publicNumber ?? ""} передано бібліотекарю.`);
      submissionRef.current = null;
      setTitle("");
      setAuthor("");
      setYear("");
      setQuantity("");
      setSourceUrl("");
      setNote("");
      setStartedAt(new Date().toISOString());
    } catch (submitError) {
      setError(publicErrorMessage(submitError, "Не вдалося надіслати пропозицію. Спробуйте ще раз."));
    } finally {
      setBusy(false);
    }
  }

  const formUnavailable = referenceBusy || Boolean(referenceError) || classes.length === 0;

  function retryReference() {
    setReferenceBusy(true);
    setReferenceError("");
    setReferenceKey((value) => value + 1);
  }

  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#suggestion-form">Перейти до форми</a>
      <header className={styles.header}>
        <a className={styles.brand} href={PUBLIC_CATALOG_URL} aria-label="Єдина бібліотека — відкрити публічний каталог">
          <img src={LOGO_URL} alt="Емблема Єдиної бібліотеки" width="62" height="62" />
          <span><strong>Єдина бібліотека</strong><small>Міжнародний ліцей МАУП</small></span>
        </a>
        <nav aria-label="Основна навігація">
          <a href={PUBLIC_CATALOG_URL}>Каталог <span aria-hidden="true">↗</span></a>
          <a href={TEACHER_CABINET_URL}>Кабінет учителя</a>
        </nav>
      </header>

      <main className={styles.main}>
        <section className={styles.story} aria-labelledby="suggest-book-title">
          <div className={styles.storyTop}>
            <p className={styles.eyebrow}><span aria-hidden="true"></span> Відкрита бібліотека</p>
            <h1 id="suggest-book-title">Запропонуйте книгу, якої нам бракує</h1>
            <p className={styles.lead}>Допоможіть формувати бібліотеку разом. Напишіть, яке видання варто додати до фонду — бібліотекар побачить вашу пропозицію у своєму кабінеті.</p>
          </div>

          <ol className={styles.steps} aria-label="Як це працює">
            <li><span>01</span><div><strong>Назвіть себе</strong><p>Оберіть клас і введіть прізвище та ім’я.</p></div></li>
            <li><span>02</span><div><strong>Укажіть книгу</strong><p>Назва й автор обов’язкові. Рік, кількість і покликання можна додати за бажанням.</p></div></li>
            <li><span>03</span><div><strong>Надішліть пропозицію</strong><p>Вона потрапить безпосередньо до бібліотекаря.</p></div></li>
          </ol>

          <div className={styles.assurance}>
            <span aria-hidden="true">✓</span>
            <p><strong>Потрібні лише 4 поля</strong>Клас, ім’я, назва та автор книги. Телефон і електронна адреса не потрібні.</p>
          </div>
        </section>

        <section className={styles.formPanel} aria-labelledby="form-title">
          <div className={styles.formHeading}>
            <p className={styles.kicker}>Пропозиція учня</p>
            <h2 id="form-title">Розкажіть про книгу</h2>
            <p>Поля із зірочкою обов’язкові.</p>
          </div>

          {referenceBusy ? <div className={styles.referenceStatus} role="status"><span aria-hidden="true"></span> Завантажуємо список класів…</div> : null}
          {referenceError ? (
            <div className={styles.referenceError} role="alert">
              <div><strong>Список класів не завантажився</strong><p>{referenceError}</p></div>
              <button type="button" onClick={retryReference}>Спробувати ще раз</button>
            </div>
          ) : null}

          <div ref={feedbackRef} tabIndex={-1} className={styles.feedback}>
            {error ? <div className={styles.error} role="alert"><span aria-hidden="true">!</span><p>{error}</p></div> : null}
            {success ? <div className={styles.success} role="status"><span aria-hidden="true">✓</span><p>{success}</p></div> : null}
          </div>

          <form id="suggestion-form" onSubmit={submit} aria-busy={busy}>
            <div className={styles.academicYear}><span>Навчальний рік</span><strong>{academicYear || (referenceBusy ? "оновлюємо…" : "не визначено")}</strong></div>

            <fieldset>
              <legend><span>01</span> Про вас</legend>
              <div className={styles.fields}>
                <label htmlFor="suggest-class">Клас <em>*</em>
                  <select id="suggest-class" name="className" required value={className} disabled={formUnavailable} onChange={(event) => setClassName(event.currentTarget.value)} aria-describedby="class-help">
                    <option value="">Оберіть клас</option>
                    {classes.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}
                  </select>
                  <small id="class-help">Ваш клас потрібен бібліотекарю для опрацювання пропозиції.</small>
                </label>
                <label htmlFor="suggest-full-name">Прізвище та ім’я <em>*</em>
                  <input id="suggest-full-name" name="fullName" autoComplete="name" required minLength={3} maxLength={160} value={fullName} onChange={(event) => setFullName(event.currentTarget.value)} placeholder="Наприклад, Марія Іваненко" aria-describedby="name-help" />
                  <small id="name-help">Укажіть справжні дані без номера телефону.</small>
                </label>
              </div>
            </fieldset>

            <fieldset>
              <legend><span>02</span> Про книгу</legend>
              <div className={styles.fields}>
                <label className={styles.wide} htmlFor="suggest-title">Назва книги <em>*</em>
                  <input id="suggest-title" name="title" autoComplete="off" required minLength={2} maxLength={320} value={title} onChange={(event) => setTitle(event.currentTarget.value)} placeholder="Повна назва видання" />
                </label>
                <label htmlFor="suggest-author">Автор <em>*</em>
                  <input id="suggest-author" name="author" autoComplete="off" required minLength={2} maxLength={240} value={author} onChange={(event) => setAuthor(event.currentTarget.value)} placeholder="Ім’я автора" />
                </label>
                <label htmlFor="suggest-year">Рік видання <small className={styles.optional}>необов’язково</small>
                  <input id="suggest-year" name="publicationYear" type="number" inputMode="numeric" min="1000" max="2100" value={year} onChange={(event) => setYear(event.currentTarget.value)} placeholder="Наприклад, 2024" />
                </label>
                <label htmlFor="suggest-quantity">Кількість <small className={styles.optional}>необов’язково</small>
                  <input id="suggest-quantity" name="requestedQuantity" type="number" inputMode="numeric" min="1" max="50" value={quantity} onChange={(event) => setQuantity(event.currentTarget.value)} placeholder="Стандартно — 1" />
                </label>
                <label className={styles.wide} htmlFor="suggest-link">Покликання на книгу <small className={styles.optional}>необов’язково</small>
                  <input id="suggest-link" name="sourceUrl" type="url" autoComplete="url" maxLength={1000} value={sourceUrl} onChange={(event) => setSourceUrl(event.currentTarget.value)} placeholder="https://…" aria-describedby="link-help" />
                  <small id="link-help">Наприклад, сторінка видавництва або книгарні.</small>
                </label>
                <label className={styles.wide} htmlFor="suggest-note">Чому ця книга потрібна? <small className={styles.optional}>необов’язково</small>
                  <textarea id="suggest-note" name="note" maxLength={500} value={note} onChange={(event) => setNote(event.currentTarget.value)} placeholder="Коротко напишіть, чому радите це видання" />
                </label>
                <label className={styles.trap} aria-hidden="true" htmlFor="suggest-website">Сайт
                  <input id="suggest-website" name="website" tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.currentTarget.value)} />
                </label>
              </div>
            </fieldset>

            <button className={styles.submit} type="submit" disabled={busy || formUnavailable}>
              <span>{busy ? "Надсилаємо…" : "Надіслати пропозицію"}</span><span aria-hidden="true">→</span>
            </button>
            <p className={styles.privacy}><span aria-hidden="true">●</span> Дані бачить лише бібліотекар. Вони не публікуються у відкритому каталозі.</p>
          </form>
        </section>
      </main>

      <footer className={styles.footer}>
        <span>Єдина бібліотека · Міжнародний ліцей МАУП</span>
        <a href={PUBLIC_CATALOG_URL}>Повернутися до каталогу <span aria-hidden="true">↗</span></a>
      </footer>
    </div>
  );
}

class PublicFormError extends Error {}

async function readPublicResponse(response: Response, fallback: string): Promise<PublicResponseBody> {
  const text = await response.text();
  try {
    const value = JSON.parse(text) as unknown;
    if (!isRecord(value)) throw new Error("object expected");
    const rawClasses = value.classes;
    const classes = Array.isArray(rawClasses) && rawClasses.every(isClassReference)
      ? rawClasses
      : undefined;
    const rawFieldErrors = value.fieldErrors;
    const fieldErrors = isRecord(rawFieldErrors)
      ? Object.fromEntries(Object.entries(rawFieldErrors).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : undefined;
    return {
      success: value.success === true,
      classes,
      academicYear: typeof value.academicYear === "string" ? value.academicYear : undefined,
      publicNumber: typeof value.publicNumber === "string" ? value.publicNumber : undefined,
      error: typeof value.error === "string" ? value.error : undefined,
      fieldErrors,
    };
  } catch {
    throw new PublicFormError(fallback);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isClassReference(value: unknown): value is ClassReference {
  return isRecord(value)
    && typeof value.id === "string"
    && value.id.length > 0
    && typeof value.name === "string"
    && value.name.length > 0;
}

function publicErrorMessage(error: unknown, fallback: string): string {
  return error instanceof PublicFormError ? error.message : fallback;
}
