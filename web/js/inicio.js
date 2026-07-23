import { collection, query, where, getDocs, getCountFromServer } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { db, requireAuth, wireLogoutButton, setActiveNav, formatDate, hoyBogotaStr, diasHastaProximaFechaAnual, AREAS } from "./utils.js";

await requireAuth();
wireLogoutButton();
setActiveNav();

const hoy = hoyBogotaStr();

function fechaMenosDias(dias) {
  const d = new Date(`${hoy}T00:00:00`);
  d.setDate(d.getDate() - dias);
  return d.toISOString().slice(0, 10);
}

function semaforoHtml(filas) {
  return filas.map((f) => `
    <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:10px;background:var(--sidebar-bg);">
      <span class="badge ${f.tono}" style="min-width:38px;text-align:center;font-size:13px;">${f.valor}</span>
      <div style="flex:1;">
        <div style="font-weight:600;font-size:13.5px;">${f.titulo}</div>
        <div class="text-muted" style="font-size:12px;">${f.detalle}</div>
      </div>
    </div>
  `).join("");
}

function barChartHtml(filas) {
  if (filas.length === 0) {
    return `<p class="text-muted" style="font-size:12.5px;">Sin datos todavía.</p>`;
  }
  const max = Math.max(...filas.map((f) => f.valor), 1);
  return filas.map((f) => `
    <div class="bar-chart-row">
      <div class="bar-chart-label">${f.label}</div>
      <div class="bar-chart-track">
        <div class="bar-chart-fill" style="width:${Math.max((f.valor / max) * 100, 8)}%;">${f.valor}</div>
      </div>
    </div>
  `).join("");
}

const [staffSnap, vacantesAbiertasSnap, incidentesAbiertosCount, accionesSnap, auditoriasSnap, informesLibresSnap, informesPlantillaSnap] = await Promise.all([
  getDocs(collection(db, "staff")),
  getDocs(query(collection(db, "vacantes"), where("estado", "==", "abierta"))),
  getCountFromServer(query(collection(db, "incidentes"), where("estado", "==", "abierto"))),
  getDocs(collection(db, "accionesCorrectivas")),
  getDocs(collection(db, "auditorias")),
  getDocs(query(collection(db, "informesLibres"), where("estado", "==", "final"))),
  getDocs(collection(db, "informesPlantilla"))
]);

const empleados = staffSnap.docs.map((d) => d.data());
const empleadosActivos = empleados.filter((e) => e.estado === "activo");
const vacantesAbiertas = vacantesAbiertasSnap.docs.map((d) => d.data());
const incidentesAbiertosNum = incidentesAbiertosCount.data().count;
const acciones = accionesSnap.docs.map((d) => d.data());
const accionesAbiertas = acciones.filter((a) => a.estado !== "cerrada");
const accionesVencidas = accionesAbiertas.filter((a) => (a.fechaLimite || "") < hoy);
const auditorias = auditoriasSnap.docs.map((d) => d.data());
const auditoriasAbiertas = auditorias.filter((a) => a.estado !== "cerrada");
const limite30Dias = fechaMenosDias(30);
const vacantesEstancadas = vacantesAbiertas.filter((v) => (v.fechaPublicacion || hoy) <= limite30Dias);

const informes = [
  ...informesLibresSnap.docs.map((d) => { const i = d.data(); return { codigo: i.codigo, nombre: i.titulo, cliente: i.cliente, creadoEn: i.creadoEn }; }),
  ...informesPlantillaSnap.docs.map((d) => { const i = d.data(); return { codigo: i.codigo, nombre: i.plantillaNombre, cliente: i.cliente, creadoEn: i.creadoEn }; })
].sort((a, b) => (b.creadoEn?.seconds || 0) - (a.creadoEn?.seconds || 0));

// ---- Stat tiles ----
document.getElementById("statEmpleados").textContent = empleadosActivos.length;
document.getElementById("statVacantes").textContent = vacantesAbiertas.length;
document.getElementById("statIncidentes").textContent = incidentesAbiertosNum;
document.getElementById("statInformes").textContent = informes.length;

