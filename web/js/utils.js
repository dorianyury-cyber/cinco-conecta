// Inicialización de Firebase + utilidades compartidas por todas las páginas
// del panel de staff de Cinco Conecta.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";
import { firebaseConfig, RECAPTCHA_SITE_KEY } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);

if (RECAPTCHA_SITE_KEY && RECAPTCHA_SITE_KEY !== "PENDIENTE") {
  initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
    isTokenAutoRefreshEnabled: true
  });
}

export function showAlert(el, message, type = "error") {
  if (!el) return;
  el.textContent = message;
  el.className = `alert ${type}`;
  el.style.display = "block";
}

export function clearAlert(el) {
  if (!el) return;
  el.style.display = "none";
  el.textContent = "";
}

export function friendlyError(err) {
  const code = err?.code || "";
  const map = {
    "auth/invalid-credential": "Correo o contraseña incorrectos.",
    "auth/wrong-password": "Correo o contraseña incorrectos.",
    "auth/user-not-found": "No existe una cuenta con ese correo.",
    "auth/too-many-requests": "Demasiados intentos. Intenta de nuevo más tarde.",
    "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
    "auth/requires-recent-login": "Por seguridad, vuelve a iniciar sesión antes de intentar esto de nuevo.",
    "auth/email-already-exists": "Ya existe una cuenta con ese correo.",
    "permission-denied": "No tienes permiso para realizar esta acción.",
    "resource-exhausted": "Se alcanzó el límite de intentos. Intenta más tarde.",
    "invalid-argument": err?.message || "Datos inválidos.",
    "unauthenticated": "No se pudo verificar la solicitud. Recarga la página e intenta de nuevo."
  };
  return map[code] || err?.message || "Ocurrió un error inesperado.";
}

export function formatDate(value) {
  if (!value) return "-";
  const d = value?.toDate ? value.toDate() : new Date(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("es-CO", { year: "numeric", month: "short", day: "2-digit" });
}

export function formatDateCorta(value) {
  if (!value) return "-";
  const d = value?.toDate ? value.toDate() : new Date(typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  if (isNaN(d.getTime())) return "-";
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

// Mismos valores institucionales publicados en cinco-sas/corporativo.html —
// se usan para etiquetar cada reconocimiento entre compañeros.
export const VALORES_CINCO = [
  "Seriedad", "Cumplimiento", "Calidad", "Compromiso",
  "Armonía con el medio ambiente", "Sostenibilidad del talento humano",
  "Creatividad", "Dinamismo", "Ética"
];

export function hoyStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// "Hoy" en huso horario de Colombia (no el del navegador de quien mire el
// panel) — mismo criterio que obtenerFilasSemaforo() en Copropiedad
// Saludable, para que vencido/próximo a vencer no dependa de dónde esté
// viajando quien lo consulte.
export function hoyBogotaStr() {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const obj = {};
  partes.forEach((p) => { obj[p.type] = p.value; });
  return `${obj.year}-${obj.month}-${obj.day}`;
}

// Áreas de ubicación organizacional de un empleado (mismos 4 grupos del
// menú lateral + Administrativo y Gerencia) — compartido entre el
// formulario/tabla de Empleados y el panel de Inicio (gráfica "Empleados
// por área"), para no duplicar el mapa en dos archivos.
export const AREAS = {
  experiencia: "Experiencia",
  sgi: "SGI-HSEQ",
  interventoria: "Interventoría",
  talento: "Talento Humano",
  administrativo: "Administrativo y Gerencia"
};

/**
 * Días que faltan para que se repita el mes/día de `fechaStr` (YYYY-MM-DD),
 * contando desde `hoyBogotaStr()` — si ya pasó este año, calcula contra el
 * próximo. Se usa igual para cumpleaños (fechaNacimiento) y aniversarios
 * laborales (fechaIngreso): mismo cálculo, dos campos distintos. Devuelve
 * null si `fechaStr` no tiene formato válido.
 */
export function diasHastaProximaFechaAnual(fechaStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr || "")) return null;
  const hoy = new Date(`${hoyBogotaStr()}T00:00:00`);
  const [, mes, dia] = fechaStr.split("-").map(Number);
  let proxima = new Date(hoy.getFullYear(), mes - 1, dia);
  if (proxima < hoy) proxima = new Date(hoy.getFullYear() + 1, mes - 1, dia);
  return Math.round((proxima - hoy) / 86400000);
}

export function poblarSelectAnios(selectEl, anioSeleccionado) {
  const anioActual = new Date().getFullYear();
  const anioMin = 2024;
  const anioMax = anioActual + 1;
  selectEl.innerHTML = '<option value="">Todos los años</option>';
  for (let a = anioMax; a >= anioMin; a--) {
    selectEl.innerHTML += `<option value="${a}">${a}</option>`;
  }
  selectEl.value = anioSeleccionado || "";
}

/**
 * Descarga un archivo de Storage (por su `path` guardado, no la URL) como
 * data URL — pasa por la Cloud Function obtenerArchivoBase64 porque el
 * bucket no tiene CORS habilitado para que el navegador lo descargue
 * directamente con fetch() (mismo problema ya diagnosticado en LBDC Neiva).
 */
export async function obtenerArchivoComoDataUrl(path) {
  const llamada = httpsCallable(functions, "obtenerArchivoBase64");
  const { data } = await llamada({ path });
  return `data:${data.contentType};base64,${data.base64}`;
}

async function obtenerPerfilStaff(uid) {
  try {
    const snap = await getDoc(doc(db, "staff", uid));
    return snap.exists() ? snap.data() : null;
  } catch {
    return null;
  }
}

function actualizarCajaUsuario(nombre) {
  const insertar = () => {
    const nameEl = document.getElementById("userName");
    if (nameEl) nameEl.textContent = nombre;
  };
  if (document.body) insertar();
  else document.addEventListener("DOMContentLoaded", insertar);
}

/**
 * Los enlaces del menú marcados con esta clase (Vacantes/Candidatos/
 * Empleados) solo los puede ver el rol "admin" (Talento Humano) — un
 * empleado regular no gestiona contratación ni invita gente. Esto es solo
 * comodidad de interfaz: la seguridad real la dan las Firestore Rules.
 * El selector es genérico (no solo `a.solo-admin`) porque el grupo
 * "Talento Humano" completo del menú lateral también lleva esta clase en
 * su contenedor, para ocultar el grupo entero (botón + ítems) de una vez
 * en vez de dejar un desplegable vacío.
 */
function ocultarNavSoloAdmin() {
  const insertar = () => {
    document.querySelectorAll(".sidebar .solo-admin").forEach((el) => el.classList.add("hidden"));
  };
  if (document.body) insertar();
  else document.addEventListener("DOMContentLoaded", insertar);
}

/**
 * Verifica sesión + carga el perfil desde staff/{uid} (incluye `rol`:
 * "admin" o "empleado"). Si la cuenta fue desactivada por un admin, se
 * cierra la sesión. Si el perfil tiene `debeCambiarPassword: true`
 * (cuenta recién invitada, o a la que un admin le generó una contraseña
 * nueva), se manda a cambiar-password.html sin importar qué página haya
 * pedido el login — esa página nunca termina de cargar para esa cuenta
 * hasta que cambie la contraseña.
 */
export function requireAuth() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        window.location.href = "login.html";
        return;
      }
      const perfil = await obtenerPerfilStaff(user.uid);
      if (!perfil || perfil.estado === "bloqueado") {
        await signOut(auth);
        window.location.href = "login.html?error=sin-acceso";
        return;
      }
      const enCambiarPassword = window.location.pathname.endsWith("cambiar-password.html");
      if (perfil.debeCambiarPassword && !enCambiarPassword) {
        window.location.href = "cambiar-password.html";
        return;
      }
      actualizarCajaUsuario(perfil.nombre || user.email);
      if (perfil.rol !== "admin") ocultarNavSoloAdmin();
      resolve({ user, perfil });
    });
  });
}

