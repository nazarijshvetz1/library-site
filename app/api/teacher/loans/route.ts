import { env } from "cloudflare:workers";

import type { CatalogD1Database } from "@/lib/catalog-d1";
import { listOpenClassLoans, listOpenLoans } from "@/lib/library-directory-store";
import { teacherPortalGate, visitJson, visitStoreError } from "@/lib/visit-schedule-api";
import type { VisitD1Database } from "@/lib/visit-schedule-store";
import { requireVisitTeacherSession } from "@/lib/visit-teacher-auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const gate = teacherPortalGate();
  if (gate) return gate;
  const db = env.DB as unknown as CatalogD1Database & VisitD1Database;
  try {
    const teacher = await requireVisitTeacherSession(db, request);
    const [personalLoans, classLoans] = await Promise.all([
      listOpenLoans(db, { teacherUserId: teacher.teacherUserId, limit: 200 }),
      listOpenClassLoans(db, { teacherUserId: teacher.teacherUserId, limit: 200 }),
    ]);
    const personalCopies = personalLoans.reduce(
      (total, loan) => total + loan.items.reduce((sum, item) => sum + item.quantityOutstanding, 0),
      0,
    );
    const classCopies = classLoans.reduce(
      (total, loan) => total + loan.items.reduce((sum, item) => sum + item.quantityOutstanding, 0),
      0,
    );
    const visibleClassLoans = classLoans.map((loan) => ({
      ...loan,
      relationship: {
        curator: loan.curatorUserId === teacher.teacherUserId,
        responsible: loan.responsibleTeacherUserId === teacher.teacherUserId,
      },
    }));
    return visitJson({
      schemaVersion: 1,
      success: true,
      summary: {
        personalCopies,
        classCopies,
        totalCopies: personalCopies + classCopies,
        classCount: new Set(classLoans.map((loan) => loan.classYearId)).size,
      },
      personalLoans,
      classLoans: visibleClassLoans,
    });
  } catch (error) {
    return visitStoreError(error, "teacher_loans_unavailable");
  }
}
