/**
 * Request bodies for the finance master-data forms, validated with the shared schemas so the
 * form says what is wrong before the API does. Full account numbers are never accepted (last four
 * digits only); an empty PIN / phone / last-4 on edit keeps the stored masked value.
 */
import {
  type FinanceAccountType,
  type FinanceCategoryKind,
  type FinancePayeeKind,
  type SaveBudgetLine,
  SaveBudgetLineSchema,
  type SaveFinanceAccount,
  SaveFinanceAccountSchema,
  type SaveFinanceCategory,
  SaveFinanceCategorySchema,
  type SaveFinancePayee,
  SaveFinancePayeeSchema,
} from '@ngao360/shared';
import type { z } from 'zod';

type Built<T> = { body: T } | { error: string };

function firstIssue(err: z.ZodError): string {
  const i = err.issues[0];
  return i ? `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}` : 'Check the form';
}

export function buildAccountBody(
  f: { name: string; type: FinanceAccountType; institution: string; last4: string; currency: string; dedicated: boolean; status: 'ACTIVE' | 'CLOSED' },
  expectedVersion?: number,
): Built<SaveFinanceAccount> {
  if (f.last4 && !/^\d{4}$/.test(f.last4)) return { error: 'Enter exactly the last four digits' };
  const parsed = SaveFinanceAccountSchema.safeParse({
    name: f.name,
    type: f.type,
    institution: f.institution.trim() || null,
    ...(f.last4 ? { accountNumberLast4: f.last4 } : {}),
    currency: f.currency,
    isDedicatedCampaignAccount: f.dedicated,
    status: f.status,
    ...(expectedVersion ? { expectedVersion } : {}),
  });
  return parsed.success ? { body: parsed.data } : { error: firstIssue(parsed.error) };
}

export function buildCategoryBody(f: { code: string; name: string; kind: FinanceCategoryKind; parentId: string; description: string; active: boolean }): Built<SaveFinanceCategory> {
  const parsed = SaveFinanceCategorySchema.safeParse({
    code: f.code.trim(),
    name: f.name,
    kind: f.kind,
    parentId: f.parentId || null,
    description: f.description.trim() || null,
    active: f.active,
  });
  if (!parsed.success) return { error: parsed.error.issues.some((i) => i.path[0] === 'code') ? 'Code: 2–24 upper-case letters, digits, dots, dashes or underscores' : firstIssue(parsed.error) };
  return { body: parsed.data };
}

export function buildPayeeBody(f: { name: string; kind: FinancePayeeKind; taxPin: string; phone: string; active: boolean; notes: string }): Built<SaveFinancePayee> {
  const parsed = SaveFinancePayeeSchema.safeParse({
    name: f.name,
    kind: f.kind,
    ...(f.taxPin.trim() ? { taxPin: f.taxPin.trim() } : {}),
    ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
    active: f.active,
    notes: f.notes.trim() || null,
  });
  return parsed.success ? { body: parsed.data } : { error: firstIssue(parsed.error) };
}

export function buildBudgetLineBody(
  f: {
    code: string;
    name: string;
    departmentId: string;
    categoryId: string;
    amountMinor: number;
    currency: string;
    periodStart: string;
    periodEnd: string;
    eventId: string | null;
    electionCycleId: string | null;
  },
  expectedVersion?: number,
): Built<SaveBudgetLine> {
  if (f.periodStart && f.periodEnd && f.periodEnd < f.periodStart) return { error: 'The period ends before it starts' };
  const parsed = SaveBudgetLineSchema.safeParse({
    code: f.code.trim(),
    name: f.name,
    departmentId: f.departmentId || null,
    eventId: f.eventId,
    categoryId: f.categoryId || null,
    electionCycleId: f.electionCycleId,
    amountMinor: f.amountMinor,
    currency: f.currency,
    periodStart: f.periodStart || null,
    periodEnd: f.periodEnd || null,
    ...(expectedVersion ? { expectedVersion } : {}),
  });
  if (!parsed.success) {
    if (parsed.error.issues.some((i) => i.path[0] === 'departmentId')) return { error: 'Choose a department' };
    return { error: firstIssue(parsed.error) };
  }
  return { body: parsed.data };
}
