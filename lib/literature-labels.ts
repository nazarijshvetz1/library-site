export const LITERATURE_TITLE = 'Єдина бібліотека Художня та наукова література';
export const LYCEUM_NAME = 'Міжнародний ліцей МАУП';
const alpha3: Record<string,string> = {AUT:'AT',AUS:'AU',BEL:'BE',BTN:'BT',CAN:'CA',CHE:'CH',CHN:'CN',CZE:'CZ',DEU:'DE',DNK:'DK',DZA:'DZ',ESP:'ES',FIN:'FI',FRA:'FR',GBR:'GB',GRC:'GR',IRL:'IE',ITA:'IT',JPN:'JP',PRK:'KP',LBN:'LB',LKA:'LK',LVA:'LV',MEX:'MX',NLD:'NL',NOR:'NO',NPL:'NP',POL:'PL',SWE:'SE',UKR:'UA',USA:'US',NZL:'NZ',IND:'IN',BRA:'BR',ARG:'AR',KOR:'KR',UK:'GB'};
const uk = new Intl.DisplayNames(['uk'],{type:'region'});
const en = new Intl.DisplayNames(['en'],{type:'region'});
export function countryCode(value: unknown) {
 const raw=String(value||'').trim(),upper=raw.toUpperCase();
 if(alpha3[upper])return alpha3[upper];
 if(/^[A-Z]{2}$/.test(upper))return upper;
 const code=Object.values(alpha3).find(c=>[uk.of(c),en.of(c)].some(n=>n?.toLocaleLowerCase('uk-UA')===raw.toLocaleLowerCase('uk-UA')));
 return code||raw;
}
export function countryLabel(value:unknown){const code=countryCode(value);return /^[A-Z]{2}$/.test(code)?uk.of(code)||String(value):String(value||'');}
export function countryAliases(value:unknown){const code=countryCode(value);return Array.from(new Set([code,...Object.entries(alpha3).filter(([,v])=>v===code).map(([k])=>k),countryLabel(code),/^[A-Z]{2}$/.test(code)?en.of(code)||code:code]));}
