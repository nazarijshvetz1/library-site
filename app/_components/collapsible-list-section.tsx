"use client";

import { type ReactNode, useState } from "react";

import SiteIcon from "./site-icon";
import styles from "./collapsible-list-section.module.css";

type CollapsibleListSectionProps = {
  titleId: string;
  title: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  defaultExpanded?: boolean;
  collapsedMessage?: string;
  headingLevel?: "h2" | "h3";
  flatOnMobile?: boolean;
};

export default function CollapsibleListSection({
  titleId,
  title,
  eyebrow,
  actions,
  children,
  className = "",
  contentClassName = "",
  defaultExpanded = true,
  collapsedMessage = "Список згорнуто. Усі записи та вибрані фільтри збережено.",
  headingLevel = "h2",
  flatOnMobile = false,
}: CollapsibleListSectionProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const contentId = `${titleId}-content`;
  const Heading = headingLevel;

  return (
    <section className={`${styles.section} ${flatOnMobile ? styles.flatOnMobile : ""} ${className}`.trim()} aria-labelledby={titleId} data-collapsible-list="true">
      <div className={styles.heading}>
        <div className={styles.titleBlock}>
          {eyebrow ? <span>{eyebrow}</span> : null}
          <Heading id={titleId}>{title}</Heading>
        </div>
        <div className={styles.actions}>
          <button
            className={styles.toggle}
            type="button"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className={styles.chevron} data-expanded={expanded ? "true" : "false"} aria-hidden="true"><SiteIcon name="expand" size={17} /></span>
            {expanded ? "Згорнути" : "Розгорнути"}
          </button>
          {actions}
        </div>
      </div>
      <div id={contentId} className={`${styles.content} ${contentClassName}`.trim()} hidden={!expanded}>
        {children}
      </div>
      {!expanded ? <p className={styles.collapsedNote} role="status">{collapsedMessage}</p> : null}
    </section>
  );
}
