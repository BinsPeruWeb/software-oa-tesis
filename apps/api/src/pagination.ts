import { BadRequestException } from '@nestjs/common';

export const PAGE_SIZE = 10;

export function pageNumber(value: unknown) {
  if (value === undefined || value === null || value === '') return 1;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100000) throw new BadRequestException('Página inválida');
  return parsed;
}

export function paged<T>(items: T[], page: number) {
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(page, pages);
  return { items: items.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE), page: current, pageSize: PAGE_SIZE, total, pages };
}
