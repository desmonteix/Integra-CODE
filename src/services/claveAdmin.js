// Secreto compartido por el panel y la puerta. Una clave vacia no autentica.
const crypto = require('crypto');

function claveCoincide(claveRecibida, claveConfigurada) {
  if (!claveConfigurada || typeof claveRecibida !== 'string') return false;
  const recibida = Buffer.from(claveRecibida);
  const configurada = Buffer.from(claveConfigurada);
  if (recibida.length !== configurada.length) return false;
  return crypto.timingSafeEqual(recibida, configurada);
}

module.exports = { claveCoincide };
