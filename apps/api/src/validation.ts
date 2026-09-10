import { BadRequestException } from '@nestjs/common';

export function text(value: unknown, label: string, minimum: number, maximum: number) {
  if (typeof value !== 'string') throw new BadRequestException(`${label} es obligatorio`);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new BadRequestException(`${label} debe tener entre ${minimum} y ${maximum} caracteres`);
  }
  return normalized;
}

export function optionalText(value: unknown, label: string, maximum: number) {
  if (value === null || value === undefined || value === '') return null;
  return text(value, label, 1, maximum);
}

export function dni(value: unknown) {
  const normalized = text(value, 'DNI', 8, 8);
  if (!/^\d{8}$/.test(normalized)) throw new BadRequestException('El DNI debe contener exactamente 8 dígitos');
  return normalized;
}

export function cellphone(value: unknown) {
  const normalized = text(value, 'Celular', 9, 9).replace(/\s/g, '');
  if (!/^9\d{8}$/.test(normalized)) throw new BadRequestException('El celular debe tener 9 dígitos y comenzar con 9');
  return normalized;
}

export function cmpNumber(value: unknown) {
  const normalized = text(value, 'CMP', 4, 10);
  if (!/^\d{4,10}$/.test(normalized)) throw new BadRequestException('El CMP debe contener entre 4 y 10 dígitos');
  return normalized;
}

export function personName(value: unknown, label: string) {
  const normalized = text(value, label, 2, 80);
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(normalized)) {
    throw new BadRequestException(`${label} contiene caracteres no permitidos`);
  }
  return normalized;
}

export function medicalRecord(value: unknown) {
  const normalized = text(value, 'Historia clínica', 1, 30);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized)) {
    throw new BadRequestException('La historia clínica solo admite letras, números, punto, guion, barra y guion bajo');
  }
  return normalized;
}

export function email(value: unknown, required = false) {
  if (!required && (value === null || value === undefined || value === '')) return null;
  const normalized = text(value, 'Correo', 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new BadRequestException('Correo inválido');
  return normalized;
}

export function isoDate(value: unknown, label: string, allowFuture = false) {
  const normalized = text(value, label, 10, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new BadRequestException(`${label} inválida`);
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new BadRequestException(`${label} inválida`);
  }
  if (!allowFuture && parsed > new Date()) throw new BadRequestException(`${label} no puede estar en el futuro`);
  return normalized;
}

export function dateOfBirth(value: unknown) {
  const normalized = isoDate(value, 'Fecha de nacimiento');
  const parsed = new Date(`${normalized}T00:00:00Z`);
  const oldest = new Date();
  oldest.setUTCFullYear(oldest.getUTCFullYear() - 130);
  oldest.setUTCHours(0, 0, 0, 0);
  if (parsed < oldest) throw new BadRequestException('La fecha de nacimiento no puede superar 130 años de antigüedad');
  return normalized;
}

export function uuid(value: unknown, label: string) {
  const normalized = text(value, label, 36, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new BadRequestException(`${label} inválido`);
  }
  return normalized;
}

export function boundedNumber(value: unknown, label: string, minimum: number, maximum: number, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new BadRequestException(`${label} debe estar entre ${minimum} y ${maximum}`);
  }
  return value;
}
