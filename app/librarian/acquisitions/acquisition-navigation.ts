import type { LibrarianSubsection } from "../_components/librarian-shell";

export function acquisitionSubsections(telegramMiniApp = false): LibrarianSubsection[] {
  return [
    { id: "requests", section: "acquisitions", label: "Заявки", hint: "Поточне комплектування", icon: "acquisitions", href: telegramMiniApp ? "/librarian/telegram/cabinet?target=acquisitions" : "/librarian/acquisitions" },
    { id: "planning", section: "acquisitions", label: "Планування фонду", hint: "Потреба на новий рік", icon: "reports", href: telegramMiniApp ? "/librarian/telegram/cabinet?target=acquisitions&view=planning" : "/librarian/acquisitions/planning" },
  ];
}
