// src/public/js/registro.js
// Envio del formulario de registro via fetch, manejo de los estados de
// respuesta (201 exito, 400 validacion, 409 agotado, 500/red error).

document.addEventListener('DOMContentLoaded', function () {
  var form = document.getElementById('form-registro');
  if (!form) {
    // El SSR ya mostraba el aforo completo: no hay formulario que manejar.
    return;
  }

  var boton = document.getElementById('boton-enviar');
  var mensajeExito = document.getElementById('mensaje-exito');
  var mensajeErrorGeneral = document.getElementById('mensaje-error-general');

  var CAMPOS = ['nombre_completo', 'dni', 'celular', 'correo', 'organizacion', 'tipo_entrada', 'comprobante', 'acepta_terminos'];
  var TEXTO_BOTON_DEFAULT = boton.textContent;

  // Popup de Terminos y Condiciones (<dialog> nativo, sin libreria de modal).
  // El boton "Terminos y Condiciones" vive DENTRO del <label> del checkbox a
  // proposito: un <button> es un descendiente interactivo, asi que un click
  // ahi NO dispara el toggle del checkbox asociado al label (comportamiento
  // estandar del navegador), solo abre el popup.
  var botonAbrirTerminos = document.getElementById('abrir-terminos');
  var modalTerminos = document.getElementById('modal-terminos');
  if (botonAbrirTerminos && modalTerminos) {
    botonAbrirTerminos.addEventListener('click', function () {
      modalTerminos.showModal();
    });

    modalTerminos.querySelectorAll('[data-cerrar-terminos]').forEach(function (el) {
      el.addEventListener('click', function () {
        modalTerminos.close();
      });
    });

    // Cerrar al hacer click en el "::backdrop": si el click cae justo sobre
    // el <dialog> (y no sobre alguno de sus hijos), el target es el dialog.
    modalTerminos.addEventListener('click', function (evento) {
      if (evento.target === modalTerminos) {
        modalTerminos.close();
      }
    });
  }

  function limpiarErrores() {
    CAMPOS.forEach(function (campo) {
      var p = form.querySelector('[data-error-para="' + campo + '"]');
      if (p) p.textContent = '';
    });
    mensajeErrorGeneral.hidden = true;
    mensajeErrorGeneral.textContent = '';
  }

  function mostrarErroresDeValidacion(detalles) {
    limpiarErrores();
    var sinAsignar = [];
    detalles.forEach(function (detalle) {
      var campo = CAMPOS.find(function (c) {
        return detalle.indexOf(c) !== -1;
      });
      var p = campo ? form.querySelector('[data-error-para="' + campo + '"]') : null;
      if (p) {
        p.textContent = detalle;
      } else {
        sinAsignar.push(detalle);
      }
    });
    if (sinAsignar.length > 0) {
      mensajeErrorGeneral.textContent = sinAsignar.join(' ');
      mensajeErrorGeneral.hidden = false;
    }
  }

  function mostrarAgotado() {
    form.hidden = true;
    var contenedor = form.parentElement;
    var div = document.createElement('div');
    div.id = 'mensaje-agotado';
    div.className = 'alerta alerta-agotado';
    div.innerHTML = '<strong>Aforo completo</strong> — ya no se aceptan más registros.';
    contenedor.insertBefore(div, form);
  }

  function mostrarErrorGenerico(texto) {
    mensajeErrorGeneral.textContent = texto;
    mensajeErrorGeneral.hidden = false;
  }

  function reactivarBoton() {
    boton.disabled = false;
    boton.textContent = TEXTO_BOTON_DEFAULT;
  }

  form.addEventListener('submit', function (evento) {
    evento.preventDefault();
    limpiarErrores();
    mensajeExito.hidden = true;

    boton.disabled = true;
    boton.textContent = 'Enviando...';

    var formData = new FormData(form);

    fetch('/api/registro', { method: 'POST', body: formData })
      .then(function (respuesta) {
        return respuesta
          .json()
          .catch(function () {
            return null;
          })
          .then(function (cuerpo) {
            return { status: respuesta.status, cuerpo: cuerpo };
          });
      })
      .then(function (resultado) {
        var status = resultado.status;
        var cuerpo = resultado.cuerpo;

        if (status === 201) {
          form.hidden = true;
          mensajeExito.textContent = 'Registro exitoso. Nos vemos en la integración.';
          mensajeExito.hidden = false;
          return;
        }

        if (status === 409) {
          mostrarAgotado();
          return;
        }

        if (status === 400) {
          var detalles = (cuerpo && cuerpo.detalles) || ['Revisa los datos ingresados.'];
          mostrarErroresDeValidacion(detalles);
          reactivarBoton();
          return;
        }

        mostrarErrorGenerico('Ocurrió un problema, intenta de nuevo en unos minutos.');
        reactivarBoton();
      })
      .catch(function () {
        mostrarErrorGenerico('Ocurrió un problema, intenta de nuevo en unos minutos.');
        reactivarBoton();
      });
  });
});
