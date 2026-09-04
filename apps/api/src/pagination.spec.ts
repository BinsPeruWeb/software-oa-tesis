import { describe, expect, it } from '@jest/globals';
import { PAGE_SIZE, pageNumber, paged } from './pagination';

describe('paginación administrativa', () => {
  it('mantiene un tamaño fijo de diez elementos', () => {
    expect(PAGE_SIZE).toBe(10);
    expect(paged(Array.from({ length: 24 }, (_, index) => index), 1)).toMatchObject({
      page: 1,
      pageSize: 10,
      pages: 3,
      total: 24,
    });
  });

  it('usa la primera página por defecto y rechaza valores inválidos', () => {
    expect(pageNumber(undefined)).toBe(1);
    expect(pageNumber('3')).toBe(3);
    expect(() => pageNumber('0')).toThrow('Página inválida');
    expect(() => pageNumber('-3')).toThrow('Página inválida');
    expect(() => pageNumber('2.9')).toThrow('Página inválida');
    expect(() => pageNumber('texto')).toThrow('Página inválida');
  });
});