export async function logout() {
  await signOut(auth);
  window.location.href = "login.html";
}

export function wireLogoutButton(selector = "#logoutBtn") {
  const btn = document.querySelector(selector);
  if (btn) btn.addEventListener("click", logout);
}

/**
 * Marca el enlace activo del menú lateral y activa el comportamiento de
 * acordeón de sus grupos (Experiencia / SGI-HSEQ / Interventoría /
 * Talento Humano, en vez de una lista plana de 11+ enlaces): el grupo
 * que contiene la página activa se abre automáticamente, cada grupo se
 * abre/cierra con un clic en su encabezado, y el estado (abierto/
 * cerrado) se recuerda en localStorage para que no se cierre solo al
 * navegar entre páginas del mismo grupo. Se llama una sola vez por
 * página, junto con requireAuth/wireLogoutButton de siempre.
 */
export function setActiveNav() {
  const current = window.location.pathname.split("/").pop() || "inicio.html";
  document.querySelectorAll(".sidebar nav a").forEach((a) => {
    if (a.getAttribute("href") === current) {
      a.classList.add("active");
      a.closest(".nav-group")?.classList.add("open");
    }
  });

  document.querySelectorAll(".nav-group-toggle").forEach((btn) => {
    const grupo = btn.closest(".nav-group");
    const id = grupo?.dataset.grupo;
    if (id && localStorage.getItem(`navGrupoAbierto_${id}`) === "1") grupo.classList.add("open");
    btn.addEventListener("click", () => {
      const abierto = grupo.classList.toggle("open");
      if (id) localStorage.setItem(`navGrupoAbierto_${id}`, abierto ? "1" : "0");
    });
  });
}

export async function iniciarSesionStaff(correo, password) {
  await signInWithEmailAndPassword(auth, correo, password);
}
