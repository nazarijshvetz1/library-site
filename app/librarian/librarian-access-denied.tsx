/* eslint-disable @next/next/no-img-element, @next/next/no-html-link-for-pages -- official emblem and full-page Vinext navigation are intentional. */

import { LIBRARY_EMBLEM_URL } from "./_components/librarian-routes";
import styles from "./librarian-access-denied.module.css";

export default function LibrarianAccessDenied({
  title,
  description = "Цей обліковий запис не входить до списку працівників бібліотеки.",
  signOutHref,
}: {
  title: string;
  description?: string;
  signOutHref?: string;
}) {
  return (
    <main className={styles.shell}>
      <section className={styles.card} aria-labelledby="librarian-access-title">
        <img className={styles.emblem} src={LIBRARY_EMBLEM_URL} alt="" width="82" height="82" />
        <p className={styles.eyebrow}>Захищений кабінет</p>
        <h1 id="librarian-access-title">{title}</h1>
        <p>{description}</p>
        <div className={styles.actions}>
          <a href="/">На головну</a>
          {signOutHref ? <a href={signOutHref}>Вийти з облікового запису</a> : null}
        </div>
      </section>
    </main>
  );
}
