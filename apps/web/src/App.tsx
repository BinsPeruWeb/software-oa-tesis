import {
  FormEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  Archive,
  BarChart3,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Download,
  FileText,
  HeartPulse,
  History,
  Images,
  LayoutDashboard,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  ShieldCheck,
  Stethoscope,
  UserRound,
  UserRoundCog,
  UsersRound,
} from "lucide-react";
import { Toaster, toast } from "sonner";
import { api, post } from "./api";
import ClinicalAnalysis from "./ClinicalAnalysis";
import { Notify, Paged, Patient, User } from "./types";
import { Badge, ConfirmModal, Empty, Modal, Pagination, Spinner } from "./ui";

type Route = { name: string; patientId?: string; episodeId?: string };
type ClinicalProfile = {
  painScore: number | null;
  obesity: boolean;
  diabetes: boolean;
  hypertension: boolean;
  nicotineUse: boolean;
  traumaLowerExtremity: boolean;
  updatedAt?: string;
};
type AnalysisSummary = {
  episodeId: string;
  episodeDate: string;
  studyId: string;
  examDate: string;
  kneeSide: "L" | "R";
  sourceType: string;
  previewUrl: string;
  status: string;
  ensemble: any;
  arthroplasty: any;
  progression: any;
  radiologySeconds: number | null;
  totalProcessingSeconds: number;
  gradcams?: any[];
  reports?: any[];
};
type AdminUser = {
  id: string;
  email: string;
  displayName: string;
  role: "ADMIN" | "CLINICIAN";
  active: boolean;
  dni: string | null;
  cmp: string | null;
  healthEstablishment: string | null;
  lastAccess: string | null;
};

const today = new Date().toISOString().slice(0, 10);
const formatDate = (value?: string | null) =>
  value
    ? new Intl.DateTimeFormat("es-PE", { dateStyle: "medium" }).format(
        new Date(value),
      )
    : "—";
const percent = (value?: number | null) =>
  value == null ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
const flags = [
  ["obesity", "Obesidad"],
  ["diabetes", "Diabetes"],
  ["hypertension", "Hipertensión"],
  ["nicotineUse", "Consumo de nicotina"],
  ["traumaLowerExtremity", "Trauma de miembro inferior"],
] as const;
const completeClinicalProfile = (profile: ClinicalProfile | null | undefined) =>
  Boolean(profile && flags.every(([key]) => typeof profile[key] === "boolean"));
const passwordWords = [
  "Lima",
  "Sol",
  "Luna",
  "Rio",
  "Menta",
  "Pino",
  "Nube",
  "Cobre",
];
function friendlyPassword() {
  const values = new Uint32Array(3);
  crypto.getRandomValues(values);
  return `${passwordWords[values[0] % passwordWords.length]}-${passwordWords[values[1] % passwordWords.length]}-${1000 + (values[2] % 9000)}!`;
}

