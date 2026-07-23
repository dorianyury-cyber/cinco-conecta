import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { auth, showAlert, clearAlert, friendlyError, iniciarSesionStaff } from "./utils.js";

const form = document.getElementById("loginForm");
const alertBox = document.getElementById("alertBox");
const submitBtn = document.getElementById("submitBtn");

const params = new URLSearchParams(window.location.search);
if (params.get("error") === "sin-acceso") {
  showAlert(alertBox, "Tu acceso no está activo. Contacta al administrador.", "error");
}

onAuthStateChanged(auth, (user) => {
  if (user) window.location.href = "inicio.html";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert(alertBox);
  submitBtn.disabled = true;
  submitBtn.textContent = "Ingresando...";
  try {
    await iniciarSesionStaff(document.getElementById("correo").value.trim(), document.getElementById("password").value);
    window.location.href = "inicio.html";
  } catch (err) {
    showAlert(alertBox, friendlyError(err), "error");
    submitBtn.disabled = false;
    submitBtn.textContent = "Ingresar";
  }
});
