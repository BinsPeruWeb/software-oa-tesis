import { api, post } from "./api";

export type ReportSide = "ALL" | "R" | "L";
export async function downloadClinicalReport(episodeId: string, reportType: "EPISODE" | "LONGITUDINAL", kneeSide: ReportSide) {
  const result = await post<{ id: string; warning?: string }>(`/api/episodes/${episodeId}/reports`, { reportType, kneeSide });
  const pdf = await api<Blob>(`/api/reports/${result.id}/download`);
  const url = URL.createObjectURL(pdf);
  const link = document.createElement("a");
  link.href = url;
  const side = kneeSide === "ALL" ? "general" : kneeSide === "R" ? "derecha" : "izquierda";
  link.download = `reporte-oa-${reportType === "LONGITUDINAL" ? "longitudinal" : "episodio"}-${side}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return result;
}
