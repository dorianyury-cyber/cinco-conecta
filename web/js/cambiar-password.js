import {
  EmailAuthProvider, reauthenticateWithCredential, updatePassword
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { functions, requireAuth, showAlert, clearAlert, friendlyError } from "./utils.js";

const { user, perfil } = await requireAuth();

if (perfil.debeCambiarPassword) {
  document.getElementById("motivoTexto").textContent =
    "Por seguridad, debes cambiar tu contraseña temporal antes de continuar.";
}

const form = document.getElementById("cambiarForm");
const alertBox = document.getElementById("alertBox");
const btn = document.getElementById("guardarBtn");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearAlert(alertBox);

  const passwordActual = document.getElementById("passwordActual").value;
  const passwordNueva = document.getElementById("passwordNueva").value;
  const passwordConfirmar = document.getElementById("passwordConfirmar").value;

  if (passwordNueva !== passwordConfirmar) {
    showAlert(alertBox, "Las dos contraseñas nuevas no coinciden.", "error");
    return;
  }
  if (passwordNueva === passwordActual) {
    showAlert(alertBox, "La nueva contraseña debe ser diferente de la actual.", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Guardando...";
  try {
    const credencial = EmailAuthProvider.credential(user.email, passwordActual);
    await reauthenticateWithCredential(user, credencial);
    await updatePassword(user, passwordNueva);
    await httpsCallable(functions, "confirmarCambioPassword")();
    window.location.href = "candidatos.html";
  } catch (err) {
    showAlert(alertBox, friendlyError(err), "error");
    btn.disabled = false;
    btn.textContent = "Guardar nueva contraseña";
  }
});
