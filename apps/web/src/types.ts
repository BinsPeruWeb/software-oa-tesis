export type User = { id: string; email: string; displayName: string; role: 'ADMIN' | 'CLINICIAN' };
export type Patient = {
  id: string; medicalRecordNumber: string; dni: string; names: string; surnames: string;
  birthDate: string; sex: 'female' | 'male' | null; phone: string; email: string | null;
  archived?: boolean; createdAt?: string; stats?: { episodes: number; studies: number; reports: number };
};
export type Paged<T> = { items: T[]; page: number; pageSize: number; total: number; pages: number };
export type Notify = (message: string, tone?: 'success' | 'error' | 'info' | 'warning') => void;
