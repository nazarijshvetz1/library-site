import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  getChatGPTUser,
} from "./chatgpt-auth";

const PUBLIC_CATALOG_URL = "https://nazarijshvetz1.github.io/library-site/";
const LOGO_URL = `${PUBLIC_CATALOG_URL}library-logo.png`;

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getChatGPTUser();

  return (
    <main className="landing-shell">
      <nav className="landing-nav" aria-label="Головна навігація">
        <a className="brand-lockup" href="/" aria-label="Єдина бібліотека — головна">
          <img className="brand-logo" src={LOGO_URL} alt="" width="56" height="56" />
          <span>
            <strong>Єдина бібліотека</strong>
            <small>Міжнародний ліцей МАУП</small>
          </span>
        </a>

        <a className="nav-link" href={PUBLIC_CATALOG_URL}>
          Відкрити каталог
          <span aria-hidden="true">↗</span>
        </a>
      </nav>

      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="hero-copy">
          <p className="eyebrow"><span aria-hidden="true" /> Робоче місце бібліотеки</p>
          <h1 id="landing-title">Уся бібліотечна робота — в одному зрозумілому просторі</h1>
          <p className="hero-lead">
            Переглядайте відкритий каталог або увійдіть до захищеного кабінету,
            щоб готувати надходження, переміщення та ревізію.
          </p>

          <div className="hero-actions">
            {user ? (
              <>
                <a className="button button-primary" href="/librarian">
                  Перейти до кабінету
                  <span aria-hidden="true">→</span>
                </a>
                <a className="button button-quiet" href={chatGPTSignOutPath("/")}>
                  Вийти
                </a>
              </>
            ) : (
              <a className="button button-primary" href={chatGPTSignInPath("/librarian")}>
                <span className="chatgpt-mark" aria-hidden="true">✦</span>
                Sign in with ChatGPT
              </a>
            )}
            <a className="button button-secondary" href={PUBLIC_CATALOG_URL}>
              Переглянути каталог
            </a>
          </div>

          <p className="privacy-note">
            <span aria-hidden="true">●</span>
            Кабінет доступний лише уповноваженим працівникам бібліотеки.
          </p>
        </div>

        <aside className="hero-panel" aria-label="Можливості кабінету">
          <div className="panel-glow" aria-hidden="true" />
          <div className="hero-logo-wrap">
            <img src={LOGO_URL} alt="Емблема бібліотеки Міжнародного ліцею МАУП" width="176" height="176" />
          </div>
          <div className="panel-heading">
            <span>Кабінет бібліотекаря</span>
            <span className="status-pill"><i /> захищено</span>
          </div>
          <div className="feature-grid">
            <article><span aria-hidden="true">＋</span><strong>Новий матеріал</strong><small>Картка за ISBN</small></article>
            <article><span aria-hidden="true">↓</span><strong>Надходження</strong><small>Кількість і місце</small></article>
            <article><span aria-hidden="true">⇄</span><strong>Переміщення</strong><small>Між кабінетами</small></article>
            <article><span aria-hidden="true">✓</span><strong>Ревізія</strong><small>Фактичний залишок</small></article>
          </div>
          <p className="draft-preview"><span aria-hidden="true">◷</span> Спочатку чернетка — зміни завжди під контролем</p>
        </aside>
      </section>

      <footer className="landing-footer">
        <span>© {new Date().getFullYear()} Бібліотека Міжнародного ліцею МАУП</span>
        <span>Дані каталогу оновлюються з єдиної службової бази</span>
      </footer>
    </main>
  );
}
