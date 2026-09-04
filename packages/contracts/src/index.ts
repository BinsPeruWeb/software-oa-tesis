export const MODEL_VERSION = "oa-final-2026-09-03" as const;

export enum UserRole {
  CLINICIAN = "CLINICIAN",
  ADMIN = "ADMIN",
}

export enum ImageSourceType {
  DICOM_BILATERAL = "DICOM_BILATERAL",
  RASTER_BILATERAL = "RASTER_BILATERAL",
  RASTER_SINGLE_ROI = "RASTER_SINGLE_ROI",
}

export enum KneeSide {
  LEFT = "L",
  RIGHT = "R",
}

export enum ReviewDecision {
  CONFIRMED = "CONFIRMED",
  CORRECTED = "CORRECTED",
  REJECTED = "REJECTED",
}

export enum JobStatus {
  QUEUED = "QUEUED",
  RUNNING = "RUNNING",
  SUCCEEDED = "SUCCEEDED",
  FAILED = "FAILED",
}

export interface ProbabilityMap {
  KL0: number;
  KL1: number;
  KL2: number;
  KL3: number;
  KL4: number;
}

export interface KlPrediction {
  modelVersion: typeof MODEL_VERSION;
  predictedKl: 0 | 1 | 2 | 3 | 4;
  confidence: number;
  probabilities: ProbabilityMap;
  memberProbabilities: {
    resnet50: ProbabilityMap;
    densenet121: ProbabilityMap;
  };
  modelHashes: Record<string, string>;
  sourceType: ImageSourceType;
  pipeline: string;
  device: string;
  durationMs: number;
}

export interface ClinicalFlags {
  obesity: boolean;
  diabetes: boolean;
  hypertension: boolean;
  nicotineUse: boolean;
  traumaLowerExtremity: boolean;
}

export interface PriorKlExam {
  date: string;
  klg: 0 | 1 | 2 | 3 | 4;
  kneeSide: KneeSide;
}

export interface ArthroplastyRiskRequest extends ClinicalFlags {
  dateOfBirth: string;
  currentDate: string;
  currentKl: 0 | 1 | 2 | 3 | 4;
  painScore: number | null;
  sex: "female" | "male" | null;
  kneeSide: KneeSide;
  priorExams: PriorKlExam[];
}

export interface ProgressionTimepoint extends ClinicalFlags {
  date: string;
  klg: 0 | 1 | 2 | 3 | 4;
  ageAtExam: number;
  painScore: number | null;
  kneeSide: KneeSide;
}

export interface BinaryRiskResult {
  modelVersion: typeof MODEL_VERSION;
  probability: number;
  threshold: number;
  screenPositive: boolean;
  target: string;
  horizonMonths: number | [number, number];
  warning: string;
}

export const RESEARCH_WARNING =
  "Uso experimental y de apoyo; requiere interpretación del traumatólogo. No constituye una indicación quirúrgica.";