// ---- Estado general (semáforo): lo que necesita atención hoy, calculado
// contra datos reales de cada módulo — nada aquí es un contador inventado. ----
const cumpleañosSemana = empleadosActivos.filter((e) => {
  const dias = diasHastaProximaFechaAnual(e.fechaNacimiento);
  return dias !== null && dias <= 7;
}).length;
const aniversariosSemana = empleadosActivos.filter((e) => {
  const dias = diasHastaProximaFechaAnual(e.fechaIngreso);
  return dias !== null && dias <= 7;
}).length;
const perfilesIncompletos = empleadosActivos.filter((e) => !e.cedula || !e.cargo || !e.area).length;

document.getElementById("semaforoLista").innerHTML = semaforoHtml([
  {
    titulo: "Cumpleaños esta semana",
    detalle: cumpleañosSemana > 0 ? "Celébralos en Reconocimientos" : "Ninguno esta semana",
    valor: cumpleañosSemana,
    tono: cumpleañosSemana > 0 ? "gold" : "muted"
  },
  {
    titulo: "Aniversarios laborales esta semana",
    detalle: aniversariosSemana > 0 ? "Vale la pena reconocerlos" : "Ninguno esta semana",
    valor: aniversariosSemana,
    tono: aniversariosSemana > 0 ? "gold" : "muted"
  },
  {
    titulo: "Perfiles de empleado incompletos",
    detalle: perfilesIncompletos > 0 ? "Falta cédula, cargo o área" : "Todos los perfiles completos",
    valor: perfilesIncompletos,
    tono: perfilesIncompletos > 0 ? "warn" : "ok"
  },
  {
    titulo: "Incidentes SGI abiertos",
    detalle: incidentesAbiertosNum > 0 ? "Revisa SGI-HSEQ" : "Ninguno abierto",
    valor: incidentesAbiertosNum,
    tono: incidentesAbiertosNum > 0 ? "danger" : "ok"
  },
  {
    titulo: "Acciones correctivas vencidas",
    detalle: accionesVencidas.length > 0 ? "Ya pasaron su fecha límite" : "Ninguna vencida",
    valor: accionesVencidas.length,
    tono: accionesVencidas.length > 0 ? "danger" : "ok"
  },
  {
    titulo: "Vacantes abiertas hace más de 30 días",
    detalle: vacantesEstancadas.length > 0 ? "Considera cerrarlas o revisar el proceso" : "Ninguna estancada",
    valor: vacantesEstancadas.length,
    tono: vacantesEstancadas.length > 0 ? "warn" : "ok"
  },
  {
    titulo: "Auditorías abiertas",
    detalle: auditoriasAbiertas.length > 0 ? "Pendientes por cerrar" : "Todas cerradas",
    valor: auditoriasAbiertas.length,
    tono: auditoriasAbiertas.length > 0 ? "warn" : "ok"
  }
]);

// ---- Gráfica "Estado general" ----
document.getElementById("graficoGeneral").innerHTML = barChartHtml([
  { label: "Empleados activos", valor: empleadosActivos.length },
  { label: "Vacantes abiertas", valor: vacantesAbiertas.length },
  { label: "Incidentes abiertos", valor: incidentesAbiertosNum },
  { label: "Acciones correctivas abiertas", valor: accionesAbiertas.length },
  { label: "Auditorías abiertas", valor: auditoriasAbiertas.length }
]);

// ---- Gráfica "Empleados por área" ----
const porArea = {};
empleadosActivos.forEach((e) => {
  const nombreArea = AREAS[e.area] || "Sin área";
  porArea[nombreArea] = (porArea[nombreArea] || 0) + 1;
});
document.getElementById("graficoAreas").innerHTML = barChartHtml(
  Object.entries(porArea)
    .sort((a, b) => b[1] - a[1])
    .map(([label, valor]) => ({ label, valor }))
);

// ---- Informes de Interventoría: últimos generados ----
const tablaInformes = document.getElementById("tablaInformes");
tablaInformes.innerHTML = informes.length === 0
  ? `<tr><td colspan="4" class="text-muted text-center">Sin informes generados todavía.</td></tr>`
  : informes.slice(0, 8).map((i) => `
    <tr>
      <td>${i.codigo || "-"}</td>
      <td>${i.nombre || "-"}</td>
      <td>${i.cliente || "-"}</td>
      <td>${formatDate(i.creadoEn)}</td>
    </tr>
  `).join("");