function Login({ onDone }: { onDone: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<any>();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function login(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await post<any>("/api/auth/login", { email, password });
      if (result.authenticated) onDone(await api("/api/auth/me"));
      else setChallenge(result);
    } catch (reason: any) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }
  async function verify(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      await post("/api/auth/mfa/verify", {
        challengeToken: challenge.challengeToken,
        code,
      });
      onDone(await api("/api/auth/me"));
    } catch (reason: any) {
      setError(reason.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-shell">
      <section className="auth-visual">
        <div className="brand-symbol">OA</div>
        <div>
          <span className="overline light">
            Plataforma clínica experimental
          </span>
          <h1>Decisiones mejor informadas, seguimiento más claro.</h1>
          <p>
            Clasificación radiográfica y análisis longitudinal de osteoartritis
            de rodilla.
          </p>
        </div>
        <small>
          Herramienta de investigación · No sustituye el criterio médico
        </small>
      </section>
      <section className="auth-form">
        <div className="auth-card">
          <div className="mobile-brand">OA · Plataforma clínica</div>
          <span className="overline">Acceso seguro</span>
          <h2>{challenge ? "Verificación administrativa" : "Bienvenido"}</h2>
          <p>
            {challenge
              ? "Ingrese el código temporal de su autenticador."
              : "Ingrese sus credenciales para abrir el panel."}
          </p>
          {!challenge ? (
            <form className="form-stack" onSubmit={login}>
              <label>
                Correo electrónico
                <input
                  type="email"
                  maxLength={254}
                  value={email}
                  onChange={(event) =>
                    setEmail(event.target.value.slice(0, 254))
                  }
                  autoComplete="username"
                  required
                />
              </label>
              <label>
                Contraseña
                <input
                  type="password"
                  maxLength={128}
                  value={password}
                  onChange={(event) =>
                    setPassword(event.target.value.slice(0, 128))
                  }
                  autoComplete="current-password"
                  required
                />
              </label>
              <button className="button primary" disabled={busy}>
                {busy ? "Ingresando…" : "Ingresar al panel"}
              </button>
            </form>
          ) : (
            <form className="form-stack" onSubmit={verify}>
              {challenge.enrollment && (
                <div className="enrollment">
                  <b>Configure su autenticador</b>
                  <code>{challenge.enrollment.secret}</code>
                </div>
              )}
              <label>
                Código de 6 dígitos
                <input
                  inputMode="numeric"
                  minLength={6}
                  maxLength={6}
                  pattern="[0-9]{6}"
                  value={code}
                  onChange={(event) =>
                    setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  autoFocus
                  required
                />
              </label>
              <button className="button primary" disabled={busy}>
                Verificar
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => setChallenge(undefined)}
              >
                Volver
              </button>
            </form>
          )}
          {error && <div className="alert danger-alert">{error}</div>}
        </div>
      </section>
    </main>
  );
}

function Page({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <span className="overline">Centro de control OA</span>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        {action}
      </header>
      {children}
    </div>
  );
}
function Metric({
  label,
  value,
  detail,
  tone = "",
}: {
  label: string;
  value: number | string;
  detail: string;
  tone?: string;
}) {
  const Glyph = label.includes("Médico")
    ? Stethoscope
    : label.includes("Paciente") || label.includes("paciente")
      ? UserRound
      : label.includes("Usuario")
        ? UsersRound
        : label.includes("Estudio")
          ? Images
          : label.includes("Revisión")
            ? ClipboardCheck
            : label.includes("Reporte")
              ? FileText
              : label.includes("Evento")
                ? Clock3
                : Activity;
  return (
    <article className={`metric ${tone}`}>
      <div className="metric-icon">
        <Glyph size={21} />
      </div>
      <div className="metric-copy">
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

function AdminDashboard() {
  const [data, setData] = useState<any>();
  useEffect(() => {
    void api("/api/admin/dashboard").then(setData);
  }, []);
  if (!data) return <Spinner />;
  return (
    <Page
      title="Resumen del sistema"
      subtitle="Actividad operativa sin exponer información clínica identificable."
    >
      <div className="metric-grid">
        <Metric
          label="Usuarios administrativos"
          value={data.activeUsers - data.clinicians}
          detail="Cuentas técnicas activas"
        />
        <Metric
          label="Médicos"
          value={data.clinicians}
          detail="Profesionales activos"
        />
        <Metric
          label="Pacientes"
          value={data.patients}
          detail="Conteo agregado"
        />
        <Metric
          label="Inferencias activas"
          value={data.activeJobs}
          detail="En cola o ejecutándose"
        />
        <Metric
          label="Trabajos fallidos"
          value={data.failedJobs}
          detail="Requieren revisión"
          tone={data.failedJobs ? "metric-warning" : ""}
        />
        <Metric
          label="Eventos 24 h"
          value={data.events24h}
          detail="Trazabilidad reciente"
        />
      </div>
    </Page>
  );
}

function AccountForm({
  kind,
  initial,
  onClose,
  onSaved,
  notify,
}: {
  kind: "users" | "clinicians";
  initial?: AdminUser;
  onClose: () => void;
  onSaved: () => void;
  notify: Notify;
}) {
  const doctor = kind === "clinicians";
  const [form, setForm] = useState({
    email: initial?.email ?? "",
    displayName: initial?.displayName ?? "",
    password: "",
    dni: initial?.dni ?? "",
    cmp: initial?.cmp ?? "",
    healthEstablishment: initial?.healthEstablishment ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [looking, setLooking] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const path = initial
        ? `/api/admin/${kind}/${initial.id}`
        : "/api/admin/clinicians";
      await api(path, {
        method: initial ? "PATCH" : "POST",
        body: JSON.stringify(form),
      });
      notify(
        initial ? "Cuenta actualizada" : "Médico y cuenta de acceso creados",
        "success",
      );
      onSaved();
      onClose();
    } catch (error: any) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function lookup() {
    setLooking(true);
    try {
      const result = await api<any>(`/api/admin/lookup-dni?dni=${form.dni}`);
      if (!result.found) {
        notify("DNI no encontrado", "warning");
        return;
      }
      setForm((value) => ({
        ...value,
        displayName: `${result.names} ${result.surnames}`.trim().slice(0, 100),
      }));
      notify("Nombre autocompletado desde el DNI", "success");
    } catch (error: any) {
      notify(error.message, "error");
    } finally {
      setLooking(false);
    }
  }
  function generatePassword() {
    setForm((value) => ({ ...value, password: friendlyPassword() }));
    setShowPassword(true);
    notify("Contraseña generada; puede copiarla antes de guardar", "success");
  }
  async function copyPassword() {
    if (!form.password) {
      notify("Primero genere o escriba una contraseña", "warning");
      return;
    }
    try {
      await navigator.clipboard.writeText(form.password);
      notify("Contraseña copiada", "success");
    } catch {
      notify("No fue posible copiarla automáticamente", "error");
    }
  }
  return (
    <Modal
      title={
        initial ? `Editar ${doctor ? "médico" : "usuario"}` : "Registrar médico"
      }
      onClose={onClose}
      wide={doctor}
    >
      <form className="form-grid" onSubmit={save}>
        {doctor && (
          <label className="span">
            DNI
            <div className="field-action">
              <input
                inputMode="numeric"
                minLength={8}
                maxLength={8}
                pattern="[0-9]{8}"
                value={form.dni}
                onChange={(event) =>
                  setForm({
                    ...form,
                    dni: event.target.value.replace(/\D/g, "").slice(0, 8),
                  })
                }
                required
              />
              <button
                type="button"
                className="button secondary"
                disabled={looking || form.dni.length !== 8}
                onClick={() => void lookup()}
              >
                {looking ? "Consultando…" : "Autocompletar"}
              </button>
            </div>
            <small>
              Consulte PeruDevs para completar el nombre o escríbalo
              manualmente.
            </small>
          </label>
        )}
        <label>
          Nombre completo
          <input
            minLength={2}
            maxLength={100}
            value={form.displayName}
            onChange={(event) =>
              setForm({
                ...form,
                displayName: event.target.value.slice(0, 100),
              })
            }
            required
          />
        </label>
        <label>
          Correo de acceso
          <input
            type="email"
            maxLength={254}
            value={form.email}
            onChange={(event) =>
              setForm({ ...form, email: event.target.value.slice(0, 254) })
            }
            required
          />
        </label>
        {doctor && (
          <>
            <label>
              CMP
              <input
                inputMode="numeric"
                minLength={4}
                maxLength={10}
                pattern="[0-9]{4,10}"
                value={form.cmp}
                onChange={(event) =>
                  setForm({
                    ...form,
                    cmp: event.target.value.replace(/\D/g, "").slice(0, 10),
                  })
                }
                required
              />
              <small>Entre 4 y 10 dígitos.</small>
            </label>
            <label>
              Establecimiento de salud
              <input
                minLength={2}
                maxLength={120}
                value={form.healthEstablishment}
                onChange={(event) =>
                  setForm({
                    ...form,
                    healthEstablishment: event.target.value.slice(0, 120),
                  })
                }
                placeholder="Ej. Hospital Regional del Cusco"
                required
              />
            </label>
          </>
        )}
        <label className="span">
          {initial ? "Nueva contraseña (opcional)" : "Contraseña inicial"}
          <div className="credential-action">
            <input
              type={showPassword ? "text" : "password"}
              minLength={8}
              maxLength={128}
              value={form.password}
              onChange={(event) =>
                setForm({ ...form, password: event.target.value.slice(0, 128) })
              }
              autoComplete="new-password"
              required={!initial}
            />
            <button
              type="button"
              className="button secondary"
              onClick={generatePassword}
            >
              Generar
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!form.password}
              onClick={() => void copyPassword()}
            >
              Copiar
            </button>
          </div>
          <button
            type="button"
            className="password-visibility"
            onClick={() => setShowPassword((value) => !value)}
          >
            {showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
          </button>
          <small>
            {!initial
              ? "Mínimo 8 caracteres. Puede usar la contraseña sugerida y copiarla para entregarla al médico."
              : "Déjela vacía para conservar la actual, o genere una nueva y cópiela antes de guardar."}
          </small>
        </label>
        <div className="modal-actions span">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancelar
          </button>
          <button className="button primary" disabled={busy}>
            {busy
              ? "Guardando…"
              : doctor && !initial
                ? "Crear médico y usuario"
                : "Guardar cambios"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AccountsPage({
  kind,
  notify,
}: {
  kind: "users" | "clinicians";
  notify: Notify;
}) {
  const doctors = kind === "clinicians";
  const [data, setData] = useState<Paged<AdminUser>>();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<AdminUser | null | undefined>();
  const [confirm, setConfirm] = useState<AdminUser>();
  const load = () =>
    api<Paged<AdminUser>>(
      `/api/admin/${kind}?page=${page}&search=${encodeURIComponent(search)}`,
    )
      .then(setData)
      .catch((error) => notify(error.message, "error"));
  useEffect(() => {
    void load();
  }, [kind, page, search]);
  async function toggle(account: AdminUser) {
    try {
      if (account.active)
        await api(`/api/admin/users/${account.id}`, { method: "DELETE" });
      else await post(`/api/admin/users/${account.id}/activate`, {});
      notify(
        account.active ? "Cuenta desactivada" : "Cuenta reactivada",
        "success",
      );
      setConfirm(undefined);
      void load();
    } catch (error: any) {
      notify(error.message, "error");
    }
  }
  return (
    <Page
      title={doctors ? "Médicos" : "Usuarios"}
      subtitle={
        doctors
          ? "Cada médico registrado recibe automáticamente su propia cuenta de acceso."
          : "Todas las cuentas de acceso del sistema, incluidas las creadas para médicos."
      }
      action={
        doctors ? (
          <button className="button primary" onClick={() => setEditing(null)}>
            <Plus size={17} /> Registrar médico
          </button>
        ) : undefined
      }
    >
      <div className="toolbar">
        <input
          type="search"
          placeholder={
            doctors
              ? "Buscar médico, correo, CMP o establecimiento"
              : "Buscar usuario o correo"
          }
          maxLength={100}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value.slice(0, 100));
            setPage(1);
          }}
        />
      </div>
      <section className="surface table-card">
        {!data ? (
          <Spinner />
        ) : data.items.length === 0 ? (
          <Empty
            title={doctors ? "No hay médicos" : "No hay usuarios"}
            detail={
              doctors
                ? "Registre al primer médico para crear su acceso."
                : "No existen cuentas de acceso."
            }
          />
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>{doctors ? "Médico" : "Usuario"}</th>
                  {doctors ? (
                    <>
                      <th>CMP</th>
                      <th>Establecimiento de salud</th>
                    </>
                  ) : (
                    <th>Rol</th>
                  )}
                  <th>Estado</th>
                  <th>Último acceso</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((account) => (
                  <tr key={account.id}>
                    <td data-label={doctors ? "Médico" : "Usuario"}>
                      <b>{account.displayName}</b>
                      <small>{account.email}</small>
                      {doctors && (
                        <small>
                          DNI{" "}
                          {account.dni
                            ? `••••${account.dni.slice(-4)}`
                            : "pendiente"}
                        </small>
                      )}
                    </td>
                    {doctors ? (
                      <>
                        <td data-label="CMP">{account.cmp ?? "—"}</td>
                        <td data-label="Establecimiento">
                          {account.healthEstablishment ?? "—"}
                        </td>
                      </>
                    ) : (
                      <td data-label="Rol">
                        <Badge tone="info">
                          {account.role === "CLINICIAN"
                            ? "Médico"
                            : "Administrador"}
                        </Badge>
                      </td>
                    )}
                    <td data-label="Estado">
                      <Badge tone={account.active ? "success" : "neutral"}>
                        {account.active ? "Activo" : "Inactivo"}
                      </Badge>
                    </td>
                    <td data-label="Último acceso">
                      {formatDate(account.lastAccess)}
                    </td>
                    <td className="row-actions">
                      <button
                        className="icon-button"
                        onClick={() => setEditing(account)}
                      >
                        Editar
                      </button>
                      <button
                        className="icon-button danger-text"
                        onClick={() => setConfirm(account)}
                      >
                        {account.active ? "Desactivar" : "Reactivar"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination {...data} onPage={setPage} />
          </>
        )}
      </section>
      {editing !== undefined && (
        <AccountForm
          kind={kind}
          initial={editing ?? undefined}
          onClose={() => setEditing(undefined)}
          onSaved={load}
          notify={notify}
        />
      )}
      {confirm && (
        <ConfirmModal
          title={confirm.active ? "Desactivar cuenta" : "Reactivar cuenta"}
          detail={`${confirm.displayName} ${confirm.active ? "perderá acceso y se cerrarán sus sesiones." : "podrá volver a ingresar al sistema."}`}
          danger={confirm.active}
          onClose={() => setConfirm(undefined)}
          action={() => void toggle(confirm)}
        />
      )}
    </Page>
  );
}

function AdminAudit() {
  const [data, setData] = useState<Paged<any>>();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  useEffect(() => {
    void api<Paged<any>>(
      `/api/admin/audit?page=${page}&search=${encodeURIComponent(search)}`,
    ).then(setData);
  }, [page, search]);
  return (
    <Page
      title="Auditoría"
      subtitle="Registro inmutable de accesos, cambios y decisiones."
    >
      <div className="toolbar">
        <input
          type="search"
          placeholder="Filtrar eventos"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value.slice(0, 100));
            setPage(1);
          }}
        />
      </div>
      <section className="surface table-card">
        {!data ? (
          <Spinner />
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Actor</th>
                  <th>Acción</th>
                  <th>Entidad</th>
                  <th>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Fecha">{formatDate(item.occurredAt)}</td>
                    <td data-label="Actor">{item.actorName ?? "Sistema"}</td>
                    <td data-label="Acción">
                      <Badge tone="info">{item.action}</Badge>
                    </td>
                    <td data-label="Entidad">{item.entityType}</td>
                    <td data-label="Detalle">
                      <small>
                        {Object.keys(item.metadata ?? {}).join(", ") || "—"}
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination {...data} onPage={setPage} />
          </>
        )}
      </section>
    </Page>
  );
}

function AdminSettings({ notify }: { notify: Notify }) {
  const [form, setForm] = useState({
    organizationName: "",
    reportSubtitle: "",
    patientCodePrefix: "OA",
  });
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    void api<any[]>("/api/admin/settings").then((rows) => {
      const org = rows.find((item) => item.key === "organization")?.value ?? {};
      const code = rows.find((item) => item.key === "patientCode")?.value ?? {};
      setForm({
        organizationName: org.name ?? "",
        reportSubtitle: org.reportSubtitle ?? "",
        patientCodePrefix: code.prefix ?? "OA",
      });
      setLoaded(true);
    });
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/admin/settings", {
        method: "PATCH",
        body: JSON.stringify(form),
      });
      notify("Configuración actualizada", "success");
    } catch (error: any) {
      notify(error.message, "error");
    }
  }
  if (!loaded) return <Spinner />;
  return (
    <Page
      title="Configuración"
      subtitle="Identidad institucional y reglas generales."
    >
      <section className="surface settings-card">
        <form className="form-grid" onSubmit={save}>
          <label>
            Nombre de la institución
            <input
              minLength={2}
              maxLength={100}
              value={form.organizationName}
              onChange={(event) =>
                setForm({
                  ...form,
                  organizationName: event.target.value.slice(0, 100),
                })
              }
              required
            />
          </label>
          <label>
            Prefijo de historia clínica
            <input
              minLength={1}
              maxLength={8}
              pattern="[A-Za-z0-9]+"
              value={form.patientCodePrefix}
              onChange={(event) =>
                setForm({
                  ...form,
                  patientCodePrefix: event.target.value
                    .toUpperCase()
                    .slice(0, 8),
                })
              }
              required
            />
          </label>
          <label className="span">
            Subtítulo del reporte
            <input
              minLength={2}
              maxLength={160}
              value={form.reportSubtitle}
              onChange={(event) =>
                setForm({
                  ...form,
                  reportSubtitle: event.target.value.slice(0, 160),
                })
              }
              required
            />
          </label>
          <button className="button primary span">Guardar configuración</button>
        </form>
      </section>
    </Page>
  );
}

