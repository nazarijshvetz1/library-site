"use client";

import SiteIcon from "@/app/_components/site-icon";

export default function PrintActions() {
  return <nav aria-label="Дії з документом" className="print-actions"><button type="button" onClick={() => window.print()}><SiteIcon name="reports" size={17} /> Друкувати / PDF</button><button type="button" onClick={() => window.close()}><SiteIcon name="close" size={17} /> Закрити</button></nav>;
}
