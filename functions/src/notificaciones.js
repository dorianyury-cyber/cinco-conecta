const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { enviarCambioEtapa } = require("./email");

// Cuando el staff cambia la etapa de un candidato desde el panel, se le
// avisa por correo automáticamente — así nunca queda en "silencio de
// radio" esperando noticias.
const onCandidatoEtapaCambiada = onDocumentUpdated("candidatos/{candidatoId}", async (event) => {
  const antes = event.data.before.data();
  const despues = event.data.after.data();
  if (antes.etapa === despues.etapa) return;

  try {
    await enviarCambioEtapa({
      nombres: despues.nombres,
      email: despues.email,
      tituloVacante: despues.vacanteTitulo,
      etapa: despues.etapa
    });
  } catch (err) {
    console.error("No se pudo enviar el correo de cambio de etapa:", err);
  }
});

module.exports = { onCandidatoEtapaCambiada };
