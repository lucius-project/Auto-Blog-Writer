/**
 * Website checklist item shape + scoring, shared by the worker (produces
 * items), the API (merges manual state, scores) and the web page.
 */

export type ChecklistCategory = "Technical" | "Location pages" | "Industry pages" | "Reviews & trust" | "Off-site";
export type ChecklistStatus = "pass" | "warn" | "fail" | "manual";
export type ChecklistImpact = "high" | "medium" | "low";

export interface ChecklistItem {
  /** stable across runs (manual ticks are keyed by it), e.g. "local:nanaimo:schema" */
  key: string;
  category: ChecklistCategory;
  title: string;
  status: ChecklistStatus;
  impact: ChecklistImpact;
  /** what the check found */
  detail: string;
  /** how to fix it, in plain language */
  fix: string;
  /** page the item is about, when there is one */
  url?: string;
  /** manual items only: owner ticked it off */
  done?: boolean;
  doneAt?: string;
}

export const CHECKLIST_CATEGORIES: ChecklistCategory[] = ["Technical", "Location pages", "Industry pages", "Reviews & trust", "Off-site"];

const WEIGHT: Record<ChecklistImpact, number> = { high: 3, medium: 2, low: 1 };

/** 0-100: pass (or ticked manual) = full weight, warn = half, fail/unticked = 0. */
export function checklistScore(items: ChecklistItem[]): number {
  let earned = 0, total = 0;
  for (const it of items) {
    const w = WEIGHT[it.impact];
    total += w;
    if (it.status === "pass" || (it.status === "manual" && it.done)) earned += w;
    else if (it.status === "warn") earned += w / 2;
  }
  return total ? Math.round((earned / total) * 100) : 0;
}

/** true when the item still needs work */
export const needsWork = (it: ChecklistItem) =>
  it.status === "fail" || it.status === "warn" || (it.status === "manual" && !it.done);
