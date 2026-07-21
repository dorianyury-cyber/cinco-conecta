const nodemailer = require("nodemailer");

// SMTP_USER / SMTP_PASS se cargan como variables de entorno (functions/.env
// en local, o generado por el workflow de GitHub Actions a partir de los
// "Secrets" del repositorio — nunca se escriben a mano ni se suben al repo).
const DESTINATARIO_RRHH = "gerencia.cincoltda@hotmail.com";

function buildTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000
  });
}

const ETAPA_TEXTO = {
  recibido: "Recibida",
  preseleccionado: "Preseleccionado(a)",
  entrevista: "En etapa de entrevista",
  prueba: "En etapa de pruebas",
  oferta: "¡Tenemos una oferta para ti!",
  contratado: "¡Contratado(a)!",
  rechazado: "Proceso finalizado"
};

async function enviarConfirmacionPostulacion({ nombres, email, tituloVacante }) {
  const transporter = buildTransporter();
  await transporter.sendMail({
    from: `"Cinco S.A.S. - Talento Humano" <${process.env.SMTP_USER}>`,
    to: email,
    subject: `Recibimos tu postulación a "${tituloVacante}"`,
    text: [
      `Hola ${nombres},`,
      "",
      `Gracias por postularte a la vacante "${tituloVacante}" en Cinco S.A.S.`,
      "Ya recibimos tu información y hoja de vida — te avisaremos por este mismo correo cada vez que tu proceso avance.",
      "",
      "Puedes consultar el estado de tu postulación en cualquier momento desde nuestro sitio, en la sección Trabaja con Nosotros.",
      "",
      "Cinco S.A.S."
    ].join("\n")
  });
}

async function enviarNotificacionRRHH({ nombres, apellidos, email, telefono, tituloVacante }) {
  const transporter = buildTransporter();
  await transporter.sendMail({
    from: `"Cinco Conecta" <${process.env.SMTP_USER}>`,
    to: DESTINATARIO_RRHH,
    replyTo: email,
    subject: `Nueva postulación: ${nombres} ${apellidos} — ${tituloVacante}`,
    text: [
      `Vacante: ${tituloVacante}`,
      `Nombre: ${nombres} ${apellidos}`,
      `Email: ${email}`,
      `Teléfono: ${telefono}`
    ].join("\n")
  });
}

async function enviarCambioEtapa({ nombres, email, tituloVacante, etapa }) {
  const transporter = buildTransporter();
  const etapaTexto = ETAPA_TEXTO[etapa] || etapa;
  await transporter.sendMail({
    from: `"Cinco S.A.S. - Talento Humano" <${process.env.SMTP_USER}>`,
    to: email,
    subject: `Actualización de tu postulación a "${tituloVacante}"`,
    text: [
      `Hola ${nombres},`,
      "",
      `Tu proceso de selección para "${tituloVacante}" tiene una actualización:`,
      "",
      etapaTexto,
      "",
      "Puedes consultar el detalle en nuestro sitio, en la sección Trabaja con Nosotros.",
      "",
      "Cinco S.A.S."
    ].join("\n")
  });
}

async function enviarBienvenidaEmpleado({ nombre, correo, password }) {
  const transporter = buildTransporter();
  await transporter.sendMail({
    from: `"Cinco Conecta" <${process.env.SMTP_USER}>`,
    to: correo,
    subject: "Bienvenido(a) a Cinco Conecta — tus datos de acceso",
    text: [
      `¡Bienvenido(a), ${nombre}!`,
      "",
      "Ya tienes acceso a Cinco Conecta, la plataforma interna de Cinco S.A.S.: reconoce a tus compañeros, participa en las encuestas y entérate de los comunicados de la empresa.",
      "",
      "Tus accesos:",
      `Usuario: ${correo}`,
      `Contraseña temporal: ${password}`,
      "",
      "Ingresa aquí: https://cinco-conecta.web.app/login.html",
      "",
      "Cinco S.A.S."
    ].join("\n")
  });
}

module.exports = { enviarConfirmacionPostulacion, enviarNotificacionRRHH, enviarCambioEtapa, enviarBienvenidaEmpleado, ETAPA_TEXTO };
