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

export function hoyStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
 * Verifica sesión + carga el perfil desde staff/{uid}. Un solo nivel de
 * acceso por ahora (no hay roles diferenciados todavía) — si la cuenta fue
 * desactivada por otro miembro del equipo, se cierra la sesión.
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
      actualizarCajaUsuario(perfil.nombre || user.email);
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

export function setActiveNav() {
  const current = window.location.pathname.split("/").pop() || "candidatos.html";
  document.querySelectorAll(".sidebar nav a").forEach((a) => {
    if (a.getAttribute("href") === current) a.classList.add("active");
  });
}

export async function iniciarSesionStaff(correo, password) {
  await signInWithEmailAndPassword(auth, correo, password);
}