function PatientForm({
  initial,
  onClose,
  onSaved,
  notify,
}: {
  initial?: Patient;
  onClose: () => void;
  onSaved: (patient: Patient) => void;
  notify: Notify;
}) {
  const [form, setForm] = useState({
    dni: initial?.dni ?? "",
    names: initial?.names ?? "",
    surnames: initial?.surnames ?? "",
    birthDate: initial?.birthDate ?? "",
    sex: initial?.sex ?? "",
    phone: initial?.phone ?? "",
    email: initial?.email ?? "",
  });
  const [looking, setLooking] = useState(false);
  const [busy, setBusy] = useState(false);
  async function lookup() {
    setLooking(true);
    try {
      const value = await api<any>(`/api/patients/lookup-dni?dni=${form.dni}`);
      if (!value.found)
        notify(
          "No se encontraron datos; complete el formulario manualmente",
          "warning",
        );
      else {
        setForm({
          ...form,
          names: value.names ?? "",
          surnames: value.surnames ?? "",
          birthDate: value.birthDate ?? "",
          sex: value.sex ?? "",
        });
        notify("Datos encontrados; verifíquelos antes de guardar", "success");
      }
    } catch (error: any) {
      notify(error.message, "error");
    } finally {
      setLooking(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const patient = await api<Patient>(
        initial ? `/api/patients/${initial.id}` : "/api/patients",
        {
          method: initial ? "PATCH" : "POST",
          body: JSON.stringify({
            ...form,
            sex: form.sex || null,
            email: form.email || null,
          }),
        },
      );
      notify(
        initial
          ? "Paciente actualizado"
          : `Paciente registrado con HC ${patient.medicalRecordNumber}`,
        "success",
      );
      onSaved(patient);
      onClose();
    } catch (error: any) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={initial ? "Editar paciente" : "Registrar paciente"}
      onClose={onClose}
      wide
    >
      <form className="form-grid" onSubmit={save}>
        <label>
          DNI
          <div className="field-action">
            <input
              inputMode="numeric"
              minLength={8}
              maxLength={8}
              pattern="[0-9]{8}"
              value={form.dni}
              onChange={(event) =>
                setForm({
                  ...form,
                  dni: event.target.value.replace(/\D/g, "").slice(0, 8),
                })
              }
              required
            />
            <button
              type="button"
              className="button secondary"
              disabled={looking || form.dni.length !== 8}
              onClick={lookup}
            >
              {looking ? "Consultando…" : "Autocompletar"}
            </button>
          </div>
        </label>
        <label>
          Nombres
          <input
            minLength={2}
            maxLength={80}
            value={form.names}
            onChange={(event) =>
              setForm({ ...form, names: event.target.value.slice(0, 80) })
            }
            required
          />
        </label>
        <label>
          Apellidos
          <input
            minLength={2}
            maxLength={80}
            value={form.surnames}
            onChange={(event) =>
              setForm({ ...form, surnames: event.target.value.slice(0, 80) })
            }
            required
          />
        </label>
        <label>
          Fecha de nacimiento
          <input
            type="date"
            max={today}
            value={form.birthDate}
            onChange={(event) =>
              setForm({ ...form, birthDate: event.target.value })
            }
            required
          />
        </label>
        <label>
          Sexo
          <select
            value={form.sex ?? ""}
            onChange={(event) =>
              setForm({ ...form, sex: event.target.value as any })
            }
          >
            <option value="">No registrado</option>
            <option value="female">Femenino</option>
            <option value="male">Masculino</option>
          </select>
        </label>
        <label>
          Celular
          <input
            inputMode="numeric"
            minLength={9}
            maxLength={9}
            pattern="9[0-9]{8}"
            value={form.phone}
            onChange={(event) =>
              setForm({
                ...form,
                phone: event.target.value.replace(/\D/g, "").slice(0, 9),
              })
            }
            required
          />
        </label>
        <label>
          Correo opcional
          <input
            type="email"
            maxLength={254}
            value={form.email ?? ""}
            onChange={(event) =>
              setForm({ ...form, email: event.target.value.slice(0, 254) })
            }
          />
        </label>
        {!initial && (
          <div className="auto-code">
            <span>Historia clínica</span>
            <b>Se generará automáticamente</b>
          </div>
        )}
        <div className="modal-actions span">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancelar
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Guardando…" : "Guardar paciente"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ClinicalProfileForm({
  initial,
  patientId,
  onClose,
  onSaved,
  notify,
}: {
  initial: ClinicalProfile | null;
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
  notify: Notify;
}) {
  const [pain, setPain] = useState(initial?.painScore?.toString() ?? "");
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(
      flags.map(([key]) => [key, initial ? String(initial[key]) : ""]),
    ),
  );
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (Object.values(values).some((value) => value === ""))
      return notify("Marque Sí o No en todos los indicadores", "warning");
    setBusy(true);
    try {
      await api(`/api/patients/${patientId}/clinical-profile`, {
        method: "PATCH",
        body: JSON.stringify({
          painScore: pain === "" ? null : Number(pain),
          ...Object.fromEntries(
            Object.entries(values).map(([key, value]) => [
              key,
              value === "true",
            ]),
          ),
        }),
      });
      notify("Datos clínicos actualizados en la historia", "success");
      onSaved();
      onClose();
    } catch (error: any) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Datos clínicos de la historia" onClose={onClose} wide>
      <p className="muted">
        Estos valores se copiarán como una fotografía clínica en cada análisis
        nuevo. Actualícelos cuando cambie la condición del paciente.
      </p>
      <form className="form-grid" onSubmit={save}>
        <label>
          Dolor actual 0–10, opcional
          <input
            type="number"
            min="0"
            max="10"
            step="0.1"
            value={pain}
            onChange={(event) => setPain(event.target.value)}
          />
        </label>
        {flags.map(([key, label]) => (
          <label key={key}>
            {label}
            <select
              value={values[key]}
              onChange={(event) =>
                setValues({ ...values, [key]: event.target.value })
              }
              required
            >
              <option value="">Seleccione…</option>
              <option value="true">Sí</option>
              <option value="false">No</option>
            </select>
          </label>
        ))}
        <div className="modal-actions span">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancelar
          </button>
          <button className="button primary" disabled={busy}>
            Guardar en historia clínica
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PriorForm({
  patientId,
  onClose,
  onSaved,
  notify,
}: {
  patientId: string;
  onClose: () => void;
  onSaved: () => void;
  notify: Notify;
}) {
  const [form, setForm] = useState<any>({
    examDate: "",
    kneeSide: "R",
    confirmedKl: "0",
    painScore: "",
    obesity: "",
    diabetes: "",
    hypertension: "",
    nicotineUse: "",
    traumaLowerExtremity: "",
  });
  async function save(event: FormEvent) {
    event.preventDefault();
    if (flags.some(([key]) => form[key] === ""))
      return notify("Complete todos los indicadores históricos", "warning");
    try {
      await post(`/api/patients/${patientId}/prior-exams`, {
        ...form,
        confirmedKl: Number(form.confirmedKl),
        painScore: form.painScore === "" ? null : Number(form.painScore),
        ...Object.fromEntries(
          flags.map(([key]) => [key, form[key] === "true"]),
        ),
      });
      notify("Antecedente agregado a la historia clínica", "success");
      onSaved();
      onClose();
    } catch (error: any) {
      notify(error.message, "error");
    }
  }
  return (
    <Modal title="Agregar examen anterior" onClose={onClose} wide>
      <p className="muted">
        Úselo para incorporar un estudio histórico que no fue analizado dentro
        del sistema. Los episodios anteriores del sistema se consideran
        automáticamente.
      </p>
      <form className="form-grid" onSubmit={save}>
        <label>
          Fecha del examen
          <input
            type="date"
            max={today}
            value={form.examDate}
            onChange={(event) =>
              setForm({ ...form, examDate: event.target.value })
            }
            required
          />
        </label>
        <label>
          Rodilla
          <select
            value={form.kneeSide}
            onChange={(event) =>
              setForm({ ...form, kneeSide: event.target.value })
            }
          >
            <option value="R">Derecha</option>
            <option value="L">Izquierda</option>
          </select>
        </label>
        <label>
          KL confirmado
          <select
            value={form.confirmedKl}
            onChange={(event) =>
              setForm({ ...form, confirmedKl: event.target.value })
            }
          >
            {[0, 1, 2, 3, 4].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          Dolor histórico, opcional
          <input
            type="number"
            min="0"
            max="10"
            step="0.1"
            value={form.painScore}
            onChange={(event) =>
              setForm({ ...form, painScore: event.target.value })
            }
          />
        </label>
        {flags.map(([key, label]) => (
          <label key={key}>
            {label}
            <select
              value={form[key]}
              onChange={(event) =>
                setForm({ ...form, [key]: event.target.value })
              }
              required
            >
              <option value="">Seleccione…</option>
              <option value="true">Sí</option>
              <option value="false">No</option>
            </select>
          </label>
        ))}
        <div className="modal-actions span">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancelar
          </button>
          <button className="button primary">Guardar antecedente</button>
        </div>
      </form>
    </Modal>
  );
}

function ClinicianDashboard({
  navigate,
}: {
  navigate: (route: Route) => void;
}) {
  const [data, setData] = useState<any>();
  useEffect(() => {
    void api("/api/patients/dashboard").then(setData);
  }, []);
  if (!data) return <Spinner />;
  return (
    <Page
      title="Buenos días"
      subtitle="Este es el estado de su actividad clínica."
    >
      <div className="metric-grid four">
        <Metric
          label="Mis pacientes"
          value={data.patients}
          detail="Pacientes activos"
        />
        <Metric
          label="Estudios"
          value={data.studies}
          detail="Radiografías registradas"
        />
        <Metric
          label="Revisiones pendientes"
          value={data.pending}
          detail="Resultados sin revisión médica"
          tone={data.pending ? "metric-warning" : ""}
        />
        <Metric
          label="Reportes"
          value={data.reports}
          detail="Borradores generados"
        />
      </div>
      <div className="quick-grid">
        <button onClick={() => navigate({ name: "patients" })}>
          <span>
            <UserRoundCog size={22} />
          </span>
          <b>Registrar o buscar paciente</b>
          <small>Inicie desde la historia clínica.</small>
        </button>
        <button onClick={() => navigate({ name: "reviews" })}>
          <span>
            <ClipboardCheck size={22} />
          </span>
          <b>Revisiones clínicas</b>
          <small>Consulte o corrija resultados KL.</small>
        </button>
        <button onClick={() => navigate({ name: "reports" })}>
          <span>
            <FileText size={22} />
          </span>
          <b>Reportes recientes</b>
          <small>Consulte borradores generados.</small>
        </button>
      </div>
    </Page>
  );
}

function PatientsPage({
  navigate,
  notify,
}: {
  navigate: (route: Route) => void;
  notify: Notify;
}) {
  const [data, setData] = useState<Paged<Patient>>();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState(false);
  const load = () =>
    api<Paged<Patient>>(
      `/api/patients?page=${page}&search=${encodeURIComponent(search)}`,
    )
      .then(setData)
      .catch((error) => notify(error.message, "error"));
  useEffect(() => {
    void load();
  }, [page, search]);
  return (
    <Page
      title="Mis pacientes"
      subtitle="Historias clínicas bajo su responsabilidad."
      action={
        <button className="button primary" onClick={() => setModal(true)}>
          + Registrar paciente
        </button>
      }
    >
      <div className="toolbar">
        <input
          type="search"
          placeholder="Buscar por nombre, DNI o historia clínica"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value.slice(0, 100));
            setPage(1);
          }}
        />
      </div>
      <section className="surface table-card">
        {!data ? (
          <Spinner />
        ) : data.items.length === 0 ? (
          <Empty
            title="Aún no tiene pacientes"
            detail="Registre un paciente para comenzar."
          />
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>Paciente</th>
                  <th>Historia clínica</th>
                  <th>DNI</th>
                  <th>Celular</th>
                  <th>Registro</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((patient) => (
                  <tr key={patient.id}>
                    <td data-label="Paciente">
                      <b>
                        {patient.surnames}, {patient.names}
                      </b>
                      <small>{patient.email ?? "Sin correo"}</small>
                    </td>
                    <td data-label="Historia clínica">
                      <Badge tone="info">{patient.medicalRecordNumber}</Badge>
                    </td>
                    <td data-label="DNI">••••{patient.dni.slice(-4)}</td>
                    <td data-label="Celular">{patient.phone}</td>
                    <td data-label="Registro">
                      {formatDate(patient.createdAt)}
                    </td>
                    <td className="row-actions">
                      <button
                        className="button table-action"
                        onClick={() =>
                          navigate({ name: "patient", patientId: patient.id })
                        }
                      >
                        Ver ficha
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination {...data} onPage={setPage} />
          </>
        )}
      </section>
      {modal && (
        <PatientForm
          onClose={() => setModal(false)}
          notify={notify}
          onSaved={(patient) => {
            void load();
            navigate({ name: "patient", patientId: patient.id });
          }}
        />
      )}
    </Page>
  );
}

function AnalysisCard({
  analysis,
  open,
}: {
  analysis: AnalysisSummary;
  open: () => void;
}) {
  const values = analysis.ensemble?.probabilities;
  const currentKl = analysis.ensemble?.confirmedKl ?? values?.predictedKl;
  return (
    <article className="study-summary-card">
      <div className="study-image">
        <img
          src={analysis.previewUrl}
          alt={`Radiografía del ${formatDate(analysis.examDate)}`}
        />
        <Badge
          tone={
            analysis.status === "COMPLETED"
              ? "success"
              : analysis.status === "FAILED"
                ? "danger"
                : "info"
          }
        >
          {analysis.status === "COMPLETED"
            ? "Completado"
            : analysis.status === "FAILED"
              ? "Falló"
              : "Procesando"}
        </Badge>
      </div>
      <div className="study-summary-body">
        <span className="overline">
          {formatDate(analysis.examDate)} · Rodilla{" "}
          {analysis.kneeSide === "L" ? "izquierda" : "derecha"}
        </span>
        {values ? (
          <>
            <div className="summary-kl">
              <strong>KL {values.predictedKl}</strong>
              <span>{percent(values.confidence)} confianza</span>
            </div>
            <div className="summary-risks">
              <span>
                Artroplastia{" "}
                <b>
                  {percent(analysis.arthroplasty?.probabilities?.probability)}
                </b>
              </span>
              <span>
                Progresión{" "}
                <b>
                  {analysis.progression?.available === false || currentKl === 4
                    ? "No aplica (KL4)"
                    : analysis.progression
                      ? percent(analysis.progression.probabilities?.probability)
                      : "No disponible"}
                </b>
              </span>
            </div>
            <small>
              Evaluación radiológica: {analysis.radiologySeconds ?? "—"} s
            </small>
          </>
        ) : (
          <p className="muted">El análisis todavía está en procesamiento.</p>
        )}
        <button className="button secondary" onClick={open}>
          Ver análisis
        </button>
      </div>
    </article>
  );
}

function AnalysisCarousel({
  analyses,
  open,
}: {
  analyses: AnalysisSummary[];
  open: (analysis: AnalysisSummary) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const move = (direction: number) =>
    track.current?.scrollBy({ left: direction * 346, behavior: "smooth" });
  return (
    <div className="analysis-carousel">
      <div className="carousel-head">
        <span>
          {analyses.length} {analyses.length === 1 ? "estudio" : "estudios"}
        </span>
        {analyses.length > 1 && (
          <div>
            <button
              type="button"
              aria-label="Estudio anterior"
              onClick={() => move(-1)}
            >
              ‹
            </button>
            <button
              type="button"
              aria-label="Estudio siguiente"
              onClick={() => move(1)}
            >
              ›
            </button>
          </div>
        )}
      </div>
      <div className="analysis-timeline-grid" ref={track}>
        {analyses.map((analysis) => (
          <AnalysisCard
            key={analysis.studyId}
            analysis={analysis}
            open={() => open(analysis)}
          />
        ))}
      </div>
    </div>
  );
}

function PatientDetail({
  id,
  navigate,
  notify,
}: {
  id: string;
  navigate: (route: Route) => void;
  notify: Notify;
}) {
  const [patient, setPatient] = useState<Patient>();
  const [episodes, setEpisodes] = useState<any[]>([]);
  const [analyses, setAnalyses] = useState<AnalysisSummary[]>([]);
  const [profile, setProfile] = useState<ClinicalProfile | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [editing, setEditing] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [priorOpen, setPriorOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const load = async () => {
    try {
      const [p, e, a, c, h] = await Promise.all([
        api<Patient>(`/api/patients/${id}`),
        api<any[]>(`/api/patients/${id}/episodes`),
        api<AnalysisSummary[]>(`/api/patients/${id}/analyses`),
        api<ClinicalProfile | null>(`/api/patients/${id}/clinical-profile`),
        api<any[]>(`/api/patients/${id}/prior-exams`),
      ]);
      setPatient(p);
      setEpisodes(e);
      setAnalyses(a);
      setProfile(c);
      setHistory(h);
    } catch (error: any) {
      notify(error.message, "error");
    }
  };
  useEffect(() => {
    void load();
  }, [id]);
  if (!patient) return <Spinner />;
  async function archive() {
    try {
      await api(`/api/patients/${id}`, { method: "DELETE" });
      notify("Paciente archivado", "success");
      navigate({ name: "patients" });
    } catch (error: any) {
      notify(error.message, "error");
    }
  }
  function newAnalysis() {
    if (!completeClinicalProfile(profile)) {
      notify(
        "Complete y valide los datos clínicos de la historia antes de ingresar al análisis",
        "warning",
      );
      setProfileOpen(true);
      return;
    }
    navigate({ name: "analysis", patientId: id });
  }
  return (
    <Page
      title={`${patient.surnames}, ${patient.names}`}
      subtitle={`${patient.medicalRecordNumber} · Historia clínica`}
      action={
        <div className="head-actions">
          <button className="button secondary" onClick={() => setEditing(true)}>
            <UserRoundCog size={17} /> Editar paciente
          </button>
          <button className="button primary" onClick={newAnalysis}>
            <BarChart3 size={17} /> Nuevo análisis
          </button>
          <button
            className="button danger-soft"
            onClick={() => setArchiving(true)}
          >
            <Archive size={17} /> Archivar
          </button>
        </div>
      }
    >
      <section className="surface patient-overview-card">
        <div className="identity-card">
          <div className="avatar">
            {patient.names[0]}
            {patient.surnames[0]}
          </div>
          <div>
            <span className="overline">Datos personales</span>
            <h2>
              {patient.names} {patient.surnames}
            </h2>
            <dl>
              <div>
                <dt>DNI</dt>
                <dd>{patient.dni}</dd>
              </div>
              <div>
                <dt>Nacimiento</dt>
                <dd>{formatDate(patient.birthDate)}</dd>
              </div>
              <div>
                <dt>Sexo</dt>
                <dd>
                  {patient.sex === "female"
                    ? "Femenino"
                    : patient.sex === "male"
                      ? "Masculino"
                      : "No registrado"}
                </dd>
              </div>
              <div>
                <dt>Celular</dt>
                <dd>{patient.phone}</dd>
              </div>
              <div>
                <dt>Correo</dt>
                <dd>{patient.email ?? "No registrado"}</dd>
              </div>
            </dl>
          </div>
        </div>
        <div className="patient-stats-strip">
          <div>
            <History size={19} />
            <span>
              <strong>{patient.stats?.episodes ?? 0}</strong>
              <small>Episodios</small>
            </span>
          </div>
          <div>
            <Images size={19} />
            <span>
              <strong>{patient.stats?.studies ?? 0}</strong>
              <small>Estudios</small>
            </span>
          </div>
          <div>
            <FileText size={19} />
            <span>
              <strong>{patient.stats?.reports ?? 0}</strong>
              <small>Reportes</small>
            </span>
          </div>
        </div>
      </section>
      <section
        className={`surface clinical-profile-card ${profile ? "" : "incomplete"}`}
      >
        <div>
          <span className="overline">Contexto clínico permanente</span>
          <h2>
            {profile
              ? "Datos clínicos actuales"
              : "Complete los datos clínicos"}
          </h2>
          <p>
            {profile
              ? `Dolor: ${profile.painScore ?? "No disponible"}/10 · ${flags.map(([key, label]) => `${label}: ${profile[key] ? "Sí" : "No"}`).join(" · ")}`
              : "Estos datos forman parte de la historia clínica y son necesarios antes de analizar una radiografía."}
          </p>
        </div>
        <button
          className="button secondary"
          onClick={() => setProfileOpen(true)}
        >
          {profile ? "Actualizar" : "Completar ahora"}
        </button>
      </section>
      <section className="surface timeline-card">
        <div className="section-head">
          <div>
            <span className="overline">Seguimiento visual</span>
            <h2>Análisis por episodio</h2>
            <p className="muted">
              Los episodios anteriores de la misma rodilla y distinta fecha
              activan automáticamente la LSTM.
            </p>
          </div>
        </div>
        {analyses.length === 0 ? (
          <Empty
            title="Sin análisis"
            detail="Cargue la primera radiografía para iniciar la línea de tiempo."
          />
        ) : (
          <AnalysisCarousel
            analyses={analyses}
            open={(analysis) =>
              navigate({
                name: "episode-analysis",
                patientId: id,
                episodeId: analysis.episodeId,
              })
            }
          />
        )}
        {episodes.some(
          (episode) =>
            !analyses.some((analysis) => analysis.episodeId === episode.id),
        ) && (
          <p className="muted orphan-note">
            Existen episodios sin estudio asociado que no se muestran en el
            resumen.
          </p>
        )}
      </section>
      <section className="surface history-card">
        <div className="section-head">
          <div>
            <span className="overline">Antecedentes externos</span>
            <h2>Exámenes previos no analizados en el sistema</h2>
          </div>
          <button
            className="button secondary"
            onClick={() => setPriorOpen(true)}
          >
            + Agregar antecedente
          </button>
        </div>
        {history.length === 0 ? (
          <p className="muted">
            No hay antecedentes externos. Los análisis anteriores del sistema ya
            se consideran automáticamente.
          </p>
        ) : (
          <div className="history-list">
            {history.map((item) => (
              <article key={item.id}>
                <b>{formatDate(item.examDate)}</b>
                <span>
                  Rodilla {item.kneeSide === "L" ? "izquierda" : "derecha"} · KL{" "}
                  {item.confirmedKl} · Dolor {item.painScore ?? "N/D"}
                </span>
                <button
                  className="icon-button danger-text"
                  onClick={async () => {
                    await api(`/api/patients/${id}/prior-exams/${item.id}`, {
                      method: "DELETE",
                    });
                    notify("Antecedente eliminado", "success");
                    void load();
                  }}
                >
                  Eliminar
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
      {editing && (
        <PatientForm
          initial={patient}
          onClose={() => setEditing(false)}
          notify={notify}
          onSaved={() => void load()}
        />
      )}
      {profileOpen && (
        <ClinicalProfileForm
          initial={profile}
          patientId={id}
          notify={notify}
          onClose={() => setProfileOpen(false)}
          onSaved={() => void load()}
        />
      )}
      {priorOpen && (
        <PriorForm
          patientId={id}
          notify={notify}
          onClose={() => setPriorOpen(false)}
          onSaved={() => void load()}
        />
      )}
      {archiving && (
        <ConfirmModal
          title="Archivar paciente"
          detail="Dejará de aparecer en la lista activa, pero sus estudios se conservarán."
          danger
          onClose={() => setArchiving(false)}
          action={() => void archive()}
        />
      )}
    </Page>
  );
}

function EpisodeAnalysis({
  patientId,
  episodeId,
  navigate,
  notify,
}: {
  patientId: string;
  episodeId: string;
  navigate: (route: Route) => void;
  notify: Notify;
}) {
  const [data, setData] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<any>();
  const load = () =>
    api(`/api/episodes/${episodeId}/analysis`)
      .then(setData)
      .catch((error) => notify(error.message, "error"));
  useEffect(() => {
    void load();
  }, [episodeId]);
  useEffect(() => {
    if (
      !data?.studies?.some(
        (study: AnalysisSummary) => study.status === "PROCESSING",
      )
    )
      return;
    const timer = window.setTimeout(() => void load(), 1500);
    return () => window.clearTimeout(timer);
  }, [data]);
  async function report(type: "EPISODE" | "LONGITUDINAL") {
    setBusy(true);
    try {
      const value = await post<any>(`/api/episodes/${episodeId}/reports`, {
        reportType: type,
      });
      const pdf = await api<Blob>(`/api/reports/${value.id}/download`);
      const url = URL.createObjectURL(pdf);
      const link = document.createElement("a");
      link.href = url;
      link.download = `reporte-oa-${type === "LONGITUDINAL" ? "longitudinal" : "episodio"}-${String(data.episodeDate).slice(0, 10)}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify("PDF generado y descargado", "success");
    } catch (error: any) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function review(event: FormEvent) {
    event.preventDefault();
    try {
      const observationId = data.studies.find(
        (study: AnalysisSummary) => study.ensemble?.id === reviewing.id,
      )?.observationId;
      await post(`/api/predictions/${reviewing.id}/review`, {
        decision:
          Number(reviewing.kl) === reviewing.predicted
            ? "CONFIRMED"
            : "CORRECTED",
        confirmedKl: Number(reviewing.kl),
      });
      if (observationId)
        await Promise.allSettled([
          post(`/api/observations/${observationId}/risks/arthroplasty`, {}),
          post(`/api/observations/${observationId}/risks/progression`, {}),
        ]);
      notify("Revisión registrada y riesgos actualizados", "success");
      setReviewing(undefined);
      void load();
    } catch (error: any) {
      notify(error.message, "error");
    }
  }
  if (!data) return <Spinner />;
  return (
    <Page
      title={`Análisis del ${formatDate(data.episodeDate)}`}
      subtitle="Resumen completo del episodio y sus resultados."
      action={
        <button
          className="button secondary"
          onClick={() => navigate({ name: "patient", patientId })}
        >
          ← Volver a la ficha
        </button>
      }
    >
      <div className="episode-actions">
        <button
          className="button primary"
          disabled={busy}
          onClick={() => void report("EPISODE")}
        >
          <Download size={17} /> Descargar PDF del episodio
        </button>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void report("LONGITUDINAL")}
        >
          <Download size={17} /> Descargar PDF longitudinal
        </button>
      </div>
      {data.studies.map((study: AnalysisSummary) => {
        const prediction = study.ensemble?.probabilities;
        return (
          <div className="episode-study" key={study.studyId}>
            <section className="surface episode-hero">
              <div className="episode-radiograph">
                <img src={study.previewUrl} alt="Radiografía original" />
              </div>
              <div className="episode-result">
                <Badge tone={study.status === "COMPLETED" ? "success" : "info"}>
                  {study.status}
                </Badge>
                <span className="overline">
                  {formatDate(study.examDate)} · Rodilla{" "}
                  {study.kneeSide === "L" ? "izquierda" : "derecha"}
                </span>
                <div className="large-kl">
                  <span>KL estimado</span>
                  <strong>{prediction?.predictedKl ?? "—"}</strong>
                  <small>{percent(prediction?.confidence)} de confianza</small>
                </div>
                <dl>
                  <div>
                    <dt>Evaluación radiológica</dt>
                    <dd>{study.radiologySeconds ?? "—"} s</dd>
                  </div>
                  <div>
                    <dt>Procesamiento automatizado</dt>
                    <dd>{study.totalProcessingSeconds ?? "—"} s</dd>
                  </div>
                  <div>
                    <dt>Dispositivo</dt>
                    <dd>{study.ensemble?.device ?? "—"}</dd>
                  </div>
                </dl>
                {prediction && (
                  <button
                    className="button secondary"
                    onClick={() =>
                      setReviewing({
                        id: study.ensemble.id,
                        predicted: prediction.predictedKl,
                        kl:
                          study.ensemble.confirmedKl ?? prediction.predictedKl,
                      })
                    }
                  >
                    {study.ensemble.confirmedKl == null
                      ? "Revisar o corregir KL"
                      : `KL clínico confirmado: ${study.ensemble.confirmedKl}`}
                  </button>
                )}
              </div>
            </section>
            {prediction && (
              <section className="surface detail-grid">
                <div>
                  <span className="overline">Probabilidades KL0–KL4</span>
                  <div className="probability-bars">
                    {Object.entries(prediction.ensemble).map(
                      ([label, value]: any) => (
                        <div key={label}>
                          <span>{label}</span>
                          <i>
                            <b style={{ width: percent(value) }} />
                          </i>
                          <em>{percent(value)}</em>
                        </div>
                      ),
                    )}
                  </div>
                </div>
                <div className="risk-grid">
                  <RiskRead
                    title="Artroplastia · 24 meses"
                    value={study.arthroplasty}
                  />
                  <RiskRead
                    title="Progresión KL · 3–12 meses"
                    value={study.progression}
                  />
                </div>
              </section>
            )}
            {study.gradcams?.length ? (
              <section className="surface gradcam-section">
                <div className="section-head">
                  <div>
                    <span className="overline">Explicabilidad</span>
                    <h2>Mapas Grad-CAM</h2>
                  </div>
                </div>
                <div className="cam-grid">
                  {study.gradcams.map((cam: any) => (
                    <figure key={cam.id}>
                      <img src={cam.dataUrl} alt={`Grad-CAM ${cam.backbone}`} />
                      <figcaption>
                        {cam.backbone} · objetivo KL{cam.targetKl}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        );
      })}
      {reviewing && (
        <Modal
          title="Revisión médica de KL"
          onClose={() => setReviewing(undefined)}
        >
          <form className="form-stack" onSubmit={review}>
            <label>
              Grado KL confirmado
              <select
                value={reviewing.kl}
                onChange={(event) =>
                  setReviewing({ ...reviewing, kl: event.target.value })
                }
              >
                {[0, 1, 2, 3, 4].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <p className="muted">
              Esta revisión no bloquea la visualización. Al cambiar el KL deberá
              volver a generarse el reporte para reflejarlo.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setReviewing(undefined)}
              >
                Cancelar
              </button>
              <button className="button primary">Guardar revisión</button>
            </div>
          </form>
        </Modal>
      )}
    </Page>
  );
}

function RiskRead({ title, value }: { title: string; value: any }) {
  return (
    <article className="risk-card">
      <span className="overline">Estimación independiente</span>
      <h3>{title}</h3>
      {!value || value.available === false ? (
        <>
          <Badge tone="neutral">
            {value?.available === false ? "No aplicable" : "No disponible"}
          </Badge>
          <p className="muted">
            {value?.reason ?? "Aún no se registró este resultado."}
          </p>
        </>
      ) : (
        <>
          <strong>{percent(value.probabilities?.probability)}</strong>
          <Badge tone={value.screenPositive ? "warning" : "success"}>
            {value.screenPositive ? "Tamiz positivo" : "Tamiz negativo"}
          </Badge>
          <small>
            KL de entrada{" "}
            {value.klOrigin === "CLINICIAN"
              ? "revisado por el médico"
              : "estimado por el modelo"}
          </small>
        </>
      )}
    </article>
  );
}

function SimplePagedPage({
  kind,
  navigate,
}: {
  kind: "studies" | "reviews" | "reports";
  navigate: (route: Route) => void;
}) {
  const [data, setData] = useState<Paged<any>>();
  const [page, setPage] = useState(1);
  useEffect(() => {
    void api<Paged<any>>(`/api/${kind}?page=${page}`).then(setData);
  }, [kind, page]);
  const title =
    kind === "studies"
      ? "Estudios"
      : kind === "reviews"
        ? "Revisiones clínicas"
        : "Reportes";
  return (
    <Page
      title={title}
      subtitle={
        kind === "studies"
          ? "Radiografías y estado de procesamiento."
          : kind === "reviews"
            ? "Clasificaciones KL y revisión médica opcional."
            : "Borradores por episodio y longitudinales."
      }
    >
      <section className="surface table-card">
        {!data ? (
          <Spinner />
        ) : data.items.length === 0 ? (
          <Empty
            title={`Sin ${title.toLowerCase()}`}
            detail="Los nuevos registros aparecerán aquí."
          />
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>Paciente</th>
                  <th>HC</th>
                  <th>Fecha</th>
                  <th>Resultado / estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Paciente">
                      <b>{item.patientName}</b>
                    </td>
                    <td data-label="HC">{item.medicalRecordNumber}</td>
                    <td data-label="Fecha">
                      {formatDate(
                        item.examDate ?? item.episodeDate ?? item.generatedAt,
                      )}
                    </td>
                    <td data-label="Estado">
                      {kind === "reviews" ? (
                        <Badge tone={item.decision ? "success" : "warning"}>
                          {item.decision ?? "Pendiente"} · KL{" "}
                          {item.confirmedKl ?? item.probabilities?.predictedKl}
                        </Badge>
                      ) : kind === "reports" ? (
                        item.reportType
                      ) : (
                        <Badge tone="info">{item.status}</Badge>
                      )}
                    </td>
                    <td className="row-actions">
                      {kind === "reports" ? (
                        <a
                          className="button table-action"
                          href={`/api/reports/${item.id}/download`}
                        >
                          Descargar
                        </a>
                      ) : (
                        <button
                          className="button table-action"
                          onClick={() =>
                            navigate({
                              name: "patient",
                              patientId: item.patientId,
                            })
                          }
                        >
                          Ver paciente
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination {...data} onPage={setPage} />
          </>
        )}
      </section>
    </Page>
  );
}

function AnalysisLoader({
  patientId,
  notify,
  onDone,
  openAnalysis,
}: {
  patientId: string;
  notify: Notify;
  onDone: () => void;
  openAnalysis: (episodeId: string) => void;
}) {
  const [patient, setPatient] = useState<Patient>();
  useEffect(() => {
    void Promise.all([
      api<Patient>(`/api/patients/${patientId}`),
      api<ClinicalProfile | null>(
        `/api/patients/${patientId}/clinical-profile`,
      ),
    ])
      .then(([loadedPatient, profile]) => {
        if (!completeClinicalProfile(profile)) {
          notify(
            "La historia clínica debe estar completa antes de iniciar un análisis",
            "warning",
          );
          onDone();
          return;
        }
        setPatient(loadedPatient);
      })
      .catch((error) => {
        notify(error.message, "error");
        onDone();
      });
  }, [patientId]);
  return patient ? (
    <ClinicalAnalysis
      patient={patient}
      notify={notify}
      onDone={onDone}
      openAnalysis={openAnalysis}
    />
  ) : (
    <Spinner />
  );
}

function Shell({
  user,
  onLogout,
  notify,
}: {
  user: User;
  onLogout: () => void;
  notify: Notify;
}) {
  const [route, setRoute] = useState<Route>({ name: "dashboard" });
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const nav =
    user.role === "ADMIN"
      ? [
          { name: "dashboard", label: "Resumen", icon: LayoutDashboard },
          { name: "users", label: "Usuarios", icon: UsersRound },
          { name: "clinicians", label: "Médicos", icon: Stethoscope },
          { name: "audit", label: "Auditoría", icon: ShieldCheck },
          { name: "settings", label: "Configuración", icon: Settings },
        ]
      : [
          { name: "dashboard", label: "Inicio", icon: LayoutDashboard },
          { name: "patients", label: "Mis pacientes", icon: UserRound },
          { name: "studies", label: "Estudios", icon: Images },
          { name: "reviews", label: "Revisiones", icon: ClipboardCheck },
          { name: "reports", label: "Reportes", icon: FileText },
        ];
  const currentSection =
    nav.find((item) => item.name === route.name)?.label ??
    (route.name === "episode-analysis"
      ? "Detalle del análisis"
      : "Historia clínica");
  const go = (next: Route) => {
    setRoute(next);
    setMobileOpen(false);
  };
  const content = useMemo(() => {
    if (user.role === "ADMIN") {
      if (route.name === "users" || route.name === "clinicians")
        return <AccountsPage kind={route.name} notify={notify} />;
      if (route.name === "audit") return <AdminAudit />;
      if (route.name === "settings") return <AdminSettings notify={notify} />;
      return <AdminDashboard />;
    }
    if (route.name === "patients")
      return <PatientsPage navigate={go} notify={notify} />;
    if (route.name === "patient" && route.patientId)
      return (
        <PatientDetail id={route.patientId} navigate={go} notify={notify} />
      );
    if (route.name === "analysis" && route.patientId)
      return (
        <AnalysisLoader
          patientId={route.patientId}
          notify={notify}
          onDone={() => go({ name: "patient", patientId: route.patientId })}
          openAnalysis={(episodeId) =>
            go({
              name: "episode-analysis",
              patientId: route.patientId,
              episodeId,
            })
          }
        />
      );
    if (route.name === "episode-analysis" && route.patientId && route.episodeId)
      return (
        <EpisodeAnalysis
          patientId={route.patientId}
          episodeId={route.episodeId}
          navigate={go}
          notify={notify}
        />
      );
    if (["studies", "reviews", "reports"].includes(route.name))
      return <SimplePagedPage kind={route.name as any} navigate={go} />;
    return <ClinicianDashboard navigate={go} />;
  }, [route, user.role]);
  return (
    <div
      className={`app-shell ${collapsed ? "collapsed" : ""} ${mobileOpen ? "mobile-open" : ""}`}
    >
      <button
        className="mobile-scrim"
        aria-label="Cerrar menú"
        onClick={() => setMobileOpen(false)}
      />
      <aside>
        <div className="sidebar-brand">
          <div className="brand-symbol small">
            <HeartPulse size={21} />
          </div>
          <div>
            <b>OA Clínica</b>
            <small>Inteligencia radiológica</small>
          </div>
        </div>
        <nav>
          {nav.map(({ name, label, icon: Icon }) => (
            <button
              key={name}
              className={
                route.name === name ||
                (name === "patients" &&
                  ["patient", "analysis", "episode-analysis"].includes(
                    route.name,
                  ))
                  ? "active"
                  : ""
              }
              onClick={() => go({ name })}
            >
              <i>
                <Icon size={19} strokeWidth={2} />
              </i>
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-account">
            <div className="user-chip">
              <div>{user.displayName.slice(0, 2).toUpperCase()}</div>
              <span>
                <b>{user.displayName}</b>
                <small>
                  {user.role === "ADMIN"
                    ? "Administrador técnico"
                    : "Médico responsable"}
                </small>
              </span>
            </div>
            <button
              className="nav-logout"
              onClick={onLogout}
              title="Cerrar sesión"
              aria-label="Cerrar sesión"
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-area">
        <div className="topbar">
          <button
            className="menu-toggle desktop-toggle"
            aria-label={collapsed ? "Expandir menú" : "Contraer menú"}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? (
              <PanelLeftOpen size={20} />
            ) : (
              <PanelLeftClose size={20} />
            )}
          </button>
          <button
            className="menu-toggle mobile-toggle"
            aria-label="Abrir menú"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={21} />
          </button>
          <div className="topbar-context">
            <span>OA Clínica</span>
            <b>{currentSection}</b>
          </div>
          <div className="topbar-status">
            <CheckCircle2 size={15} /> Servicios operativos
          </div>
        </div>
        <div className="content">{content}</div>
      </main>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<User>();
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    void api<User>("/api/auth/me")
      .then(setUser)
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, []);
  const notify: Notify = (message, tone = "info") => {
    if (tone === "success") toast.success(message);
    else if (tone === "error") toast.error(message);
    else if (tone === "warning") toast.warning(message);
    else toast.info(message);
  };
  async function logout() {
    await post("/api/auth/logout", {});
    setUser(undefined);
  }
  if (checking)
    return (
      <div className="boot">
        <div className="brand-symbol">OA</div>
        <Spinner />
      </div>
    );
  return (
    <>
      {user ? (
        <Shell user={user} notify={notify} onLogout={() => void logout()} />
      ) : (
        <Login onDone={setUser} />
      )}
      <Toaster
        position="bottom-right"
        richColors
        duration={4000}
        visibleToasts={4}
        toastOptions={{ className: "oa-toast" }}
      />
    </>
  );
}
