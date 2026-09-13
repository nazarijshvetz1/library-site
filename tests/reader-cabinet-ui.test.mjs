import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read=file=>fs.readFileSync(file,'utf8');
const panels=read('app/reader/cabinet-panels.tsx');
const controls=read('app/reader/cabinet-controls.tsx');
const workspace=read('app/reader/reader-workspace.tsx');
const book=read('app/reader/cabinet-book.tsx');
const css=read('app/reader/cabinet.module.css');
const catalogBackend=read('lib/reader-cabinet-catalog.ts');

test('reader home uses compact mobile-only scopes without shrinking every form action',()=>{
 assert.match(panels,/homeGreeting/u);assert.match(panels,/homeMetrics/u);assert.match(panels,/homeActions/u);
 assert.match(panels,/Знайти книжку/u);assert.match(panels,/Сканувати штрих-код/u);
 assert.match(css,/\.homeMetrics article\{min-height:76px;padding:10px 12px\}/u);
 assert.match(css,/\.homeActions\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/u);
});

test('book covers, titles and free card area open the book while related names keep their own action',()=>{
 assert.match(controls,/data-clickable="true"/u);assert.match(controls,/closest\('button,a,input,select,textarea,summary,details'\)/u);
 assert.match(controls,/function BookEntityLinks/u);assert.match(controls,/function PublicationLine/u);
 assert.match(panels,/onBook=\{onBook\} onEntity=\{onEntity\}/u);assert.match(book,/kinds=\{\['author'\]\}/u);assert.match(book,/PublicationLine/u);
});

test('catalog exposes five compact directories, detail pages and related books with route-aware back navigation',()=>{
 for(const label of ['Категорії','Автори','Видавництва','Теги','Серії'])assert.match(panels,new RegExp(label,'u'));
 assert.match(panels,/view:'entities'/u);assert.match(panels,/view:'entity'/u);assert.match(panels,/bookHeading:'Книжки автора'/u);assert.match(panels,/bookHeading:'Видання цього видавництва'/u);
 assert.match(workspace,/function openBrowse/u);assert.match(workspace,/function openEntity/u);assert.match(workspace,/entityKind/u);assert.match(workspace,/onBack=\{nav\.back\}/u);
 assert.match(workspace,/next!=='catalog'.*\['browse','entity','entityKind'\]/u);assert.match(workspace,/else if\(tab==='home'\)/u);
 assert.match(css,/\.browseGrid/u);assert.match(css,/\.directoryList/u);assert.match(css,/\.entityFacts/u);
});

test('account suggests canonical full name, remains editable and presents a dedicated red logout action',()=>{
 assert.match(panels,/profile\.displayName\.trim\(\)==='Читач'\?profile\.fullName/u);
 assert.match(panels,/Ім’я у спільноті/u);assert.match(panels,/maxLength=\{180\}/u);assert.match(panels,/logoutButton/u);
 assert.match(css,/\.logoutButton\{[^}]*color:#922f29[^}]*background:#fbe8e2/u);
});

test('reader catalog is dense, shows public book facts, and community search suggestions identify books visually',()=>{
 assert.match(controls,/function BookPublicMeta/u);assert.match(controls,/book\.pages/u);assert.match(controls,/book\.websiteUrl/u);
 assert.match(controls,/kind==='book'\?s\.bookSuggestion/u);assert.match(controls,/Автор не вказаний/u);assert.match(controls,/<Cover book=\{row\}/u);
 assert.match(panels,/catalogCards/u);assert.match(panels,/<BookPublicMeta book=\{book\}/u);
 assert.match(css,/\.homeGreeting>img\{width:72px;height:72px/u);assert.match(css,/\.catalogCards\{gap:8px\}/u);assert.match(css,/\.suggestions \.bookSuggestion/u);
 assert.match(catalogBackend,/m\.search_text LIKE/u);assert.doesNotMatch(catalogBackend,/searchFold/u);
});
