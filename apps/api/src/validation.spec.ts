import { describe, expect, it } from '@jest/globals';
import { cellphone, dateOfBirth, dni, email, isoDate, medicalRecord, personName } from './validation';

describe('validación de entradas públicas', () => {
  it('acepta únicamente un DNI peruano de ocho dígitos', () => {
    expect(dni('12345678')).toBe('12345678');
    expect(() => dni('1234567')).toThrow();
    expect(() => dni('1234A678')).toThrow();
  });

  it('acepta únicamente celulares peruanos de nueve dígitos que empiezan en 9', () => {
    expect(cellphone('912345678')).toBe('912345678');
    expect(() => cellphone('+51912345678')).toThrow();
    expect(() => cellphone('812345678')).toThrow();
  });

  it('limita y normaliza identidad, historia clínica y correo', () => {
    expect(personName('  María   José  ', 'Nombres')).toBe('María José');
    expect(() => personName('A', 'Nombres')).toThrow();
    expect(medicalRecord('HC-2026/10')).toBe('HC-2026/10');
    expect(() => medicalRecord('HC 2026')).toThrow();
    expect(email('MEDICO@EXAMPLE.ORG')).toBe('medico@example.org');
  });

  it('rechaza fechas inexistentes y futuras', () => {
    expect(isoDate('2020-02-29', 'Fecha')).toBe('2020-02-29');
    expect(() => isoDate('2021-02-29', 'Fecha')).toThrow();
    expect(() => isoDate('2999-01-01', 'Fecha')).toThrow();
    expect(() => dateOfBirth('1800-01-01')).toThrow();
  });
});
